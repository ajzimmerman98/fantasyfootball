// D1 storage. Tables are created on first use, so there are no migrations to run.

const SCHEMA = [
  // Single-user app: one profile row
  `CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), sleeper_username TEXT, settings TEXT, updated_at TEXT)`,
  // Each saved version of a Boone list, keyed by its published time
  `CREATE TABLE IF NOT EXISTS rankings (season INTEGER NOT NULL, week INTEGER NOT NULL, list TEXT NOT NULL, pub INTEGER NOT NULL, fetched_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (season, week, list, pub))`,
  // Newest copy of each FantasyPros consensus, Sleeper projections and rest-of-season list: these change many times a week, so only the latest is kept
  `CREATE TABLE IF NOT EXISTS rankings_latest (source TEXT NOT NULL, kind TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, list TEXT NOT NULL, pub INTEGER NOT NULL, fetched_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (source, kind, season, week, list))`,
  `CREATE TABLE IF NOT EXISTS trade_values (season INTEGER NOT NULL, week INTEGER NOT NULL, pos TEXT NOT NULL, published TEXT, fetched_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (season, week, pos))`,
  `CREATE TABLE IF NOT EXISTS lineup_builds (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, season INTEGER, week INTEGER, league_id TEXT, league_name TEXT, scoring TEXT, rankings_pub INTEGER, source TEXT, result TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS lineup_builds_created ON lineup_builds (created_at)`,
  // One saved build per league, rankings source and scoring (the latest). Older rule was one per league.
  `DROP INDEX IF EXISTS lineup_builds_league`,
  `DELETE FROM lineup_builds WHERE league_id IS NOT NULL AND id NOT IN (SELECT MAX(id) FROM lineup_builds WHERE league_id IS NOT NULL GROUP BY league_id, IFNULL(source, ''), IFNULL(scoring, ''))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lineup_builds_key ON lineup_builds (league_id, source, scoring)`,
];

// Set up once per database binding (there's one in production; tests use several)
const ready = new WeakMap();
export function ensureSchema(db) {
  if (!ready.has(db)) ready.set(db, db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { ready.delete(db); throw e; }));
  return ready.get(db);
}

const now = () => new Date().toISOString();

