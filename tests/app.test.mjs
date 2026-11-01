// The app in a real browser (Chromium via Playwright), with every outside service answered by tests/helpers/world.mjs.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { openApp, newEnv, closeBrowser, text } from "./helpers/app.mjs";
import { state } from "./helpers/world.mjs";

after(closeBrowser);
const build = async (page, source = "boone") => {
  await page.selectOption("#rsrc", source);
  await page.click("#go");
  await page.waitForFunction(() => / updated |err/.test(document.getElementById("status").innerHTML), null, { timeout: 30000 });
};
const card = (page, i) => text(page, `#out .card:nth-of-type(${i + 1})`);

test("lineup: rankings, projected points, matchup preview, kickoff, weather and locked players", async () => {
  const { page, errors } = await openApp();
  await build(page);
  assert.match(await text(page, "#status"), /Season 2026, week 8\. 2 league\(s\)\. Justin Boone's rankings updated/);
  const c = await card(page, 0);
  assert.match(c, /Week 8 vs Rival FC \d+% to win/);
  assert.match(c, /Projected: you [\d.]+ · them [\d.]+/);
  assert.match(c, /score 12\.5–8\.1/);
  assert.match(c, /Josh Allen QB BUF TV \d+.*@ MIA ?Very windy/);   // outdoor game, 22 mph forecast
  assert.match(c, /Bijan Robinson RB ATL.*vs NYJ/);               // ATL has a roof: no weather flags
  assert.doesNotMatch(c, /Bijan Robinson RB ATL[^|]*Windy/);
  assert.match(c, /🔒 Locked · in progress vs MIN/);              // Jameson Williams, DET game under way
  assert.match(c, /🔒 3 starters already playing or done, so they stay put\./); // Jameson Williams and T.J. Hockenson (in progress), DK Metcalf (final)
  assert.match(c, /24\.1 pts/);
  assert.match(c, /Breece Hall RB NYJ TV \d+ UNRANKED Sun/);        // has a game, so not "bye?"                                    // Sleeper projection for Josh Allen
  // Locked players aren't moved: Germie Bernard (PIT, final) stays on the bench, Metcalf (PIT) stays in
  assert.doesNotMatch(c, /START Germie Bernard/);
  assert.doesNotMatch(c, /SIT DK Metcalf/);
  assert.match(await card(page, 1), /Half League/);
  assert.deepEqual(errors, []);
});

test("lineup: every rankings source builds; saved lineups are kept per source", async () => {
  const env = newEnv();
  const { page, errors } = await openApp({ env, query: "?owner", connect: true });
  for (const s of ["boone", "ecr", "sleeper"]) await build(page, s);
  await build(page, "boone");
  await page.waitForSelector("#saved .sv");
  const rows = env.DB._db.prepare("SELECT league_id, source, scoring FROM lineup_builds ORDER BY league_id, source").all().map((r) => `${r.league_id}/${r.source}/${r.scoring}`);
  assert.deepEqual(rows, ["L1/boone/PPR", "L1/ecr/PPR", "L1/sleeper/PPR", "L2/boone/HALF", "L2/ecr/HALF", "L2/sleeper/HALF"]);
  const saved = await text(page, "#saved");
  assert.doesNotMatch(saved, /Expired/, "fresh builds aren't expired");
  const result = JSON.parse(env.DB._db.prepare("SELECT result FROM lineup_builds WHERE league_id = 'L1' AND source = 'boone'").get().result);
  assert.equal(result.matchup.opp, "Rival FC");
  await page.click("#saved details summary");
  assert.match(await text(page, "#saved details"), /vs (Rival FC|rival): projected [\d.]+–[\d.]+ · \d+% to win|Half League/);
  assert.deepEqual(errors, []);
});

test("feed health: a banner says when the saved copy is used", async () => {
  const env = newEnv();
  const first = await openApp({ env });
  await build(first.page, "ecr");                 // live load, saved by the Worker
  assert.ok(await first.page.$eval("#l_warn", (e) => e.hidden));
  state.fpDown = true;
  try {
    const { page } = await openApp({ env });      // new page: no in-app cache
    await build(page, "ecr");
    assert.match(await text(page, "#l_warn"), /FantasyPros rankings couldn't be refreshed \(FantasyPros returned 503\), so you're seeing the saved copy from/);
  } finally { state.fpDown = false; }
});

test("free agents: rostered players excluded; trending adds; trade value trends", async () => {
  const { page, errors } = await openApp();
  await page.click("#tb_fa");
  await page.selectOption("#fa_src", "ecr:week");
  await page.click("#fa_go");
  await page.waitForSelector("#fa_ui:not([hidden])", { timeout: 30000 });
  const out = await text(page, "#fa_out");
  for (const rostered of ["Jaxon Smith-Njigba", "Kenneth Walker", "Parker Washington", "Bijan Robinson"]) assert.ok(!out.includes(rostered), rostered);
  assert.match(out, /Over your starter/);
  await page.selectOption("#fa_src", "tvboone:ros");
  await page.waitForFunction(() => /Ranked by Justin Boone's trade value/.test(document.getElementById("fa_status").textContent), null, { timeout: 30000 });
  assert.match(await text(page, "#fa_out"), /Value \d+ \(▲\d+\)/);
  assert.deepEqual(errors, []);
});

test("trades: Justin Boone week-over-week and FantasyCalc 30-day trends; trade ideas", async () => {
  const { page, errors } = await openApp();
  await page.click("#tb_trade");
  await page.click("#tr_go");
  await page.waitForSelector("#tr_ui:not([hidden])", { timeout: 30000 });
  assert.ok((await page.$$("#tr_mine .tr-up, #tr_mine .tr-dn, #tr_theirs .tr-up, #tr_theirs .tr-dn")).length > 0, "Boone trend arrows");
  await page.click("#tr_gen");
  assert.match(await text(page, "#tr_ideas"), /Your starting lineup is worth \d+/);
  await page.selectOption("#tr_vsrc", "fc");
  await page.waitForFunction(() => /FantasyCalc values/.test(document.getElementById("tr_status").textContent), null, { timeout: 30000 });
  assert.match(await text(page, "#tr_fmt"), /FantasyCalc values for this league/);
  assert.deepEqual(errors, []);
});

test("power rankings: every option ranks both teams", async () => {
  const { page, errors } = await openApp();
  await page.click("#tb_power");
  for (const src of ["boone", "ecr", "fc", "wk:boone", "wk:ecr", "wk:sleeper"]) {
    await page.evaluate(() => { document.getElementById("pw_status").textContent = ""; }); // clear first: a cached switch finishes instantly
    await page.selectOption("#pw_src", src);
    if (src === "boone") await page.click("#pw_go");
    await page.waitForFunction(() => /updated|trade values\./.test(document.getElementById("pw_status").textContent), null, { timeout: 30000 });
    assert.equal((await page.$$("#pw_out details.pw")).length, 2, src);
  }
  assert.deepEqual(errors, []);
});

test("history: standings, head-to-head and records for the league", async () => {
  const { page, errors } = await openApp();
  await page.click("#tb_hist");
  await page.click("#hi_go");
  await page.waitForFunction(() => /games\./.test(document.getElementById("hi_status").textContent), null, { timeout: 30000 });
  const out = await text(page, "#hi_out");
  for (const s of ["Champions", "All-time standings", "Head-to-head", "League records", "Luck index", "Season by season"]) assert.ok(out.includes(s), s);
  // Draft recap: grades for both managers, steals and busts with real names
  assert.match(out, /Draft recap 2026 Grades by the points each manager's picks scored so far\./);
  assert.match(out, /A\+ · (aj|rival) [\d,]+ Best pick: /);
  assert.match(out, /F · (aj|rival) [\d,]+ Best pick: /);
  assert.match(out, /Biggest steals .*round \d+, pick \d+ · finished #\d+ among drafted players/i);
  assert.match(out, /Biggest busts Jaxon Smith-Njigba WR -\d+ rival · round 1, pick 2/i);
  // Trade (week 3): aj got Drake Maye; rival got Jalen Coker and aj's 2027 round 2 pick
  assert.match(out, /Trades 1 trade · most active: /);
  assert.match(out, /2026 week 3 (aj|rival) won by [\d.]+ so far/);
  assert.match(out, /aj got Drake Maye QB [\d.]+/);
  assert.match(out, /rival got Jalen Coker WR, 2027 round 2 [\d.]+/);
  // Pickups: Germie Bernard off waivers for $12 in week 2
  assert.match(out, /Best pickups .*Germie Bernard WR \d+ aj · 2026 week 2 · \$12/);
  assert.match(out, /Most moves (aj|rival) 1 · (aj|rival) 1/i);
  assert.deepEqual(errors, []);
});

test("layout: no sideways scrolling on any tab at phone widths", async () => {
  for (const width of [320, 375, 430]) {
    const { page } = await openApp({ width });
    for (const tab of ["lineup", "fa", "weather", "trade", "power", "hist"]) {
      await page.click(`#tb_${tab}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${tab} at ${width}`);
    }
  }
});

test("sync section is hidden unless opened with ?owner", async () => {
  const friend = await openApp();
  assert.ok(await friend.page.$eval("#sync", (e) => e.hidden));
  const owner = await openApp({ query: "?owner" });
  assert.ok(!(await owner.page.$eval("#sync", (e) => e.hidden)));
});

test("install as an app: manifest, icons and offline start", async () => {
  const http = await import("node:http"), fs = await import("node:fs"), path = await import("node:path");
  const { ROOT } = await import("./helpers/world.mjs"), { launch } = await import("./helpers/app.mjs");
  const types = { ".html": "text/html", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const ctx = await (await launch()).newContext();
  try {
    await ctx.route(/^https:\/\//, (r) => r.abort()); // no outside data needed here
    const page = await ctx.newPage(), base = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(base);
    const man = await page.evaluate(async () => {
      const l = document.querySelector("link[rel=manifest]"), m = await (await fetch(l.href)).json();
      return { name: m.name, display: m.display, icons: await Promise.all(m.icons.map(async (i) => (await fetch(new URL(i.src, l.href))).ok)) };
    });
    assert.deepEqual(man, { name: "Boone Lineups", display: "standalone", icons: [true, true] });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller));
    await ctx.setOffline(true);
    await page.reload();
    assert.equal(await page.title(), "Boone Lineups");
  } finally { await ctx.close(); server.close(); }
});

test("tabs load on their own when the username is remembered; flipping back doesn't reload", async () => {
  const calls = [];
  const { page, errors } = await openApp({ remembered: true, sleeperCalls: calls });
  // The Lineup tab builds without a click
  await page.waitForFunction(() => / updated /.test(document.getElementById("status").textContent), null, { timeout: 30000 });
  assert.match(await text(page, "#out"), /Sleeper League/);
  await page.click("#tb_fa");
  await page.waitForSelector("#fa_ui:not([hidden])", { timeout: 30000 });
  await page.click("#tb_power");
  await page.waitForFunction(() => document.querySelectorAll("#pw_out details.pw").length === 2, null, { timeout: 30000 });
  await page.click("#tb_weather");
  await page.waitForFunction(() => /Week 8/.test(document.getElementById("w_status").textContent), null, { timeout: 30000 });
  // Back to Lineup: already loaded, so no new Sleeper requests
  const before = calls.length;
  await page.click("#tb_lineup");
  await page.waitForTimeout(500);
  assert.equal(calls.length, before);
  // The tabs share one Sleeper load within a minute: the user lookup happened once (the button always reloads)
  assert.equal(calls.filter((p) => p === "/v1/user/aj").length, 1);
  assert.deepEqual(errors, []);
});

test("no Doubtful or debug checkboxes; ?debug still shows the debug table", async () => {
  const plain = await openApp();
  assert.equal(await plain.page.$("#doubt"), null);
  assert.equal(await plain.page.$("#debug"), null);
  const dbg = await openApp({ query: "?debug" });
  await build(dbg.page);
  assert.ok((await dbg.page.$$("#out details.dbg")).length > 0);
});

test("playoff odds: the simulation behaves sensibly", async () => {
  const { page } = await openApp();
  const r = await page.evaluate(() => {
    // Seeded random numbers so the result is the same every run
    const rng = ((a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(42);
    const team = (id, w, mean) => ({ id, w, l: 7 - w, t: 0, pf: mean * 7, mean, meanNow: mean });
    const weeks = Array.from({ length: 6 }, (_, k) => k % 2 ? [[1, 2], [3, 4]] : [[1, 3], [2, 4]]);
    const even = simulateSeason({ teams: [1, 2, 3, 4].map((id) => team(id, 3, 110)), weeks, nPO: 2, sims: 4000, rng, me: 0 });
    const lop = simulateSeason({ teams: [team(1, 7, 140), team(2, 0, 90), team(3, 3, 110), team(4, 3, 110)], weeks, nPO: 2, sims: 4000, rng });
    const six = simulateSeason({ teams: Array.from({ length: 10 }, (_, k) => team(k + 1, 3, 110)), weeks: [[[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]], nPO: 6, sims: 500, rng });
    // Same standings; one run treats team strength as certain, the other allows for uncertainty
    const mk = (unc) => [team(1, 4, 125), team(2, 3, 105), team(3, 4, 112), team(4, 3, 110)].map((t) => ({ ...t, unc }));
    const sure = simulateSeason({ teams: mk(0), weeks, nPO: 2, sims: 20000, rng }), unsure = simulateSeason({ teams: mk(7), weeks, nPO: 2, sims: 20000, rng });
    return { sure: { po: sure.teams.map((t) => t.po) }, unsure: { po: unsure.teams.map((t) => t.po) }, even: even.teams.map((t) => t.po), what: even.what, lop: lop.teams.map((t) => ({ po: t.po, champ: t.champ })), sixByes: six.byes, order: bracketOrder(8) };
  });
  for (const p of r.even) assert.ok(Math.abs(p - 0.5) < 0.06, "even teams ~50%: " + p);
  assert.ok(r.what.win > r.what.lose + 0.2, "winning this week helps");
  assert.ok(r.lop[0].po > 0.99 && r.lop[1].po < 0.01, "7-0 juggernaut in, 0-7 out");
  assert.ok(r.lop[0].champ > 0.6);
  assert.equal(r.sixByes, 2);
  assert.ok(r.unsure.po[1] > r.sure.po[1] + 0.01 && r.unsure.po[0] < r.sure.po[0], "strength uncertainty pulls the weakest team up and the strongest down");
  assert.deepEqual(r.order, [1, 8, 4, 5, 2, 7, 3, 6]);
});

test("playoff odds card on the Power Rankings tab", async () => {
  const { page, errors } = await openApp();
  await page.click("#tb_power");
  await page.click("#pw_go");
  await page.waitForFunction(() => /Your playoff odds/.test(document.getElementById("po_out").textContent), null, { timeout: 30000 });
  const t = await text(page, "#po_out");
  assert.match(t, /Playoff odds 1 of 2 teams make it · 7 weeks left · 10,000 simulations\./);
  assert.match(t, /Your playoff odds: \d+% · if you win this week \d+% · if you lose \d+%/);
  assert.match(t, /aj \(you\) \d+% 4-3 now · projected [\d.]+ wins of 14 · title \d+%/);
  const odds = [...t.matchAll(/(?:aj \(you\)|Rival FC) (\d+)%/g)].map((m) => +m[1]);
  assert.equal(odds.length, 2);
  assert.ok(Math.abs(odds[0] + odds[1] - 100) <= 1, "one playoff spot: odds add up to 100%");
  assert.deepEqual(errors, []);
});
