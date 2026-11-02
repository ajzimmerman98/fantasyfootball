// Sleeper's weekly projections (the API sleeper.com's own app uses; not officially documented).
// Turned into the same QB / FLEX / K / DEF lists as the FantasyPros sources, ranked by projected points.

const URL_BASE = "https://api.sleeper.app/projections/nfl";
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
// Points field per list: receptions only matter for FLEX
const PTS = { QB: "pts_std", "FLEX:PPR": "pts_ppr", "FLEX:HALF": "pts_half_ppr", K: "pts_std", DEF: "pts_std" };
const ofList = { QB: ["QB"], "FLEX:PPR": ["RB", "WR", "TE"], "FLEX:HALF": ["RB", "WR", "TE"], K: ["K"], DEF: ["DEF"] };

const memo = new Map(); // "season|week" -> { ts, p: Promise<{ ts, rows }> }; the promise is shared so parallel list requests fetch once
function projections(season, week) {
  const k = `${season}|${week}`, m = memo.get(k);
  if (m && Date.now() - m.ts < 10 * 60e3) return m.p;
  const p = (async () => {
    const q = new URLSearchParams({ season_type: "regular", order_by: "pts_ppr" });
    for (const pos of POSITIONS) q.append("position[]", pos);
    const r = await fetch(`${URL_BASE}/${season}/${week}?${q}`, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`Sleeper projections returned ${r.status}`);
    const d = await r.json();
    if (!Array.isArray(d)) throw new Error("Sleeper projections returned an unexpected format");
    return { ts: Date.now(), rows: d };
  })();
  memo.set(k, { ts: Date.now(), p });
  p.catch(() => memo.delete(k));
  return p;
}

export function sleeperList(rows, key, fetchedAt = Date.now()) {
  const want = ofList[key], field = PTS[key];
  let pub = 0;
  const players = rows
    .map((x) => {
      const p = x.player || {}, pos = p.position || (p.fantasy_positions || [])[0];
      const pts = +(x.stats || {})[field];
      pub = Math.max(pub, +x.last_modified || +x.updated_at || 0);
      const n = pos === "DEF" ? `${p.first_name || ""} ${p.last_name || ""}`.trim() : `${p.first_name || ""} ${p.last_name || ""}`.trim();
      return { n, t: x.team || p.team || (pos === "DEF" ? x.player_id : null), pos, pts };
    })
    .filter((p) => p.n && want.includes(p.pos) && p.pts > 0)
    .sort((a, b) => b.pts - a.pts)
    .map((p, i) => ({ r: i + 1, n: p.n, t: p.t, ...(key.startsWith("FLEX") ? { pos: p.pos } : {}), pts: Math.round(p.pts * 10) / 10 }));
  // Projections are revised all week; the newest revision time, or when they were fetched
  return { key, source: "sleeper", kind: "week", pub: players.length ? pub || fetchedAt : 0, players };
}

export async function fetchSleeperList(season, week, key) {
  const { ts, rows } = await projections(season, week);
  return sleeperList(rows, key, ts);
}

// Player id -> { name, team, inj, pos, pts: { PPR, HALF, STD } } from this week's projections (they carry each player's team and injury status)
export async function sleeperPlayers(season, week) {
  const { rows } = await projections(season, week), out = {};
  for (const x of rows) {
    const p = x.player || {}, pos = p.position || (p.fantasy_positions || [])[0], name = `${p.first_name || ""} ${p.last_name || ""}`.trim();
    const st = x.stats || {};
    out[x.player_id] = { name: pos === "DEF" ? `${name} D/ST` : name || x.player_id, team: x.team || p.team || (pos === "DEF" ? x.player_id : null), inj: p.injury_status || null, pos,
      pts: { PPR: +st.pts_ppr || 0, HALF: +st.pts_half_ppr || 0, STD: +st.pts_std || 0 } };
  }
  return out;
}
