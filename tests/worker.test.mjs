// Worker: rankings feeds, feed-health fallback, FantasyCalc, ESPN conversion, database rules, sign-in, scheduled job.
import test from "node:test";
import assert from "node:assert/strict";
import { newEnv, callWorker, workerModule } from "./helpers/app.mjs";
import { state, fixtures } from "./helpers/world.mjs";
import { makeD1 } from "./helpers/d1mock.mjs";
import * as db from "../worker/src/db.js";
import { parseFC, fcFormat } from "../worker/src/fantasycalc.js";
import { normalizeLeague } from "../worker/src/espn.js";
import { sleeperList } from "../worker/src/sleeper.js";

const W = "https://w.test";
const get = async (p, env, init) => { const r = await callWorker(W + p, env, init); return { status: r.status, body: await r.json() }; };

test("rankings: Justin Boone, FantasyPros (week and rest of season), Sleeper projections", async () => {
  const env = newEnv();
  const boone = await get("/rankings?season=2026&week=8&scoring=PPR", env);
  assert.equal(boone.status, 200);
  assert.deepEqual(Object.keys(boone.body.lists).sort(), ["DEF", "FLEX", "K", "QB"]);
  assert.equal(boone.body.lists.QB.players[0].r, 1);
  assert.ok(boone.body.lists.FLEX.players.every((p) => ["RB", "WR", "TE"].includes(p.pos)));
  assert.ok(boone.body.lists.FLEX.pub > 0);
  const ecr = await get("/rankings?season=2026&week=8&scoring=HALF&source=ecr", env);
  assert.ok(ecr.body.lists.FLEX.players.length >= 100);
  const ros = await get("/rankings?season=2026&week=8&scoring=PPR&source=ecr&kind=ros", env);
  assert.ok(ros.body.lists.QB.players.length > 10);
  const sl = await get("/rankings?season=2026&week=8&scoring=HALF&source=sleeper", env);
  assert.equal(sl.body.lists.QB.players[0].n, "Josh Allen");
  assert.ok(sl.body.lists.FLEX.players.every((p, i, a) => i === 0 || a[i - 1].pts >= p.pts), "ranked by projected points");
  assert.equal((await get("/rankings?source=boone&kind=ros", env)).status, 400);
  assert.equal((await get("/rankings?source=nope", env)).status, 400);
});

test("feed health: when FantasyPros fails, the saved copy is served and the error is reported", async () => {
  const env = newEnv();
  await get("/rankings?season=2026&week=8&scoring=PPR&source=ecr", env); // saves a copy
  state.fpDown = true;
  try {
    const r = await get("/rankings?season=2026&week=8&scoring=PPR&source=ecr", env);
    assert.equal(r.status, 200);
    assert.equal(r.body.lists.QB.source, "saved");
    assert.ok(r.body.errors.length > 0);
    assert.match(r.body.errors[0], /503/);
  } finally { state.fpDown = false; }
});

test("Sleeper projections: one fetch shared by all lists; zero-point players dropped", async () => {
  const rows = JSON.parse(fixtures.projections);
  const flex = sleeperList(rows, "FLEX:PPR");
  assert.ok(flex.players.length > 0 && flex.players.every((p) => p.pts > 0 && p.pos));
  const def = sleeperList(rows, "DEF");
  assert.equal(def.players[0].t, "JAX");
  const before = state.calls.length;
  await get("/rankings?season=2026&week=9&scoring=PPR&source=sleeper", newEnv());
  assert.equal(state.calls.slice(before).filter((u) => u.includes("/projections/")).length, 1);
});

test("FantasyCalc: values and 30-day trend rescaled to a top player of 100; format clamped", () => {
  const players = parseFC(JSON.parse(fixtures.fantasycalc));
  assert.equal(players[0].value, 100);
  assert.ok(players.every((p) => ["QB", "RB", "WR", "TE"].includes(p.pos)));
  assert.ok(players.some((p) => p.trend > 0) && players.some((p) => p.trend < 0));
  assert.deepEqual(fcFormat({ ppr: "0.5", qbs: "2", teams: "11" }), { ppr: 0.5, qbs: 2, teams: 10 });
  assert.deepEqual(fcFormat({}), { ppr: 1, qbs: 1, teams: 12 });
});

test("ESPN league converts to the app's league shape and finds my team", () => {
  const L = normalizeLeague(fixtures.espnLeague, "ABCD-1234");
  assert.equal(L.league_id, "espn:1126044");
  assert.ok(L.teams.some((t) => t.mine));
  assert.ok(L.roster_positions.includes("QB"));
  assert.ok(Object.values(L.players).some((p) => p.p === "DEF" && p.n.endsWith("D/ST")));
});

