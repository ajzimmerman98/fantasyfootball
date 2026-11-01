// ESPN fantasy leagues, read with the owner's login cookies (ESPN_S2 and ESPN_SWID secrets).
// ESPN has no official public API; this is the API espn.com's own fantasy site uses.
// Leagues are converted to the same shape the app uses for Sleeper leagues.

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

// ESPN lineup slot ids -> Sleeper-style slot names (IDP and other slots are dropped)
const SLOT = { 0: "QB", 2: "RB", 3: "WRRB_FLEX", 4: "WR", 5: "REC_FLEX", 6: "TE", 7: "SUPER_FLEX", 16: "DEF", 17: "K", 23: "FLEX", 20: "BN", 21: "IR" };
const SLOT_ORDER = [0, 2, 4, 6, 3, 5, 23, 7, 17, 16]; // starting slots, in the order the app shows them
const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };
const PRO = { 0: null, 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU" };
const INJ = { QUESTIONABLE: "Questionable", DOUBTFUL: "Doubtful", OUT: "Out", INJURY_RESERVE: "IR", SUSPENSION: "Sus", DAY_TO_DAY: "Questionable" };
// D/ST "players" use negative ids tied to the team; give them the team code as id, like Sleeper
const pid = (p) => (POS[p.defaultPositionId] === "DEF" && PRO[p.proTeamId] ? `espn:DEF:${PRO[p.proTeamId]}` : `espn:${p.id}`);
const swidNorm = (s) => String(s || "").replace(/[{}]/g, "").toUpperCase();

export function normalizeLeague(d, swid) {
  const st = d.settings || {}, counts = st.rosterSettings?.lineupSlotCounts || {};
  const rosterPositions = [];
  for (const id of SLOT_ORDER) for (let i = 0; i < (+counts[id] || 0); i++) rosterPositions.push(SLOT[id]);
  for (let i = 0; i < (+counts[20] || 0); i++) rosterPositions.push("BN");
  const rec = (st.scoringSettings?.scoringItems || []).find((s) => s.statId === 53)?.points ?? 0;
  const members = Object.fromEntries((d.members || []).map((m) => [m.id, m]));
  const me = swidNorm(swid), players = {};
  const teams = (d.teams || []).map((t) => {
    const owners = t.owners || (t.primaryOwner ? [t.primaryOwner] : []);
    const ids = [], starters = [], reserve = [];
    const entries = (t.roster?.entries || []).map((e) => {
      const p = e.playerPoolEntry?.player || {}, pos = POS[p.defaultPositionId];
      if (!pos) return null; // IDP, unknown
      const id = pid(p);
      players[id] = { n: pos === "DEF" ? `${p.firstName || ""} ${p.lastName || ""}`.replace(/\s*D\/ST\s*$/i, "").trim() + " D/ST" : p.fullName, f: p.firstName, l: pos === "DEF" ? (p.lastName || "").replace(/\s*D\/ST\s*$/i, "") : p.lastName, p: pos, t: PRO[p.proTeamId] || null, i: INJ[e.injuryStatus || p.injuryStatus] || null };
      ids.push(id);
      return { id, slot: e.lineupSlotId };
    }).filter(Boolean);
    for (const sid of SLOT_ORDER) for (const e of entries) if (e.slot === sid) starters.push(e.id);
    for (const e of entries) if (e.slot === 21) reserve.push(e.id);
    const owner = members[owners[0]];
    return {
      roster_id: t.id,
      owner_id: `espn:${owners[0] || t.id}`,
      mine: owners.some((o) => swidNorm(o) === me),
      team_name: t.name || [t.location, t.nickname].filter(Boolean).join(" ") || t.abbrev || `Team ${t.id}`,
      owner_name: owner ? owner.displayName || `${owner.firstName || ""} ${owner.lastName || ""}`.trim() : null,
      players: ids, starters, reserve,
    };
  });
  return {
    league_id: `espn:${d.id}`, provider: "espn", name: st.name || `ESPN league ${d.id}`, season: d.seasonId,
    week: d.scoringPeriodId || d.status?.currentMatchupPeriod || null,
    roster_positions: rosterPositions, scoring_settings: { rec }, teams, players,
  };
}

export async function fetchLeague(season, leagueId, env) {
  const url = `${BASE}/${season}/segments/0/leagues/${encodeURIComponent(leagueId)}?view=mSettings&view=mTeam&view=mRoster`;
  const swid = env.ESPN_SWID ? `{${swidNorm(env.ESPN_SWID)}}` : "";
  const cookie = [env.ESPN_S2 && `espn_s2=${env.ESPN_S2}`, swid && `SWID=${swid}`].filter(Boolean).join("; ");
  const r = await fetch(url, { headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) } });
  if (r.status === 401 || r.status === 403)
    throw new Error(env.ESPN_S2 && env.ESPN_SWID ? "ESPN rejected the login cookies (they may have expired, or this account isn't in the league)." : "This league is private: set the ESPN_S2 and ESPN_SWID secrets on the Worker.");
  if (r.status === 404) throw new Error("ESPN league not found for this season.");
  if (!r.ok) throw new Error(`ESPN returned ${r.status}`);
  return normalizeLeague(await r.json(), env.ESPN_SWID);
}
