// Boone Lineups API (Cloudflare Worker)
//
// GET /trade-values  Justin Boone's latest rest-of-season trade value charts (QB, RB, WR, TE),
//                    read from his weekly Yahoo articles.
// GET /health        Liveness check.
//
// Yahoo doesn't allow browsers on other sites to read its pages, so the app asks this Worker instead.
// No storage bindings yet: results are kept in memory for an hour per Worker instance.

const AUTHOR_URL = "https://sports.yahoo.com/author/justin-boone/";
const ARTICLE_BASE = "https://sports.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const CACHE_MS = 60 * 60 * 1000;
const POSITIONS = { quarterback: "QB", "running-back": "RB", "wide-receiver": "WR", "tight-end": "TE" };
// e.g. /fantasy/article/2026-trade-value-charts--justin-boones-fantasy-football-running-back-breakdown-for-week-8-154046064.html
const ARTICLE_RE = /\/fantasy\/article\/(\d{4})-trade-value-charts--justin-boones-fantasy-football-(quarterback|running-back|wide-receiver|tight-end)-breakdown-for-week-(\d+)-\d+\.html/g;

let memo = null; // { ts, data }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300", ...CORS, ...extra },
  });
}

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
  if (!r.ok) throw new Error(`Yahoo returned ${r.status} for ${url}`);
  return r.text();
}

const decode = (s) =>
  s.replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .trim();

// Newest article per position: highest season, then highest week
export function findArticles(html) {
  const best = {};
  for (const m of html.matchAll(ARTICLE_RE)) {
    const [path, season, slug, week] = m;
    const pos = POSITIONS[slug], cur = best[pos], key = +season * 100 + +week;
    if (!cur || key > cur.key) best[pos] = { pos, season: +season, week: +week, url: ARTICLE_BASE + path, key };
  }
  return Object.values(best).map(({ key, ...a }) => a);
}

// First table whose header has Player plus value columns (HALF/PPR or 1QB/2QB)
export function parseChart(html) {
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) || []) {
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/g) || []).map(decode));
    if (rows.length < 2) continue;
    const head = rows[0].map((h) => h.toUpperCase());
    const iName = head.indexOf("PLAYER"), iRank = head.findIndex((h) => h === "RK" || h === "RANK");
    const cols = head.map((h, i) => [h, i]).filter(([h]) => ["HALF", "PPR", "1QB", "2QB", "STD"].includes(h));
    if (iName < 0 || !cols.length) continue;
    const players = [];
    for (const r of rows.slice(1)) {
      const name = r[iName];
      if (!name) continue;
      const values = {};
      for (const [h, i] of cols) { const v = parseFloat(r[i]); if (!isNaN(v)) values[h] = v; }
      players.push({ rank: iRank >= 0 ? +r[iRank] || players.length + 1 : players.length + 1, name, values });
    }
    if (players.length) return { columns: cols.map(([h]) => h), players };
  }
  return null;
}

const published = (html) => (html.match(/"datePublished":"([^"]+)"/) || [])[1] || null;

export async function loadTradeValues() {
  const articles = findArticles(await getText(AUTHOR_URL));
  if (!articles.length) throw new Error("No trade value chart articles found on Boone's Yahoo author page.");
  const charts = {}, errors = [];
  await Promise.all(articles.map(async (a) => {
    try {
      const html = await getText(a.url), chart = parseChart(html);
      if (!chart) throw new Error("no trade value table in article");
      charts[a.pos] = { week: a.week, season: a.season, url: a.url, published: published(html), ...chart };
    } catch (e) { errors.push(`${a.pos}: ${e.message}`); }
  }));
  if (!Object.keys(charts).length) throw new Error("Couldn't read any trade value charts. " + errors.join("; "));
  const weeks = Object.values(charts).map((c) => c.week);
  return { source: "Justin Boone, Yahoo Sports", week: Math.max(...weeks), season: Math.max(...Object.values(charts).map((c) => c.season)), fetched: new Date().toISOString(), charts, errors };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/trade-values") {
      const fresh = url.searchParams.has("refresh");
      try {
        if (!fresh && memo && Date.now() - memo.ts < CACHE_MS) return json(memo.data);
        const data = await loadTradeValues();
        memo = { ts: Date.now(), data };
        return json(data);
      } catch (e) {
        if (memo) return json({ ...memo.data, stale: true, staleReason: e.message });
        return json({ error: e.message }, 502);
      }
    }
    return json({ error: "Not found", endpoints: ["/trade-values", "/health"] }, 404);
  },
};
