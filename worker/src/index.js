// Boone Lineups API (Cloudflare Worker)
//
// Public (Boone's published data):
//   GET  /trade-values                      Boone's latest trade value charts, plus prev: each position's chart from an earlier week
//                                           (for trends) (?refresh skips the 1-hour cache)
//   GET  /rankings?season&week&scoring&source&kind
//                                           QB, FLEX, K, DEF lists (scoring = PPR | HALF; defaults to Sleeper's current week).
//                                           source = boone (default) | ecr (FantasyPros consensus) | sleeper (Sleeper projections);
//                                           kind = week (default) | ros (consensus only)
//   GET  /trade-values/fantasycalc?ppr&qbs&teams   FantasyCalc redraft values for a league format, rescaled so the top player is 100
//   GET  /rankings/status?season&week       Newest publish time of Boone's rankings for that week
//   GET  /health
// Private (header "Authorization: Bearer <ACCESS_CODE>"):
//   GET/PUT /me/profile                     Sleeper username and app settings
//   GET  /me/builds?limit                   Saved lineup builds, each with the newest rankings time for its week
//   POST /me/builds                         Save builds: { builds: [...] }
//   DELETE /me/builds/:id
//   GET  /me/espn?season                    Your ESPN leagues (ids from profile settings.espnLeagues), in the app's league shape
//   GET  /push/key · POST /push/subscribe · POST /push/unsubscribe · POST /push/test   Reminder sign-ups (see reminders.js)
// Scheduled every 3 hours: send reminders; save new versions of the weekly rankings from every source (Boone, FantasyPros consensus, Sleeper projections), and the week's trade value charts.
//
// Bindings: DB (D1). Secrets: ACCESS_CODE; ESPN_S2 and ESPN_SWID (ESPN login cookies, for private leagues).

import { loadTradeValues } from "./tradevalues.js";
import { loadFantasyCalc, fcFormat } from "./fantasycalc.js";
import { fetchList, sleeperWeek, appLists, SOURCES, KINDS } from "./rankings.js";
import * as store from "./db.js";
import { fetchLeague } from "./espn.js";
import { vapidKeys, validSubscription, sendPush } from "./push.js";
import { runReminders } from "./reminders.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};
const json = (body, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, ...CORS } });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

let tvMemo = null; // { ts, data }
const TV_CACHE_MS = 60 * 60 * 1000;

async function tradeValues(env, fresh) {
  if (!fresh && tvMemo && Date.now() - tvMemo.ts < TV_CACHE_MS) return tvMemo.data;
  try {
    const data = await loadTradeValues();
    if (env.DB) await store.ensureSchema(env.DB).then(async () => {
      await store.saveTradeValues(env.DB, data);
      // A position Yahoo didn't give us this time: use its newest saved chart (marked saved)
      const missing = ["QB", "RB", "WR", "TE"].filter((p) => !data.charts[p]);
      if (missing.length) {
        const saved = await store.latestTradeValues(env.DB);
        for (const p of missing) if (saved[p] && saved[p].season === data.season) data.charts[p] = { ...saved[p], saved: true };
      }
      // Previous week's charts, so the app can show each player's change
      data.prev = await store.prevTradeValues(env.DB, data.season, data.week);
    }).catch(() => {});
    tvMemo = { ts: Date.now(), data };
    return data;
  } catch (e) {
    if (tvMemo) return { ...tvMemo.data, stale: true, staleReason: e.message };
    throw new HttpError(502, e.message);
  }
}

