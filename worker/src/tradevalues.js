// Justin Boone's rest-of-season trade value charts (QB, RB, WR, TE), read from his weekly Yahoo articles.
// Yahoo doesn't allow browsers on other sites to read its pages, so the app gets these through the Worker.

const AUTHOR_URL = "https://sports.yahoo.com/author/justin-boone/";
const ARTICLE_BASE = "https://sports.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const POSITIONS = { quarterback: "QB", "running-back": "RB", "wide-receiver": "WR", "tight-end": "TE" };
// e.g. /fantasy/article/2026-trade-value-charts--justin-boones-fantasy-football-running-back-breakdown-for-week-8-154046064.html
const ARTICLE_RE = /\/fantasy\/article\/(\d{4})-trade-value-charts--justin-boones-fantasy-football-(quarterback|running-back|wide-receiver|tight-end)-breakdown-for-week-(\d+)-\d+\.html/g;

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

// The author page only lists his most recent articles, so once he posts more, some charts drop off it. Each chart
// article links to the other positions' charts, so links found inside loaded articles fill the gaps (up to 3 rounds).
export async function loadTradeValues() {
  let want = findArticles(await getText(AUTHOR_URL));
  if (!want.length) throw new Error("No trade value chart articles found on Boone's Yahoo author page.");
  const charts = {}, errors = {}, tried = new Set();
  const newer = (a, b) => !b || a.season * 100 + a.week > b.season * 100 + b.week;
  for (let round = 0; round < 3 && want.length; round++) {
    const found = [];
    await Promise.all(want.map(async (a) => {
      tried.add(a.url);
      try {
        const html = await getText(a.url), chart = parseChart(html);
        found.push(...findArticles(html));
        if (!chart) throw new Error("no trade value table in article");
        if (newer(a, charts[a.pos])) charts[a.pos] = { week: a.week, season: a.season, url: a.url, published: published(html), ...chart };
        delete errors[a.pos];
      } catch (e) { if (!charts[a.pos]) errors[a.pos] = `${a.pos}: ${e.message}`; }
    }));
    // Next round: positions still missing, or a newer week linked from an article
    const best = {};
    for (const b of found) if (!tried.has(b.url) && newer(b, best[b.pos]) && newer(b, charts[b.pos])) best[b.pos] = b;
    want = Object.values(best);
  }
  if (!Object.keys(charts).length) throw new Error("Couldn't read any trade value charts. " + Object.values(errors).join("; "));
  const weeks = Object.values(charts).map((c) => c.week);
  return { source: "Justin Boone, Yahoo Sports", week: Math.max(...weeks), season: Math.max(...Object.values(charts).map((c) => c.season)), fetched: new Date().toISOString(), charts, errors: Object.values(errors) };
}
