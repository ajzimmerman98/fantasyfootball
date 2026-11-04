// Reminders, checked by the Worker's hourly schedule and sent with Web Push (push.js):
// - Weekly recap: Tuesday from 7 AM (the device's time), each Sleeper league's result, record, playoff odds (and change) and top scorer.
// - Waiver tips: Tuesday from 10 AM (the device's time), free agents ranked above one of your starters (FantasyPros rest of season).
// - New Justin Boone rankings: when a new version of his weekly rankings is saved (at most one notice every 12 hours).
// - Lineup problems: a Sleeper starter who is out, doubtful, on IR, suspended or on bye, or an empty starting spot,
//   about 4 hours before it matters (his game's kickoff; the week's first kickoff for byes and empty spots), with the
//   best healthy bench player to start instead (Sleeper projections). Each once.

import { sendPush, vapidKeys } from "./push.js";
import { sleeperPlayers } from "./sleeper.js";
import { fetchList } from "./rankings.js";
import { lineupStrength, strengths, simulateSeason } from "./playoffs.js";
import * as store from "./db.js";

const SLEEPER = "https://api.sleeper.app/v1";
const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
// Nothing is sent from 11 PM to 7 AM on the device's clock; whatever is due waits for the first check after 7 AM.
const localHour = (now, tz) => { try { return +new Intl.DateTimeFormat("en-US", { timeZone: tz || "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(now)); } catch { return localHour(now, "America/New_York"); } };
export const quiet = (now, tz) => { const h = localHour(now, tz); return h >= 23 || h < 7; };
export const LEAD_MS = 4 * 3600e3; // how long before kickoff problems are sent (checked most hours)
const BAD = { Out: "out", Doubtful: "doubtful", IR: "on IR", PUP: "on PUP", Sus: "suspended", Suspended: "suspended", NA: "not active" };
const TEAM_FIX = { WSH: "WAS", JAC: "JAX", LA: "LAR" };
const FLEX = { FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["WR", "RB"], REC_FLEX: ["WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"] };
const fits = (slot, pos) => (FLEX[slot] ? FLEX[slot].includes(pos) : slot === pos);
const scoringOf = (lg) => { const rec = +(lg.scoring_settings || {}).rec || 0; return rec >= 0.75 ? "PPR" : rec >= 0.25 ? "HALF" : "STD"; };
// Sleeper reads are shared within one run (the lineup check, recap and waiver tips all need a league's rosters), since
// every outside request counts toward the Worker's per-run limit.
let memo = null;
const sj = (p) => {
  if (memo && memo.has(p)) return memo.get(p);
  const pr = (async () => { const r = await fetch(SLEEPER + p); if (!r.ok) throw new Error(`Sleeper returned ${r.status}`); return r.json(); })();
  if (memo) { memo.set(p, pr); pr.catch(() => memo && memo.delete(p)); }
  return pr;
};
const UNLIMITED = { left: () => Infinity };
const RESERVE = 3; // requests kept back for sending the notifications themselves

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
export async function lineupProblems(username, { season, week, players, games, muted = new Set(), budget = UNLIMITED }) {
  const u = await sj(`/user/${encodeURIComponent(username)}`).catch(() => null);
  if (!u || !u.user_id) return [];
  const upcoming = Object.values(games).filter((g) => g.state === "pre").map((g) => g.kick);
  const firstKick = upcoming.length ? Math.min(...upcoming) : null;
  const out = [];
  for (const lg of await sj(`/user/${u.user_id}/leagues/nfl/${season}`)) {
    if (muted.has(lg.league_id)) continue;
    if (budget.left() < 2 + RESERVE) break; // the rest is checked next hour, still well before kickoff
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
// Tuesday from a given hour on the device's clock (recap from 7 AM, waiver tips from 10 AM, when most leagues' claims are made)
export const waiverDay = (now, tz) => tuesdayFrom(now, 10, tz);
export function tuesdayFrom(now, hour, tz = "America/New_York") {
  let f;
  try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz || "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now)); }
  catch { return tuesdayFrom(now, hour); }
  const g = (t) => f.find((x) => x.type === t)?.value;
  return g("weekday") === "Tue" && +g("hour") >= hour ? `${g("year")}-${g("month")}-${g("day")}` : null;
}
// Free agents ranked above one of your starters at their position, by FantasyPros rest-of-season rankings.
// A free agent is only suggested when he can be matched to a Sleeper player id that no team has, so nobody already taken slips in.
// Returns null when the run's request budget ran out before every league was checked (tried again next hour).
export async function waiverTips(username, { season, players, ros, muted = new Set(), budget = UNLIMITED }) {
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
    if (muted.has(lg.league_id)) continue;
    const lists = ros[scoringOf(lg) === "PPR" ? "PPR" : "HALF"];
    if (!lists) continue;
    if (budget.left() < 1 + RESERVE) return null;
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

// ---- Weekly recap ----
// The most recent week whose NFL games are all final (this week, or the one before)
export async function finishedWeek(season, week) {
  for (const w of [week, week - 1]) {
    if (w < 1) continue;
    const g = Object.values(await weekSchedule(season, w));
    if (g.length && g.every((x) => x.state === "post")) return w;
  }
  return null;
}
const pctTxt = (x) => (x >= 0.995 ? ">99%" : x > 0 && x < 0.005 ? "<1%" : Math.round(x * 100) + "%");
// A league's matchup pairs for weeks from..to. Sleeper sets the whole regular season's schedule up front, so each week's
// pairs are kept in D1 once read: the recap then needs no request per remaining week.
async function leagueWeeks(db, id, season, from, to) {
  const key = `sched|${season}|${id}`, have = JSON.parse((await store.getSetting(db, key)) || "{}");
  const need = [];
  for (let w = from; w <= to; w++) if (!have[w]) need.push(w);
  if (need.length) {
    const got = await Promise.all(need.map((w) => sj(`/league/${id}/matchups/${w}`).catch(() => [])));
    let added = false;
    got.forEach((wm, k) => {
      const by = {};
      for (const x of wm || []) if (x.matchup_id != null) (by[x.matchup_id] ||= []).push(x.roster_id);
      const pairs = Object.values(by).filter((g) => g.length === 2);
      if (pairs.length) { have[need[k]] = pairs; added = true; }
    });
    if (added) await store.setSetting(db, key, JSON.stringify(have));
  }
  return Array.from({ length: to - from + 1 }, (_, k) => have[from + k] || []);
}
async function missingWeeks(db, id, season, from, to) {
  const have = JSON.parse((await store.getSetting(db, `sched|${season}|${id}`)) || "{}");
  let n = 0;
  for (let w = from; w <= to; w++) if (!have[w]) n++;
  return n;
}
// One line per Sleeper league for week `w`; also saves each league's playoff odds so next week can show the change.
// skip: league ids already done on an earlier run. Returns { lines, done (league ids), complete }: not complete when
// the run's request budget ran out first, so the rest is picked up on the next run.
export async function weeklyRecap(db, username, { season, w, players, sims = 2000, muted = new Set(), skip = new Set(), budget = UNLIMITED }) {
  const u = await sj(`/user/${encodeURIComponent(username)}`).catch(() => null);
  if (!u || !u.user_id) return { lines: [], done: [], complete: true };
  const out = [], done = [];
  for (const lg of await sj(`/user/${u.user_id}/leagues/nfl/${season}`)) {
    if (muted.has(lg.league_id) || skip.has(lg.league_id)) continue;
    const st = lg.settings || {}, last = (+st.playoff_week_start || 15) - 1;
    const cost = 3 + (w < last ? await missingWeeks(db, lg.league_id, season, w + 1, last) : 0);
    if (budget.left() < cost + RESERVE) return { lines: out, done, complete: false };
    const [rosters, users, ms] = await Promise.all([sj(`/league/${lg.league_id}/rosters`), sj(`/league/${lg.league_id}/users`).catch(() => []), sj(`/league/${lg.league_id}/matchups/${w}`)]);
    const mine = (rosters || []).find((r) => r.owner_id === u.user_id), m = mine && (ms || []).find((x) => x.roster_id === mine.roster_id);
    const opp = m && m.matchup_id != null && ms.find((x) => x.matchup_id === m.matchup_id && x.roster_id !== m.roster_id);
    done.push(lg.league_id);
    if (!m || !opp) continue; // no game this week (bye, or out of the playoffs)
    const a = +m.points || 0, b = +opp.points || 0, res = a > b ? "W" : a < b ? "L" : "T";
    const oppRoster = rosters.find((r) => r.roster_id === opp.roster_id), oppUser = (users || []).find((x) => oppRoster && x.user_id === oppRoster.owner_id);
    const oppName = oppUser?.metadata?.team_name || oppUser?.display_name || `Team ${opp.roster_id}`;
    let top = null;
    (m.starters || []).forEach((pid, i) => { const v = +(m.starters_points || [])[i] || 0; if (pid && pid !== "0" && (!top || v > top.v)) top = { pid, v }; });
    let record = null, odds = null, delta = null;
    if (w <= last) {
      // Standings after this week (Sleeper may not have counted it yet), with next week's projected best lineups
      const sc = scoringOf(lg), slots = (lg.roster_positions || []).filter((x) => !["BN", "IR", "TAXI"].includes(x));
      const base = rosters.map((r) => {
        const s2 = r.settings || {};
        let W = +s2.wins || 0, L = +s2.losses || 0, T = +s2.ties || 0, pf = (+s2.fpts || 0) + (+s2.fpts_decimal || 0) / 100;
        if (W + L + T < w) {
          const mm = ms.find((x) => x.roster_id === r.roster_id), oo = mm && mm.matchup_id != null && ms.find((x) => x.matchup_id === mm.matchup_id && x.roster_id !== r.roster_id);
          if (mm && oo) { pf += +mm.points || 0; if (+mm.points > +oo.points) W++; else if (+mm.points < +oo.points) L++; else T++; }
        }
        const away = new Set([...(r.reserve || []), ...(r.taxi || [])]), ids = (r.players || []).filter((id) => !away.has(id)), val = {}, pos = {};
        for (const id of ids) { const p = players[id]; if (p) { pos[id] = p.pos; val[id] = BAD[p.inj] ? 0 : p.pts[sc] || 0; } }
        return { id: r.roster_id, owner: r.owner_id, w: W, l: L, t: T, pf, g: W + L + T, proj: lineupStrength(ids, slots, val, pos) };
      });
      const me = base.find((t) => t.owner === u.user_id);
      record = `${me.w}-${me.l}${me.t ? "-" + me.t : ""}`;
      if (w < last) {
        const pairs = await leagueWeeks(db, lg.league_id, season, w + 1, last);
        if (pairs.some((g) => g.length)) {
          const teams = strengths(base), k = teams.findIndex((t) => t.owner === u.user_id);
          odds = simulateSeason({ teams, weeks: pairs, nPO: +st.playoff_teams || 6, median: +st.league_average_match === 1, sims, me: k }).teams[k].po;
          const key = `odds|${username.toLowerCase()}|${lg.league_id}`, prev = JSON.parse((await store.getSetting(db, key)) || "null");
          if (prev && prev.week === w - 1) delta = Math.round(odds * 100) - Math.round(prev.po * 100);
          await store.setSetting(db, key, JSON.stringify({ week: w, po: odds }));
        }
      }
    }
    out.push({ league: lg.name, res, a, b, playoffs: w > last,
      text: `${lg.name}: ${w > last ? "playoffs, " : ""}${res} ${a.toFixed(1)}–${b.toFixed(1)} vs ${oppName}` +
        (record ? ` · ${record}` : "") + (odds != null ? ` · playoff odds ${pctTxt(odds)}${delta ? ` (${delta > 0 ? "▲" : "▼"}${Math.abs(delta)})` : ""}` : "") +
        (top ? ` · top scorer ${players[top.pid]?.name || top.pid} ${top.v.toFixed(1)}` : "") });
  }
  return { lines: out, done, complete: true };
}

const timeIn = (ms, tz) => { try { return new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz || "America/New_York" }); } catch { return new Date(ms).toISOString(); } };

// The scheduled check. newBoone: a new version of Justin Boone's rankings for `week` was saved on this run.
// budget.left(): outside requests this run may still make. only: "rankings" sends just the new-rankings notice (the
// runs that refresh rankings use most of their budget on that).
export async function runReminders(env, { season, week, newBoone, now = Date.now(), budget = UNLIMITED, only = null }) {
  memo = new Map();
  try { return await reminders(env, { season, week, newBoone, now, budget, only }); }
  finally { memo = null; }
}
async function reminders(env, { season, week, newBoone, now, budget, only }) {
  const db = env.DB, subs = await store.listSubs(db);
  const result = { subscribers: subs.length, sent: 0, gone: 0, deferred: [], errors: [] };
  if (!subs.length) return result;
  const keys = await vapidKeys(db);
  const send = async (sub, msg) => {
    const r = await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, msg, keys).catch(() => "error");
    if (r === "gone") { await store.removeSub(db, sub.endpoint); result.gone++; } else if (r === "ok") result.sent++; else result.errors.push("push failed");
    return r;
  };
  const err = (what, e) => result.errors.push(`${what}: ${e.message}`);

  // New rankings: a notice lasts 12 hours, so a device in quiet hours gets it after 7 AM
  if (newBoone) {
    const last = JSON.parse((await store.getSetting(db, "boone_notice")) || "null");
    if (!last || last.week !== week || now - last.at > 12 * 3600e3)
      await store.setSetting(db, "boone_notice", JSON.stringify({ week, at: now, title: last && last.week === week ? `Justin Boone updated his week ${week} rankings` : `Justin Boone's week ${week} rankings are out` }));
  }
  const notice = JSON.parse((await store.getSetting(db, "boone_notice")) || "null");
  if (notice && now - notice.at < 12 * 3600e3) for (const s of subs) {
    if (s.prefs.rankings === false || quiet(now, s.tz) || !(await store.unsent(db, s.endpoint, [`rankings|${notice.at}`])).size) continue;
    if ((await send(s, { title: notice.title, body: "Tap to build your lineups.", url: "./#lineup", tag: `rankings-${notice.week}` })) === "ok") await store.markSent(db, s.endpoint, [`rankings|${notice.at}`]);
  }
  if (only === "rankings") return result;

  // Lineup problems
  const want = subs.filter((s) => s.prefs.lineup !== false && s.sleeper_username && !quiet(now, s.tz));
  if (want.length) {
    try {
      const [players, games] = await Promise.all([sleeperPlayers(season, week), weekSchedule(season, week)]);
      for (const s of want) {
        try {
          const due = (await lineupProblems(s.sleeper_username, { season, week, players, games, muted: new Set(s.prefs.muted || []), budget })).filter((p) => p.at > now && p.at - now <= LEAD_MS);
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
        } catch (e) { err("lineup check", e); }
      }
    } catch (e) { err("lineup check", e); }
  }

  // Weekly recap: once on Tuesday (from 7 AM on the device's clock) for the week that just finished. Leagues are done
  // as the run's request budget allows; what's done so far is kept in D1 and the whole recap is sent once complete.
  const recapFor = [];
  for (const s of subs) {
    const day = tuesdayFrom(now, 7, s.tz);
    if (day && s.prefs.recap !== false && s.sleeper_username && !quiet(now, s.tz) && (await store.unsent(db, s.endpoint, [`recap|${day}`])).size) recapFor.push([s, day]);
  }
  if (recapFor.length) {
    try {
      const w = await finishedWeek(season, week);
      if (w) {
        const players = await sleeperPlayers(season, w + 1).catch(() => ({}));
        for (const [s, day] of recapFor) {
          try {
            const bufKey = `recapbuf|${day}|${s.endpoint}`, buf = JSON.parse((await store.getSetting(db, bufKey)) || "null") || { done: [], lines: [] };
            const r = await weeklyRecap(db, s.sleeper_username, { season, w, players, muted: new Set(s.prefs.muted || []), skip: new Set(buf.done), budget });
            const lines = [...buf.lines, ...r.lines];
            if (!r.complete) { await store.setSetting(db, bufKey, JSON.stringify({ done: [...buf.done, ...r.done], lines })); result.deferred.push("recap"); continue; }
            if (lines.length) {
              const n = (x) => lines.filter((l) => l.res === x).length, one = lines[0];
              const title = lines.length === 1 ? `Week ${w}: you ${one.res === "W" ? "won" : one.res === "L" ? "lost" : "tied"} ${one.a.toFixed(1)}–${one.b.toFixed(1)}` : `Week ${w} recap: ${n("W")}-${n("L")}${n("T") ? "-" + n("T") : ""}`;
              if ((await send(s, { title, body: lines.map((x) => x.text).join("\n"), url: "./#power", tag: `recap-${w}` })) !== "ok") continue;
            }
            await store.markSent(db, s.endpoint, [`recap|${day}`]);
            await store.setSetting(db, bufKey, "null");
          } catch (e) { err("recap", e); }
        }
      }
    } catch (e) { err("recap", e); }
  }

  // Waiver tips: once on Tuesday (from 10 AM on the device's clock)
  const tipsFor = [];
  for (const s of subs) {
    const day = waiverDay(now, s.tz);
    if (day && s.prefs.waivers !== false && s.sleeper_username && !quiet(now, s.tz) && (await store.unsent(db, s.endpoint, [`waivers|${day}`])).size) tipsFor.push([s, day]);
  }
  if (tipsFor.length && budget.left() < 4 + RESERVE) result.deferred.push("waivers");
  else if (tipsFor.length) {
    try {
      const [players, ...lists] = await Promise.all([sleeperPlayers(season, week), ...["QB", "FLEX:PPR", "FLEX:HALF"].map((k) => fetchList(season, week, k, "ecr", "ros").catch(() => null))]);
      const [qb, ppr, half] = lists, ros = {};
      if (qb && ppr) ros.PPR = { QB: qb.players, FLEX: ppr.players };
      if (qb && half) ros.HALF = { QB: qb.players, FLEX: half.players };
      for (const [s, day] of tipsFor) {
        try {
          const tips = await waiverTips(s.sleeper_username, { season, players, ros, muted: new Set(s.prefs.muted || []), budget });
          if (!tips) { result.deferred.push("waivers"); continue; }
          if (tips.length) {
            const r = await send(s, {
              title: tips.length === 1 ? `Waiver tip: add ${tips[0].name}` : `Waiver tips: ${tips.length} pickups`,
              body: tips.map((t) => `${t.league}: ${t.name} (${t.pos}, rest of season #${t.r}) over your starter ${t.over}`).join("\n"),
              url: "./#fa", tag: `waivers-${day}`,
            });
            if (r !== "ok") continue;
          }
          await store.markSent(db, s.endpoint, [`waivers|${day}`]);
        } catch (e) { err("waivers", e); }
      }
    } catch (e) { err("waivers", e); }
  }
  return result;
}
