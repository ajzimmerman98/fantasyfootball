// Reminders: notification encryption and signing (decrypted here as a phone would), sign-up endpoints, and the checks.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { newEnv, callWorker, closeBrowser } from "./helpers/app.mjs";
import { state } from "./helpers/world.mjs";
import { encryptPayload, validSubscription, b64u, unb64u, vapidKeys } from "../worker/src/push.js";
import { runReminders } from "../worker/src/reminders.js";
import * as db from "../worker/src/db.js";

after(closeBrowser); // the last test opens the app in a browser
const enc = new TextEncoder(), dec = new TextDecoder();
const hmac = async (k, d) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

// A pretend phone: its own key pair and auth secret, like a browser's push subscription
async function device(endpoint = "https://web.push.apple.com/QDevice" + Math.random().toString(36).slice(2)) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint, keys: { p256dh: b64u(pub), auth: b64u(auth) } };
  // RFC 8291 receiver side: undo encryptPayload
  sub.decrypt = async (body) => {
    body = new Uint8Array(body);
    const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, kp.privateKey, 256));
    const ikm = await hmac(await hmac(auth, ecdh), cat(enc.encode("WebPush: info\0"), pub, asPub, new Uint8Array([1])));
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
    assert.equal(pt[pt.length - 1], 2, "last-record delimiter");
    return JSON.parse(dec.decode(pt.slice(0, -1)));
  };
  return sub;
}
const post = (env, path, body) => callWorker("https://w.test" + path, env, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const pushesTo = (sub) => state.pushes.filter((p) => p.url === sub.endpoint);

test("a notification can only be read by the device it was made for", async () => {
  const phone = await device(), other = await device();
  const body = await encryptPayload(phone, JSON.stringify({ title: "Hi", body: "there" }));
  assert.deepEqual(await phone.decrypt(body), { title: "Hi", body: "there" });
  await assert.rejects(() => other.decrypt(body));
});

test("only real push services are accepted as sign-up endpoints", async () => {
  const ok = await device("https://fcm.googleapis.com/fcm/send/abc");
  assert.ok(validSubscription(ok));
  for (const bad of ["https://evil.example/push", "http://web.push.apple.com/x", "https://web.push.apple.com.evil.example/x"])
    assert.ok(!validSubscription({ ...ok, endpoint: bad }), bad);
  assert.ok(!validSubscription({ endpoint: ok.endpoint, keys: { p256dh: "abc", auth: ok.keys.auth } }));
});

test("sign up, test notification (signed by the Worker), sign out", async () => {
  const env = newEnv(), phone = await device();
  const { publicKey } = await (await callWorker("https://w.test/push/key", env)).json();
  assert.equal(unb64u(publicKey).length, 65);
  assert.equal((await post(env, "/push/subscribe", { subscription: { endpoint: "https://evil.example/x", keys: phone.keys } })).status, 400);
  assert.equal((await post(env, "/push/subscribe", { subscription: phone, sleeperUsername: "aj", prefs: { rankings: true, lineup: false }, tz: "America/Chicago" })).status, 200);
  assert.equal((await post(env, "/push/test", { endpoint: phone.endpoint })).status, 200);
  const sent = pushesTo(phone).at(-1);
  assert.equal(sent.headers["Content-Encoding"], "aes128gcm");
  assert.equal((await phone.decrypt(sent.body)).title, "Reminders are on");
  // The VAPID signature checks out against the Worker's public key, for this push service
  const [, jwt, k] = sent.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, publicKey);
  const [h, p, sig] = jwt.split(".");
  const key = await crypto.subtle.importKey("raw", unb64u(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(sig), enc.encode(`${h}.${p}`)));
  assert.equal(JSON.parse(dec.decode(unb64u(p))).aud, "https://web.push.apple.com");
  assert.equal((await post(env, "/push/test", { endpoint: phone.endpoint })).status, 429, "tests are rate limited");
  await post(env, "/push/unsubscribe", { endpoint: phone.endpoint });
  assert.equal((await post(env, "/push/test", { endpoint: phone.endpoint })).status, 404);
});

