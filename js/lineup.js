// Lineup tab: candidates, the best lineup, lineup cards (points, matchup preview, kickoff, weather, locks), building.
// Loaded as a plain script by index.html, in order; files share one global scope.
const cmp=(a,b)=>{for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i]??0,y=b[i]??0;if(x!==y)return x<y?-1:1}return 0};
function fk(c,slot){
  const cur=c.cur?0:1;
  if(slot==="SUPER_FLEX"){if(c.rsf!=null)return[0,c.rsf,cur];return[1,c.pos==="QB"?0:1,...fk(c,"FLEX")]}
  if(c.rf!=null)return[0,c.rf,cur];
  if(c.rp!==Infinity)return[1,c.rp,cur];
  return[2,0,cur];
}
const realIds=a=>(a||[]).filter(x=>x&&x!=="0");
function candidates(roster,starters,players,ranks,allowDoubt){
  const benchOnly=new Set([...(roster.reserve||[]),...(roster.taxi||[])]);
  const cur=new Set(realIds(starters));
  const out=[];
  for(const id of roster.players||[]){
    if(benchOnly.has(id))continue;const p=players[id];if(!p)continue;
    const isSk=["RB","WR","TE"].includes(p.p),isSf=p.p!=="K"&&p.p!=="DEF";
    let rp=lookup(ranks[p.p],p);if(rp==null&&["RB","WR","TE"].includes(p.p))rp=lookup(ranks.FLEX,p);
    out.push({id,name:p.n||(p.f+" "+p.l),pos:p.p,team:p.t,inj:p.i,
      out:OUT.has(p.i)||(!allowDoubt&&p.i==="Doubtful"),
      rp:rp??Infinity,pr:isSk?lookupPosRank(ranks.FLEX,p):null,rf:isSk?lookup(ranks.FLEX,p):null,rsf:isSf?lookup(ranks.SUPERFLEX,p):null,cur:cur.has(id)});
  }
  return out;
}
// fixed = {slot index: player} for starters whose game has started (they stay); frozen = ids that can't be moved
function build(slots,cands,fixed={},frozen=new Set()){
  const res=Array(slots.length).fill(null),used=new Set(),av=cands.filter(c=>!c.out&&!frozen.has(c.id));
  for(const [i,c] of Object.entries(fixed)){res[i]=c;used.add(c.id)}
  slots.forEach((s,i)=>{if(res[i]||!STRICT.has(s))return;
    const pool=av.filter(c=>c.pos===s&&!used.has(c.id)).sort((a,b)=>cmp([a.rp,a.cur?0:1],[b.rp,b.cur?0:1]));
    if(pool[0]){res[i]=pool[0];used.add(pool[0].id)}});
  for(const st of FLEX_ORDER)slots.forEach((s,i)=>{if(s!==st||res[i])return;
    const pool=av.filter(c=>FLEX[s].includes(c.pos)&&!used.has(c.id)).sort((a,b)=>cmp(fk(a,s),fk(b,s)));
    if(pool[0]){res[i]=pool[0];used.add(pool[0].id)}});
  return res;
}

