// Reminders, checked on the Worker's 3-hour schedule and sent with Web Push (push.js):
// - New Justin Boone rankings: when a new version of his weekly rankings is saved (at most one notice every 12 hours).
// - Lineup problems: a Sleeper starter who is out, doubtful, on IR, suspended or on bye, or an empty starting spot,
//   about 4 hours before it matters (his game's kickoff; the week's first kickoff for byes and empty spots). Each once.

import { sendPush, vapidKeys } from "./push.js";
import { sleeperPlayers } from "./sleeper.js";
import * as store from "./db.js";

const SLEEPER = "https://api.sleeper.app/v1";
const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
export const LEAD_MS = 4 * 3600e3; // how long before kickoff problems are sent (the check runs every 3 hours)
const BAD = { Out: "out", Doubtful: "doubtful", IR: "on IR", PUP: "on PUP", Sus: "suspended", Suspended: "suspended", NA: "not active" };
const TEAM_FIX = { WSH: "WAS", JAC: "JAX", LA: "LAR" };
const sj = async (p) => { const r = await fetch(SLEEPER + p); if (!r.ok) throw new Error(`Sleeper returned ${r.status}`); return r.json(); };

// Kickoff and state (pre / in / post) by NFL team, for one week
export async function weekSchedule(season, week) {
  const r = await fetch(`${SCOREBOARD}?dates=${season}&seasontype=2&week=${week}`);
  if (!r.ok) throw new Error(`ESPN schedule returned ${r.status}`);
  const by = {};
  for (const ev of (await r.json()).events || []) {
    const c = ev.competitions?.[0] || {}, kick = Date.parse(c.date || ev.date), state = (ev.status?.type || c.status?.type || {}).state;
    for (const t of c.competitors || []) { const a = t.team?.abbreviation; if (a) by[TEAM_FIX[a] || a] = { kick, state }; }
  }
  return by;
}

// This week's lineup problems for one Sleeper user: [{ key, league, text, at }] (at = when it matters)
export async function lineupProblems(username, { season, week, players, games }) {
  const u = await sj(`/user/${encodeURIComponent(username)}`).catch(() => null);
  if (!u || !u.user_id) return [];
  const upcoming = Object.values(games).filter((g) => g.state === "pre").map((g) => g.kick);
  const firstKick = upcoming.length ? Math.min(...upcoming) : null;
  const out = [];
  for (const lg of await sj(`/user/${u.user_id}/leagues/nfl/${season}`)) {
    const [rosters, ms] = await Promise.all([sj(`/league/${lg.league_id}/rosters`), sj(`/league/${lg.league_id}/matchups/${week}`)]);
    const mine = (rosters || []).find((r) => r.owner_id === u.user_id), m = mine && (ms || []).find((x) => x.roster_id === mine.roster_id);
    if (!m) continue; // no game this week in this league
    const slots = (lg.roster_positions || []).filter((s) => !["BN", "IR", "TAXI"].includes(s));
    (m.starters || []).forEach((pid, i) => {
      if (!pid || pid === "0") { if (firstKick) out.push({ key: `${lg.league_id}|${week}|empty|${i}`, league: lg.name, text: `empty ${(slots[i] || "starting").replace("_", " ")} spot`, at: firstKick }); return; }
      const p = players[pid];
      if (!p || !p.team) return; // unknown player: say nothing rather than guess
      const g = games[p.team];
      if (!g) { if (firstKick) out.push({ key: `${lg.league_id}|${week}|bye|${pid}`, league: lg.name, text: `${p.name} is on bye`, at: firstKick }); return; }
      if (g.state !== "pre") return; // already playing: too late
      if (BAD[p.inj]) out.push({ key: `${lg.league_id}|${week}|inj|${pid}|${p.inj}`, league: lg.name, text: `${p.name} is ${BAD[p.inj]}`, at: g.kick });
    });
  }
  return out;
}

const timeIn = (ms, tz) => { try { return new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz || "America/New_York" }); } catch { return new Date(ms).toISOString(); } };

// The scheduled check. newBoone: a new version of Justin Boone's rankings for `week` was saved on this run.
export async function runReminders(env, { season, week, newBoone, now = Date.now() }) {
  const db = env.DB, subs = await store.listSubs(db);
  const result = { subscribers: subs.length, sent: 0, gone: 0, errors: [] };
  if (!subs.length) return result;
  const keys = await vapidKeys(db);
  const send = async (sub, msg) => {
    const r = await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, msg, keys).catch(() => "error");
    if (r === "gone") { await store.removeSub(db, sub.endpoint); result.gone++; } else if (r === "ok") result.sent++; else result.errors.push("push failed");
    return r;
  };

  // New rankings
  if (newBoone) {
    const last = JSON.parse((await store.getSetting(db, "boone_notice")) || "null");
    if (!last || last.week !== week || now - last.at > 12 * 3600e3) {
      await store.setSetting(db, "boone_notice", JSON.stringify({ week, at: now }));
      const title = last && last.week === week ? `Justin Boone updated his week ${week} rankings` : `Justin Boone's week ${week} rankings are out`;
      for (const s of subs) if (s.prefs.rankings !== false) await send(s, { title, body: "Tap to build your lineups.", url: "./#lineup", tag: `rankings-${week}` });
    }
  }

  // Lineup problems
  const want = subs.filter((s) => s.prefs.lineup !== false && s.sleeper_username);
  if (want.length) {
    const [players, games] = await Promise.all([sleeperPlayers(season, week), weekSchedule(season, week)]);
    for (const s of want) {
      try {
        const due = (await lineupProblems(s.sleeper_username, { season, week, players, games })).filter((p) => p.at > now && p.at - now <= LEAD_MS);
        const fresh = await store.unsent(db, s.endpoint, due.map((p) => p.key));
        const list = due.filter((p) => fresh.has(p.key));
        if (!list.length) continue;
        const first = Math.min(...list.map((p) => p.at)), texts = [...new Set(list.map((p) => p.text))];
        const r = await send(s, {
          // The same problem in several leagues (one player started in each) reads as one problem
          title: texts.length === 1 ? `Lineup check: ${texts[0]}` : `Lineup check: ${texts.length} problems`,
          body: list.map((p) => `${p.league}: ${p.text}`).join("\n") + `\nKickoff ${timeIn(first, s.tz)}`,
          url: "./#lineup", tag: `lineup-${week}`,
        });
        if (r === "ok") await store.markSent(db, s.endpoint, list.map((p) => p.key));
      } catch (e) { result.errors.push(`${s.sleeper_username}: ${e.message}`); }
    }
  }
  return result;
}
