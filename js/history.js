// History tab: standings, head-to-head, records, luck, draft recap, trades, pickups.
// Loaded as a plain script by index.html, in order; files share one global scope.
// ---------- League history tab ----------
// Walks a Sleeper league back through previous_league_id. Each season: users, rosters, winners bracket and regular-season
// matchups, reduced to games between managers (user ids carry across seasons). Finished seasons are cached on the device.
const HI_CACHE="hist_v2_"; // v2 adds the draft, transactions and player points
async function histSeason(id,curWeek){
  try{const c=JSON.parse(store.get(HI_CACHE+id)||"null");if(c)return c}catch(e){}
  const [lg,users,rosters,bracket,drafts]=await Promise.all([api(`/league/${id}`,true),api(`/league/${id}/users`).catch(()=>[]),api(`/league/${id}/rosters`,true).catch(()=>[]),api(`/league/${id}/winners_bracket`,true).catch(()=>[]),api(`/league/${id}/drafts`).catch(()=>[])]);
  const done=lg.status==="complete",pre=lg.status==="pre_draft"||lg.status==="drafting";
  const last=(+lg.settings?.playoff_week_start||15)-1,upto=pre?0:done?last:Math.min(last,Math.max(0,curWeek-1));
  const own={},names={};
  for(const r of rosters)own[r.roster_id]=r.owner_id||`orphan:${lg.season}:${r.roster_id}`;
  for(const u of users)names[u.user_id]={n:u.display_name||"Manager",t:u.metadata?.team_name||null};
  for(const r of rosters)if(!r.owner_id)names[own[r.roster_id]]={n:`Orphan team ${r.roster_id}`,t:null};
  // Transactions run into the playoffs; the current season only up to this week
  const txWeeks=pre?0:done?Math.min(18,last+4):Math.max(1,curWeek);
  const dr=(Array.isArray(drafts)?drafts:[]).find(d=>d.status==="complete")||(Array.isArray(drafts)?drafts:[])[0];
  const [weeks,txs,picks]=await Promise.all([
    Promise.all(Array.from({length:upto},(_,i)=>api(`/league/${id}/matchups/${i+1}`,!done).catch(()=>[]))),
    Promise.all(Array.from({length:txWeeks},(_,i)=>api(`/league/${id}/transactions/${i+1}`,!done).catch(()=>[]))),
    dr?api(`/draft/${dr.draft_id}/picks`).catch(()=>[]):[]]);
  const games=[],seasonPts={},starts=[];
  weeks.forEach((ms,i)=>{const by={};for(const m of ms||[]){
      if(m.matchup_id!=null)(by[m.matchup_id]||(by[m.matchup_id]=[])).push(m);
      // Every player's points (season totals for the draft recap) and starters' points by team (trades, pickups)
      for(const [pid,v] of Object.entries(m.players_points||{}))seasonPts[pid]=(seasonPts[pid]||0)+(+v||0);
      (m.starters||[]).forEach((pid,k)=>{const v=+(m.starters_points||[])[k]||0;if(pid&&pid!=="0"&&v)starts.push([i+1,own[m.roster_id],pid,+v.toFixed(2)])})}
    for(const g of Object.values(by))if(g.length===2)games.push([i+1,own[g[0].roster_id],+(+g[0].points||0).toFixed(2),own[g[1].roster_id],+(+g[1].points||0).toFixed(2)])});
  for(const k in seasonPts)seasonPts[k]=+seasonPts[k].toFixed(2);
  // Completed trades and adds (waivers and free agents), by manager
  const trades=[],adds=[];
  txs.forEach((list,i)=>{for(const t of list||[]){if(t.status!=="complete")continue;const w=+t.leg||i+1;
    if(t.type==="trade"){const sides={},S=o=>sides[o]||(sides[o]={gets:[],picks:[],faab:0});
      for(const rid of t.roster_ids||[])S(own[rid]);
      for(const [pid,rid] of Object.entries(t.adds||{}))S(own[rid]).gets.push(pid);
      for(const d of t.draft_picks||[])S(own[d.owner_id]).picks.push(`${d.season} round ${d.round}`);
      for(const f of t.waiver_budget||[])S(own[f.receiver]).faab+=+f.amount||0;
      trades.push({w,t:+t.created||0,sides})}
    else if(t.type==="waiver"||t.type==="free_agent")for(const [pid,rid] of Object.entries(t.adds||{}))adds.push({w,t:+t.created||0,o:own[rid],pid,bid:t.type==="waiver"?+(t.settings?.waiver_bid)||0:null})}});
  const draft=(Array.isArray(picks)?picks:[]).map(p=>({r:p.round,n:p.pick_no,pid:p.player_id,o:own[p.roster_id]||p.picked_by,k:!!p.is_keeper,
    name:`${p.metadata?.first_name||""} ${p.metadata?.last_name||""}`.trim(),pos:p.metadata?.position||""})).filter(p=>p.pid);
  const b=Array.isArray(bracket)?bracket:[],ow=x=>typeof x==="number"?own[x]:null;
  const fin=b.find(m=>m.p===1),third=b.find(m=>m.p===3),po=new Set(),pw={},pl={};
  for(const m of b){for(const t of [m.t1,m.t2])if(typeof t==="number")po.add(ow(t));if(m.w&&m.l){pw[ow(m.w)]=(pw[ow(m.w)]||0)+1;pl[ow(m.l)]=(pl[ow(m.l)]||0)+1}}
  const out={id,season:+lg.season,name:lg.name,prev:lg.previous_league_id&&lg.previous_league_id!=="0"?lg.previous_league_id:null,done,weeks:upto,names,games,
    champ:fin&&fin.w?ow(fin.w):null,runner:fin&&fin.l?ow(fin.l):null,third:third&&third.w?ow(third.w):null,playoffs:[...po].filter(Boolean),pw,pl,
    seasonPts,starts,trades,adds,draft};
  if(done)store.set(HI_CACHE+id,JSON.stringify(out));
  return out;
}
// ---------- History: draft recap, trades, pickups ----------
// Points a player scored in this manager's starting lineup from week `from` up to (not including) week `to`
const startedPts=(s,o,pid,from,to=99)=>s.starts.reduce((t,[w,oo,p,v])=>oo===o&&p===pid&&w>=from&&w<to?t+v:t,0);
function hiExtras(seasons){
  // Trades: each side's new players, scored by what they put up in that side's starting lineup for the rest of the season
  const trades=[];
  for(const s of seasons)for(const tr of s.trades||[]){
    const sides=Object.entries(tr.sides).map(([o,x])=>({o,...x,pts:x.gets.reduce((t,pid)=>t+startedPts(s,o,pid,tr.w),0)}));
    if(sides.length<2)continue;
    const by=sides.slice().sort((a,b)=>b.pts-a.pts),margin=by[0].pts-by[1].pts;
    trades.push({season:s.season,w:tr.w,t:tr.t,sides,winner:margin>=0.5?by[0].o:null,margin,live:!s.done});
  }
  trades.sort((a,b)=>b.season-a.season||b.w-a.w||b.t-a.t);
  // Pickups: each add counts until the same manager adds that player again
  const picks=[],moves={};
  for(const s of seasons){const by={};
    for(const a of s.adds||[]){(by[a.o+"|"+a.pid]||(by[a.o+"|"+a.pid]=[])).push(a);moves[a.o]=(moves[a.o]||0)+1}
    for(const list of Object.values(by)){list.sort((a,b)=>a.w-b.w||a.t-b.t);
      list.forEach((a,k)=>picks.push({...a,season:s.season,pts:startedPts(s,a.o,a.pid,a.w,k+1<list.length?list[k+1].w:99)}))}}
  picks.sort((a,b)=>b.pts-a.pts);
  const traders={};for(const t of trades)for(const sd of t.sides)traders[sd.o]=(traders[sd.o]||0)+1;
  return{trades,pickups:picks.filter(p=>p.pts>0).slice(0,10),moves,traders,draftSeasons:seasons.filter(s=>(s.draft||[]).length).map(s=>s.season)};
}
const GRADES=["A+","A","A-","B+","B","B-","C+","C","C-","D","F"];
function hiDraft(s){
  const ps=s.draft.map(p=>({...p,pts:s.seasonPts[p.pid]||0}));
  // Value: draft slot minus finishing rank by points, among drafted players (keepers left out)
  const fresh=ps.filter(p=>!p.k);
  fresh.slice().sort((a,b)=>b.pts-a.pts).forEach((p,k)=>{p.prank=k+1});
  fresh.slice().sort((a,b)=>a.n-b.n).forEach((p,k)=>{p.slot=k+1;p.val=p.slot-p.prank});
  const steals=fresh.filter(p=>p.pts>0).sort((a,b)=>b.val-a.val||b.pts-a.pts).slice(0,5);
  // Busts: the worst value among the first quarter of the draft (at least the first round)
  const cut=Math.max(12,Math.round(fresh.length/4)),busts=fresh.filter(p=>p.slot<=cut).sort((a,b)=>a.val-b.val||a.pts-b.pts).slice(0,5);
  const by={};for(const p of ps){const x=by[p.o]||(by[p.o]={pts:0,best:null});x.pts+=p.pts;if(!x.best||p.pts>x.best.pts)x.best=p}
  const order=Object.entries(by).sort((a,b)=>b[1].pts-a[1].pts);
  order.forEach(([,x],k)=>{x.grade=GRADES[Math.round(k*(GRADES.length-1)/Math.max(1,order.length-1))]});
  return{steals,busts,order};
}
// Player names: Sleeper's player list, then the draft's own names, then (for retired players) the full list, cached
async function hiNames(seasons){
  const want=new Set();for(const s of seasons){for(const t of s.trades||[])for(const x of Object.values(t.sides))x.gets.forEach(p=>want.add(p));for(const a of s.adds||[])want.add(a.pid);for(const d of s.draft||[])want.add(d.pid)}
  let cache={};try{cache=JSON.parse(store.get("pnames_v1")||"{}")}catch(e){}
  const out={},miss=[];
  for(const s of seasons)for(const d of s.draft||[])if(d.name)out[d.pid]={n:d.name,p:d.pos};
  for(const id of want){const p=HI.sl.players[id];if(p)out[id]={n:p.n||`${p.f} ${p.l}`,p:p.p};else if(!out[id]){if(cache[id])out[id]=cache[id];else miss.push(id)}}
  if(miss.length)try{const all=await api("/players/nfl");for(const id of miss){const x=all[id];if(x)cache[id]=out[id]={n:x.full_name||`${x.first_name||""} ${x.last_name||""}`.trim(),p:x.position}}store.set("pnames_v1",JSON.stringify(cache))}catch(e){}
  return out;
}
function hiExtrasHtml(){
  const {ex,agg,me,pn}=HI,N=o=>esc(agg.name[o]||"Manager"),P=id=>{const p=pn[id];return p?`${esc(p.n)} <span class="r">${esc(p.p||"")}</span>`:`Player ${esc(id)}`};
  const num1=v=>v.toFixed(1);let h="";
  // Draft recap
  if(ex.draftSeasons.length){
    const season=ex.draftSeasons.includes(HI.dseason)?HI.dseason:ex.draftSeasons[ex.draftSeasons.length-1],s=HI.seasons.find(x=>x.season===season),d=hiDraft(s);
    const so=s.done?"":` <span class="r">(through week ${s.weeks})</span>`;
    h+=`<div class="card hcard"><h2>Draft recap <select id="hi_dseason" aria-label="Season">${ex.draftSeasons.slice().reverse().map(y=>`<option${y===season?" selected":""}>${y}</option>`).join("")}</select></h2>`+
      `<div class="ok" style="margin-bottom:4px">Grades by the points each manager's picks scored${s.done?"":" so far"}.${so}</div>`+
      d.order.map(([o,x])=>`<div class="hrow${o===me?" me":""}"><span><b>${x.grade}</b> · ${N(o)}</span><b>${Math.round(x.pts).toLocaleString()}</b><div class="m">Best pick: ${x.best?`${P(x.best.pid)} (round ${x.best.r}, ${Math.round(x.best.pts)} pts)`:"—"}</div></div>`).join("")+
      `<h3 class="hsub">Biggest steals</h3>`+d.steals.map(p=>`<div class="hrow"><span>${P(p.pid)}</span><b class="w">+${p.val}</b><div class="m">${N(p.o)} · round ${p.r}, pick ${p.n} · finished #${p.prank} among drafted players · ${Math.round(p.pts)} pts</div></div>`).join("")+
      `<h3 class="hsub">Biggest busts</h3>`+d.busts.map(p=>`<div class="hrow"><span>${P(p.pid)}</span><b class="l">${p.val}</b><div class="m">${N(p.o)} · round ${p.r}, pick ${p.n} · finished #${p.prank} · ${Math.round(p.pts)} pts</div></div>`).join("")+`</div>`;
  }
  // Trades
  const tr=ex.trades,most=Object.entries(ex.traders).sort((a,b)=>b[1]-a[1])[0];
  const trHtml=t=>`<div class="trd"><div class="trh"><b>${t.season} week ${t.w}</b><span>${t.winner?`${N(t.winner)} won by ${num1(t.margin)}${t.live?" so far":""}`:"Even"}</span></div>`+
    t.sides.map(x=>`<div class="trs${x.o===t.winner?" win":""}"><span>${N(x.o)} got ${[...x.gets.map(P),...x.picks.map(esc),...(x.faab?[`$${x.faab} FAAB`]:[])].join(", ")||"nothing"}</span><b>${num1(x.pts)}</b></div>`).join("")+`</div>`;
  h+=`<div class="card hcard"><h2>Trades</h2>`+(tr.length?`<div class="ok" style="margin-bottom:4px">${tr.length} trade${tr.length>1?"s":""}${most?` · most active: ${N(most[0])} (${most[1]})`:""}. Points = what each side's new players scored in its starting lineup for the rest of that season.</div>`+
    tr.slice(0,8).map(trHtml).join("")+(tr.length>8?`<details class="more"><summary>All ${tr.length} trades</summary>${tr.slice(8).map(trHtml).join("")}</details>`:""):`<div class="ok">No trades yet.</div>`)+`</div>`;
  // Pickups
  const mv=Object.entries(ex.moves).sort((a,b)=>b[1]-a[1]);
  h+=`<div class="card hcard"><h2>Best pickups</h2>`+(ex.pickups.length?`<div class="ok" style="margin-bottom:4px">Waiver and free-agent adds, by points scored in the new team's starting lineup.</div>`+
    ex.pickups.map(p=>`<div class="hrow${p.o===me?" me":""}"><span>${P(p.pid)}</span><b>${Math.round(p.pts)}</b><div class="m">${N(p.o)} · ${p.season} week ${p.w}${p.bid?` · $${p.bid}`:""}</div></div>`).join(""):`<div class="ok">No pickups have scored yet.</div>`)+
    (mv.length?`<h3 class="hsub">Most moves</h3><div class="ok">${mv.slice(0,5).map(([o,n])=>`${N(o)} ${n}`).join(" · ")}</div>`:"")+`</div>`;
  return h;
}
let HI=null;
async function hiRun(auto){
  const user=$("user").value.trim(),st=$("hi_status");store.set("user",user);
  if(!user){st.textContent="Enter your Sleeper username.";return}
  $("hi_go").disabled=true;
  try{
    const sl=await loadSleeper(user,false,st,auto);
    const idx=sl.leagues.map((lg,i)=>sl.mineAll[i]&&lg.provider!=="espn"?i:-1).filter(i=>i>=0);
    if(!idx.length)throw new Error("No Sleeper leagues with your roster found.");
    HI={sl,data:{},me:sl.userId};
    const last=store.get("hi_league");
    $("hi_league").innerHTML=idx.map(i=>`<option value="${i}">${esc(sl.leagues[i].name)}</option>`).join("");
    const keep=idx.find(i=>sl.leagues[i].league_id===last);if(keep!=null)$("hi_league").value=String(keep);
    $("hi_ui").hidden=false;
    await hiLoad();
  }catch(e){st.innerHTML=`<span class="err">${esc(e.message)}</span>`}
  $("hi_go").disabled=false;
}
async function hiLoad(){
  const i=+$("hi_league").value,{sl}=HI,lg=sl.leagues[i],st=$("hi_status");store.set("hi_league",lg.league_id);
  if(!HI.data[lg.league_id]){
    const seasons=[];let id=lg.league_id;
    while(id&&seasons.length<20){st.textContent=`Loading ${lg.name}: ${seasons.length?seasons[seasons.length-1].season-1:sl.state.season} season…`;
      const s=await histSeason(id,+sl.week||0);seasons.push(s);id=s.prev}
    HI.data[lg.league_id]=seasons.reverse();
  }
  const seasons=HI.data[lg.league_id],played=seasons.filter(s=>s.games.length);
  st.textContent=`${lg.name}: ${seasons.length} season${seasons.length>1?"s":""} (${seasons[0].season}–${seasons[seasons.length-1].season}), ${played.reduce((t,s)=>t+s.games.length,0)} games.`;
  HI.agg=hiAggregate(seasons);HI.seasons=seasons;HI.ex=hiExtras(seasons);
  st.textContent+=" Looking up player names…";HI.pn=await hiNames(seasons);
  st.textContent=st.textContent.replace(" Looking up player names…","");
  if(!HI.agg.mgr[HI.who])HI.who=HI.agg.mgr[HI.me]?HI.me:Object.keys(HI.agg.mgr)[0];
  hiRender();
}
function hiAggregate(seasons){
  const mgr={},h2h={},name={},recs={hi:null,lo:null,blow:null,close:null},seasonRows=[];
  const M=o=>mgr[o]||(mgr[o]={w:0,l:0,t:0,pf:0,pa:0,g:0,aw:0,al:0,at:0,titles:0,runner:0,po:0,pw:0,pl:0,seasons:0});
  const H=(a,b)=>{const x=h2h[a]||(h2h[a]={});return x[b]||(x[b]={w:0,l:0,t:0,pf:0,pa:0,last:null})};
  // Names: newest season wins
  for(const s of seasons)for(const [o,v] of Object.entries(s.names))name[o]=v.n;
  const streak={};const best={w:{n:0},l:{n:0}};
  for(const s of seasons){
    const tm=o=>s.names[o]?.t||name[o]||"Team",sea={};
    for(const o of Object.keys(s.names))if(s.games.some(g=>g[1]===o||g[3]===o)){M(o).seasons++;sea[o]={w:0,l:0,t:0,pf:0}}
    const byWeek={};
    for(const [w,a,pa,b,pb] of s.games){
      for(const [x,px,y,py] of [[a,pa,b,pb],[b,pb,a,pa]]){
        const m=M(x),h=H(x,y),r=px>py?"w":px<py?"l":"t";m[r]++;m.g++;m.pf+=px;m.pa+=py;h[r]++;h.pf+=px;h.pa+=py;h.last={season:s.season,week:w,px,py};
        const z=sea[x]||(sea[x]={w:0,l:0,t:0,pf:0});z[r]++;z.pf+=px;
        // streaks across seasons, in game order
        const k=streak[x]||(streak[x]={r:null,n:0,from:null});
        if(k.r===r)k.n++;else{k.r=r;k.n=1;k.from={season:s.season,week:w}}
        if(r!=="t"&&k.n>best[r].n)best[r]={n:k.n,o:x,from:k.from,to:{season:s.season,week:w}};
        if(!recs.hi||px>recs.hi.p)recs.hi={p:px,o:x,v:y,season:s.season,week:w};
        if(px>0&&(!recs.lo||px<recs.lo.p))recs.lo={p:px,o:x,v:y,season:s.season,week:w};
        (byWeek[w]||(byWeek[w]=[])).push([x,px]);
      }
      const mg=Math.abs(pa-pb),wn=pa>=pb?[a,pa,b,pb]:[b,pb,a,pa];
      if(!recs.blow||mg>recs.blow.m)recs.blow={m:mg,w:wn[0],pw:wn[1],l:wn[2],pl:wn[3],season:s.season,week:w};
      if(!recs.close||mg<recs.close.m)recs.close={m:mg,w:wn[0],pw:wn[1],l:wn[2],pl:wn[3],season:s.season,week:w};
    }
    // All-play: every score against every other score that week
    for(const sc of Object.values(byWeek))for(const [x,px] of sc)for(const [y,py] of sc)if(x!==y){const m=M(x);px>py?m.aw++:px<py?m.al++:m.at++}
    if(s.champ)M(s.champ).titles++;if(s.runner)M(s.runner).runner++;
    for(const o of s.playoffs)M(o).po++;for(const [o,n] of Object.entries(s.pw))M(o).pw+=n;for(const [o,n] of Object.entries(s.pl))M(o).pl+=n;
    const ents=Object.entries(sea);
    const top=ents.slice().sort((a,b)=>(b[1].w+b[1].t/2)-(a[1].w+a[1].t/2)||b[1].pf-a[1].pf)[0],pts=ents.slice().sort((a,b)=>b[1].pf-a[1].pf)[0];
    seasonRows.push({s,tm,top,pts});
  }
  // Best single season by record, then points; most points in a season
  let bestSeason=null,mostPts=null;
  for(const r of seasonRows){const ents=r.s.games.length?Object.keys(r.s.names):[];
    for(const o of ents){const g=r.s.games.filter(x=>x[1]===o||x[3]===o);if(!g.length)continue;
      let w=0,l=0,t=0,pf=0;for(const [,a,pa,b,pb] of g){const px=a===o?pa:pb,py=a===o?pb:pa;px>py?w++:px<py?l++:t++;pf+=px}
      const pct=(w+t/2)/(w+l+t);
      if(r.s.done&&(!bestSeason||pct>bestSeason.pct||pct===bestSeason.pct&&pf>bestSeason.pf))bestSeason={o,w,l,t,pf,pct,season:r.s.season};
      if(r.s.done&&(!mostPts||pf>mostPts.pf))mostPts={o,pf,season:r.s.season,g:g.length};}}
  return{mgr,h2h,name,recs,best,seasonRows,bestSeason,mostPts};
}
const rec=x=>`${x.w}-${x.l}${x.t?"-"+x.t:""}`;
const pct=x=>{const n=x.w+x.l+x.t;return n?((x.w+x.t/2)/n).toFixed(3).replace(/^0/,""):"—"};
const num=v=>Math.round(v).toLocaleString();
function hiRender(){
  const {agg,me,who}=HI,{mgr,h2h,name,recs,best,seasonRows,bestSeason,mostPts}=agg,N=o=>esc(name[o]||"Manager");
  const when=x=>`${x.season} wk ${x.week}`;
  const ids=Object.keys(mgr).sort((a,b)=>((mgr[b].w+mgr[b].t/2)/Math.max(1,mgr[b].g))-((mgr[a].w+mgr[a].t/2)/Math.max(1,mgr[a].g))||mgr[b].pf-mgr[a].pf);
  let h="";
  // Champions
  h+=`<div class="card hcard"><h2>Champions</h2>`+seasonRows.slice().reverse().map(({s,tm})=>`<div class="hrow${s.champ===me?" me":""}"><span><b>${s.season}</b> · ${s.champ?`🏆 ${esc(tm(s.champ))} (${N(s.champ)})`:`<span class="r">${s.done?"No champion recorded":"In progress"}</span>`}</span><span></span>${s.runner?`<div class="m">Runner-up: ${esc(tm(s.runner))} (${N(s.runner)})</div>`:""}</div>`).join("")+`</div>`;
  // All-time standings
  h+=`<div class="card hcard"><h2>All-time standings</h2>`+ids.map((o,k)=>{const m=mgr[o];
    return`<div class="hrow${o===me?" me":""}"><span>${k+1}. ${N(o)}${m.titles?` ${"🏆".repeat(m.titles)}`:""}</span><b>${rec(m)} · ${pct(m)}</b><div class="m">PF ${num(m.pf)} · PA ${num(m.pa)} · ${(m.pf/Math.max(1,m.g)).toFixed(1)} per game · ${m.seasons} season${m.seasons>1?"s":""} · ${m.po?`playoffs ${m.po}× (${m.pw}-${m.pl})`:"no playoffs"}${m.runner?` · runner-up ${m.runner}×`:""}</div></div>`}).join("")+`</div>`;
  // Head to head
  const opp=Object.entries(h2h[who]||{}).sort((a,b)=>(b[1].w-b[1].l)-(a[1].w-a[1].l)||b[1].pf-a[1].pf);
  h+=`<div class="card hcard"><h2>Head-to-head <select id="hi_who" aria-label="Manager">${ids.map(o=>`<option value="${esc(o)}"${o===who?" selected":""}>${N(o)}${o===me?" (you)":""}</option>`).join("")}</select></h2>`+
    (opp.length?opp.map(([o,x])=>`<div class="hrow"><span>vs ${N(o)}</span><b class="${x.w>x.l?"w":x.w<x.l?"l":""}">${rec(x)}</b><div class="m">PF ${num(x.pf)} · PA ${num(x.pa)} · avg ${(x.pf/Math.max(1,x.w+x.l+x.t)).toFixed(1)}–${(x.pa/Math.max(1,x.w+x.l+x.t)).toFixed(1)}${x.last?` · last: ${x.last.px>x.last.py?"W":x.last.px<x.last.py?"L":"T"} ${x.last.px.toFixed(1)}–${x.last.py.toFixed(1)} (${x.last.season} wk ${x.last.week})`:""}</div></div>`).join(""):'<div class="ok">No games yet.</div>')+`</div>`;
  // Records
  const R=[];
  if(recs.hi)R.push(["Highest score",`${recs.hi.p.toFixed(2)}`,`${N(recs.hi.o)} vs ${N(recs.hi.v)}, ${when(recs.hi)}`]);
  if(recs.lo)R.push(["Lowest score",`${recs.lo.p.toFixed(2)}`,`${N(recs.lo.o)} vs ${N(recs.lo.v)}, ${when(recs.lo)}`]);
  if(recs.blow)R.push(["Biggest blowout",`by ${recs.blow.m.toFixed(2)}`,`${N(recs.blow.w)} ${recs.blow.pw.toFixed(1)}–${recs.blow.pl.toFixed(1)} ${N(recs.blow.l)}, ${when(recs.blow)}`]);
  if(recs.close)R.push(["Closest game",recs.close.m?`by ${recs.close.m.toFixed(2)}`:"Tie",`${N(recs.close.w)} ${recs.close.pw.toFixed(2)}–${recs.close.pl.toFixed(2)} ${N(recs.close.l)}, ${when(recs.close)}`]);
  if(bestSeason)R.push(["Best regular season",rec(bestSeason),`${N(bestSeason.o)}, ${bestSeason.season} (${num(bestSeason.pf)} PF)`]);
  if(mostPts)R.push(["Most points in a season",num(mostPts.pf),`${N(mostPts.o)}, ${mostPts.season} (${(mostPts.pf/mostPts.g).toFixed(1)} per game)`]);
  if(best.w.n)R.push(["Longest win streak",`${best.w.n} games`,`${N(best.w.o)}, ${when(best.w.from)} to ${when(best.w.to)}`]);
  if(best.l.n)R.push(["Longest losing streak",`${best.l.n} games`,`${N(best.l.o)}, ${when(best.l.from)} to ${when(best.l.to)}`]);
  h+=`<div class="card hcard"><h2>League records</h2>`+(R.map(([a,b,c])=>`<div class="hrow"><span>${a}</span><b>${b}</b><div class="m">${c}</div></div>`).join("")||'<div class="ok">No games yet.</div>')+`</div>`;
  // Luck
  const luck=ids.map(o=>{const m=mgr[o],ap=(m.aw+m.at/2)/Math.max(1,m.aw+m.al+m.at),ac=(m.w+m.t/2)/Math.max(1,m.g);return{o,m,ap,ac,d:ac-ap}}).sort((a,b)=>b.d-a.d);
  h+=`<div class="card hcard"><h2>Luck index</h2><div class="ok" style="margin-bottom:4px">Actual record vs all-play record (as if you'd played every team every week).</div>`+
    luck.map(x=>`<div class="hrow${x.o===me?" me":""}"><span>${N(x.o)}</span><b class="${x.d>0.005?"w":x.d<-0.005?"l":""}">${x.d>=0?"+":""}${(x.d*100).toFixed(1)}%</b><div class="m">Actual ${rec(x.m)} (${pct(x.m)}) · all-play ${x.m.aw}-${x.m.al}${x.m.at?"-"+x.m.at:""} (${(x.ap).toFixed(3).replace(/^0/,"")})${x===luck[0]&&x.d>0?" · luckiest":x===luck[luck.length-1]&&x.d<0?" · unluckiest":""}</div></div>`).join("")+`</div>`;
  // Season by season
  h+=`<div class="card hcard"><h2>Season by season</h2>`+seasonRows.slice().reverse().map(({s,tm,top,pts})=>`<div class="hrow"><span><b>${s.season}</b>${s.done?"":` <span class="r">(${s.weeks?`through week ${s.weeks}`:"not started"})</span>`}</span><span class="r">${s.games.length} games</span><div class="m">${s.champ?`Champion ${esc(tm(s.champ))}${s.third?` · 3rd ${esc(tm(s.third))}`:""} · `:""}${top?`Best record ${esc(tm(top[0]))} ${rec(top[1])}`:""}${pts?` · Most points ${esc(tm(pts[0]))} ${num(pts[1].pf)}`:""}</div></div>`).join("")+`</div>`;
  $("hi_out").innerHTML=h+hiExtrasHtml();
}
$("hi_go").onclick=()=>hiRun();
$("hi_league").onchange=()=>hiLoad().catch(e=>$("hi_status").innerHTML=`<span class="err">${esc(e.message)}</span>`);
$("hi_out").addEventListener("change",e=>{if(e.target.id==="hi_who"){HI.who=e.target.value;hiRender()}if(e.target.id==="hi_dseason"){HI.dseason=+e.target.value;hiRender()}});

