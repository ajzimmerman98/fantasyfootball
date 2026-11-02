// Rankings loader: Justin Boone, FantasyPros, Sleeper projections (Worker first, direct fallback); feed health.
// Loaded as a plain script by index.html, in order; files share one global scope.
// ---------- Rankings loader (Boone or FantasyPros consensus) ----------
// Yahoo's Boone articles embed a FantasyPros widget; 317 is Boone's FantasyPros expert id. Without the expert filter the same feed
// gives the FantasyPros consensus (ECR). Not an official API, so Paste stays as a fallback.
const FP_EXPERT="317",FP_POS={QB:"QB",FLEX:"FLX",K:"K",DEF:"DST"};
const SRC_NAME={boone:"Justin Boone",ecr:"FantasyPros",sleeper:"Sleeper projections"};
const srcLabel=(source,kind)=>source==="boone"?"Justin Boone's":source==="sleeper"?"Sleeper projections":source==="tvboone"?"Justin Boone's trade value":source==="tvfc"?"FantasyCalc trade value":kind==="ros"?"FantasyPros rest-of-season":"FantasyPros";
function jsonp(url){
  return new Promise((ok,no)=>{
    const cb="fpcb_"+Math.random().toString(36).slice(2),s=document.createElement("script");
    const done=()=>{clearTimeout(t);delete window[cb];s.remove()};
    const t=setTimeout(()=>{done();no(new Error("FantasyPros didn't respond."))},20000);
    window[cb]=d=>{done();ok(d)};s.onerror=()=>{done();no(new Error("Couldn't reach FantasyPros."))};
    s.src=url+"&callback="+cb;document.head.appendChild(s);
  });
}
async function fetchFP(season,week,sec,scoring,source="boone",kind="week"){
  const boone=source==="boone";
  const q=new URLSearchParams({sport:"NFL",year:season,week:kind==="ros"?0:week,position:FP_POS[sec],scoring:sec==="FLEX"?scoring:"STD",type:kind==="ros"?"ROS":"ST"});
  if(boone){q.set("experts","show");q.set("filters",FP_EXPERT);q.set("widget","ST")}
  const d=await jsonp("https://partners.fantasypros.com/api/v1/consensus-rankings.php?"+q);
  const who=(d.expert_names||{})[FP_EXPERT];
  if(boone&&who&&!/boone/i.test(who))throw new Error(`FantasyPros expert ${FP_EXPERT} is now "${who}", not Boone. Paste lists for now.`);
  // rank_ecr is the 1..N numbering Yahoo's widget displays (Boone's raw ranks have gaps for players FantasyPros dropped)
  const ps=(d.players||[]).map(p=>({r:+(p.rank_ecr||(boone&&(p.experts||{})[FP_EXPERT])),n:p.player_name,t:teamKey(p.player_team_id),pos:sec==="FLEX"?(p.player_positions||"").split(",")[0]:"",o:typeof p.player_owned_avg==="number"?Math.round(p.player_owned_avg):null}))
    .filter(p=>p.r&&p.n).sort((a,b)=>a.r-b.r);
  const pubStr=boone&&(d.expert_pub||{})[FP_EXPERT],pub=pubStr?Date.parse(pubStr.replace(" ","T")+"Z"):(d.last_updated_ts||0)*1000;
  return{ps,pub};
}
async function sleeperWeek(){
  const state=await api("/state/nfl",true),week=state.display_week||state.week;
  store.set("cur_week",String(week));return{season:state.season,week};
}
// "FA" stands in for an unknown team so the position (and so the position rank) is still read
const listText=ps=>ps.map(p=>`${p.r}. ${p.n}${p.t||p.pos?` (${p.t||"FA"}${p.pos?", "+p.pos:""})`:""}`).join("\n");
const feedName=(source,kind)=>source==="sleeper"?"Sleeper projections":`${srcLabel(source,kind)} rankings`;
// Feed-health banner: shows each distinct warning (or hides when there are none)
function showWarn(id,msgs){const m=[...new Set(msgs.filter(Boolean))],el=$(id);if(!el)return;el.hidden=!m.length;el.innerHTML=m.map(x=>`<div>⚠️ ${esc(x)}</div>`).join("")}
// One entry per LISTS item: {ps,pub} or {err}. Prefer the Worker (no third-party script in the page, and it saves each version
// for "expired" checks); JSONP as fallback. Cached for a few minutes so tabs can share a load.
const RL_CACHE={};
async function rankLists(source,kind,season,week,scoring){
  const ck=[source,kind,season,week,scoring].join("|"),c=RL_CACHE[ck];
  if(c&&Date.now()-c.ts<5*60e3)return c.res;
  let res=null;
  if(apiBase())try{
    const r=await fetch(`${apiBase()}/rankings?season=${season}&week=${week}&scoring=${scoring}&source=${source}&kind=${kind}`,{cache:"no-store"}),d=await r.json();
    if(r.status===409)return LISTS.map(()=>({err:new Error(d.error)}));
    if(r.ok&&d.lists){res=LISTS.map(([k])=>{const l=d.lists[k];return l?{ps:l.players.map(p=>({...p,t:teamKey(p.t)})),pub:l.pub,saved:l.source==="saved"}:{ps:[],pub:0}});
      // Feed health: the Worker fell back to its saved copy because the live feed failed
      const sv=res.filter(x=>x.saved);
      if(sv.length)res.warn=`${feedName(source,kind)} couldn't be refreshed${d.errors&&d.errors.length?` (${d.errors[0].replace(/^\w+(:\w+)?: /,"")})`:""}, so you're seeing the saved copy from ${fmtTime(Math.max(...sv.map(x=>x.pub)))}.`;
      else if(d.errors&&d.errors.length&&res.some(x=>x.ps.length))res.warn=`Some ${feedName(source,kind)} lists didn't load: ${d.errors.map(e=>e.split(":")[0]).join(", ")}.`;
    }
  }catch(e){}
  const viaWorker=!!res;
  if(!res)res=source==="sleeper"?await sleeperDirect(season,week,scoring).catch(e=>LISTS.map(()=>({err:e})))
    :await Promise.all(LISTS.map(([k])=>fetchFP(season,week,k,scoring,source,kind).catch(e=>({err:e}))));
  if(!viaWorker&&apiBase()&&res.some(r=>r.ps&&r.ps.length))res.warn=`Couldn't reach the app's server, so ${feedName(source,kind)} came straight from the source (no saved copy if that fails).`;
  if(res.some(r=>r.ps&&r.ps.length))RL_CACHE[ck]={ts:Date.now(),res};
  return res;
}
// Sleeper's weekly projections straight from Sleeper, when the Worker isn't reachable (same lists the Worker builds)
async function sleeperDirect(season,week,scoring){
  const q=new URLSearchParams({season_type:"regular",order_by:"pts_ppr"});for(const p of ["QB","RB","WR","TE","K","DEF"])q.append("position[]",p);
  const r=await fetch(`https://api.sleeper.app/projections/nfl/${season}/${week}?${q}`,{cache:"no-store"});
  if(!r.ok)throw new Error(`Sleeper projections error ${r.status}`);
  const rows=await r.json();if(!Array.isArray(rows))throw new Error("Sleeper projections returned an unexpected format.");
  const want={QB:["QB"],FLEX:["RB","WR","TE"],K:["K"],DEF:["DEF"]};let pub=0;
  const all=rows.map(x=>{const p=x.player||{},pos=p.position||(p.fantasy_positions||[])[0];pub=Math.max(pub,+x.last_modified||+x.updated_at||0);
    return{n:`${p.first_name||""} ${p.last_name||""}`.trim(),t:teamKey(x.team||p.team||(pos==="DEF"?x.player_id:null)),pos,st:x.stats||{}}});
  return LISTS.map(([k])=>{const f=k==="FLEX"?(scoring==="HALF"?"pts_half_ppr":"pts_ppr"):"pts_std";
    const ps=all.map(p=>({...p,pts:+p.st[f]})).filter(p=>p.n&&want[k].includes(p.pos)&&p.pts>0).sort((a,b)=>b.pts-a.pts)
      .map((p,i)=>({r:i+1,n:p.n,t:p.t,pos:k==="FLEX"?p.pos:"",pts:Math.round(p.pts*10)/10}));
    return{ps,pub:ps.length?pub||Date.now():0}});
}
