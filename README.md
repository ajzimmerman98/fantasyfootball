# Boone Lineups

A fantasy football helper for Sleeper (and ESPN) leagues: start/sit lineups from Justin Boone's, FantasyPros' or Sleeper's
rankings, free agents, weather, trades, power rankings with playoff odds, league history, and phone reminders.

Live at https://ajzimmerman98.github.io/fantasyfootball/ (GitHub Pages; installable to the home screen).

## Where things live

| Path | What |
|---|---|
| `index.html` | The page: tabs and their controls |
| `css/app.css` | Styles (light and dark) |
| `js/core.js` | Shared basics: helpers, rankings-list parsing, player matching, loading Sleeper and ESPN data |
| `js/lineup.js` | Lineup tab: best lineup, cards with points, matchup preview, kickoff, weather and locks |
| `js/values.js`, `js/trades.js` | Trade values (Justin Boone, FantasyCalc; Dynasty Daddy or KeepTradeCut for dynasty leagues) and the Trades tab with trade ideas |
| `js/rankings.js` | Loading rankings from each source, with feed-health warnings |
| `js/freeagents.js`, `js/weather.js`, `js/power.js`, `js/history.js` | The other tabs (Power Rankings includes playoff odds) |
| `js/sync.js`, `js/reminders.js` | Owner sync (saved lineups) and the Reminders card |
| `js/app.js` | Install as an app, tabs, automatic loading, start-up |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app: offline start, notifications |
| `worker/` | Cloudflare Worker: rankings and trade value feeds, database, reminders (see `worker/README.md`) |
| `tests/` | `npm test`: Worker and in-browser app tests on a fixed test world (see `tests/README.md`) |

The scripts are plain (non-module) scripts loaded in order by `index.html` and share one global scope, so the app also
runs straight from the file system.

## Test and live

There are two copies of the app, each with its own Worker and database, so changes can be tried without touching what friends use:

| | App | Worker | Database | Branch |
|---|---|---|---|---|
| Live | https://ajzimmerman98.github.io/fantasyfootball/ | `boone-api` | `boone-db` | `main` |
| Test | https://ajzimmerman98.github.io/fantasyfootball/staging/ | `boone-api-staging` | `boone-db-staging` | `staging` |

Changes go to `staging` first (a pull request into `staging`), get tried in the test copy, then reach live with a pull request from `staging` into `main`. Tests run on every pull request and on pushes to both branches.

The test copy shows a "Test version" banner, keeps its own browser storage (keys start with `stg_`) and offline copy, and installs to a home screen as "Boone test". Its reminders come from the test Worker, so friends never get test notifications.

### One-time setup
1. **GitHub Pages:** repository Settings → Pages → Build and deployment → Source: **GitHub Actions**. The Pages workflow (`.github/workflows/pages.yml`) then publishes `main` at the root and `staging` under `/staging/`.
2. **Test database:** Cloudflare → Storage & databases → D1 → Create, named `boone-db-staging`. Its Database ID is in `worker/wrangler.jsonc` under `env.staging` (done: `598448c1-e6cc-46eb-9939-ef56a1fde445`).
3. **Test Worker:** Cloudflare → Workers & Pages → Create → Import a repository: this repository, Worker name `boone-api-staging`, production branch `staging`, root directory `/worker`, deploy command `npx wrangler deploy --env staging`.
4. **Test Worker secrets** (optional, same as live): `ACCESS_CODE`, and `ESPN_S2` / `ESPN_SWID` to try ESPN leagues.
