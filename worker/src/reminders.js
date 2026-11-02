// Reminders, checked on the Worker's 3-hour schedule and sent with Web Push (push.js):
// - Waiver tips: Tuesday from 10 AM Eastern, free agents ranked above one of your starters (FantasyPros rest of season).
// - New Justin Boone rankings: when a new version of his weekly rankings is saved (at most one notice every 12 hours).
// - Lineup problems: a Sleeper starter who is out, doubtful, on IR, suspended or on bye, or an empty starting spot,
//   about 4 hours before it matters (his game's kickoff; the week's first kickoff for byes and empty spots), with the
//   best healthy bench player to start instead (Sleeper projections). Each once.

import { sendPush, vapidKeys } from "./push.js";
import { sleeperPlayers } from "./sleeper.js";
import { fetchList } from "./rankings.js";
import * as store from "./db.js";

const SLEEPER = "https://api.sleeper.app/v1";
const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
export const LEAD_MS = 4 * 3600e3; // how long before kickoff problems are sent (the check runs every 3 hours)
const BAD = { Out: "out", Doubtful: "doubtful", IR: "on IR", PUP: "on PUP", Sus: "suspended", Suspended: "suspended", NA: "not active" };
const TEAM_FIX = { WSH: "WAS", JAC: "JAX", LA: "LAR" };
const FLEX = { FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["WR", "RB"], REC_FLEX: ["WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"] };
const fits = (slot, pos) => (FLEX[slot] ? FLEX[slot].includes(pos) : slot === pos);
const scoringOf = (lg) => { const rec = +(lg.scoring_settings || {}).rec || 0; return rec >= 0.75 ? "PPR" : rec >= 0.25 ? "HALF" : "STD"; };
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
    const slots = (lg.roster_positions || []).filter((s) => !["BN", "IR", "TAXI"].includes(s)), sc = scoringOf(lg);
    const starters = m.starters || [], away = new Set([...starters, ...(mine.reserve || []), ...(mine.taxi || [])]);
    // Healthy bench players whose game hasn't started, best projection first: each can fill one problem spot
    const bench = (mine.players || []).filter((id) => !away.has(id)).map((id) => ({ id, p: players[id] }))
      .filter(({ p }) => p && p.team && games[p.team] && games[p.team].state === "pre" && !BAD[p.inj] && p.pts[sc] > 0)
      .sort((a, b) => b.p.pts[sc] - a.p.pts[sc]);
    const used = new Set();
    const fix = (slot) => {
      const b = bench.find((x) => !used.has(x.id) && fits(slot, x.p.pos));
      if (!b) return `no healthy ${FLEX[slot] ? "flex-eligible player" : slot} on your bench`;
      used.add(b.id);
      return `start ${b.p.name} (${b.p.pts[sc].toFixed(1)} pts)`;
    };
    starters.forEach((pid, i) => {
      const slot = slots[i] || "";
      if (!pid || pid === "0") { if (firstKick) out.push({ key: `${lg.league_id}|${week}|empty|${i}`, league: lg.name, text: `empty ${(slot || "starting").replace("_", " ")} spot`, fix: fix(slot), at: firstKick }); return; }
      const p = players[pid];
      if (!p || !p.team) return; // unknown player: say nothing rather than guess
      const g = games[p.team];
      if (!g) { if (firstKick) out.push({ key: `${lg.league_id}|${week}|bye|${pid}`, league: lg.name, text: `${p.name} is on bye`, fix: fix(slot), at: firstKick }); return; }
      if (g.state !== "pre") return; // already playing: too late
      if (BAD[p.inj]) out.push({ key: `${lg.league_id}|${week}|inj|${pid}|${p.inj}`, league: lg.name, text: `${p.name} is ${BAD[p.inj]}`, fix: fix(slot), at: g.kick });
    });
  }
  return out;
}

