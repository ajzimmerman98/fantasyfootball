# Boone Lineups API (Cloudflare Worker)

A small Cloudflare Worker that serves data the browser can't fetch directly.

| Endpoint | What it returns |
|---|---|
| `GET /trade-values` | Justin Boone's latest rest-of-season trade value charts (QB, RB, WR, TE) from his weekly Yahoo articles. Add `?refresh` to skip the 1-hour in-memory cache. |
| `GET /health` | `{"ok":true}` |

`/trade-values` finds the newest chart articles on [Boone's Yahoo author page](https://sports.yahoo.com/author/justin-boone/) and reads the table in each one. Response shape:

```json
{
  "week": 8, "season": 2026, "fetched": "…", "errors": [],
  "charts": {
    "RB": { "week": 8, "published": "2026-10-28T21:13:03Z", "url": "…", "columns": ["HALF", "PPR"],
            "players": [{ "rank": 1, "name": "Jahmyr Gibbs", "values": { "HALF": 101, "PPR": 104 } }] },
    "QB": { "columns": ["1QB", "2QB"], "players": [ … ] }
  }
}
```

No storage bindings are needed yet. A database (D1) comes with saved lineups and profiles.

## Deploy (one time)

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Go to **Workers & Pages → Create → Import a repository**, connect GitHub, and pick `fantasyfootball`.
3. Set **Project name** to `boone-api` (it must match `name` in `wrangler.jsonc`).
4. Under **Advanced settings**, set **Path** (the root directory) to `/worker`. Leave the deploy command as `npx wrangler deploy`.
5. **Deploy.** The Worker's URL looks like `https://boone-api.<your-subdomain>.workers.dev`.

Every merge to `main` that changes this folder redeploys it automatically.

## Connect the app

The app points at `https://boone-api.ajzimmerman98.workers.dev` via `API_BASE_DEFAULT` in `index.html`. To try a Worker before that, open the app with `?api=https://boone-api.<your-subdomain>.workers.dev` once; the URL is remembered in that browser.

## Local development (optional)

```bash
cd worker
npx wrangler dev
```
