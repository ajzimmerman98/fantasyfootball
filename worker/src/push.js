// Web Push (notifications to phones and browsers), written against WebCrypto so the Worker needs no packages.
// - VAPID (RFC 8292): the Worker's own key pair identifies it to the push services. Created on first use, kept in D1.
// - Message encryption (RFC 8291, "aes128gcm" from RFC 8188): only the subscribed device can read a notification.

const enc = new TextEncoder();
export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));

// Only the browser vendors' push services: a subscription can't make the Worker post anywhere else
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
export function validSubscription(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname) && unb64u(sub.keys.p256dh).length === 65 && unb64u(sub.keys.auth).length === 16;
  } catch { return false; }
}

// The Worker's VAPID key pair: { publicKey (base64url, raw P-256 point), privateJwk }
export async function vapidKeys(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'vapid'`).first();
  if (row) return JSON.parse(row.value);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = { publicKey: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
  await db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)`).bind(JSON.stringify(keys)).run();
  return JSON.parse((await db.prepare(`SELECT value FROM settings WHERE key = 'vapid'`).first()).value); // whichever was saved first
}

async function vapidHeader(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const h = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${h}.${p}`)); // raw r||s, as ES256 wants
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${keys.publicKey}`;
}

// RFC 8291: encrypt `payload` for one subscription. Returns the request body (header + one record).
export async function encryptPayload(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic); // record size 4096
  return concat(header, data);
}

// Send one notification. Returns "ok", "gone" (the device unsubscribed: delete it) or "error".
export async function sendPush(sub, message, keys, { subject = "https://ajzimmerman98.github.io/fantasyfootball/", ttl = 24 * 3600 } = {}) {
  const body = await encryptPayload(sub, JSON.stringify(message));
  const r = await fetch(sub.endpoint, { method: "POST", body, headers: {
    "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: "high",
    Authorization: await vapidHeader(sub.endpoint, keys, subject) } });
  if (r.status === 404 || r.status === 410) return "gone";
  return r.ok ? "ok" : "error";
}
