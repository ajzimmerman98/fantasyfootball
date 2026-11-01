// D1 storage. Tables are created on first use, so there are no migrations to run.

const SCHEMA = [
  // People who have signed in (Cloudflare Access decides who may)
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen TEXT)`,
  `CREATE TABLE IF NOT EXISTS profiles (user_id INTEGER PRIMARY KEY, sleeper_username TEXT, settings TEXT, updated_at TEXT)`,
  // From the single-user version: one profile row, moved to the owner on their first sign-in
  `CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), sleeper_username TEXT, settings TEXT, updated_at TEXT)`,
  // Each saved version of a Boone list, keyed by its published time
  `CREATE TABLE IF NOT EXISTS rankings (season INTEGER NOT NULL, week INTEGER NOT NULL, list TEXT NOT NULL, pub INTEGER NOT NULL, fetched_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (season, week, list, pub))`,
  // Newest copy of each FantasyPros consensus, Sleeper projections and rest-of-season list: these change many times a week, so only the latest is kept
  `CREATE TABLE IF NOT EXISTS rankings_latest (source TEXT NOT NULL, kind TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, list TEXT NOT NULL, pub INTEGER NOT NULL, fetched_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (source, kind, season, week, list))`,
  `CREATE TABLE IF NOT EXISTS trade_values (season INTEGER NOT NULL, week INTEGER NOT NULL, pos TEXT NOT NULL, published TEXT, fetched_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (season, week, pos))`,
  `CREATE TABLE IF NOT EXISTS lineup_builds (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, season INTEGER, week INTEGER, league_id TEXT, league_name TEXT, scoring TEXT, rankings_pub INTEGER, source TEXT, result TEXT NOT NULL, user_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS lineup_builds_created ON lineup_builds (created_at)`,
];
// Run after lineup_builds has its user_id column (added to older databases in ensureSchema)
const SCHEMA_AFTER = [
  // One saved build per person, league, rankings source and scoring (the latest). Older rules: per league, then per league+source+scoring.
  `DROP INDEX IF EXISTS lineup_builds_league`,
  `DROP INDEX IF EXISTS lineup_builds_key`,
  `DELETE FROM lineup_builds WHERE league_id IS NOT NULL AND id NOT IN (SELECT MAX(id) FROM lineup_builds WHERE league_id IS NOT NULL GROUP BY IFNULL(user_id, -1), league_id, IFNULL(source, ''), IFNULL(scoring, ''))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lineup_builds_user_key ON lineup_builds (user_id, league_id, source, scoring)`,
];

let ready = null;
export function ensureSchema(db) {
  if (!ready) ready = (async () => {
    await db.batch(SCHEMA.map((s) => db.prepare(s)));
    const { results } = await db.prepare(`PRAGMA table_info(lineup_builds)`).all();
    if (!results.some((c) => c.name === "user_id")) await db.prepare(`ALTER TABLE lineup_builds ADD COLUMN user_id INTEGER`).run();
    await db.batch(SCHEMA_AFTER.map((s) => db.prepare(s)));
  })().catch((e) => { ready = null; throw e; });
  return ready;
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

// ---- Users ----
// Finds or creates the user for an email. The owner (OWNER_EMAIL) also takes over data saved before there were users.
export async function userFor(db, email, isOwner) {
  let u = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (u) await db.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`).bind(now(), u.id).run();
  else {
    await db.prepare(`INSERT OR IGNORE INTO users (email, created_at, last_seen) VALUES (?, ?, ?)`).bind(email, now(), now()).run();
    u = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  }
  if (isOwner) {
    await db.batch([
      db.prepare(`UPDATE lineup_builds SET user_id = ? WHERE user_id IS NULL`).bind(u.id),
      db.prepare(`INSERT OR IGNORE INTO profiles (user_id, sleeper_username, settings, updated_at) SELECT ?, sleeper_username, settings, updated_at FROM profile WHERE id = 1`).bind(u.id),
    ]);
  }
  return u.id;
}

// ---- Profile (one per user) ----
export async function getProfile(db, userId) {
  const row = await db.prepare(`SELECT sleeper_username, settings, updated_at FROM profiles WHERE user_id = ?`).bind(userId).first();
  return row ? { sleeperUsername: row.sleeper_username, settings: JSON.parse(row.settings || "{}"), updatedAt: row.updated_at } : { sleeperUsername: null, settings: {}, updatedAt: null };
}
export async function putProfile(db, userId, { sleeperUsername, settings }) {
  await db.prepare(`INSERT INTO profiles (user_id, sleeper_username, settings, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET sleeper_username = excluded.sleeper_username, settings = excluded.settings, updated_at = excluded.updated_at`)
    .bind(userId, sleeperUsername ?? null, JSON.stringify(settings || {}), now()).run();
  return getProfile(db, userId);
}

// ---- Saved lineup builds: the latest build per league, rankings source and scoring; building again with the same ones replaces it ----
export async function addBuilds(db, userId, builds) {
  const created = now();
  // source and scoring are part of the key, so they're never left NULL (NULLs never match in a unique index)
  const stmts = builds.filter((b) => b.leagueId).map((b) =>
    db.prepare(`INSERT INTO lineup_builds (user_id, created_at, season, week, league_id, league_name, scoring, rankings_pub, source, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, league_id, source, scoring) DO UPDATE SET created_at = excluded.created_at, season = excluded.season, week = excluded.week, league_name = excluded.league_name,
        rankings_pub = excluded.rankings_pub, result = excluded.result`)
      .bind(userId, created, b.season ?? null, b.week ?? null, String(b.leagueId), b.leagueName ?? null, String(b.scoring || "PPR"), b.rankingsPub ?? null, String(b.source || "pasted"), JSON.stringify(b.result ?? {})));
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}
// Each build comes back with the newest publish time of its rankings source for its week, so the app can tell whether it's expired
export async function listBuilds(db, userId, limit = 30) {
  const { results } = await db.prepare(`SELECT b.*, CASE WHEN b.source IN ('ecr', 'sleeper')
      THEN (SELECT MAX(pub) FROM rankings_latest r WHERE r.source = b.source AND r.kind = 'week' AND r.season = b.season AND r.week = b.week)
      ELSE (SELECT MAX(pub) FROM rankings r WHERE r.season = b.season AND r.week = b.week) END AS latest_pub
    FROM lineup_builds b WHERE b.user_id = ? ORDER BY b.league_name, b.created_at DESC LIMIT ?`).bind(userId, limit).all();
  return results.map((r) => ({
    id: r.id, createdAt: r.created_at, season: r.season, week: r.week, leagueId: r.league_id, leagueName: r.league_name,
    scoring: r.scoring, rankingsPub: r.rankings_pub, latestPub: r.latest_pub, source: r.source, result: JSON.parse(r.result),
  }));
}
export async function deleteBuild(db, userId, id) {
  const r = await db.prepare(`DELETE FROM lineup_builds WHERE id = ? AND user_id = ?`).bind(id, userId).run();
  return (r.meta?.changes || 0) > 0;
}