// ---- Rankings history ----
export async function saveRankings(db, season, week, list) {
  if (!list.players.length || !list.pub) return false;
  const r = await db.prepare(`INSERT OR IGNORE INTO rankings (season, week, list, pub, fetched_at, data) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(season, week, list.key, list.pub, now(), JSON.stringify(list.players)).run();
  return (r.meta?.changes || 0) > 0;
}
export async function latestRankings(db, season, week, keys) {
  const out = {};
  for (const key of keys) {
    const row = await db.prepare(`SELECT pub, data FROM rankings WHERE season = ? AND week = ? AND list = ? ORDER BY pub DESC LIMIT 1`).bind(season, week, key).first();
    if (row) out[key] = { key, pub: row.pub, players: JSON.parse(row.data) };
  }
  return out;
}
export async function latestPub(db, season, week) {
  const row = await db.prepare(`SELECT MAX(pub) AS pub FROM rankings WHERE season = ? AND week = ?`).bind(season, week).first();
  return row?.pub || 0;
}

// ---- Latest copy of other sources' lists (week = 0 for rest of season) ----
export async function saveLatest(db, season, week, list) {
  if (!list.players.length || !list.pub) return false;
  await db.prepare(`INSERT INTO rankings_latest (source, kind, season, week, list, pub, fetched_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, kind, season, week, list) DO UPDATE SET pub = excluded.pub, fetched_at = excluded.fetched_at, data = excluded.data`)
    .bind(list.source, list.kind, season, week, list.key, list.pub, now(), JSON.stringify(list.players)).run();
  return true;
}
export async function getLatest(db, source, kind, season, week, key) {
  const row = await db.prepare(`SELECT pub, data FROM rankings_latest WHERE source = ? AND kind = ? AND season = ? AND week = ? AND list = ?`).bind(source, kind, season, week, key).first();
  return row ? { key, pub: row.pub, players: JSON.parse(row.data) } : null;
}

// ---- Trade value history (one copy per position per week) ----
export async function saveTradeValues(db, data) {
  const stmts = Object.entries(data.charts || {}).map(([pos, c]) =>
    db.prepare(`INSERT OR IGNORE INTO trade_values (season, week, pos, published, fetched_at, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(c.season, c.week, pos, c.published, now(), JSON.stringify({ columns: c.columns, players: c.players, url: c.url })));
  if (stmts.length) await db.batch(stmts);
}

// Each position's newest saved chart from before this week (for week-over-week trends): { pos: { week, players } }
export async function prevTradeValues(db, season, week) {
  const { results } = await db.prepare(`SELECT pos, week, data FROM trade_values WHERE season = ? AND week < ? ORDER BY week DESC`).bind(season, week).all();
  const out = {};
  for (const r of results) if (!out[r.pos]) out[r.pos] = { week: r.week, players: JSON.parse(r.data).players || [] };
  return out;
}

// ---- Profile ----
export async function getProfile(db) {
  const row = await db.prepare(`SELECT sleeper_username, settings, updated_at FROM profile WHERE id = 1`).first();
  return row ? { sleeperUsername: row.sleeper_username, settings: JSON.parse(row.settings || "{}"), updatedAt: row.updated_at } : { sleeperUsername: null, settings: {}, updatedAt: null };
}
export async function putProfile(db, { sleeperUsername, settings }) {
  await db.prepare(`INSERT INTO profile (id, sleeper_username, settings, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET sleeper_username = excluded.sleeper_username, settings = excluded.settings, updated_at = excluded.updated_at`)
    .bind(sleeperUsername ?? null, JSON.stringify(settings || {}), now()).run();
  return getProfile(db);
}

// ---- Saved lineup builds: the latest build per league, rankings source and scoring; building again with the same ones replaces it ----
export async function addBuilds(db, builds) {
  const created = now();
  // source and scoring are part of the key, so they're never left NULL (NULLs never match in a unique index)
  const stmts = builds.filter((b) => b.leagueId).map((b) =>
    db.prepare(`INSERT INTO lineup_builds (created_at, season, week, league_id, league_name, scoring, rankings_pub, source, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(league_id, source, scoring) DO UPDATE SET created_at = excluded.created_at, season = excluded.season, week = excluded.week, league_name = excluded.league_name,
        rankings_pub = excluded.rankings_pub, result = excluded.result`)
      .bind(created, b.season ?? null, b.week ?? null, String(b.leagueId), b.leagueName ?? null, String(b.scoring || "PPR"), b.rankingsPub ?? null, String(b.source || "pasted"), JSON.stringify(b.result ?? {})));
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}
// Each build comes back with the newest publish time of its rankings source for its week, so the app can tell whether it's expired
export async function listBuilds(db, limit = 30) {
  // Only the lists a build used count: QB, K, DEF and the FLEX list for its scoring
  const { results } = await db.prepare(`SELECT b.*, CASE WHEN b.source IN ('ecr', 'sleeper')
      THEN (SELECT MAX(pub) FROM rankings_latest r WHERE r.source = b.source AND r.kind = 'week' AND r.season = b.season AND r.week = b.week AND r.list IN ('QB', 'K', 'DEF', 'FLEX:' || b.scoring))
      ELSE (SELECT MAX(pub) FROM rankings r WHERE r.season = b.season AND r.week = b.week AND r.list IN ('QB', 'K', 'DEF', 'FLEX:' || b.scoring)) END AS latest_pub
    FROM lineup_builds b ORDER BY b.league_name, b.created_at DESC LIMIT ?`).bind(limit).all();
  return results.map((r) => ({
    id: r.id, createdAt: r.created_at, season: r.season, week: r.week, leagueId: r.league_id, leagueName: r.league_name,
    scoring: r.scoring, rankingsPub: r.rankings_pub, latestPub: r.latest_pub, source: r.source, result: JSON.parse(r.result),
  }));
}
export async function deleteBuild(db, id) {
  const r = await db.prepare(`DELETE FROM lineup_builds WHERE id = ?`).bind(id).run();
  return (r.meta?.changes || 0) > 0;
}
