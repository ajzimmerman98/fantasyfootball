// Rankings from the FantasyPros feed behind the widget in Boone's Yahoo articles. Not an official API, so the app keeps Paste as a fallback.
// Sources: "boone" = Justin Boone only (FantasyPros expert 317); "ecr" = FantasyPros expert consensus (no expert filter).
//          "sleeper" = Sleeper's weekly projections, ranked by projected points (see sleeper.js).
// Kinds: "week" = this week's rankings; "ros" = rest of season (consensus only; Boone has no rest-of-season list there).

import { fetchSleeperList } from "./sleeper.js";

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

export const SOURCES = ["boone", "ecr", "sleeper"];
export const KINDS = ["week", "ros"];

export async function fetchList(season, week, key, source = "boone", kind = "week") {
  if (source === "sleeper") {
    if (kind !== "week") throw new Error("Sleeper projections are weekly only");
    return fetchSleeperList(season, week, key);
  }
  const def = LIST_DEFS[key], boone = source === "boone";
  if (boone && kind !== "week") throw new Error("Boone only has weekly rankings on FantasyPros");
  const q = new URLSearchParams({ sport: "NFL", year: String(season), week: kind === "ros" ? "0" : String(week), position: def.pos, scoring: def.scoring, type: kind === "ros" ? "ROS" : "ST" });
  if (boone) { q.set("experts", "show"); q.set("filters", EXPERT); q.set("widget", "ST"); }
  const r = await fetch(`${FP_URL}?${q}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`FantasyPros returned ${r.status}`);
  const d = await r.json();
  const who = (d.expert_names || {})[EXPERT];
  if (boone && who && !/boone/i.test(who)) throw new Error(`FantasyPros expert ${EXPERT} is now "${who}", not Boone`);
  const players = (d.players || [])
    .map((p) => {
      const o = { r: +(p.rank_ecr || (boone && (p.experts || {})[EXPERT])), n: p.player_name, t: teamKey(p.player_team_id) }; // rank_ecr = the 1..N numbering Yahoo's widget shows
      if (def.pos === "FLX") o.pos = (p.player_positions || "").split(",")[0];
      if (typeof p.player_owned_avg === "number") o.o = Math.round(p.player_owned_avg); // % of leagues (Yahoo, ESPN, ...) where he's rostered
      return o;
    })
    .filter((p) => p.r && p.n)
    .sort((a, b) => a.r - b.r);
  const pubStr = boone && (d.expert_pub || {})[EXPERT];
  const pub = pubStr ? Date.parse(pubStr.replace(" ", "T") + "Z") : (d.last_updated_ts || 0) * 1000;
  return { key, source, kind, pub: players.length ? pub : 0, players };
}

// Current NFL season and week, as Sleeper shows them
export async function sleeperWeek() {
  const r = await fetch("https://api.sleeper.app/v1/state/nfl");
  if (!r.ok) throw new Error(`Sleeper returned ${r.status}`);
  const s = await r.json();
  return { season: +s.season, week: +(s.display_week || s.week) };
}
