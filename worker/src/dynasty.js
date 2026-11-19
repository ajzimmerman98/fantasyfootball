// Dynasty trade values for dynasty leagues, from Dynasty Daddy's public API (https://dynasty-daddy.com), no key.
// Its "market" picks whose values: 14 = Dynasty Daddy's own, 0 = KeepTradeCut (Dynasty Daddy mirrors KeepTradeCut's
// values daily; they match keeptradecut.com to within a few points). Each player comes with his Sleeper id, a 1QB and
// a superflex value, and the same from a month ago (for trends).

const URL_BASE = "https://dynasty-daddy.com/api/v1/player/all/today";
export const MARKETS = { dd: { id: 14, name: "Dynasty Daddy" }, ktc: { id: 0, name: "KeepTradeCut" } };
const POS = new Set(["QB", "RB", "WR", "TE"]); // same positions as the other value sources (draft picks are left out)

// Values run to about 10,000; each column is rescaled so its top player is 100, like the other sources.
// Trends are the change since a month ago, on the same scale.
export function parseDynasty(arr) {
  if (!Array.isArray(arr)) throw new Error("Dynasty Daddy returned an unexpected format");
  const rows = arr
    .filter((x) => x && POS.has(x.position) && x.full_name && (+x.trade_value > 0 || +x.sf_trade_value > 0))
    .map((x) => ({ name: x.full_name, pos: x.position, team: x.team || null, sid: x.sleeper_id ? String(x.sleeper_id) : null, age: x.age ?? null,
      r1: +x.trade_value || 0, rsf: +x.sf_trade_value || 0, l1: +x.last_month_value || 0, lsf: +x.last_month_value_sf || 0 }));
  if (!rows.length) throw new Error("Dynasty Daddy returned no players");
  const m1 = Math.max(...rows.map((p) => p.r1)) || 1, msf = Math.max(...rows.map((p) => p.rsf)) || 1;
  const sc = (v, m) => Math.max(0, Math.round((v / m) * 100));
  return rows.map(({ r1, rsf, l1, lsf, ...p }) => ({
    ...p, v1: sc(r1, m1), vsf: sc(rsf, msf),
    // A month-ago value of 0 means there wasn't one (a new player): no trend rather than a huge jump
    t1: l1 > 0 ? sc(r1, m1) - sc(l1, m1) : null, tsf: lsf > 0 ? sc(rsf, msf) - sc(lsf, msf) : null,
  })).sort((a, b) => b.vsf - a.vsf);
}

export async function loadDynasty(market) {
  const mk = MARKETS[market];
  if (!mk) throw new Error("Unknown dynasty values source.");
  const r = await fetch(`${URL_BASE}?market=${mk.id}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Dynasty Daddy returned ${r.status}`);
  return { source: mk.name, market, fetchedAt: new Date().toISOString(), players: parseDynasty(await r.json()) };
}
