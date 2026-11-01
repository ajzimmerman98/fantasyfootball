// FantasyCalc trade values (https://fantasycalc.com): crowd-sourced from real fantasy trades. Free public API, no key.
// Redraft values for a league format: ppr (0 | 0.5 | 1), number of QBs (1 | 2 for superflex), number of teams.

const URL_BASE = "https://api.fantasycalc.com/values/current";
const POS = new Set(["QB", "RB", "WR", "TE"]); // same positions as Boone's charts
const TEAMS = [8, 10, 12, 14, 16];

export function fcFormat(q) {
  const ppr = [0, 0.5, 1].includes(+q.ppr) ? +q.ppr : 1;
  const qbs = +q.qbs === 2 ? 2 : 1;
  const n = +q.teams || 12, teams = TEAMS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
  return { ppr, qbs, teams };
}

export function parseFC(arr) {
  if (!Array.isArray(arr)) throw new Error("FantasyCalc returned an unexpected format");
  const players = arr
    .map((x) => {
      const p = x.player || {};
      return { name: p.name, pos: p.position, team: p.maybeTeam || null, sid: p.sleeperId ? String(p.sleeperId) : null, raw: +x.value, rank: x.overallRank ?? null, posRank: x.positionRank ?? null, trend: x.trend30Day ?? null };
    })
    .filter((p) => p.name && POS.has(p.pos) && p.raw > 0)
    .sort((a, b) => b.raw - a.raw);
  if (!players.length) throw new Error("FantasyCalc returned no players");
  // FantasyCalc values run into the thousands; rescale so the top player is 100, close to Boone's chart scale
  const max = players[0].raw;
  for (const p of players) {
    p.value = Math.max(1, Math.round((p.raw / max) * 100));
    // trend30Day is in FantasyCalc's raw units: put it on the same 0-100 scale
    p.trend = typeof p.trend === "number" ? Math.round((p.trend / max) * 100) : null;
  }
  return players;
}

export async function loadFantasyCalc(fmt) {
  const q = new URLSearchParams({ isDynasty: "false", numQbs: String(fmt.qbs), numTeams: String(fmt.teams), ppr: String(fmt.ppr) });
  const r = await fetch(`${URL_BASE}?${q}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`FantasyCalc returned ${r.status}`);
  return { source: "fantasycalc", format: fmt, fetchedAt: new Date().toISOString(), players: parseFC(await r.json()) };
}
