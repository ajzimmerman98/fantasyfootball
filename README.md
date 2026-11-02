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
| `js/values.js`, `js/trades.js` | Trade values (Justin Boone, FantasyCalc) and the Trades tab with trade ideas |
| `js/rankings.js` | Loading rankings from each source, with feed-health warnings |
| `js/freeagents.js`, `js/weather.js`, `js/power.js`, `js/history.js` | The other tabs (Power Rankings includes playoff odds) |
| `js/sync.js`, `js/reminders.js` | Owner sync (saved lineups) and the Reminders card |
| `js/app.js` | Install as an app, tabs, automatic loading, start-up |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app: offline start, notifications |
| `worker/` | Cloudflare Worker: rankings and trade value feeds, database, reminders (see `worker/README.md`) |
| `tests/` | `npm test`: Worker and in-browser app tests on a fixed test world (see `tests/README.md`) |

The scripts are plain (non-module) scripts loaded in order by `index.html` and share one global scope, so the app also
runs straight from the file system.
