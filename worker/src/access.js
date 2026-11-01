// Cloudflare Access login. When Access protects this Worker's address, every request carries a signed token
// (Cf-Access-Jwt-Assertion header, also the CF_Authorization cookie). It's checked here against the team's public keys,
// so a request that didn't come through Access can't claim to be someone.
// Settings (Worker secrets): ACCESS_TEAM_DOMAIN (e.g. "yourteam.cloudflareaccess.com"), ACCESS_AUD (the application's audience tag).

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));
const team = (env) => String(env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");

let certs = null; // { team, ts, keys }
async function keysFor(t, kid) {
  const fresh = certs && certs.team === t && Date.now() - certs.ts < 3600e3;
  if (!fresh || !certs.keys.some((k) => k.kid === kid)) {
    const r = await fetch(`https://${t}/cdn-cgi/access/certs`);
    if (!r.ok) throw new Error(`Couldn't load Access keys (${r.status})`);
    certs = { team: t, ts: Date.now(), keys: (await r.json()).keys || [] };
  }
  return certs.keys.find((k) => k.kid === kid) || null;
}

function token(request) {
  const h = request.headers.get("Cf-Access-Jwt-Assertion");
  if (h) return h;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

// Returns the signed-in email, or null when there's no valid Access token
export async function accessEmail(request, env) {
  const t = team(env), jwt = token(request);
  if (!t || !env.ACCESS_AUD || !jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = json(parts[0]); payload = json(parts[1]); } catch { return null; }
  if (header.alg !== "RS256") return null;
  const jwk = await keysFor(t, header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const now = Date.now() / 1000, aud = [].concat(payload.aud || []);
  if (!aud.includes(env.ACCESS_AUD) || payload.iss !== `https://${t}` || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60)) return null;
  return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
}
