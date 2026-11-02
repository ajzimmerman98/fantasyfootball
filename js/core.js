// Shared basics: constants, helpers, rankings-list parsing and player matching, Sleeper and ESPN loading.
// Loaded as a plain script by index.html, in order; files share one global scope.
const API="https://api.sleeper.app/v1";
const DEBUG=/[?&]debug\b/.test(location.search);
const STRICT=new Set(["QB","RB","WR","TE","K","DEF"]);
const FLEX={FLEX:["RB","WR","TE"],REC_FLEX:["WR","TE"],WRRB_FLEX:["WR","RB"],SUPER_FLEX:["QB","RB","WR","TE"]};
const FLEX_ORDER=["REC_FLEX","WRRB_FLEX","FLEX","SUPER_FLEX"];
const NON=new Set(["BN","IR","TAXI"]);
const OUT=new Set(["Out","IR","PUP","Sus","NA","COV"]);
const ALIAS={QB:"QB",RB:"RB",WR:"WR",TE:"TE",K:"K",FLEX:"FLEX",SUPERFLEX:"SUPERFLEX",SUPER_FLEX:"SUPERFLEX",DST:"DEF",DEF:"DEF","D/ST":"DEF"};
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const store={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};

function norm(s){return s.toLowerCase().replace(/[.'’]/g,"").replace(/[^a-z0-9\s]/g," ").replace(/\b(jr|sr|ii|iii|iv)\b/g,"").split(/\s+/).filter(Boolean).join(" ")}
function sim(a,b){const m=a.length,n=b.length;if(!m||!n)return 0;let p=Array.from({length:n+1},(_,j)=>j);for(let i=1;i<=m;i++){const c=[i];for(let j=1;j<=n;j++)c[j]=Math.min(p[j]+1,c[j-1]+1,p[j-1]+(a[i-1]===b[j-1]?0:1));p=c}return 1-p[n]/Math.max(m,n)}

function clean(line,sec){
  line=line.trim();if(!line||line.startsWith("//"))return null;
  let parts=line.split("\t").map(p=>p.trim()).filter(Boolean);
  while(parts.length&&/^[\d.)#:\-]+$/.test(parts[0]))parts.shift();
  if(!parts.length)return null;
  let s=parts[0].replace(/^\s*#?\d+\s*[.):\-]?\s+/,"");
  s=s.split(/\s*(?:,|\(|\s-\s|\svs\.?\s|\s@\s|\|)/)[0];
  if(sec==="DEF")s=s.replace(/\s*\b(d\/st|dst|defense)\b/i,"");
  return s.trim()||null;
}
function junk(n){return !/[a-z]/i.test(n)||n.length<3||/^tier\s*\d+$/i.test(n)||/^[A-Z]{2,4}$/.test(n)||/^(vs\.?|bye|out|ir|q|d)$/i.test(n)||/^(vs\.?|@|at)\s/i.test(n)}
// Team info parsed from lines like "1. Josh Allen (BUF)" lets lookup() tell apart players with the same or similar names
const META=new WeakMap();
function lineTeam(raw){
  const ok=t=>{t=teamKey(t);return t in STADIUMS?t:null};
  const m=raw.match(/\(([A-Z]{2,3})\b/);if(m&&ok(m[1]))return ok(m[1]);
  for(const x of raw.split("\t").slice(1))if(ok(x.trim()))return ok(x.trim());
  return null;
}
function parseList(text,sec){
  const r={},team={},nt={},byTeam={},pr={},prNt={},posCount={};let c=0;
  for(const raw of (text||"").split(/\r?\n/)){
    const name=clean(raw,sec);
    if(!name||junk(name))continue;
    const k=norm(name);if(!k)continue;
    const t=lineTeam(raw),dup=k in r;
    if(dup&&!t)continue;
    // Use the rank written on the line ("41. Name" or "41<tab>Name") when present, so displayed ranks match the source
    const num=+((raw.match(/^\s*#?(\d{1,3})(?:[.):\-\s]|$)/)||[])[1]||0);
    const rank=c=num>c?num:c+1;
    // Position rank ("RB12") when the line says the position, e.g. "30. Chuba Hubbard (CAR, RB)"
    const pm=raw.match(/\([A-Z]{2,3}[,\s\-]+(QB|RB|WR|TE|K|DST|DEF)\)/),prl=pm?pm[1]+(posCount[pm[1]]=(posCount[pm[1]]||0)+1):null;
    if(!dup){r[k]=rank;if(t)team[k]=t;if(prl)pr[k]=prl}
    if(t){if(!(k+"|"+t in nt)){nt[k+"|"+t]=rank;if(prl)prNt[k+"|"+t]=prl}if(!(t in byTeam))byTeam[t]=rank}
  }
  META.set(r,{team,nt,byTeam,pr,prNt});
  return r;
}
const LISTS=[["QB","Quarterbacks"],["FLEX","FLEX (RB / WR / TE)"],["K","Kickers"],["DEF","Defenses"]];
function ago(ts){const m=Math.round((Date.now()-ts)/60000);return m<1?"just now":m<60?m+"m ago":m<1440?Math.round(m/60)+"h ago":Math.round(m/1440)+"d ago"}
const fmtTime=ms=>new Date(ms).toLocaleString([],{weekday:"short",hour:"numeric",minute:"2-digit"});
// Finds player p in a parsed list. Returns {kind,key}: kind "nt" = name|team key, "name" = name key, "team" = DEF by team
function findEntry(table,p){
  if(!table)return null;
  const meta=META.get(table)||{},team=teamKey(p.t);
  if(p.p==="DEF"){
    if(team&&meta.byTeam&&team in meta.byTeam)return{kind:"team",key:team};
    const mas=norm(p.l||""),city=norm(p.f||"");
    for(const k of [`${city} ${mas}`.trim(),mas])if(k in table)return{kind:"name",key:k};
    for(const k in table)if(mas&&k.endsWith(mas))return{kind:"name",key:k};
    return null;
  }
  const keys=[norm(p.n||""),norm(`${p.f||""} ${p.l||""}`)].filter(Boolean);
  if(team&&meta.nt)for(const k of keys)if(k+"|"+team in meta.nt)return{kind:"nt",key:k+"|"+team};
  // When both the list and Sleeper give a team, they must agree (two players can share a name)
  const wrongTeam=t=>team&&meta.team&&meta.team[t]&&meta.team[t]!==team;
  for(const k of keys)if(k in table&&!wrongTeam(k))return{kind:"name",key:k};
  // Fuzzy match for nicknames and suffixes
  for(const k of keys){let best=null,bs=0;for(const t in table){if(wrongTeam(t))continue;const s=sim(k,t);if(s>bs){bs=s;best=t}}if(bs>=0.88)return{kind:"name",key:best}}
  return null;
}
function lookup(table,p){const e=findEntry(table,p);if(!e)return null;const m=META.get(table)||{};return e.kind==="nt"?m.nt[e.key]:e.kind==="team"?m.byTeam[e.key]:table[e.key]}
function lookupPosRank(table,p){const e=findEntry(table,p);if(!e)return null;const m=META.get(table)||{};return(e.kind==="nt"?m.prNt:e.kind==="name"?m.pr:null)?.[e.key]||null}

// fresh=true adds a cache-buster so lineup changes made in the Sleeper app show up immediately
async function api(path,fresh){const url=API+path+(fresh?(path.includes("?")?"&":"?")+"_="+Date.now():"");const r=await fetch(url,{cache:"no-store"});if(!r.ok)throw new Error(`Sleeper error ${r.status} on ${path}`);return r.json()}
async function loadPlayers(force){
  const raw=store.get("players_v1");
  if(!force&&raw){try{const o=JSON.parse(raw);if(Date.now()-o.ts<12*3600e3)return o.data}catch(e){}}
  const all=await api("/players/nfl");const data={};
  for(const id in all){const x=all[id];
    if(!STRICT.has(x.position))continue;
    if(x.position!=="DEF"&&!x.team&&!x.active)continue;
    data[id]={n:x.full_name||`${x.first_name||""} ${x.last_name||""}`.trim(),f:x.first_name,l:x.last_name,p:x.position,t:x.team,i:x.injury_status};
  }
  store.set("players_v1",JSON.stringify({ts:Date.now(),data}));
  return data;
}

// Week-specific starters from matchups are the most accurate; fall back to the roster's starters
function currentStarters(roster,matchups,week){
  const m=Array.isArray(matchups)?matchups.find(x=>x.roster_id===roster.roster_id):null;
  if(m&&Array.isArray(m.starters)&&m.starters.length)return{starters:m.starters,src:`week ${week} matchup`};
  return{starters:roster.starters||[],src:roster._espn?"ESPN lineup":"roster (no matchup data for this week)"};
}

// Shared by every tab: user, leagues, my roster and current starters in each league, player data
// reuse = an automatic tab load: share a Sleeper load from the last minute instead of fetching again.
// Buttons always load fresh, so lineup changes just made in the Sleeper app show up.
let SLC=null;
function loadSleeper(user,force,st,reuse){
  if(reuse&&!force&&SLC&&SLC.user===user&&Date.now()-SLC.ts<60e3)return SLC.p;
  const p=loadSleeperFresh(user,force,st);SLC={user,ts:Date.now(),p};
  p.catch(()=>{if(SLC&&SLC.p===p)SLC=null});
  return p;
}
async function loadSleeperFresh(user,force,st){
  st.textContent="Loading Sleeper data…";
  const [state,u]=await Promise.all([api("/state/nfl",true),api("/user/"+encodeURIComponent(user))]);
  if(!u||!u.user_id)throw new Error("Sleeper user not found.");
  const week=state.display_week||state.week;
  const leagues=await api(`/user/${u.user_id}/leagues/nfl/${state.season}`,true);
  let players=await loadPlayers(force);
  const [rosters,matchups]=await Promise.all([
    Promise.all(leagues.map(l=>api(`/league/${l.league_id}/rosters`,true))),
    Promise.all(leagues.map(l=>week?api(`/league/${l.league_id}/matchups/${week}`,true).catch(()=>null):null))
  ]);
  const espnErrors=await addEspn(+state.season,u.user_id,leagues,rosters,matchups,players,st);
  const mineAll=leagues.map((lg,i)=>rosters[i].find(r=>r.owner_id===u.user_id));
  const curAll=mineAll.map((r,i)=>r?currentStarters(r,matchups[i],week):null);
  // A rostered player missing from cached player data (new signing, position change) breaks the start/sit diff, so refresh once
  const needed=mineAll.flatMap((r,i)=>r?[...(r.players||[]),...realIds(curAll[i].starters)]:[]).filter(id=>!String(id).startsWith("espn:"));
  if(!force&&needed.some(id=>!players[id])){players={...await loadPlayers(true),...espnPlayers(leagues)}}
  // Remember this user's Sleeper leagues for the Reminders card's per-league switches
  try{store.set("rem_leagues",JSON.stringify(leagues.filter(l=>l.provider!=="espn").map(l=>({id:l.league_id,name:l.name}))));if(typeof remLeaguesUI==="function")remLeaguesUI()}catch(e){}
  return{state,week,leagues,players,rosters,matchups,mineAll,curAll,userId:u.user_id,espnErrors};
}
// ESPN leagues come from the Worker already in Sleeper's shape; merge them in so every tab handles them the same way
const espnIds=()=>(store.get("espn_leagues")||"").split(/[\s,]+/).filter(x=>/^\d{1,12}$/.test(x));
const espnPlayers=leagues=>Object.assign({},...leagues.filter(l=>l.provider==="espn").map(l=>l._players));
async function addEspn(season,myId,leagues,rosters,matchups,players,st){
  if(!synced()||!espnIds().length)return[];
  st.textContent="Loading ESPN leagues…";
  let d;try{d=await me("/espn?season="+season)}catch(e){return[{leagueId:"ESPN",error:e.message}]}
  for(const L of d.leagues){
    const names={};
    const rs=L.teams.map(t=>{const owner=t.mine?myId:t.owner_id;names[owner]=t.team_name+(t.owner_name?` (${t.owner_name})`:"");return{roster_id:t.roster_id,owner_id:owner,players:t.players,starters:t.starters,reserve:t.reserve,_espn:true}});
    leagues.push({league_id:L.league_id,name:L.name+" · ESPN",provider:"espn",total_rosters:L.teams.length,roster_positions:L.roster_positions,scoring_settings:L.scoring_settings,_names:names,_players:L.players});
    rosters.push(rs);matchups.push(null);Object.assign(players,L.players);
  }
  return d.errors||[];
}