const fcMemo = new Map(); // format key -> { ts, data }
let weekMemo = null; // { ts, p: Promise<{season, week}> }
const currentWeek = () => { if (!weekMemo || Date.now() - weekMemo.ts > 3600e3) { const p = sleeperWeek(); weekMemo = { ts: Date.now(), p }; p.catch(() => { weekMemo = null; }); } return weekMemo.p; };
// FantasyCalc values for a format. The first copy each week is kept in D1, and the previous week's copy comes back
// as `prev` so the app can show week-over-week trends.
async function fantasyCalc(q, env) {
  const fmt = fcFormat(q), key = `${fmt.ppr}|${fmt.qbs}|${fmt.teams}`, m = fcMemo.get(key);
  if (m && Date.now() - m.ts < TV_CACHE_MS) return m.data;
  try {
    const data = await loadFantasyCalc(fmt);
    if (env.DB) await (async () => {
      await store.ensureSchema(env.DB);
      const { season, week } = await currentWeek();
      await store.saveFcWeek(env.DB, season, week, key, data.players);
      data.prev = await store.prevFcWeek(env.DB, season, week, key);
    })().catch(() => {});
    fcMemo.set(key, { ts: Date.now(), data });
    return data;
  } catch (e) {
    if (m) return { ...m.data, stale: true, staleReason: e.message };
    throw new HttpError(502, e.message);
  }
}

async function weekParams(url) {
  const s = url.searchParams.get("season"), w = url.searchParams.get("week");
  if (s && w) return { season: +s, week: +w };
  return sleeperWeek();
}

// Live from FantasyPros, saving new versions; falls back to the newest saved copy if FantasyPros fails.
// Boone's weekly lists keep every version (for "expired"); other lists keep only the newest copy.
async function save(db, season, week, l) {
  return l.source === "boone" && l.kind === "week" ? store.saveRankings(db, season, week, l) : store.saveLatest(db, season, l.kind === "ros" ? 0 : week, l);
}
async function saved(db, season, week, key, source, kind) {
  if (source === "boone" && kind === "week") return (await store.latestRankings(db, season, week, [key]))[key] || null;
  return store.getLatest(db, source, kind, season, kind === "ros" ? 0 : week, key);
}
async function rankings(env, season, week, scoring, source = "boone", kind = "week") {
  if (source === "boone" && kind !== "week") throw new HttpError(400, "Boone only has weekly rankings. Use source=ecr for rest of season.");
  const map = appLists(scoring), db = env.DB;
  if (db) await store.ensureSchema(db);
  const lists = {}, errors = [];
  await Promise.all(Object.entries(map).map(async ([appKey, key]) => {
    try {
      const l = await fetchList(season, week, key, source, kind);
      lists[appKey] = { pub: l.pub, players: l.players, source: "live" };
      if (db) await save(db, season, week, l);
    } catch (e) {
      if (/not Boone/.test(e.message)) throw new HttpError(409, e.message);
      errors.push(`${appKey}: ${e.message}`);
      const s = db ? await saved(db, season, week, key, source, kind) : null;
      if (s) lists[appKey] = { pub: s.pub, players: s.players, source: "saved" };
    }
  }));
  return { season, week, scoring, rankSource: source, kind, lists, errors };
}

function authorize(request, env) {
  if (!env.ACCESS_CODE) throw new HttpError(503, "ACCESS_CODE isn't set on the Worker yet.");
  if (!env.DB) throw new HttpError(503, "The D1 database isn't connected to the Worker yet.");
  const got = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const a = new TextEncoder().encode(got), b = new TextEncoder().encode(env.ACCESS_CODE);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  if (diff) throw new HttpError(401, "Wrong access code.");
}

async function readJson(request) {
  if (+(request.headers.get("Content-Length") || 0) > 256 * 1024) throw new HttpError(413, "Too large.");
  try { return await request.json(); } catch { throw new HttpError(400, "Expected JSON."); }
}