test("private endpoints need the access code; ESPN leagues load for the owner", async () => {
  const env = newEnv();
  assert.equal((await get("/me/profile", env)).status, 401);
  const auth = { headers: { Authorization: "Bearer s3cret", "Content-Type": "application/json" } };
  const put = await get("/me/profile", env, { ...auth, method: "PUT", body: JSON.stringify({ sleeperUsername: "aj", settings: { espnLeagues: ["1126044"] } }) });
  assert.equal(put.body.sleeperUsername, "aj");
  const espn = await get("/me/espn?season=2026", env, auth);
  assert.equal(espn.body.leagues.length, 1);
});

test("saved lineups: one per league, source and scoring; older databases are upgraded", async () => {
  const d1 = makeD1();
  d1._db.exec(`CREATE TABLE lineup_builds (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, season INTEGER, week INTEGER, league_id TEXT, league_name TEXT, scoring TEXT, rankings_pub INTEGER, source TEXT, result TEXT NOT NULL);
    CREATE UNIQUE INDEX lineup_builds_league ON lineup_builds (league_id);
    INSERT INTO lineup_builds (created_at, league_id, scoring, source, result) VALUES ('2026-10-30', 'L1', 'PPR', 'boone', '{}');`);
  await db.ensureSchema(d1);
  const b = (source, scoring, result) => ({ leagueId: "L1", leagueName: "One", season: 2026, week: 8, scoring, source, result });
  await db.addBuilds(d1, [b("ecr", "PPR", { a: 1 }), b("boone", "PPR", { a: 2 })]);
  await db.addBuilds(d1, [b("boone", "PPR", { a: 3 })]);
  const rows = await db.listBuilds(d1, 60);
  assert.deepEqual(rows.map((r) => `${r.source}/${r.scoring}`).sort(), ["boone/PPR", "ecr/PPR"]);
  assert.deepEqual(rows.find((r) => r.source === "boone").result, { a: 3 });
});

test("trade values: previous week's charts come back for trends", async () => {
  const d1 = makeD1();
  await db.ensureSchema(d1);
  const tv = JSON.parse(fixtures.tradeValues), chart = (week) => Object.fromEntries(Object.entries(tv.charts).map(([pos, c]) => [pos, { ...c, season: 2026, week }]));
  await db.saveTradeValues(d1, { charts: chart(6) });
  await db.saveTradeValues(d1, { charts: chart(7) });
  await db.saveTradeValues(d1, { charts: chart(8) });
  const prev = await db.prevTradeValues(d1, 2026, 8);
  assert.equal(prev.RB.week, 7);
  assert.ok(prev.RB.players.length > 10);
});

test("scheduled job saves every source's weekly rankings without errors", async () => {
  const out = await workerModule.scheduled({ DB: makeD1() }).catch((e) => ({ errors: [e.message] }));
  const ranked = Object.keys(out.rankings || {});
  for (const s of ["boone", "ecr", "sleeper"]) assert.ok(ranked.some((k) => k.startsWith(s + ":")), s);
  assert.ok(!out.errors.some((e) => /rankings|boone|ecr|sleeper/i.test(e) && !/trade/i.test(e)), out.errors.join("; "));
});

