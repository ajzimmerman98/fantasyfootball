// Opens index.html in Chromium with every network request answered by the test world, and the Worker running in-process.
import path from "node:path";
import { createRequire } from "node:module";
import { makeD1 } from "./d1mock.mjs";
import * as world from "./world.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
export const WORKER = "https://boone-api.ajzimmerman98.workers.dev";
export const APP = "file://" + path.join(world.ROOT, "index.html");

globalThis.fetch = world.workerFetch; // the Worker module uses the global fetch
const worker = (await import(path.join(world.ROOT, "worker/src/index.js"))).default;
export const workerModule = await import(path.join(world.ROOT, "worker/src/index.js"));

export function newEnv(extra = {}) { return { DB: makeD1(), ACCESS_CODE: "s3cret", ESPN_S2: "x", ESPN_SWID: "ABCD-1234", ...extra }; }
export const callWorker = (url, env, init) => worker.fetch(new Request(url, init), env);

let browser;
export async function launch() { browser ||= await chromium.launch(); return browser; }
export async function closeBrowser() { if (browser) await browser.close(); browser = null; }

// opts: env (Worker bindings), width, query (e.g. "?owner"), connect (enter the access code),
// remembered (the username is already saved on this device, as on a return visit), sleeperCalls (array to record Sleeper paths)
export async function openApp({ env = newEnv(), width = 375, query = "", connect = false, remembered = false, sleeperCalls = null } = {}) {
  const b = await launch();
  const ctx = await b.newContext({ viewport: { width, height: 900 } });
  if (remembered) await ctx.addInitScript(() => { if (!localStorage.getItem("user")) localStorage.setItem("user", "aj"); });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(WORKER + "/**", async (r) => {
    const q = r.request(), u = new URL(q.url());
    if (u.pathname === "/trade-values") return r.fulfill({ body: world.fixtures.tradeValues, contentType: "application/json", headers: { "access-control-allow-origin": "*" } });
    const res = await worker.fetch(new Request(q.url(), { method: q.method(), headers: q.headers(), body: ["GET", "HEAD"].includes(q.method()) ? undefined : q.postData() }), env);
    r.fulfill({ status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) });
  });
  await page.route("https://api.sleeper.app/**", (r) => {
    const u = new URL(r.request().url());
    if (sleeperCalls) sleeperCalls.push(u.pathname);
    if (u.pathname.startsWith("/projections/nfl/")) return r.fulfill({ body: world.fixtures.projections, contentType: "application/json" });
    r.fulfill({ json: world.sleeper(u.pathname) });
  });
  await page.route("https://site.api.espn.com/**", (r) => r.fulfill({ json: world.schedule }));
  await page.route("https://api.open-meteo.com/**", (r) => r.fulfill({ json: world.forecast(r.request().url()) }));
  await page.route("https://geocoding-api.open-meteo.com/**", (r) => r.fulfill({ json: { results: [] } }));
  await page.route("https://partners.fantasypros.com/**", (r) => r.abort()); // the app goes through the Worker
  await page.goto(APP + query);
  if (!remembered) await page.fill("#user", "aj");
  if (connect) {
    await page.click("#sync summary");
    await page.fill("#acode", "s3cret");
    await page.click("#acode_go");
    await page.waitForSelector("#sync_on:not([hidden])");
  }
  return { page, ctx, env, errors };
}
export const text = async (page, sel) => (await page.innerText(sel)).replace(/\s+/g, " ").trim();