test("reminders: new Justin Boone rankings, lineup problems before kickoff, each sent once", async () => {
  const env = newEnv(), phone = await device(), quiet = await device(), gone = await device("https://web.push.apple.com/gone");
  await db.ensureSchema(env.DB);
  await db.saveSub(env.DB, { endpoint: phone.endpoint, ...phone.keys, sleeperUsername: "aj", prefs: { rankings: true, lineup: true }, tz: "America/New_York" });
  await db.saveSub(env.DB, { endpoint: quiet.endpoint, ...quiet.keys, sleeperUsername: "aj", prefs: { rankings: false, lineup: false } });
  await db.saveSub(env.DB, { endpoint: gone.endpoint, ...gone.keys, sleeperUsername: "aj", prefs: {} });
  // Bijan Robinson (RB) and Omar Cooper (FLEX) are out; Tetairoa McMillan (WR, CAR, not started) is on my bench.
  // Germie Bernard is also on the bench, but his game is over, so he can't come in.
  state.injuries = { "1": "Out", "6": "Out" };
  state.bench = ["31"];
  const kickoff = Date.parse("2026-11-01T18:00:00Z"), ctx = { season: "2026", week: 9 };
  try {
    // 6 hours before kickoff: rankings notice only (too early for lineup problems)
    let r = await runReminders(env, { ...ctx, newBoone: true, now: kickoff - 6 * 3600e3 });
    let mine = await Promise.all(pushesTo(phone).map((p) => phone.decrypt(p.body)));
    assert.deepEqual(mine.map((m) => m.title), ["Justin Boone's week 9 rankings are out"]);
    assert.equal(pushesTo(quiet).length, 0, "this device turned both off");
    assert.equal(r.gone, 1, "a device that unsubscribed is removed");
    assert.equal((await db.listSubs(env.DB)).length, 2);
    // 2 hours before: the lineup problem; another new Boone version right away doesn't notify again
    r = await runReminders(env, { ...ctx, newBoone: true, now: kickoff - 2 * 3600e3 });
    mine = await Promise.all(pushesTo(phone).map((p) => phone.decrypt(p.body)));
    assert.equal(mine.length, 2);
    assert.equal(mine[1].title, "Lineup check: 2 problems");
    // Each problem names who to start instead: the best healthy bench player for that spot whose game hasn't started
    assert.match(mine[1].body, /Sleeper League: Bijan Robinson is out → no healthy RB on your bench/);
    assert.match(mine[1].body, /Sleeper League: Omar Cooper is out → start Tetairoa McMillan \(14\.2 pts\)/);
    assert.match(mine[1].body, /Half League: Bijan Robinson is out → no healthy RB on your bench/);
    assert.match(mine[1].body, /Kickoff Sun 1:00 PM/);
    // The next check: nothing new
    await runReminders(env, { ...ctx, newBoone: false, now: kickoff - 1 * 3600e3 });
    assert.equal(pushesTo(phone).length, 2);
  } finally { state.injuries = {}; state.bench = []; }
});

test("waiver tips: Tuesday, free agents ranked above one of my starters, once a day", async () => {
  const { waiverDay } = await import("../worker/src/reminders.js");
  assert.equal(waiverDay(Date.parse("2026-11-03T16:00:00Z")), "2026-11-03"); // Tue 11 AM ET
  assert.equal(waiverDay(Date.parse("2026-11-03T13:00:00Z")), null);         // Tue 8 AM ET: too early
  assert.equal(waiverDay(Date.parse("2026-11-04T16:00:00Z")), null);         // Wednesday
  const env = newEnv(), phone = await device(), off = await device();
  await db.ensureSchema(env.DB);
  await db.saveSub(env.DB, { endpoint: phone.endpoint, ...phone.keys, sleeperUsername: "aj", prefs: { rankings: false, lineup: false, recap: false } });
  await db.saveSub(env.DB, { endpoint: off.endpoint, ...off.keys, sleeperUsername: "aj", prefs: { waivers: false, recap: false } });
  const tue = Date.parse("2026-11-03T16:00:00Z"), ctx = { season: "2026", week: 10, newBoone: false };
  await runReminders(env, { ...ctx, now: Date.parse("2026-11-02T16:00:00Z") }); // Monday: nothing
  assert.equal(pushesTo(phone).length, 0);
  await runReminders(env, { ...ctx, now: tue });
  const msgs = await Promise.all(pushesTo(phone).map((p) => phone.decrypt(p.body)));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].title, /^Waiver tips?: /);
  for (const line of msgs[0].body.split("\n")) assert.match(line, /^(Sleeper|Half) League: .+ \((QB|RB|WR|TE), rest of season #\d+\) over your starter .+$/);
  // Never someone already on a roster
  for (const taken of ["Jaxon Smith-Njigba", "Kenneth Walker", "Justin Jefferson", "Jalen Coker", "Drake Maye", "Josh Allen"]) assert.ok(!msgs[0].body.includes(taken + " ("), taken);
  assert.equal(msgs[0].url, "./#fa");
  assert.equal(pushesTo(off).length, 0, "this device turned waiver tips off");
  await runReminders(env, { ...ctx, now: tue + 3 * 3600e3 }); // later the same Tuesday: already sent
  assert.equal(pushesTo(phone).length, 1);
});

