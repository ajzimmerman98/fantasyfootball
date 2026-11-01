# Boone Lineups API (Cloudflare Worker)

A Cloudflare Worker that serves the app itself (`index.html`, copied into `public/` on each deploy), the data the browser can't fetch directly, and each person's profile and saved lineups in a D1 database. People sign in with Cloudflare Access (an emailed one-time code). The app and API share one address so the sign-in cookie works on phones; the old GitHub Pages address forwards here.

## Endpoints

Public (Boone's published data):

| Endpoint | What it returns |
|---|---|
| `GET /trade-values` | Boone's latest rest-of-season trade value charts (QB, RB, WR, TE) from his weekly Yahoo articles. `?refresh` skips the 1-hour cache. |
| `GET /trade-values/fantasycalc?ppr&qbs&teams` | [FantasyCalc](https://fantasycalc.com) redraft trade values (based on real trades) for a league format: `ppr` = 0, 0.5 or 1; `qbs` = 1 or 2 (superflex); `teams` = 8 to 16. QB/RB/WR/TE only, rescaled so the top player is 100 to sit on Boone's scale. Cached for an hour. |
| `GET /rankings?season&week&scoring&source&kind` | QB, FLEX, K and DEF lists from FantasyPros (`scoring` = `PPR` or `HALF`; defaults to Sleeper's current week). `source` = `boone` (default, Justin Boone), `ecr` (FantasyPros expert consensus) or `sleeper` (Sleeper's weekly projections, ranked by projected points; each player has `pts`); `kind` = `week` (default) or `ros` (rest of season, FantasyPros consensus only). Boone's weekly lists keep every version; other lists keep the newest copy. Serves the newest saved copy if FantasyPros is down. |
| `GET /rankings/status?season&week` | `{ latestPub }`: when Boone last published or updated that week's rankings. |
| `GET /health` | `{ ok, db, accessCode }`: whether the database and access code are set up. |

Private (signed in through Cloudflare Access; or `Authorization: Bearer <ACCESS_CODE>`, which counts as the owner). Everything is per person:

| Endpoint | What it does |
|---|---|
| `GET /me/whoami` | `{ email, owner }` |
| `GET` / `PUT /me/profile` | Sleeper username and app settings. |
| `GET /me/builds?limit` | Saved lineup builds (the latest one per league, rankings source and scoring), by league, each with `latestPub` (newest Boone rankings for its week) so the app can mark it expired. |
| `POST /me/builds` | Save builds: `{ "builds": [...] }`. Each replaces that league's previous build with the same `source` and `scoring`. |
| `DELETE /me/builds/:id` | Delete one build. |
| `GET /me/espn?season` | The owner's ESPN leagues (others get an empty list: the ESPN cookies are the owner's login) (IDs saved in profile `settings.espnLeagues`), converted to the app's Sleeper-style league shape: slots, scoring, every team's roster and current lineup. |

A cron trigger runs every 3 hours and saves new versions of the weekly rankings from every source (PPR and half-PPR) and the week's trade value charts, so "expired" works even when the app isn't open.

## Database

D1 database `boone-db`, bound as `DB`. Tables are created automatically on first use (`src/db.js`): `users`, `profiles` (one per person), `profile` (from the single-user version; moved to the owner on first sign-in), `rankings` (Boone history), `rankings_latest` (newest consensus and rest-of-season lists), `trade_values`, `lineup_builds`.

## Setup

### 1. Worker (done)
Imported from GitHub in **Workers & Pages** as `boone-api`, with **Path** (root directory) set to `/worker`. Every merge to `main` that changes this folder redeploys it.

### 2. Database
1. In the Cloudflare dashboard, go to **Storage & databases → D1 SQL database → Create**.
2. Name it `boone-db` and create it.
3. Copy its **Database ID** into `database_id` in `wrangler.jsonc` (done: `f4b84556-c324-4e64-9b15-3986d08cddb5`).

### 3. Sign-in (Cloudflare Access, email code)
Cloudflare Access puts a login page in front of the Worker's address: people enter their email, get a one-time code, and are in. Free for up to 50 people.
1. Open the `boone-api` Worker → **Settings → Domains & Routes**. On the **workers.dev** row, choose **Enable Cloudflare Access** (the wording may differ slightly). If Cloudflare asks you to set up Zero Trust first, pick a team name and the **Free** plan.
2. Cloudflare then shows the Access details for this Worker. Note the **audience (AUD) tag** and the **team domain** (`<team>.cloudflareaccess.com`; it's also in the JWKS/certs URL it shows).
3. In **Settings → Variables and Secrets**, add three **Secrets**:
   - `ACCESS_TEAM_DOMAIN`: `<team>.cloudflareaccess.com`
   - `ACCESS_AUD`: the audience tag
   - `OWNER_EMAIL`: the email you'll sign in with. That account is the owner: it gets the ESPN leagues and takes over the profile and saved lineups from before sign-in existed.
4. Choose who may sign in: **Zero Trust → Access → Applications** → the application for `boone-api` → **Policies** → edit the Allow policy → **Include → Emails** → add each person's email (yours too). One-time PIN is the default login method.
5. Open `https://boone-api.ajzimmerman98.workers.dev`, enter your email, then the code from the email.

To remove someone, delete their email from the policy. Their saved data stays in the database but they can't get to it.

`ACCESS_CODE` (optional) still works as an owner login for scripts or before Access is set up; delete the secret once sign-in works if you don't need it.

### 4. ESPN leagues (optional, owner only)
ESPN leagues are private by default, so the Worker reads them with your ESPN login cookies. They act like a login, so keep them as secrets only. Because they're your login, only the owner sees ESPN leagues; everyone else uses Sleeper.
1. On a computer, log in at [espn.com](https://www.espn.com), then open your browser's developer tools → **Application/Storage → Cookies → https://www.espn.com**.
2. Copy the values of `espn_s2` and `SWID`.
3. In the `boone-api` Worker → **Settings → Variables and Secrets**, add two **Secrets**: `ESPN_S2` and `ESPN_SWID`.
4. In the app, under **Sync & saved lineups** (signed in as the owner), enter your ESPN league IDs (the number after `leagueId=` in the league's address).

The cookies expire every so often (about a year); when ESPN leagues stop loading with "rejected the login cookies", replace them.

## The app

The app is served at `https://boone-api.ajzimmerman98.workers.dev`. Each deploy copies `../index.html` into `public/` (the `build` command in `wrangler.jsonc`), so editing `index.html` at the repo root is still all it takes. Old GitHub Pages links forward to the Worker (add `?stay` to stay on GitHub Pages, where sign-in and sync don't work).

## Local development (optional)

```bash
cd worker
npx wrangler dev
```
