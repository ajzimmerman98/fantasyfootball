# Tests

`npm test` runs everything: the Worker (`worker.test.mjs`) and the app in a real browser (`app.test.mjs`, Chromium via Playwright).

Nothing touches the network. `helpers/world.mjs` is a small fixed world (two Sleeper leagues, an NFL schedule with games not started, in progress and final, a windy forecast), and every outside feed is answered from `fixtures/`:

| Fixture | What it is |
|---|---|
| `fp/` | Real FantasyPros responses for week 8, 2026 (Justin Boone, consensus weekly and rest of season), trimmed to the fields the app uses |
| `trade-values.json` | The Worker's `/trade-values` output, with a made-up previous week for the trend arrows |
| `fantasycalc.json` | FantasyCalc values in its API's shape (with 30-day trends) |
| `sleeper-projections.json` | Sleeper weekly projections in its API's shape |
| `espn-league.mjs` | An ESPN league in the shape ESPN's fantasy API returns |

Setup once: `npm install` and `npx playwright install chromium`. The same tests run on GitHub for every pull request (`.github/workflows/tests.yml`).