// ---- Waiver tips ----
const norm = (x) => String(x || "").toLowerCase().replace(/[.'’]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
const TEAM_KEY = { JAC: "JAX", WSH: "WAS", LA: "LAR" }, tk = (t) => (t ? TEAM_KEY[t] || t : t);
const MIN_GAIN = 5; // a pickup must be ranked at least this many places above the starter it would replace
// Tuesday from 10 AM Eastern: the day waiver claims are made in most leagues
export function waiverDay(now) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const g = (t) => f.find((x) => x.type === t)?.value;
  return g("weekday") === "Tue" && +g("hour") >= 10 ? `${g("year")}-${g("month")}-${g("day")}` : null;
}
// Free agents ranked above one of your starters at their position, by FantasyPros rest-of-season rankings.
// A free agent is only suggested when he can be matched to a Sleeper player id that no team has, so nobody already taken slips in.
export async function waiverTips(username, { season, players, ros }) {
  const u = await sj(`/user/${encodeURIComponent(username)}`).catch(() => null);
  if (!u || !u.user_id) return [];
  const byKey = {}, byName = {};
  for (const [id, p] of Object.entries(players)) {
    if (!["QB", "RB", "WR", "TE"].includes(p.pos)) continue;
    const n = norm(p.name);
    byKey[`${n}|${p.team}`] = id;
    byName[n] = byName[n] === undefined ? id : null; // null = name shared by two players
  }
  const idOf = (e) => byKey[`${norm(e.n)}|${tk(e.t)}`] || byName[norm(e.n)] || null;
  const tips = [];
  for (const lg of await sj(`/user/${u.user_id}/leagues/nfl/${season}`)) {
    const lists = ros[scoringOf(lg) === "PPR" ? "PPR" : "HALF"];
    if (!lists) continue;
    const rosters = await sj(`/league/${lg.league_id}/rosters`), mine = (rosters || []).find((r) => r.owner_id === u.user_id);
    if (!mine) continue;
    const taken = new Set(rosters.flatMap((r) => r.players || []));
    const slots = (lg.roster_positions || []).filter((s) => !["BN", "IR", "TAXI"].includes(s));
    const elig = new Set(slots.flatMap((s) => FLEX[s] || [s]));
    // Rest-of-season rank of every listed player, by Sleeper id
    const rank = {}, entry = {};
    for (const [list, ps] of Object.entries(lists)) for (const e of ps) { const id = idOf(e); if (id && rank[`${list}|${id}`] === undefined) { rank[`${list}|${id}`] = e.r; entry[`${list}|${id}`] = e; } }
    const listOf = (pos) => (pos === "QB" ? "QB" : "FLEX");
    const found = [];
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      if (!elig.has(pos)) continue;
      const L = listOf(pos);
      // Your weakest starter at this position by rest-of-season rank (unranked counts as weakest)
      const mineAt = (mine.starters || []).filter((id) => players[id] && players[id].pos === pos).map((id) => ({ id, r: rank[`${L}|${id}`] ?? Infinity }));
      if (!mineAt.length) continue;
      const worst = mineAt.reduce((a, b) => (b.r > a.r ? b : a));
      for (const e of lists[L] || []) {
        const id = idOf(e);
        if (!id || taken.has(id) || players[id].pos !== pos) continue;
        if (e.r > worst.r - MIN_GAIN) break; // the list is in rank order: nothing clearly better left
        found.push({ league: lg.name, id, name: players[id].name, pos, r: e.r, over: players[worst.id].name, gain: (worst.r === Infinity ? 999 : worst.r) - e.r });
        break; // the best free agent at this position
      }
    }
    found.sort((a, b) => b.gain - a.gain).slice(0, 3).forEach((t) => tips.push({ ...t, key: `${lg.league_id}|waiver|${t.id}` }));
  }
  return tips;
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
          body: list.map((p) => `${p.league}: ${p.text}${p.fix ? ` → ${p.fix}` : ""}`).join("\n") + `\nKickoff ${timeIn(first, s.tz)}`,
          url: "./#lineup", tag: `lineup-${week}`,
        });
        if (r === "ok") await store.markSent(db, s.endpoint, list.map((p) => p.key));
      } catch (e) { result.errors.push(`${s.sleeper_username}: ${e.message}`); }
    }
  }
  // Waiver tips: once on Tuesday (from 10 AM Eastern)
  const day = waiverDay(now), tipsFor = subs.filter((s) => s.prefs.waivers !== false && s.sleeper_username);
  if (day && tipsFor.length) {
    const fresh = [];
    for (const s of tipsFor) if ((await store.unsent(db, s.endpoint, [`waivers|${day}`])).size) fresh.push(s);
    if (fresh.length) {
      const [players, ...lists] = await Promise.all([sleeperPlayers(season, week), ...["QB", "FLEX:PPR", "FLEX:HALF"].map((k) => fetchList(season, week, k, "ecr", "ros").catch(() => null))]);
      const [qb, ppr, half] = lists, ros = {};
      if (qb && ppr) ros.PPR = { QB: qb.players, FLEX: ppr.players };
      if (qb && half) ros.HALF = { QB: qb.players, FLEX: half.players };
      for (const s of fresh) {
        try {
          const tips = await waiverTips(s.sleeper_username, { season, players, ros });
          if (tips.length) {
            const r = await send(s, {
              title: tips.length === 1 ? `Waiver tip: add ${tips[0].name}` : `Waiver tips: ${tips.length} pickups`,
              body: tips.map((t) => `${t.league}: ${t.name} (${t.pos}, rest of season #${t.r}) over your starter ${t.over}`).join("\n"),
              url: "./#fa", tag: `waivers-${day}`,
            });
            if (r !== "ok") continue;
          }
          await store.markSent(db, s.endpoint, [`waivers|${day}`]);
        } catch (e) { result.errors.push(`${s.sleeper_username} waivers: ${e.message}`); }
      }
    }
  }
  return result;
}