test("trade values: charts missing from the author page are found through links in the other articles", async () => {
  const { loadTradeValues } = await import("../worker/src/tradevalues.js");
  const slug = (pos, id) => `/fantasy/article/2026-trade-value-charts--justin-boones-fantasy-football-${pos}-breakdown-for-week-8-${id}.html`;
  const table = (cols) => `<table><tr><th>Rk</th><th>Player</th>${cols.map((c) => `<th>${c}</th>`).join("")}</tr><tr><td>1</td><td>Star Player</td>${cols.map(() => "<td>50</td>").join("")}</tr></table>`;
  // Yahoo now lists only the QB article on the author page; the QB article links to the RB, WR and TE ones
  const pages = {
    "https://sports.yahoo.com/author/justin-boone/": `<a href="${slug("quarterback", 1)}">QB</a>`,
    ["https://sports.yahoo.com" + slug("quarterback", 1)]: table(["1QB", "2QB"]) + ["running-back", "wide-receiver", "tight-end"].map((p, i) => `<a href="${slug(p, i + 2)}">x</a>`).join(""),
    ["https://sports.yahoo.com" + slug("running-back", 2)]: table(["HALF", "PPR"]),
    ["https://sports.yahoo.com" + slug("wide-receiver", 3)]: table(["HALF", "PPR"]),
    ["https://sports.yahoo.com" + slug("tight-end", 4)]: table(["HALF", "PPR"]),
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => (pages[String(u)] ? new Response(pages[String(u)]) : new Response("", { status: 404 }));
  try {
    const d = await loadTradeValues();
    assert.deepEqual(Object.keys(d.charts).sort(), ["QB", "RB", "TE", "WR"]);
    assert.deepEqual(d.errors, []);
  } finally { globalThis.fetch = real; }
});

test("FantasyCalc: this week's copy is saved and last week's comes back for trends", async () => {
  const env = newEnv();
  await db.ensureSchema(env.DB);
  // Last week's copy (week 7, the world is in week 8) for this format, with every value 5 lower
  const players = parseFC(JSON.parse(fixtures.fantasycalc)).map((p) => ({ ...p, value: p.value - 5 }));
  await db.saveFcWeek(env.DB, 2026, 7, "1|1|12", players);
  const r = await get("/trade-values/fantasycalc?ppr=1&qbs=1&teams=12", env);
  assert.equal(r.body.prev.week, 7);
  assert.equal(r.body.prev.players[0].value, r.body.players[0].value - 5);
  assert.ok(env.DB._db.prepare("SELECT 1 FROM fc_history WHERE season = 2026 AND week = 8 AND fmt = '1|1|12'").get(), "this week's copy saved");
});

test("trimming keeps what the app uses and drops the rest", async () => {
  const d1 = makeD1();
  await db.ensureSchema(d1);
  const ins = (sql, ...a) => d1._db.prepare(sql).run(...a);
  for (const [season, week, pub] of [[2025, 10, 1], [2026, 5, 1], [2026, 5, 2], [2026, 7, 1], [2026, 7, 2], [2026, 8, 1], [2026, 8, 2]])
    ins(`INSERT INTO rankings (season, week, list, pub, fetched_at, data) VALUES (?, ?, 'QB', ?, 'x', '[]')`, season, week, pub);
  for (const [season, week] of [[2025, 3], [2026, 3], [2026, 7]]) ins(`INSERT INTO rankings_latest (source, kind, season, week, list, pub, fetched_at, data) VALUES ('ecr', 'week', ?, ?, 'QB', 1, 'x', '[]')`, season, week);
  ins(`INSERT INTO rankings_latest (source, kind, season, week, list, pub, fetched_at, data) VALUES ('ecr', 'ros', 2026, 0, 'QB', 1, 'x', '[]')`);
  for (const w of [3, 4, 5, 6, 7, 8]) ins(`INSERT INTO fc_history (season, week, fmt, fetched_at, data) VALUES (2026, ?, '1|1|12', 'x', '[]')`, w);
  ins(`INSERT INTO trade_values (season, week, pos, fetched_at, data) VALUES (2025, 17, 'QB', 'x', '{}'), (2026, 7, 'QB', 'x', '{}')`);
  ins(`INSERT INTO push_sent (endpoint, key, sent_at) VALUES ('e', 'old', '2026-09-01T00:00:00Z'), ('e', 'new', '2026-11-01T00:00:00Z')`);
  ins(`INSERT INTO lineup_builds (created_at, season, week, league_id, scoring, source, result) VALUES ('x', 2025, 9, 'L0', 'PPR', 'boone', '{}'), ('x', 2026, 8, 'L1', 'PPR', 'boone', '{}')`);
  const removed = await db.trim(d1, 2026, 8, Date.parse("2026-11-02T00:00:00Z"));
  const rows = (sql) => d1._db.prepare(sql).all().map((r) => Object.values(r).join("/"));
  // Boone: last season gone; week 5 keeps only its newest version; weeks 7 and 8 keep every version (Expired badges)
  assert.deepEqual(rows("SELECT season, week, pub FROM rankings ORDER BY season, week, pub"), ["2026/5/2", "2026/7/1", "2026/7/2", "2026/8/1", "2026/8/2"]);
  assert.deepEqual(rows("SELECT season, week, kind FROM rankings_latest ORDER BY week"), ["2026/0/ros", "2026/7/week"]);
  assert.deepEqual(rows("SELECT week FROM fc_history ORDER BY week"), ["5", "6", "7", "8"]);
  assert.deepEqual(rows("SELECT season FROM trade_values"), ["2026"]);
  assert.deepEqual(rows("SELECT key FROM push_sent"), ["new"]);
  assert.deepEqual(rows("SELECT season FROM lineup_builds"), ["2026"]);
  assert.equal(removed.rankings, 2);
});
