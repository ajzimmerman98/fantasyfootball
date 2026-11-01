// Boone Lineups API (Cloudflare Worker)
//
// Public (Boone's published data):
//   GET  /trade-values                      Boone's latest trade value charts (?refresh skips the 1-hour cache)
//   GET  /rankings?season&week&scoring&source&kind
//                                           QB, FLEX, K, DEF lists (scoring = PPR | HALF; defaults to Sleeper's current week).
//                                           source = boone (default) | ecr (FantasyPros consensus); kind = week (default) | ros (consensus only)
//   GET  /trade-values/fantasycalc?ppr&qbs&teams   FantasyCalc redraft values for a league format, rescaled so the top player is 100
//   GET  /rankings/status?season&week       Newest publish time of Boone's rankings for that week
//   GET  /health
// Private (header "Authorization: Bearer <ACCESS_CODE>"):
//   GET/PUT /me/profile                     Sleeper username and app settings
//   GET  /me/builds?limit                   Saved lineup builds, each with the newest rankings time for its week
//   POST /me/builds                         Save builds: { builds: [...] }
//   DELETE /me/builds/:id
//   GET  /me/espn?season                    Your ESPN leagues (ids from profile settings.espnLeagues), in the app's league shape
// Scheduled every 3 hours: save new versions of Boone's and the consensus weekly rankings, and the week's trade value charts.
//
// Bindings: DB (D1). Secrets: ACCESS_CODE; ESPN_S2 and ESPN_SWID (ESPN login cookies, for private leagues).

import { loadTradeValues } from "./tradevalues.js";
import { loadFantasyCalc, fcFormat } from "./fantasycalc.js";
import { fetchList, sleeperWeek, appLists, SOURCES, KINDS } from "./rankings.js";
import * as store from "./db.js";
import { fetchLeague } from "./espn.js";

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
    tvMemo = { ts: Date.now(), data };
    if (env.DB) await store.ensureSchema(env.DB).then(() => store.saveTradeValues(env.DB, data)).catch(() => {});
    return data;
  } catch (e) {
    if (tvMemo) return { ...tvMemo.data, stale: true, staleReason: e.message };
    throw new HttpError(502, e.message);
  }
}

const fcMemo = new Map(); // format key -> { ts, data }
async function fantasyCalc(q) {
  const fmt = fcFormat(q), key = `${fmt.ppr}|${fmt.qbs}|${fmt.teams}`, m = fcMemo.get(key);
  if (m && Date.now() - m.ts < TV_CACHE_MS) return m.data;
  try {
    const data = await loadFantasyCalc(fmt);
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
  if (path === "/trade-values/fantasycalc" && m === "GET") return json(await fantasyCalc(Object.fromEntries(url.searchParams)), 200, "public, max-age=1800");
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

export async function scheduled(env) {
  const out = { rankings: {}, tradeValues: null, errors: [] };
  if (!env.DB) return out;
  await store.ensureSchema(env.DB);
  try {
    const { season, week } = await sleeperWeek();
    for (const source of SOURCES) for (const key of ["QB", "FLEX:PPR", "FLEX:HALF", "K", "DEF"]) {
      try { out.rankings[`${source}:${key}`] = await save(env.DB, season, week, await fetchList(season, week, key, source)); }
      catch (e) { out.errors.push(`${source} ${key}: ${e.message}`); }
    }
  } catch (e) { out.errors.push(`week: ${e.message}`); }
  try { const d = await tradeValues(env, true); out.tradeValues = d.week; } catch (e) { out.errors.push(`trade values: ${e.message}`); }
  return out;
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { return json({ error: e.message }, e.status || 500); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env).then((r) => console.log("scheduled", JSON.stringify(r))));
  },
};
