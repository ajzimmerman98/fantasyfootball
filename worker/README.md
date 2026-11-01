# Boone Lineups API (Cloudflare Worker)

A small Cloudflare Worker that serves data the browser can't fetch directly, and stores your profile and saved lineups in a D1 database.

## Endpoints

Public (Boone's published data):

| Endpoint | What it returns |
|---|---|
| `GET /trade-values` | Boone's latest rest-of-season trade value charts (QB, RB, WR, TE) from his weekly Yahoo articles. `?refresh` skips the 1-hour cache. |
| `GET /rankings?season&week&scoring` | Boone's QB, FLEX, K and DEF lists from FantasyPros (`scoring` = `PPR` or `HALF`; defaults to Sleeper's current week). Saves each new version; serves the newest saved copy if FantasyPros is down. |
| `GET /rankings/status?season&week` | `{ latestPub }`: when Boone last published or updated that week's rankings. |
| `GET /health` | `{ ok, db, accessCode }`: whether the database and access code are set up. |

Private (send `Authorization: Bearer <ACCESS_CODE>`):

| Endpoint | What it does |
|---|---|
| `GET` / `PUT /me/profile` | Sleeper username and app settings. |
| `GET /me/builds?limit` | Saved lineup builds, newest first, each with `latestPub` (newest Boone rankings for its week) so the app can mark it expired. |
| `POST /me/builds` | Save builds: `{ "builds": [...] }`. Keeps the newest 200. |
| `DELETE /me/builds/:id` | Delete one build. |

A cron trigger runs every 3 hours and saves new versions of Boone's rankings (PPR and half-PPR) and the week's trade value charts, so "expired" works even when the app isn't open.

## Database

D1 database `boone-db`, bound as `DB`. Tables are created automatically on first use (`src/db.js`): `profile`, `rankings`, `trade_values`, `lineup_builds`.

## Setup

### 1. Worker (done)
Imported from GitHub in **Workers & Pages** as `boone-api`, with **Path** (root directory) set to `/worker`. Every merge to `main` that changes this folder redeploys it.

### 2. Database
1. In the Cloudflare dashboard, go to **Storage & databases → D1 SQL database → Create**.
2. Name it `boone-db` and create it.
3. Copy its **Database ID** into `database_id` in `wrangler.jsonc` (done: `f4b84556-c324-4e64-9b15-3986d08cddb5`).

### 3. Access code
1. Open the `boone-api` Worker → **Settings → Variables and Secrets → Add**.
2. Type **Secret**, name `ACCESS_CODE`, value: a passphrase only you know. Secrets aren't stored in the repo and survive redeploys.
3. In the app, open **Sync & saved lineups** and enter the same code. Each browser remembers it.

## Connect the app

The app points at `https://boone-api.ajzimmerman98.workers.dev` via `API_BASE_DEFAULT` in `index.html`. To try another Worker, open the app with `?api=<worker-url>` once; that browser remembers it.

## Local development (optional)

```bash
cd worker
npx wrangler dev
```