const rankTxt=c=>c.rp===Infinity?"--":(c.pr?c.pr+" · ":"")+"#"+c.rp;
const fmtKick=d=>d.toLocaleString([],{weekday:"short",hour:"numeric",minute:"2-digit"});
const ptsHtml=v=>v==null?"":`<div class="pts">${v} pts</div>`;
function render(lg,roster,cur,players,ranks,opts){
  const {starters,src}=cur,fmt=leagueFormat(lg);
  const pv=c=>opts.pts?opts.pts(players[c.id]):null;
  const tvTag=c=>{const v=tradeValue(players[c.id],fmt,c.id);return v==null?"":` <span class="tv">TV ${v}${trendHtml(tradeTrend(players[c.id],fmt,c.id))}</span>`};
  const slots=lg.roster_positions.filter(p=>!NON.has(p));
  const cands=candidates(roster,starters,players,ranks,opts.allowDoubt),byId=Object.fromEntries(cands.map(c=>[c.id,c]));
  // Kickoff/weather from the NFL schedule; once a player's game starts he's locked: starters stay put, bench players can't come in
  const gm=c=>opts.games?opts.games[teamKey(c.team)]||null:null,locked=c=>{const g=gm(c);return!!g&&g.state!=="pre"};
  const fixed={},frozen=new Set();
  if(opts.games){const cs=starters||[];slots.forEach((s,i)=>{const c=byId[cs[i]];if(c&&locked(c))fixed[i]=c});for(const c of cands)if(locked(c))frozen.add(c.id)}
  const line=build(slots,cands,fixed,frozen);
  const gameLine=c=>{if(!opts.games)return"";const g=gm(c);if(!g)return`<div class="gm">No game this week</div>`;
    const opp=teamKey(c.team)===g.home?`vs ${g.away}`:`@ ${g.home}`,when=g.state==="pre"?fmtKick(g.date):g.state==="in"?"Locked · in progress":"Locked · final";
    const fl=g.state==="pre"&&g.v?.roof==="open"?wxFlags(g.wx).map(([t,k])=>`<span class="chip ${k}">${esc(t)}</span>`).join(""):"";
    return`<div class="gm">${g.state!=="pre"?"🔒 ":""}${esc(when)} ${esc(opp)}${fl}</div>`};
  const nw=new Set(line.filter(Boolean).map(c=>c.id)),old=new Set(realIds(starters));
  // Close calls: rank only compares within one list (QB, FLEX for RB/WR/TE, K, DEF)
  const listOf=c=>c.pos==="QB"?"QB":["RB","WR","TE"].includes(c.pos)?"FLEX":c.pos;
  const fits=(slot,pos)=>STRICT.has(slot)?pos===slot:!!FLEX[slot]?.includes(pos);
  const ranked=c=>c&&c.rp!==Infinity&&!c.out;
  const close=(a,b)=>ranked(a)&&ranked(b)&&listOf(a)===listOf(b)&&Math.abs(a.rp-b.rp)<=CLOSE_RANKS;
  const rk=c=>c.out?(c.inj||"out"):c.rp===Infinity?"unranked":rankTxt(c);
  const ptsOf=c=>{const v=pv(c);return v==null?null:+v};
  // The bench player closest behind a kept starter (within a few places on the same list), for a "Close call" note
  const rival=(c,slot)=>cands.filter(b=>!nw.has(b.id)&&!frozen.has(b.id)&&fits(slot,b.pos)&&close(c,b)&&b.rp>=c.rp).sort((x,y)=>x.rp-y.rp)[0];
  let h=`<div class="card"><h2>${esc(lg.name)}</h2>`,mu=null;
  // Matchup preview: projected points of the suggested lineup (and your current one) vs the opponent's set lineup
  if(opts.opp&&opts.pts){const sum=a=>a.reduce((t,v)=>t+(v||0),0),my=sum(line.filter(Boolean).map(pv)),curPts=sum(realIds(starters).map(id=>opts.pts(players[id]))),them=sum(opts.opp.starters.map(id=>opts.pts(players[id])));
    if(my>0||them>0){mu={opp:opts.opp.name,my:+my.toFixed(1),them:+them.toFixed(1),win:Math.round(winProb(my,them)*100)};h+=matchupHtml(opts.opp,my,curPts,them,opts.week)}}
  slots.forEach((s,i)=>{const c=line[i];
    if(!c){h+=`<div class="slot"><span class="s">${esc(s)}</span><span>Nobody eligible</span><span></span></div>`;return}
    const notes=[];if(opts.games&&!gm(c))notes.push("BYE");else if(c.rp===Infinity&&(ranks[c.pos]||(["RB","WR","TE"].includes(c.pos)&&ranks.FLEX)))notes.push(opts.games?"UNRANKED":"UNRANKED (bye?)");if(c.inj)notes.push(c.inj);
    const cc=!fixed[i]&&old.has(c.id)?rival(c,s):null,ccp=cc&&ptsOf(cc);
    const ccHtml=cc?`<div class="cc">Close call: ${esc(cc.name)} (${esc(rk(cc))}${ccp!=null?` · ${ccp} pts`:""})</div>`:"";
    h+=`<div class="slot"><span class="s">${esc(s.replace("_"," "))}</span><span>${esc(c.name)} <span class="r">${esc(c.pos)} ${esc(c.team||"")}</span>${tvTag(c)}${notes.length?`<div class="n">${esc(notes.join(", "))}</div>`:""}${gameLine(c)}${ccHtml}</span><span class="r">${esc(rankTxt(c))}${ptsHtml(pv(c))}</span></div>`});
  const hasL=c=>ranks[c.pos]||(["RB","WR","TE"].includes(c.pos)&&ranks.FLEX);
  const tg=c=>c.out?` (${c.inj||"out"})`:!c.pos||!hasL(c)?"":c.rp===Infinity?" (unranked)":` (${c.pr?c.pr+", ":""}#${c.rp})`;
  const byName=(a,b)=>a.name.localeCompare(b.name);
  const starts=[...nw].filter(i=>!old.has(i)).map(i=>byId[i]).sort(byName);
  const sits=[...old].filter(i=>!nw.has(i)).map(i=>byId[i]||{name:players[i]?.n||`Unknown player (${i})`}).sort(byName);
  h+=`<div class="swaps">`;
  const nLocked=Object.keys(fixed).length;
  if(nLocked)h+=`<div class="ok" style="margin-bottom:4px">🔒 ${nLocked} starter${nLocked>1?"s":""} already playing or done, so ${nLocked>1?"they stay":"he stays"} put.</div>`;
  if(!starts.length&&!sits.length)h+=`<div class="ok">No changes. Your lineup already matches the rankings.</div>`;
  else h+=`<h3 class="swh">Make these swaps</h3>`+swapsHtml(pairSwaps(starts,sits,{slots,starters,line,gm,fits}),{rk,ptsOf,close});
  h+=`</div>`;
  const bench=cands.filter(c=>!nw.has(c.id)).sort((a,b)=>a.rp===b.rp?a.name.localeCompare(b.name):a.rp<b.rp?-1:1);
  if(bench.length)h+=`<div class="bn"><h3>Bench</h3>`+bench.map(c=>`<div class="slot"><span class="s">BN</span><span>${esc(c.name)} <span class="r">${esc(c.pos)} ${esc(c.team||"")}</span>${tvTag(c)}${c.inj?`<div class="n">${esc(c.inj)}</div>`:""}${gameLine(c)}</span><span class="r">${esc(rankTxt(c))}${ptsHtml(pv(c))}</span></div>`).join("")+`</div>`;
  if(opts.debug)h+=debugBlock(slots,starters,line,src,players,byId);
  if(opts.collect)opts.collect.push({leagueId:lg.league_id,leagueName:lg.name,scoring:opts.scoring,rankingsPub:opts.pub,result:{matchup:mu,
    slots:slots.map((s,i)=>{const c=line[i];return c?{slot:s,name:c.name,pos:c.pos,team:c.team||"",rank:rankTxt(c),pts:pv(c)}:{slot:s,name:null}}),
    starts:starts.map(c=>c.name+tg(c)),sits:sits.map(c=>c.name+tg(c))}});
  return h+`</div>`;
}
const CLOSE_RANKS=3; // within this many places on the same rankings list counts as a close call
// Pair each player coming in with one going out (preferring one whose spot he can take), soonest kickoff first
function pairSwaps(starts,sits,{slots,starters,line,gm,fits}){
  const kick=c=>{const g=c&&gm(c);return g&&g.state==="pre"?+g.date:Infinity};
  const outs=sits.map(c=>({c,slot:slots[(starters||[]).indexOf(c.id)]||""})),pairs=[];
  for(const c of starts.slice().sort((a,b)=>kick(a)-kick(b))){
    const slot=slots[line.findIndex(x=>x&&x.id===c.id)]||"";
    let k=outs.findIndex(o=>fits(o.slot,c.pos));if(k<0)k=outs.length?0:-1;
    const o=k>=0?outs.splice(k,1)[0].c:null;
    pairs.push({in:c,out:o,slot,at:Math.min(kick(c),kick(o))});
  }
  for(const o of outs)pairs.push({in:null,out:o.c,slot:o.slot,at:kick(o.c)});
  return pairs.sort((a,b)=>a.at-b.at);
}
function swapsHtml(pairs,{rk,ptsOf,close}){
  return pairs.map(p=>{
    const a=p.in,b=p.out,pa=a&&ptsOf(a),pb=b&&b.pos?ptsOf(b):null,tags=[];
    if(a&&b&&b.pos&&close(a,b))tags.push(`<span class="cc">close call</span>`);
    if(a&&b&&pa!=null&&pb!=null&&!b.out&&pa<pb-0.5)tags.push(`<span class="cc">projections favor keeping ${esc(b.name)}</span>`);
    const head=a&&b?`🔁 <span class="start">Start</span> ${esc(a.name)} · <span class="sit">bench</span> ${esc(b.name)}`:a?`<span class="start">Start</span> ${esc(a.name)} · empty spot`:`<span class="sit">Bench</span> ${esc(b.name)} · nobody eligible to replace him`;
    const meta=[p.slot.replace("_"," "),isFinite(p.at)?fmtKick(new Date(p.at)):"",a&&b&&b.pos?`${rk(a)} vs ${rk(b)}`:a?rk(a):b.pos?rk(b):"",pa!=null&&pb!=null?`${pa} vs ${pb} pts`:pa!=null?`${pa} pts`:""].filter(Boolean);
    return`<div class="sw"><div>${head}</div><div class="m">${esc(meta.join(" · "))}${tags.length?" · "+tags.join(" · "):""}</div></div>`}).join("");
}
function debugBlock(slots,starters,line,src,players,byId){
  const nm=id=>!id||id==="0"?"(empty)":byId[id]?.name||players[id]?.n||null;
  const cell=id=>{const n=nm(id);return n==null?`<span class="miss">missing from player data (${esc(id)})</span>`:`${esc(n)} <span class="r">${esc(id||"")}</span>`};
  let h=`<details class="dbg" open><summary>Debug</summary><div>Current starters from: ${esc(src)}</div><table><tr><td>Slot</td><td>Current</td><td>Suggested</td></tr>`;
  slots.forEach((s,i)=>{h+=`<tr><td>${esc(s)}</td><td>${cell((starters||[])[i])}</td><td>${line[i]?cell(line[i].id):"(none)"}</td></tr>`});
  return h+`</table></details>`;
}
async function run(force,auto){
  const user=$("user").value.trim(),source=$("rsrc").value;
  store.set("user",user);
  const out=$("out"),st=$("status");out.innerHTML="";showWarn("l_warn",[]);
  if(!user){st.textContent="Enter your Sleeper username.";return}
  $("go").disabled=true;
  try{
    const {state,week,leagues,players,rosters,matchups,mineAll,curAll,espnErrors}=await loadSleeper(user,force,st,auto);
    store.set("cur_week",String(week));
    const idx=leagues.map((lg,i)=>mineAll[i]?i:-1).filter(i=>i>=0);
    const scOf=lg=>leagueFormat(lg).sc;
    const need=[...new Set(idx.map(i=>scOf(leagues[i])))],ptsNeed=[...new Set(idx.map(i=>leagueFormat(leagues[i]).sc))];
    st.textContent=`Loading ${srcLabel(source)} rankings…`;
    // Rankings from the chosen source; Sleeper projections (in each league's own scoring) for the points; trade values for TV tags
    const [rk,pj,,users,games]=await Promise.all([
      Promise.all(need.map(sc=>rankLists(source,"week",state.season,week,sc))),
      Promise.all(ptsNeed.map(sc=>rankLists("sleeper","week",state.season,week,sc).catch(()=>null))),
      apiBase()?ensureValues(idx.map(i=>leagues[i])):null,
      // Team names for the matchup preview (Sleeper leagues with a matchup this week)
      Promise.all(leagues.map((lg,i)=>Array.isArray(matchups[i])&&matchups[i].length?api(`/league/${lg.league_id}/users`).catch(()=>[]):null)),
      gameInfo(state,week).catch(()=>null)]);
    const fatal=rk.flat().find(r=>r.err&&/not Boone/.test(r.err.message));if(fatal)throw fatal.err;
    const R={},P={},pubs={};
    need.forEach((sc,j)=>{const t={};let pub=0;LISTS.forEach(([k],n)=>{const r=rk[j][n];if(r.ps&&r.ps.length){t[k]=parseList(listText(r.ps),k);pub=Math.max(pub,r.pub)}});if(Object.keys(t).length){R[sc]=t;pubs[sc]=pub}});
    if(!Object.keys(R).length){const e=rk.flat().find(r=>r.err);throw e?e.err:new Error(`${srcLabel(source)} week ${week} rankings aren't published yet.`)}
    ptsNeed.forEach((sc,j)=>{const res=pj[j];if(!res)return;const t={};LISTS.forEach(([k],n)=>{const r=res[n];if(r&&r.ps&&r.ps.length)t[k]={table:parseList(listText(r.ps),k),pts:Object.fromEntries(r.ps.map(p=>[p.r,p.pts]))}});if(Object.keys(t).length)P[sc]=t});
    st.textContent=`Season ${state.season}, week ${week}. ${idx.length} league(s). ${srcLabel(source)}${source==="sleeper"?"":" rankings"} updated ${fmtTime(Math.max(...Object.values(pubs)))}.`+
      espnErrors.map(e=>` ESPN ${e.leagueId}: ${e.error}`).join("");
    showWarn("l_warn",[...rk.map(r=>r.warn),...pj.map(r=>r&&r.warn),Object.keys(P).length?null:"Sleeper projections didn't load, so projected points and the matchup preview are missing.",...(apiBase()?valueWarns():[])]);
    // Doubtful players aren't started; the per-slot debug table shows only with ?debug in the address
    const opts={allowDoubt:false,debug:DEBUG,collect:[]};
    leagues.forEach((lg,i)=>{
      const mine=mineAll[i],sc=scOf(lg),ranks=R[sc];
      if(!mine){out.insertAdjacentHTML("beforeend",`<div class="card"><h2>${esc(lg.name)}</h2><div class="ok">Couldn't find your roster.</div></div>`);return}
      if(!ranks){out.insertAdjacentHTML("beforeend",`<div class="card"><h2>${esc(lg.name)}</h2><div class="ok">No ${sc==="HALF"?"half-PPR":"PPR"} rankings available.</div></div>`);return}
      const pt=P[leagueFormat(lg).sc];
      const pts=p=>{const k=p&&secOf(p.p),l=pt&&k&&pt[k];if(!l)return null;const r=lookup(l.table,p);return r==null?null:l.pts[r]??null};
      out.insertAdjacentHTML("beforeend",render(lg,mine,curAll[i],players,ranks,{...opts,pts,games,scoring:sc,pub:pubs[sc],week,opp:opponent(mine,matchups[i],rosters[i],users[i])}));
    });
    if(synced())saveBuilds(+state.season,week,source,opts.collect).catch(e=>{st.textContent+=` Couldn't save: ${e.message}`});
  }catch(e){st.innerHTML=`<span class="err">${esc(e.message)}</span>`}
  $("go").disabled=false;
}
// This week's opponent from Sleeper's matchups: their set lineup, live points, and team name
function opponent(mine,mm,rosters,users){
  if(!Array.isArray(mm))return null;
  const me=mm.find(x=>x.roster_id===mine.roster_id);if(!me||me.matchup_id==null)return null;
  const them=mm.find(x=>x.matchup_id===me.matchup_id&&x.roster_id!==mine.roster_id);if(!them)return null;
  const r=(rosters||[]).find(x=>x.roster_id===them.roster_id),u=(users||[]).find(x=>r&&x.user_id===r.owner_id);
  return{name:u?.metadata?.team_name||u?.display_name||`Team ${them.roster_id}`,starters:realIds(them.starters),points:+them.points||0,myPoints:+me.points||0};
}
// Chance to win from projected points: normal model, each team's score spread ~22% of its projection
function winProb(a,b){
  const sd=Math.sqrt(Math.pow(Math.max(10,0.22*a),2)+Math.pow(Math.max(10,0.22*b),2)),z=(a-b)/sd;
  const t=1/(1+0.3275911*Math.abs(z)/Math.SQRT2),y=1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-z*z/2);
  return 0.5*(1+(z<0?-y:y));
}
function matchupHtml(o,my,cur,them,week){
  const p=winProb(my,them),pc=Math.round(p*100),live=o.points+o.myPoints>0;
  return`<div class="mu"><div class="mu-top"><span>Week ${week} vs <b>${esc(o.name)}</b></span><span class="mu-p ${pc>=50?"up":"down"}">${pc}% to win</span></div>`+
    `<div class="mu-bar"><i style="width:${Math.min(98,Math.max(2,pc))}%"></i></div>`+
    `<div class="mu-s">Projected: you <b>${my.toFixed(1)}</b> · them <b>${them.toFixed(1)}</b>${Math.abs(cur-my)>=0.05?` · your current lineup ${cur.toFixed(1)}`:""}${live?` · score ${o.myPoints.toFixed(1)}–${o.points.toFixed(1)}`:""}</div></div>`;
}
