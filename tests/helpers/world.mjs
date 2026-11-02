// A small, fixed football world for the tests: two Sleeper leagues, an NFL schedule, a forecast, and every outside feed
// (FantasyPros, Sleeper projections, FantasyCalc, ESPN) answered from tests/fixtures. Nothing touches the network.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { league as espnLeague } from "../fixtures/espn-league.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../..");
export const FIX = path.join(ROOT, "tests/fixtures");
const read = (f) => fs.readFileSync(path.join(FIX, f), "utf8");
export const fixtures = {
  tradeValues: read("trade-values.json"),
  fantasycalc: read("fantasycalc.json"),
  projections: read("sleeper-projections.json"),
  espnLeague,
};

export const SEASON = "2026", WEEK = 8;
const P = (n, pos, t, inj) => ({ full_name: n, first_name: n.split(" ")[0], last_name: n.split(" ").slice(1).join(" "), position: pos, team: t, active: true, injury_status: inj || null });
export const players = {
  "7": P("Josh Allen", "QB", "BUF"), "1": P("Bijan Robinson", "RB", "ATL"), "2": P("Breece Hall", "RB", "NYJ"),
  "3": P("Jameson Williams", "WR", "DET"), "4": P("DK Metcalf", "WR", "PIT"), "5": P("T.J. Hockenson", "TE", "MIN"),
  "6": P("Omar Cooper", "WR", "NYJ"), "8": P("Germie Bernard", "WR", "PIT"), "9": P("Drake Maye", "QB", "NE"),
  "20": P("Jaxon Smith-Njigba", "WR", "SEA"), "21": P("Kenneth Walker", "RB", "KC"), "22": P("Justin Jefferson", "WR", "MIN"),
  "23": P("Parker Washington", "WR", "JAX"), "24": P("Jalen Coker", "WR", "CAR"),
  "30": P("Ollie Gordon", "RB", "MIA"), "31": P("Tetairoa McMillan", "WR", "CAR"),
  MIN: { position: "DEF", team: "MIN", first_name: "Minnesota", last_name: "Vikings", active: true },
};
// L1 (PPR): my starters QB Allen, RB Bijan, RB Hall, WR Jameson (DET, in progress), WR Metcalf (PIT, final), TE Hockenson, FLEX Cooper;
// bench: Germie Bernard (PIT, final) and Drake Maye. L2 (half-PPR) is a second, smaller league.
export const leagues = [
  { league_id: "L1", name: "Sleeper League", roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN"], scoring_settings: { rec: 1 }, total_rosters: 2, settings: { playoff_week_start: 15, playoff_teams: 1 } },
  { league_id: "L2", name: "Half League", roster_positions: ["QB", "RB", "BN"], scoring_settings: { rec: 0.5 }, total_rosters: 2, settings: { playoff_week_start: 15 } },
];
const rosters = {
  L1: [{ roster_id: 1, owner_id: "U1", players: ["7", "1", "2", "3", "4", "5", "6", "8", "9"], starters: ["7", "1", "2", "3", "4", "5", "6"], settings: { wins: 4, losses: 3, fpts: 840, fpts_decimal: 50 } },
       { roster_id: 2, owner_id: "U2", players: ["20", "21", "22", "23", "24", "MIN"], starters: ["20", "21", "22", "23", "24"], settings: { wins: 3, losses: 4, fpts: 820 } }],
  L2: [{ roster_id: 1, owner_id: "U1", players: ["7", "1"], starters: ["7", "1"] }, { roster_id: 2, owner_id: "U2", players: ["9"], starters: ["9"] }],
};
const users = { L1: [{ user_id: "U1", display_name: "aj" }, { user_id: "U2", display_name: "rival", metadata: { team_name: "Rival FC" } }],
  L2: [{ user_id: "U1", display_name: "aj" }, { user_id: "U2", display_name: "rival" }] };
const matchups = {
  L1: [{ roster_id: 1, matchup_id: 1, points: 12.5, starters: rosters.L1[0].starters }, { roster_id: 2, matchup_id: 1, points: 8.1, starters: rosters.L1[1].starters }],
  L2: [{ roster_id: 1, matchup_id: 1, points: 0, starters: ["7", "1"] }, { roster_id: 2, matchup_id: 1, points: 0, starters: ["9"] }],
};

// League history for L1 this season: weeks 1-7 played, a draft, one trade (week 3) and two pickups
const pts = (id, w) => Math.round(((+id || 11) * 3.7 + w * 1.3) % 25 * 10) / 10 + 2;
function histWeek(w) {
  // Roster 1 starts Germie Bernard ("8") from week 2 (waiver pickup) and Drake Maye ("9") from week 3 (trade)
  const s1 = ["7", "1", "2", "3", "4", w >= 3 ? "9" : "5", w >= 2 ? "8" : "6"], s2 = ["20", "21", "22", "23", w < 3 ? "9" : "24"];
  const side = (rid, starters) => ({ roster_id: rid, matchup_id: 1, starters, starters_points: starters.map((id) => pts(id, w)),
    players_points: Object.fromEntries(starters.map((id) => [id, pts(id, w)])), points: starters.reduce((t, id) => t + pts(id, w), 0) });
  return [side(1, s1), side(2, s2)];
}
const draftPicks = [["7", 1], ["20", 2], ["21", 2], ["1", 1], ["2", 1], ["22", 2], ["23", 2], ["3", 1], ["4", 1], ["24", 2], ["9", 2], ["5", 1]].map(([pid, rid], k) => {
  const p = players[pid];
  return { round: Math.floor(k / 2) + 1, pick_no: k + 1, player_id: pid, roster_id: rid, picked_by: rid === 1 ? "U1" : "U2", is_keeper: null,
    metadata: { first_name: p.first_name, last_name: p.last_name, position: p.position } };
});
const transactions = {
  2: [{ type: "waiver", status: "complete", leg: 2, created: 2, roster_ids: [1], adds: { "8": 1 }, drops: { "6": 1 }, settings: { waiver_bid: 12 } }],
  3: [{ type: "trade", status: "complete", leg: 3, created: 3, roster_ids: [1, 2], adds: { "9": 1, "24": 2 }, drops: { "9": 2, "24": 1 },
        draft_picks: [{ season: "2027", round: 2, roster_id: 1, owner_id: 2, previous_owner_id: 1 }], waiver_budget: [] }],
  4: [{ type: "free_agent", status: "complete", leg: 4, created: 4, roster_ids: [2], adds: { "30": 2 }, drops: null }],
};

// Sleeper API (the browser calls it directly)
export function sleeper(pathname) {
  const p = pathname.replace(/^\/v1/, "");
  let m;
  if (p === "/state/nfl") return { season: SEASON, week: WEEK, display_week: WEEK, season_type: "regular" };
  if (p.startsWith("/user/") && p.includes("/leagues/")) return leagues;
  if (p.startsWith("/user/")) return { user_id: "U1" };
  if (p === "/players/nfl") return players;
  if (p === "/players/nfl/trending/add") return [{ player_id: "30", count: 12345 }, { player_id: "31", count: 800 }];
  if ((m = p.match(/^\/league\/(L\d)\/rosters$/))) return rosters[m[1]];
  if ((m = p.match(/^\/league\/(L\d)\/users$/))) return users[m[1]];
  if ((m = p.match(/^\/league\/(L\d)\/matchups\/(\d+)$/))) {
    const w = +m[2];
    if (w === WEEK) return matchups[m[1]];
    if (m[1] === "L1" && w < WEEK) return histWeek(w);
    // Rest of the regular season (weeks 9-14): the same two teams meet, nothing scored yet
    if (w > WEEK && w < 15) return matchups[m[1]].map((x) => ({ ...x, points: 0 }));
    return [];
  }
  if ((m = p.match(/^\/league\/(L\d)\/winners_bracket$/))) return [];
  if ((m = p.match(/^\/league\/(L\d)\/drafts$/))) return m[1] === "L1" ? [{ draft_id: "D1", status: "complete" }] : [];
  if (p === "/draft/D1/picks") return draftPicks;
  if ((m = p.match(/^\/league\/(L\d)\/transactions\/(\d+)$/))) return m[1] === "L1" ? transactions[+m[2]] || [] : [];
  if ((m = p.match(/^\/league\/(L\d)$/))) return { ...leagues.find((l) => l.league_id === m[1]), season: SEASON, status: "in_season", previous_league_id: null };
  return [];
}

// NFL schedule (ESPN scoreboard): not started, in progress and final games, one at a neutral site skipped
const sunday = Date.parse("2026-11-01T18:00:00Z");
const game = (away, home, state, at = sunday) => ({ id: away + home, date: new Date(at).toISOString(), status: { type: { state, shortDetail: state } },
  competitions: [{ date: new Date(at).toISOString(), neutralSite: false, venue: { fullName: home + " Stadium", address: {} },
    competitors: [{ homeAway: "home", team: { abbreviation: home } }, { homeAway: "away", team: { abbreviation: away } }] }] });
export const schedule = { events: [game("BUF", "MIA", "pre"), game("NYJ", "ATL", "pre"), game("MIN", "DET", "in"), game("CLE", "PIT", "post"),
  game("SEA", "KC", "pre"), game("JAX", "CAR", "pre"), game("NE", "LV", "pre")] };
// Open-Meteo: 22 mph wind for every outdoor game
export function forecast(url) {
  const u = new URL(url), start = Date.parse(u.searchParams.get("start_date") + "T00:00:00Z") / 1000, n = 48;
  const arr = (v) => Array(n).fill(v);
  return { hourly: { time: Array.from({ length: n }, (_, i) => start + i * 3600), temperature_2m: arr(61), apparent_temperature: arr(58), precipitation_probability: arr(10),
    rain: arr(0), showers: arr(0), snowfall: arr(0), wind_speed_10m: arr(22), wind_gusts_10m: arr(31), weather_code: arr(2) } };
}

// FantasyPros feed: the fixture for these query parameters
export function fantasyPros(url) {
  const q = new URL(url).searchParams, src = q.get("filters") === "317" ? "boone" : "ecr", kind = q.get("type") === "ROS" ? "ros" : "week";
  const f = `fp/${src}-${kind}-${q.get("position")}-${q.get("scoring")}.json`;
  return fs.existsSync(path.join(FIX, f)) ? read(f) : JSON.stringify({ players: [] });
}

// The Worker's own outgoing fetch (it runs inside the test process). state.fpDown simulates FantasyPros being down.
// state.pushes records notifications sent to push services; state.injuries adds injury statuses to Sleeper's projections.
export const state = { fpDown: false, calls: [], pushes: [], injuries: {} };
export async function workerFetch(input, init = {}) {
  const url = String(input instanceof Request ? input.url : input);
  state.calls.push(url);
  if (/^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com)\//.test(url)) {
    state.pushes.push({ url, headers: init.headers, body: init.body });
    return new Response("", { status: url.includes("/gone") ? 410 : 201 });
  }
  if (url.startsWith("https://site.api.espn.com/")) return new Response(JSON.stringify(schedule));
  if (url.startsWith("https://partners.fantasypros.com/")) return state.fpDown ? new Response("down", { status: 503 }) : new Response(fantasyPros(url));
  if (url.includes("api.sleeper.app/projections/nfl/")) {
    const rows = JSON.parse(fixtures.projections);
    for (const r of rows) if (state.injuries[r.player_id]) r.player = { ...r.player, injury_status: state.injuries[r.player_id] };
    return new Response(JSON.stringify(rows));
  }
  if (url.includes("api.sleeper.app/")) return new Response(JSON.stringify(sleeper(new URL(url).pathname)));
  if (url.startsWith("https://api.fantasycalc.com/")) return new Response(fixtures.fantasycalc);
  if (url.includes("fantasy.espn.com")) return new Response(JSON.stringify(espnLeague));
  throw new Error("Unexpected outgoing request in test: " + url);
}