async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/", m = request.method;
  if (m === "OPTIONS") return new Response(null, { headers: CORS });

  if (path === "/health") return json({ ok: true, db: !!env.DB, accessCode: !!env.ACCESS_CODE });
  if (path === "/trade-values" && m === "GET") return json(await tradeValues(env, url.searchParams.has("refresh")), 200, "public, max-age=300");
  if (path === "/trade-values/fantasycalc" && m === "GET") return json(await fantasyCalc(Object.fromEntries(url.searchParams), env), 200, "public, max-age=1800");
  if (path === "/rankings" && m === "GET") {
    const { season, week } = await weekParams(url), scoring = url.searchParams.get("scoring") === "HALF" ? "HALF" : "PPR";
    const source = url.searchParams.get("source") || "boone", kind = url.searchParams.get("kind") || "week";
    if (!SOURCES.includes(source) || !KINDS.includes(kind)) throw new HttpError(400, `source must be one of ${SOURCES.join(", ")}; kind one of ${KINDS.join(", ")}`);
    return json(await rankings(env, season, week, scoring, source, kind));
  }
  if (path === "/rankings/status" && m === "GET") {
    const { season, week } = await weekParams(url);
    // Check the QB list live (all lists are published together), then report the newest time known
    const live = await fetchList(season, week, "QB").catch(() => null);
    let pub = live?.pub || 0;
    if (env.DB) {
      await store.ensureSchema(env.DB);
      if (live) await store.saveRankings(env.DB, season, week, live);
      pub = Math.max(pub, await store.latestPub(env.DB, season, week));
    }
    return json({ season, week, latestPub: pub || null });
  }

  // Reminder sign-ups. No account: a device signs up with its push subscription and a Sleeper username.
  // Only the browser vendors' push services are accepted as endpoints (validSubscription).
  if (path.startsWith("/push/")) {
    if (!env.DB) throw new HttpError(503, "The D1 database isn't connected to the Worker yet.");
    const db = env.DB;
    await store.ensureSchema(db);
    if (path === "/push/key" && m === "GET") return json({ publicKey: (await vapidKeys(db)).publicKey });
    const b = m === "POST" ? await readJson(request) : null;
    if (path === "/push/subscribe" && m === "POST") {
      const sub = b && b.subscription;
      if (!sub || !validSubscription(sub)) throw new HttpError(400, "Not a valid push subscription.");
      if (!(await store.getSub(db, sub.endpoint)) && (await store.countSubs(db)) >= 200) throw new HttpError(429, "Too many devices signed up.");
      const muted = Array.isArray(b.prefs?.muted) ? b.prefs.muted.filter((x) => typeof x === "string" && /^[\w:-]{1,40}$/.test(x)).slice(0, 50) : [];
      const prefs = { rankings: b.prefs?.rankings !== false, lineup: b.prefs?.lineup !== false, waivers: b.prefs?.waivers !== false, recap: b.prefs?.recap !== false, muted };
      await store.saveSub(db, { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
        sleeperUsername: typeof b.sleeperUsername === "string" ? b.sleeperUsername.trim().slice(0, 64) : null, prefs, tz: typeof b.tz === "string" ? b.tz.slice(0, 64) : null });
      return json({ ok: true, prefs });
    }
    if (path === "/push/unsubscribe" && m === "POST") { if (b && typeof b.endpoint === "string") await store.removeSub(db, b.endpoint); return json({ ok: true }); }
    if (path === "/push/test" && m === "POST") {
      const s = b && typeof b.endpoint === "string" ? await store.getSub(db, b.endpoint) : null;
      if (!s) throw new HttpError(404, "This device isn't signed up for reminders.");
      if (s.last_test_at && Date.now() - s.last_test_at < 30e3) throw new HttpError(429, "Wait a few seconds before sending another test.");
      await store.touchTest(db, s.endpoint, Date.now());
      const r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, { title: "Reminders are on", body: "You'll hear about new Justin Boone rankings and lineup problems before kickoff.", url: "./#lineup", tag: "test" }, await vapidKeys(db));
      if (r === "gone") { await store.removeSub(db, s.endpoint); throw new HttpError(410, "This device's notifications were turned off. Turn reminders on again."); }
      if (r !== "ok") throw new HttpError(502, "The notification service didn't accept the test.");
      return json({ ok: true });
    }
  }

  if (path.startsWith("/me/")) {
    authorize(request, env);
    const db = env.DB;
    await store.ensureSchema(db);
    if (path === "/me/profile" && m === "GET") return json(await store.getProfile(db));
    if (path === "/me/profile" && m === "PUT") {
      const b = await readJson(request);
      return json(await store.putProfile(db, { sleeperUsername: typeof b.sleeperUsername === "string" ? b.sleeperUsername.slice(0, 64) : null, settings: b.settings && typeof b.settings === "object" ? b.settings : {} }));
    }
    if (path === "/me/builds" && m === "GET") return json({ builds: await store.listBuilds(db, Math.min(100, +url.searchParams.get("limit") || 30)) });
    if (path === "/me/builds" && m === "POST") {
      const b = await readJson(request);
      if (!Array.isArray(b.builds) || b.builds.length > 30) throw new HttpError(400, "Expected { builds: [...] } with at most 30 builds.");
      return json({ saved: await store.addBuilds(db, b.builds) });
    }
    if (path === "/me/espn" && m === "GET") {
      const ids = ((await store.getProfile(db)).settings.espnLeagues || []).map(String).filter((x) => /^\d{1,12}$/.test(x)).slice(0, 10);
      const season = +url.searchParams.get("season") || (await sleeperWeek()).season;
      const leagues = [], errors = [];
      await Promise.all(ids.map(async (id) => {
        try { leagues.push(await fetchLeague(season, id, env)); } catch (e) { errors.push({ leagueId: id, error: e.message }); }
      }));
      leagues.sort((a, b) => ids.indexOf(a.league_id.slice(5)) - ids.indexOf(b.league_id.slice(5)));
      return json({ season, leagues, errors, cookies: !!(env.ESPN_S2 && env.ESPN_SWID) });
    }
    const del = path.match(/^\/me\/builds\/(\d+)$/);
    if (del && m === "DELETE") return json({ deleted: await store.deleteBuild(db, +del[1]) });
  }
  return json({ error: "Not found" }, 404);
}

