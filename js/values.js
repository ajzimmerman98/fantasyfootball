// Trade values: Justin Boone's charts and FantasyCalc (via the Worker), league formats, trends.
// Loaded as a plain script by index.html, in order; files share one global scope.
// ---------- Trade values (via the Cloudflare Worker in worker/) ----------
const API_BASE_DEFAULT="https://boone-api.ajzimmerman98.workers.dev"; // Cloudflare Worker (worker/). Can be overridden with ?api=<url>
{const q=new URLSearchParams(location.search).get("api");if(q)store.set("api_url",q.replace(/\/+$/,""))}
const apiBase=()=>store.get("api_url")||API_BASE_DEFAULT;
let TV=null; // {data, idx:{QB:{normName:values}}}
function indexTV(data){
  // what = "values" (per-format values) or "rank" (Justin Boone's rank at the position)
  const ix=(charts,what)=>{const idx={};for(const [pos,c] of Object.entries(charts||{})){idx[pos]={};(c.players||[]).forEach((p,i)=>{const k=norm(p.name);if(k&&!(k in idx[pos]))idx[pos][k]=what==="rank"?p.rank||i+1:p.values})}return idx};
  return{data,idx:ix(data.charts,"values"),prev:ix(data.prev,"values"),rk:ix(data.charts,"rank"),prk:ix(data.prev,"rank")};
}
async function ensureTV(force){
  if(!apiBase())throw new Error("Trade values need the Cloudflare Worker, which isn't connected yet.");
  if(!force&&TV&&Date.now()-TV.ts<6*3600e3&&["QB","RB","WR","TE"].every(p=>TV.data.charts?.[p]))return TV;
  // A saved copy missing positions (e.g. Yahoo only gave one chart) isn't reused: fetch again
  const full=d=>d&&d.charts&&["QB","RB","WR","TE"].every(p=>d.charts[p]);
  if(!force)try{const c=JSON.parse(store.get("tv_cache")||"null");if(c&&full(c.data)&&Date.now()-c.ts<6*3600e3){TV={...indexTV(c.data),ts:c.ts};return TV}}catch(e){}
  let r;try{r=await fetch(apiBase()+"/trade-values"+(force?"?refresh=1":""),{cache:"no-store"})}catch(e){throw new Error("Couldn't reach the trade values service.")}
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data.charts)throw new Error(data.error||`Trade values service error ${r.status}`);
  store.set("tv_cache",JSON.stringify({ts:Date.now(),data}));
  TV={...indexTV(data),ts:Date.now()};return TV;
}
// Boone has HALF and PPR columns (standard scoring uses HALF, the closest) and 1QB / 2QB for quarterbacks.
// FantasyCalc takes the exact format: ppr 0 / 0.5 / 1, 1 or 2 QBs, and the number of teams.
function leagueFormat(lg){
  const rec=+(lg.scoring_settings||{}).rec||0,rp=lg.roster_positions||[];
  return{sc:rec>=0.75?"PPR":"HALF",qb:rp.includes("SUPER_FLEX")||rp.filter(x=>x==="QB").length>1?"2QB":"1QB",ppr:rec>=0.75?1:rec>=0.25?0.5:0,teams:+lg.total_rosters||12};
}
const fmtLabel=f=>`${f.sc==="PPR"?"PPR":"Half-PPR"} · ${f.qb==="2QB"?"Superflex":"1QB"}`;
const TV_SRC={boone:"Justin Boone's",fc:"FantasyCalc",avg:"Justin Boone + FantasyCalc average"};
const tvSrc=()=>TV_SRC[$("tr_vsrc").value]?$("tr_vsrc").value:"boone";
const tvName=()=>TV_SRC[tvSrc()];
// Exact name in the position's index, then a close fuzzy match (nicknames, suffixes)
function matchIdx(t,p){
  if(!t||!p)return null;
  const keys=[norm(p.n||""),norm(`${p.f||""} ${p.l||""}`)].filter(Boolean);
  for(const k of keys)if(k in t)return t[k];
  for(const k of keys){let best=null,bs=0;for(const n in t){const x=sim(k,n);if(x>bs){bs=x;best=n}}if(bs>=0.9)return t[best]}
  return null;
}
function tvBoone(p,fmt,prev){
  if(!TV||!p)return null;const v=matchIdx((prev?TV.prev:TV.idx)?.[p.p],p);if(!v)return null;
  const val=p.p==="QB"?v[fmt.qb]:v[fmt.sc];
  return typeof val==="number"?val:null;
}
// ---- FantasyCalc (via the Worker), one value set per league format ----
const FC={}; // format key -> {ts, data, sid:{sleeperId:value}, idx:{pos:{normName:value}}}
const fcKey=f=>`${f.ppr}|${f.qb==="2QB"?2:1}|${f.teams}`;
// FantasyCalc lookups by Sleeper id and by position + name: value, rank at the position (by value), 30-day trend,
// and the same for last week's copy (data.prev, from the Worker's weekly history) when there is one
function indexFC(data){
  const build=(players,field)=>{const sid={},idx={},rank={};
    for(const pos of ["QB","RB","WR","TE"])(players||[]).filter(p=>p.pos===pos).sort((a,b)=>b.value-a.value).forEach((p,i)=>{rank[p.sid||pos+"|"+norm(p.name)]=i+1});
    for(const p of players||[]){const v=field==="rank"?rank[p.sid||p.pos+"|"+norm(p.name)]:p[field];if(p.sid)sid[p.sid]=v;const t=idx[p.pos]||(idx[p.pos]={}),k=norm(p.name);if(k&&!(k in t))t[k]=v}
    return{sid,idx}};
  const cur=build(data.players,"value"),tr=build(data.players,"trend"),rk=build(data.players,"rank"),pv=data.prev?build(data.prev.players,"value"):null,prk=data.prev?build(data.prev.players,"rank"):null;
  return{data,sid:cur.sid,idx:cur.idx,tsid:tr.sid,tidx:tr.idx,rk,pv,prk};
}
async function ensureFC(fmt){
  const k=fcKey(fmt);
  if(FC[k]&&Date.now()-FC[k].ts<6*3600e3)return FC[k];
  try{const c=JSON.parse(store.get("fc_"+k)||"null");if(c&&Date.now()-c.ts<6*3600e3)return FC[k]={...indexFC(c.data),ts:c.ts}}catch(e){}
  if(!apiBase())throw new Error("FantasyCalc values need the Cloudflare Worker.");
  let r;try{r=await fetch(`${apiBase()}/trade-values/fantasycalc?ppr=${fmt.ppr}&qbs=${fmt.qb==="2QB"?2:1}&teams=${fmt.teams}`,{cache:"no-store"})}catch(e){throw new Error("Couldn't reach the trade values service.")}
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data.players)throw new Error(data.error||`FantasyCalc error ${r.status}`);
  store.set("fc_"+k,JSON.stringify({ts:Date.now(),data}));
  return FC[k]={...indexFC(data),ts:Date.now()};
}
function tvFC(p,fmt,id,trend){
  const d=FC[fcKey(fmt)];if(!d||!p)return null;
  if(id&&d.sid[id]!=null)return trend?d.tsid?.[id]??null:d.sid[id]; // Sleeper players match exactly by id
  return matchIdx(trend?d.tidx?.[p.p]:d.idx[p.p],p);
}
// The chosen source's value for a player in a league format. id = Sleeper player id, when known.
function tradeValue(p,fmt,id){
  const s=tvSrc();
  if(s==="boone")return tvBoone(p,fmt);
  if(s==="fc")return tvFC(p,fmt,id);
  const a=tvBoone(p,fmt),b=tvFC(p,fmt,id);
  return a==null?b:b==null?a:Math.round((a+b)/2);
}
// Feed health for trade values: the Worker served an older copy because the live source failed
function valueWarns(s=tvSrc()){
  const out=[];
  if(s!=="fc"&&TV&&TV.data.stale)out.push(`Justin Boone's trade values couldn't be refreshed (${TV.data.staleReason}), so you're seeing the last copy that loaded.`);
  if(s!=="boone")for(const x of Object.values(FC))if(x.data.stale)out.push(`FantasyCalc values couldn't be refreshed (${x.data.staleReason}), so you're seeing the last copy that loaded.`);
  return out;
}
// Trends, week over week: { d: change (value points, or places moved up at the position), label: e.g. "RB12" in rank mode }.
// Justin Boone: since his previous weekly chart. FantasyCalc: since last week's copy (until there is one, its own
// 30-day change, by value only). Average of both: none.
const trendMode=()=>store.get("tv_trend")==="rank"?"rank":"value";
function trendFor(src,p,fmt,id){
  if(!p)return null;
  const rank=trendMode()==="rank";
  if(src==="boone"){if(!TV)return null;
    if(rank){const a=matchIdx(TV.rk?.[p.p],p),b=matchIdx(TV.prk?.[p.p],p);return a==null?null:{d:b==null?0:b-a,label:p.p+a}}
    const a=tvBoone(p,fmt),b=tvBoone(p,fmt,true);return a==null||b==null?null:{d:a-b}}
  if(src==="fc"){const x=FC[fcKey(fmt)];if(!x)return null;
    const get=m=>m?(id&&m.sid[id]!=null?m.sid[id]:matchIdx(m.idx[p.p],p)):null;
    if(rank){const a=get(x.rk),b=get(x.prk);return a==null?null:{d:b==null?0:b-a,label:p.p+a}}
    const a=get({sid:x.sid,idx:x.idx});if(a==null)return null;
    if(x.pv){const b=get(x.pv);return b==null?null:{d:a-b}}
    const t=get({sid:x.tsid,idx:x.tidx});return typeof t==="number"?{d:t}:null}
  return null;
}
function tradeTrend(p,fmt,id){const s=tvSrc();return s==="avg"?null:trendFor(s,p,fmt,id)}
const trendHtml=t=>!t?"":(t.label?` <span class="r">${esc(t.label)}</span>`:"")+(t.d?` <span class="${t.d>0?"tr-up":"tr-dn"}">${t.d>0?"▲":"▼"}${Math.abs(t.d)}</span>`:"");
const trendText=t=>!t?"":(t.label?` · ${t.label}`:"")+(t.d?` (${t.d>0?"▲":"▼"}${Math.abs(t.d)})`:"");
// Load whatever the chosen source needs for these leagues. Returns a list of problems (empty when all loaded).
async function ensureValues(leagues,force){
  const s=tvSrc(),errs=[];
  if(s!=="fc")await ensureTV(force).catch(e=>errs.push("Justin Boone: "+e.message));
  if(s!=="boone"){const fmts={};for(const lg of leagues)fmts[fcKey(leagueFormat(lg))]=leagueFormat(lg);
    await Promise.all(Object.values(fmts).map(f=>ensureFC(f).catch(e=>errs.push("FantasyCalc: "+e.message))))}
  return[...new Set(errs)];
}

