// Power Rankings tab and playoff odds (the Worker has the same simulation in worker/src/playoffs.js).
// Loaded as a plain script by index.html, in order; files share one global scope.
// ---------- Power rankings tab ----------
// Score = best starting lineup (full value) + depth (best bench players at decreasing weights), rest-of-season values.
const PW_DEPTH=[0.35,0.3,0.25,0.2,0.15,0.1];
const PW_SRC={boone:"Justin Boone trade values",ecr:"FantasyPros rest-of-season rankings",fc:"FantasyCalc trade values",
  "wk:boone":"Justin Boone's weekly rankings","wk:ecr":"FantasyPros weekly rankings","wk:sleeper":"Sleeper projections"};
const isWeekly=src=>src.startsWith("wk:");
// Weekly ranks -> estimated points, so ranked sources score the same way as Sleeper's projected points
const PTS_CURVE={QB:[26,0.975],FLEX:[24,0.985],K:[10,0.98],DEF:[10,0.97]};
const rankPts=(sec,r)=>{const [a,b]=PTS_CURVE[sec];return Math.round(a*Math.pow(b,r-1)*10)/10};
// FantasyPros gives ranks, not values: #1 = 100, falling ~1.5% per FLEX rank; QBs on their own curve (lower in 1QB leagues)
const fpCurve=(r,qb,sf)=>qb?(sf?100:40)*Math.pow(0.95,r-1):100*Math.pow(0.985,r-1);
let PW=null;
async function pwRun(auto){
  const user=$("user").value.trim(),st=$("pw_status"),src=$("pw_src").value;store.set("user",user);
  if(!user){st.textContent="Enter your Sleeper username.";return}
  $("pw_go").disabled=true;
  try{
    const sl=auto&&PW&&PW.user===user&&Date.now()-PW.ts<10*60e3?PW.sl:await loadSleeper(user,false,st,auto);
    const idx=sl.leagues.map((lg,i)=>sl.mineAll[i]?i:-1).filter(i=>i>=0);
    if(!idx.length)throw new Error("No leagues with your roster found.");
    st.textContent=`Loading ${PW_SRC[src]}…`;showWarn("pw_warn",[]);
    const fp={};let note="",warns=[];
    if(isWeekly(src)){const source=src.slice(3),scs=[...new Set(idx.map(i=>leagueFormat(sl.leagues[i]).sc))];let pub=0;
      const res=await Promise.all(scs.map(sc=>rankLists(source,"week",sl.state.season,sl.week,sc)));
      const fatal=res.flat().find(r=>r.err&&/not Boone/.test(r.err.message));if(fatal)throw fatal.err;
      scs.forEach((sc,j)=>{const t={};LISTS.forEach(([k],n)=>{const r=res[j][n];if(r.ps&&r.ps.length){t[k]={table:parseList(listText(r.ps),k),pts:Object.fromEntries(r.ps.map(p=>[p.r,p.pts]))};pub=Math.max(pub,r.pub)}});if(Object.keys(t).length)fp[sc]=t});
      if(!Object.keys(fp).length){const e=res.flat().find(r=>r.err);throw e?e.err:new Error(`${PW_SRC[src]} for week ${sl.week} aren't published yet.`)}
      warns=res.map(r=>r.warn);note=`${PW_SRC[src]}, week ${sl.week} (updated ${fmtTime(pub)}).`}
    else if(src==="boone"){await ensureTV();warns=valueWarns("boone");note=`Justin Boone's week ${TV.data.week} trade values.`}
    else if(src==="fc"){const fm={};for(const i of idx){const f=leagueFormat(sl.leagues[i]);fm[fcKey(f)]=f}
      await Promise.all(Object.values(fm).map(f=>ensureFC(f)));warns=valueWarns("fc");note=`FantasyCalc values (updated ${fmtTime(Math.max(...Object.values(FC).map(x=>Date.parse(x.data.fetchedAt)||x.ts)))}).`}
    else{const scs=[...new Set(idx.map(i=>leagueFormat(sl.leagues[i]).sc))];let pub=0;
      const res=await Promise.all(scs.map(sc=>rankLists("ecr","ros",sl.state.season,sl.week,sc)));
      scs.forEach((sc,j)=>{const t={};LISTS.forEach(([k],n)=>{const r=res[j][n];if((k==="QB"||k==="FLEX")&&r.ps&&r.ps.length){t[k]=parseList(listText(r.ps),k);pub=Math.max(pub,r.pub)}});if(Object.keys(t).length)fp[sc]=t});
      if(!Object.keys(fp).length){const e=res.flat().find(r=>r.err);throw e?e.err:new Error("FantasyPros rest-of-season rankings aren't available.")}
      warns=res.map(r=>r.warn);note=`FantasyPros rest-of-season rankings (updated ${fmtTime(pub)}).`}
    PW={user,ts:PW&&PW.sl===sl?PW.ts:Date.now(),sl,src,fp,users:PW&&PW.sl===sl?PW.users:{},odds:PW&&PW.sl===sl?PW.odds:{}};
    const last=store.get("pw_league");
    $("pw_league").innerHTML=idx.map(i=>`<option value="${i}">${esc(sl.leagues[i].name)}</option>`).join("");
    const keep=idx.find(i=>sl.leagues[i].league_id===last);if(keep!=null)$("pw_league").value=String(keep);
    $("pw_ui").hidden=false;
    await pwRender();
    st.textContent=note;showWarn("pw_warn",warns);
  }catch(e){st.innerHTML=`<span class="err">${esc(e.message)}</span>`}
  $("pw_go").disabled=false;
}
function pwValuer(lg){
  const f=leagueFormat(lg);
  if(isWeekly(PW.src)){const t=PW.fp[f.sc]||{},sleeper=PW.src==="wk:sleeper";
    return p=>{const k=p&&secOf(p.p),l=k&&t[k];if(!l||OUT.has(p.i))return null;const r=lookup(l.table,p);if(r==null)return null;return sleeper?l.pts[r]??null:rankPts(k,r)}}
  if(PW.src==="boone")return(p)=>tvBoone(p,f);
  if(PW.src==="fc")return(p,id)=>tvFC(p,f,id);
  const t=PW.fp[f.sc]||{};
  return p=>{if(!p)return null;
    if(p.p==="QB"){const r=t.QB?lookup(t.QB,p):null;return r==null?null:Math.round(fpCurve(r,true,f.qb==="2QB"))}
    if(["RB","WR","TE"].includes(p.p)){const r=t.FLEX?lookup(t.FLEX,p):null;return r==null?null:Math.round(fpCurve(r))}
    return null};
}
function pwScores(i){
  const {sl}=PW,lg=sl.leagues[i],v=pwValuer(lg),wk=isWeekly(PW.src),slots=(lg.roster_positions||[]).filter(s=>!NON.has(s)&&(wk||s!=="K"&&s!=="DEF"));
  const val={},pos={};
  for(const r of sl.rosters[i])for(const id of r.players||[]){const p=sl.players[id];if(!p)continue;pos[id]=p.p;val[id]=v(p,id)??0}
  return sl.rosters[i].map(r=>{
    const ids=activeIds(r),used=new Set(),starters=lineupStrength(ids,slots,val,pos,used);
    const bench=ids.filter(id=>!used.has(id)&&val[id]>0).sort((a,b)=>val[b]-val[a]);
    if(wk)return{r,starters:Math.round(starters*10)/10,depth:0,total:Math.round(starters*10)/10,lineup:[...used],bench:[],val};
    const depth=bench.slice(0,PW_DEPTH.length).reduce((t,id,k)=>t+val[id]*PW_DEPTH[k],0);
    return{r,starters,depth:Math.round(depth),total:Math.round(starters+depth),lineup:[...used],bench:bench.slice(0,PW_DEPTH.length),val};
  }).sort((a,b)=>b.total-a.total);
}
async function pwRender(){
  if(!PW)return;
  const i=+$("pw_league").value,{sl}=PW,lg=sl.leagues[i];store.set("pw_league",lg.league_id);
  if(!PW.users[lg.league_id])PW.users[lg.league_id]=lg.provider==="espn"?Object.entries(lg._names).map(([user_id,display_name])=>({user_id,display_name})):await api(`/league/${lg.league_id}/users`).catch(()=>[]);
  const names=Object.fromEntries(PW.users[lg.league_id].map(u=>[u.user_id,u.metadata?.team_name||u.display_name||"Team"]));
  const rows=pwScores(i),top=rows[0]?.total||1,f=leagueFormat(lg),wk=isWeekly(PW.src),est=wk&&PW.src!=="wk:sleeper";
  const nm=(id,val)=>{const p=sl.players[id];return`<div class="pl2"><span>${esc(p?.n||`${p?.f||""} ${p?.l||""}`)} <span class="r">${esc(p?.p||"")} ${esc(p?.t||"")}</span></span><b class="tv">${val[id]}</b></div>`};
  $("pw_out").innerHTML=`<div class="ok" style="margin:10px 0 4px">${esc(PW_SRC[PW.src])} · ${wk?(f.sc==="PPR"?"PPR":"Half-PPR"):esc(fmtLabel(f))}${PW.src==="fc"?` · ${f.teams} teams`:""}${wk?` · ${est?"estimated ":"projected "}points for week ${sl.week}`:""}. Tap a team for its lineup.</div>`+
    rows.map((x,k)=>{const mine=x.r.owner_id===sl.userId,who=names[x.r.owner_id]||`Team ${x.r.roster_id}`;
      const order=x.lineup.slice().sort((a,b)=>x.val[b]-x.val[a]);
      return`<details class="pw${mine?" me":""}"><summary><span class="rk">${k+1}</span><span class="nm">${esc(who)}${mine?' <span class="badge b-ok">You</span>':""}<div class="sub">${wk?`${x.lineup.length} starters · ${est?"est. ":""}points`:`Starters ${x.starters} · Depth ${x.depth}`}</div></span><span class="tot">${x.total}</span><span class="bar"><i style="width:${Math.max(2,Math.round(100*x.total/top))}%"></i></span></summary>`+
        `<div class="body"><h3>${wk?"This week's best lineup":"Starting lineup"}</h3>${order.map(id=>nm(id,x.val)).join("")||'<div class="ok">No valued players.</div>'}${wk?"":`<h3>Depth</h3>${x.bench.map(id=>nm(id,x.val)).join("")||'<div class="ok">No valued bench players.</div>'}`}</div></details>`}).join("");
  poShow(i).catch(()=>{});
}
// ---------- Playoff odds (Power Rankings tab) ----------
// Standard bracket order for B seeds: 8 -> 1,8,4,5,2,7,3,6 (seeds above the playoff field are byes)
function bracketOrder(B){let o=[1,2];while(o.length<B){const m=o.length*2+1;o=o.flatMap(x=>[x,m-x])}return o}
// teams: [{id, w, l, t, pf, mean, meanNow, unc}]; weeks: per remaining week, its games as [teamIdA, teamIdB] (week 0 = this week).
// Each team's score ~ normal(mean, ~22% of mean). `unc` = how unsure we are of a team's true strength (points per game):
// each simulated season shifts the team's later-week mean by a random amount of that size (injuries, trades, luck). Returns per-team playoff / bye / title chances, expected wins, seed odds,
// and for team index `me` the playoff chance after winning or losing this week.
function simulateSeason({teams,weeks,nPO,median=false,sims=10000,rng=Math.random,me=null}){
  const n=teams.length,idx=Object.fromEntries(teams.map((t,k)=>[t.id,k]));
  nPO=Math.max(1,Math.min(nPO,n));
  const B=1<<Math.ceil(Math.log2(Math.max(2,nPO))),byes=nPO>1?B-nPO:0,order=bracketOrder(B);
  const out=teams.map(()=>({po:0,bye:0,champ:0,wins:0,seed:new Array(nPO).fill(0)})),what={win:[0,0],lose:[0,0]};
  const randn=()=>{let u=0;while(!u)u=rng();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*rng())};
  for(let s=0;s<sims;s++){
    const W=teams.map(t=>t.w+t.t/2),PF=teams.map(t=>t.pf),off=teams.map(t=>(t.unc||0)*randn());let mine=null;
    const score=(k,now)=>{const m=now?teams[k].meanNow:teams[k].mean+off[k];return m+Math.max(12,0.22*m)*randn()};
    weeks.forEach((games,wi)=>{const sc=new Array(n).fill(null);
      for(const [a,b] of games){const ka=idx[a],kb=idx[b];if(ka==null||kb==null)continue;
        const x=score(ka,wi===0),y=score(kb,wi===0);sc[ka]=x;sc[kb]=y;PF[ka]+=x;PF[kb]+=y;
        if(x>y)W[ka]++;else if(y>x)W[kb]++;else{W[ka]+=0.5;W[kb]+=0.5}
        if(wi===0&&me!=null&&(ka===me||kb===me))mine=ka===me?x>y:y>x}
      if(median){const v=sc.filter(x=>x!=null).sort((p,q)=>p-q);if(v.length){const m=(v[(v.length-1)>>1]+v[v.length>>1])/2;sc.forEach((x,k)=>{if(x!=null&&x>m)W[k]++})}}
    });
    const seeds=teams.map((_,k)=>k).sort((p,q)=>W[q]-W[p]||PF[q]-PF[p]).slice(0,nPO);
    seeds.forEach((k,si)=>{out[k].po++;out[k].seed[si]++;if(si<byes)out[k].bye++});
    W.forEach((w,k)=>{out[k].wins+=w});
    let field=order.map(sd=>sd<=nPO?seeds[sd-1]:null);
    while(field.length>1){const nx=[];for(let j=0;j<field.length;j+=2){const a=field[j],b=field[j+1];nx.push(a==null?b:b==null?a:score(a)>score(b)?a:b)}field=nx}
    if(field[0]!=null)out[field[0]].champ++;
    if(mine!=null){const bk=mine?what.win:what.lose;bk[1]++;if(seeds.includes(me))bk[0]++}
  }
  return{byes,nPO,teams:out.map(r=>({po:r.po/sims,bye:r.bye/sims,champ:r.champ/sims,wins:r.wins/sims,seed:r.seed.map(x=>x/sims)})),
    what:{win:what.win[1]?what.win[0]/what.win[1]:null,lose:what.lose[1]?what.lose[0]/what.lose[1]:null}};
}
const PO_SHRINK=6,PO_UNC=7; // pull toward average (games' worth); strength uncertainty (points per game)
async function poCompute(i){
  const {sl}=PW,lg=sl.leagues[i],s=lg.settings||{},last=(+s.playoff_week_start||15)-1,cur=+sl.week||1,rosters=sl.rosters[i];
  if(cur>last)return{over:true};
  const weeksN=[];for(let w=cur;w<=last;w++)weeksN.push(w);
  const ms=await Promise.all(weeksN.map(w=>w===cur&&Array.isArray(sl.matchups?.[i])&&sl.matchups[i].length?sl.matchups[i]:api(`/league/${lg.league_id}/matchups/${w}`).catch(()=>[])));
  const weeks=ms.map(m=>{const by={};for(const x of m||[])if(x.matchup_id!=null)(by[x.matchup_id]||(by[x.matchup_id]=[])).push(x.roster_id);return Object.values(by).filter(g=>g.length===2)});
  if(!weeks.some(g=>g.length))return{noSchedule:true};
  // This week's projected points for each team's best lineup (players out or on bye count zero)
  const res=await rankLists("sleeper","week",sl.state.season,cur,leagueFormat(lg).sc).catch(()=>null),T={};
  if(res)LISTS.forEach(([k],n)=>{const r=res[n];if(r&&r.ps&&r.ps.length)T[k]={table:parseList(listText(r.ps),k),pts:Object.fromEntries(r.ps.map(p=>[p.r,p.pts]))}});
  const projOk=Object.keys(T).length>0;
  const pts=p=>{const k=p&&secOf(p.p),l=k&&T[k];if(!l||OUT.has(p.i))return 0;const r=lookup(l.table,p);return r==null?0:l.pts[r]||0};
  const slots=(lg.roster_positions||[]).filter(x=>!NON.has(x));
  const base=rosters.map(r=>{const st=r.settings||{},w=+st.wins||0,l=+st.losses||0,t=+st.ties||0,g=w+l+t,pf=(+st.fpts||0)+(+st.fpts_decimal||0)/100;
    const ids=activeIds(r),val={},pos={};for(const id of ids){const p=sl.players[id];if(p){pos[id]=p.p;val[id]=pts(p)}}
    return{id:r.roster_id,owner:r.owner_id,w,l,t,pf,g,ppg:g?pf/g:null,proj:lineupStrength(ids,slots,val,pos)}});
  // Later weeks: points per game so far, pulled toward the league average (a lot early in the season, less later:
  // about halfway after 7 games), since part of any team's scoring so far is luck. This week's projection isn't used
  // for later weeks: byes and injuries this week would wrongly follow a team all season.
  const played=base.filter(t=>t.ppg!=null),avg=played.length?played.reduce((a,t)=>a+t.ppg,0)/played.length:null;
  const projAvg=base.filter(t=>t.proj>0).reduce((a,t,_,x)=>a+t.proj/x.length,0)||100;
  const teams=base.map(t=>{const lg=avg??projAvg,mean=t.ppg!=null?lg+(t.g/(t.g+PO_SHRINK))*(t.ppg-lg):lg;
    return{...t,mean,meanNow:t.proj>0?t.proj:mean,unc:PO_UNC}});
  const me=teams.findIndex(t=>t.owner===sl.userId);
  const sim=simulateSeason({teams,weeks,nPO:+s.playoff_teams||6,median:+s.league_average_match===1,me:me>=0?me:null});
  return{teams,sim,weeksLeft:weeks.length,median:+s.league_average_match===1,cur,projOk};
}
async function poShow(i){
  const el=$("po_out"),{sl}=PW,lg=sl.leagues[i],card=b=>`<div class="card hcard po"><h2>Playoff odds</h2>${b}</div>`;
  if(lg.provider==="espn"){el.innerHTML=card('<div class="ok">Playoff odds aren\'t available for ESPN leagues yet.</div>');return}
  PW.odds=PW.odds||{};
  if(!PW.odds[lg.league_id]){el.innerHTML=card('<div class="ok">Simulating the rest of the season…</div>');PW.odds[lg.league_id]=poCompute(i)}
  let o;try{o=await PW.odds[lg.league_id]}catch(e){delete PW.odds[lg.league_id];el.innerHTML=card(`<div class="ok err">Couldn't work out playoff odds: ${esc(e.message)}</div>`);return}
  if(+$("pw_league").value!==i)return;
  if(o.over){el.innerHTML=card('<div class="ok">The regular season is over, so there are no playoff odds to work out.</div>');return}
  if(o.noSchedule){el.innerHTML=card('<div class="ok">Sleeper hasn\'t published the rest of this league\'s schedule.</div>');return}
  const names=Object.fromEntries((PW.users[lg.league_id]||[]).map(u=>[u.user_id,u.metadata?.team_name||u.display_name||"Team"]));
  const pc=x=>x>=0.995?">99%":x>0&&x<0.005?"<1%":Math.round(x*100)+"%",{sim}=o;
  const rows=o.teams.map((t,k)=>({t,r:sim.teams[k]})).sort((a,b)=>b.r.po-a.r.po||b.r.champ-a.r.champ||b.r.wins-a.r.wins);
  const meRow=rows.find(x=>x.t.owner===sl.userId);
  let h=`<div class="ok" style="margin-bottom:6px">${sim.nPO} of ${o.teams.length} teams make it${sim.byes?`, top ${sim.byes} get a bye`:""}${o.median?" · median games counted":""} · ${o.weeksLeft} week${o.weeksLeft>1?"s":""} left · 10,000 simulations${o.projOk?"":" · Sleeper projections unavailable, so points per game only"}.</div>`;
  if(meRow&&sim.what.win!=null&&sim.what.lose!=null)h+=`<div class="wi">Your playoff odds: <b>${pc(meRow.r.po)}</b> · if you win this week <b class="tr-up">${pc(sim.what.win)}</b> · if you lose <b class="tr-dn">${pc(sim.what.lose)}</b></div>`;
  h+=rows.map(({t,r})=>{const mine=t.owner===sl.userId,who=names[t.owner]||`Team ${t.id}`,games=t.g+o.weeksLeft,best=r.seed.indexOf(Math.max(...r.seed));
    return`<div class="hrow${mine?" me":""}"><span>${esc(who)}${mine?" (you)":""}</span><b>${pc(r.po)}</b>`+
      `<div class="m">${t.w}-${t.l}${t.t?"-"+t.t:""} now · projected ${r.wins.toFixed(1)} wins of ${games}${sim.byes?` · bye ${pc(r.bye)}`:""} · title ${pc(r.champ)}${r.po>=0.5?` · most likely seed ${best+1}`:""}</div>`+
      `<span class="bar2"><i style="width:${Math.round(r.po*100)}%"></i></span></div>`}).join("");
  el.innerHTML=card(h);
}
$("pw_src").value=PW_SRC[store.get("pw_src")]?store.get("pw_src"):"boone";
$("pw_go").onclick=()=>pwRun();$("pw_league").onchange=()=>pwRender().catch(e=>$("pw_status").innerHTML=`<span class="err">${esc(e.message)}</span>`);
$("pw_src").onchange=()=>{store.set("pw_src",$("pw_src").value);saveProfile();if(PW)pwRun(true)};