export async function scheduled(env, now = Date.now()) {
  const out = { rankings: {}, tradeValues: null, reminders: null, errors: [] };
  if (!env.DB) return out;
  await store.ensureSchema(env.DB);
  let wk = null;
  try {
    wk = await sleeperWeek();
    for (const source of SOURCES) for (const key of ["QB", "FLEX:PPR", "FLEX:HALF", "K", "DEF"]) {
      try { out.rankings[`${source}:${key}`] = await save(env.DB, wk.season, wk.week, await fetchList(wk.season, wk.week, key, source)); }
      catch (e) { out.errors.push(`${source} ${key}: ${e.message}`); }
    }
  } catch (e) { out.errors.push(`week: ${e.message}`); }
  try { const d = await tradeValues(env, true); out.tradeValues = d.week; } catch (e) { out.errors.push(`trade values: ${e.message}`); }
  // FantasyCalc formats in use: keep their weekly copies going for week-over-week trends
  if (wk) try {
    for (const f of await store.recentFcFormats(env.DB, wk.season, wk.week)) { const [ppr, qbs, teams] = f.split("|"); await fantasyCalc({ ppr, qbs, teams }, env); }
  } catch (e) { out.errors.push(`fantasycalc history: ${e.message}`); }
  // Once a day: trim data nothing uses any more
  if (wk) try {
    const day = new Date(now).toISOString().slice(0, 10);
    if ((await store.getSetting(env.DB, "trim_day")) !== day) { out.trimmed = await store.trim(env.DB, wk.season, wk.week, now); await store.setSetting(env.DB, "trim_day", day); }
  } catch (e) { out.errors.push(`trim: ${e.message}`); }
  // Reminders: new Justin Boone rankings (a new version saved just now) and lineup problems before kickoff
  if (wk) try {
    const newBoone = Object.entries(out.rankings).some(([k, v]) => k.startsWith("boone:") && v === true);
    out.reminders = await runReminders(env, { ...wk, newBoone, now });
  } catch (e) { out.errors.push(`reminders: ${e.message}`); }
  return out;
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { return json({ error: e.message }, e.status || 500); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env, event.scheduledTime || Date.now()).then((r) => console.log("scheduled", JSON.stringify(r))));
  },
};
