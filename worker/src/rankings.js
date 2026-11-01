// Justin Boone's weekly rankings, from the FantasyPros feed behind the widget in his Yahoo articles.
// 317 is Boone's FantasyPros expert id. This isn't an official API, so the app keeps Paste as a fallback.

export const EXPERT = "317";
const FP_URL = "https://partners.fantasypros.com/api/v1/consensus-rankings.php";

// Stored list keys. QB, K and DEF are identical in every scoring format; FLEX differs.
export const LIST_DEFS = {
  QB: { pos: "QB", scoring: "STD" },
  "FLEX:PPR": { pos: "FLX", scoring: "PPR" },
  "FLEX:HALF": { pos: "FLX", scoring: "HALF" },
  K: { pos: "K", scoring: "STD" },
  DEF: { pos: "DST", scoring: "STD" },
};
// The app's lists for a scoring choice, mapped to stored keys
export const appLists = (scoring) => ({ QB: "QB", FLEX: scoring === "HALF" ? "FLEX:HALF" : "FLEX:PPR", K: "K", DEF: "DEF" });

const TEAM_FIX = { JAC: "JAX", WSH: "WAS", LA: "LAR", OAK: "LV", SD: "LAC" };
const teamKey = (t) => (t ? TEAM_FIX[t] || t : t);

export async function fetchList(season, week, key) {
  const def = LIST_DEFS[key];
  const q = new URLSearchParams({ sport: "NFL", year: String(season), week: String(week), position: def.pos, scoring: def.scoring, experts: "show", type: "ST", filters: EXPERT, widget: "ST" });
  const r = await fetch(`${FP_URL}?${q}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`FantasyPros returned ${r.status}`);
  const d = await r.json();
  const who = (d.expert_names || {})[EXPERT];
  if (who && !/boone/i.test(who)) throw new Error(`FantasyPros expert ${EXPERT} is now "${who}", not Boone`);
  const players = (d.players || [])
    .map((p) => ({
      r: +(p.rank_ecr || (p.experts || {})[EXPERT]), // rank_ecr = the 1..N numbering Yahoo's widget shows
      n: p.player_name,
      t: teamKey(p.player_team_id),
      pos: def.pos === "FLX" ? (p.player_positions || "").split(",")[0] : undefined,
    }))
    .filter((p) => p.r && p.n)
    .sort((a, b) => a.r - b.r);
  const pubStr = (d.expert_pub || {})[EXPERT];
  const pub = pubStr ? Date.parse(pubStr.replace(" ", "T") + "Z") : (d.last_updated_ts || 0) * 1000;
  return { key, pub: players.length ? pub : 0, players };
}

// Current NFL season and week, as Sleeper shows them
export async function sleeperWeek() {
  const r = await fetch("https://api.sleeper.app/v1/state/nfl");
  if (!r.ok) throw new Error(`Sleeper returned ${r.status}`);
  const s = await r.json();
  return { season: +s.season, week: +(s.display_week || s.week) };
}