test("weekly recap: Tuesday morning, result, record, playoff odds and the change from last week", async () => {
  const env = newEnv(), phone = await device();
  await db.ensureSchema(env.DB);
  await db.saveSub(env.DB, { endpoint: phone.endpoint, ...phone.keys, sleeperUsername: "aj", prefs: { rankings: false, lineup: false, waivers: false }, tz: "America/New_York" });
  const read = async () => Promise.all(pushesTo(phone).map((p) => phone.decrypt(p.body)));
  try {
    state.finalWeeks = [7];
    // Tuesday 5 AM Eastern: quiet hours, nothing yet
    await runReminders(env, { season: "2026", week: 8, newBoone: false, now: Date.parse("2026-11-03T10:00:00Z") });
    assert.equal(pushesTo(phone).length, 0);
    // Tuesday 8 AM: week 7 (all final) recap
    await runReminders(env, { season: "2026", week: 8, newBoone: false, now: Date.parse("2026-11-03T13:00:00Z") });
    let msgs = await read();
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].title, /^Week 7: you (won|lost) [\d.]+–[\d.]+$/);
    assert.match(msgs[0].body, /^Sleeper League: (W|L) [\d.]+–[\d.]+ vs Rival FC · 4-3 · playoff odds \d+% · top scorer .+ [\d.]+$/);
    assert.equal(msgs[0].url, "./#power");
    // Later the same morning: already sent
    await runReminders(env, { season: "2026", week: 8, newBoone: false, now: Date.parse("2026-11-03T16:00:00Z") });
    assert.equal(pushesTo(phone).length, 1);
    // The next Tuesday: week 8 (not yet in Sleeper's standings, so it's added), with the change in playoff odds
    state.finalWeeks = [8];
    await runReminders(env, { season: "2026", week: 9, newBoone: false, now: Date.parse("2026-11-10T13:00:00Z") });
    msgs = await read();
    assert.equal(msgs.length, 2);
    assert.match(msgs[1].body, /^Sleeper League: W 12\.5–8\.1 vs Rival FC · 5-3 · playoff odds \d+% \(▲\d+\)/);
  } finally { state.finalWeeks = []; }
});

test("the Worker's playoff simulation matches the app's exactly", async () => {
  const { openApp } = await import("./helpers/app.mjs");
  const { simulateSeason } = await import("../worker/src/playoffs.js");
  const rngSrc = "((a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(7)";
  const input = { teams: [[1, 5, 120, 118], [2, 4, 112, 125], [3, 3, 108, 100], [4, 2, 101, 104], [5, 4, 115, 0], [6, 2, 99, 97]].map(([id, w, mean, now]) => ({ id, w, l: 7 - w, t: 0, pf: mean * 7, mean, meanNow: now || mean, unc: 7 })),
    weeks: [[[1, 2], [3, 4], [5, 6]], [[1, 3], [2, 5], [4, 6]], [[1, 4], [2, 6], [3, 5]]], nPO: 4, median: true, sims: 3000, me: 2 };
  const worker = simulateSeason({ ...input, rng: eval(rngSrc) });
  const { page } = await openApp();
  const app = await page.evaluate(([inp, src]) => simulateSeason({ ...inp, rng: eval(src) }), [input, rngSrc]);
  assert.deepEqual(app, JSON.parse(JSON.stringify(worker)));
});

test("muted leagues are left out of lineup alerts", async () => {
  const env = newEnv(), phone = await device();
  await db.ensureSchema(env.DB);
  await db.saveSub(env.DB, { endpoint: phone.endpoint, ...phone.keys, sleeperUsername: "aj", prefs: { rankings: false, recap: false, waivers: false, muted: ["L2"] }, tz: "America/New_York" });
  state.injuries = { "1": "Out" };
  try {
    await runReminders(env, { season: "2026", week: 11, newBoone: false, now: Date.parse("2026-11-01T16:00:00Z") });
    const [msg] = await Promise.all(pushesTo(phone).map((p) => phone.decrypt(p.body)));
    assert.match(msg.body, /Sleeper League: Bijan Robinson is out/);
    assert.doesNotMatch(msg.body, /Half League/);
  } finally { state.injuries = {}; }
});
