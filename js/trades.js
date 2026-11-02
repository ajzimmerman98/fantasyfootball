// Trades tab: comparer and the trade idea generator.
// Loaded as a plain script by index.html, in order; files share one global scope.
let TR=null; // trades tab state
async function trRun(auto){
  const user=$("user").value.trim(),st=$("tr_status");store.set("user",user);
  if(!user){st.textContent="Enter your Sleeper username.";return}
  $("tr_go").disabled=true;
  try{
    const sl=await loadSleeper(user,false,st,auto);
    st.textContent=`Loading ${tvName()} values…`;
    const verr=await ensureValues(sl.leagues.filter((lg,i)=>sl.mineAll[i]));
    if(tvSrc()!=="avg"&&verr.length)throw new Error(verr[0].replace(/^[^:]+: /,""));
    TR={sl,users:{},give:new Set(),get:new Set()};
    const opts=sl.leagues.map((lg,i)=>sl.mineAll[i]?`<option value="${i}">${esc(lg.name)}</option>`:"").join("");
    if(!opts)throw new Error("No leagues with your roster found.");
    $("tr_league").innerHTML=opts;
    const last=store.get("tr_league");if(last&&$("tr_league").querySelector(`option[value="${last}"]`))$("tr_league").value=last;
    $("tr_ui").hidden=false;
    st.textContent=tvStatus(verr);showWarn("tr_warn",valueWarns());
    await trLeague();
  }catch(e){st.innerHTML=`<span class="err">${esc(e.message)}</span>`}
  $("tr_go").disabled=false;
}
function tvStatus(errs){
  const parts=[];
  if(tvSrc()!=="fc"&&TV){const d=TV.data,stale=d.stale?` (couldn't refresh: ${d.staleReason})`:"",miss=Object.keys(d.charts).length<4?` Missing: ${["QB","RB","WR","TE"].filter(x=>!d.charts[x]).join(", ")}.`:"";const sv=Object.entries(d.charts).filter(([,c])=>c.saved).map(([p,c])=>`${p} (week ${c.week})`);parts.push(`Justin Boone's week ${d.week} trade values${stale}.${miss}${sv.length?` Saved copy used for ${sv.join(", ")}.`:""}`)}
  if(tvSrc()!=="boone"&&Object.keys(FC).length){const t=Math.max(...Object.values(FC).map(x=>Date.parse(x.data.fetchedAt)||x.ts));parts.push(`FantasyCalc values (updated ${fmtTime(t)}).`)}
  return parts.join(" ")+(errs.length?" "+errs.join(" "):"");
}
async function trLeague(){
  const i=+$("tr_league").value,{sl}=TR,lg=sl.leagues[i];store.set("tr_league",String(i));
  TR.give.clear();TR.get.clear();$("tr_ideas").innerHTML="";
  if(!TR.users[lg.league_id])TR.users[lg.league_id]=lg.provider==="espn"?Object.entries(lg._names).map(([user_id,display_name])=>({user_id,display_name})):await api(`/league/${lg.league_id}/users`).catch(()=>[]);
  const names=Object.fromEntries(TR.users[lg.league_id].map(u=>[u.user_id,u.metadata?.team_name||u.display_name||"Team"]));
  const others=sl.rosters[i].filter(r=>r.owner_id!==sl.userId);
  $("tr_team").innerHTML=others.map(r=>`<option value="${r.roster_id}">${esc(names[r.owner_id]||"Team "+r.roster_id)}</option>`).join("");
  const f=leagueFormat(lg);
  $("tr_fmt").textContent=`${tvName()} values for this league: ${fmtLabel(f)}${tvSrc()!=="boone"?` · ${f.teams} teams`:""}`;
  trRender();
}
function trRows(roster,set,side,fmt){
  const {players}=TR.sl;
  const rows=(roster?.players||[]).map(id=>{const p=players[id];return p&&{id,p,v:tradeValue(p,fmt,id),d:tradeTrend(p,fmt,id)}}).filter(Boolean)
    .sort((a,b)=>(b.v??-1)-(a.v??-1)||(a.p.n||"").localeCompare(b.p.n||""));
  if(!rows.length)return'<div class="ok">No players.</div>';
  return rows.map(({id,p,v,d})=>`<label class="tp${v==null?" off":""}"><input type="checkbox" data-side="${side}" data-id="${esc(id)}"${set.has(id)?" checked":""}><span>${esc(p.n||`${p.f} ${p.l}`)} <span class="r">${esc(p.p)} ${esc(p.t||"FA")}</span></span><b>${v==null?"—":v}${v==null?"":trendHtml(d)}</b></label>`).join("");
}
function trRender(){
  const i=+$("tr_league").value,{sl}=TR,lg=sl.leagues[i],fmt=leagueFormat(lg);
  const them=sl.rosters[i].find(r=>String(r.roster_id)===$("tr_team").value);
  $("tr_mine").innerHTML=trRows(sl.mineAll[i],TR.give,"give",fmt);
  $("tr_theirs").innerHTML=trRows(them,TR.get,"get",fmt);
  trSum();
}
function trSum(){
  const i=+$("tr_league").value,{sl}=TR,fmt=leagueFormat(sl.leagues[i]);
  const tot=set=>[...set].reduce((a,id)=>a+(tradeValue(sl.players[id],fmt,id)??0),0);
  const g=tot(TR.give),r=tot(TR.get),d=r-g,el=$("tr_sum");
  if(!TR.give.size&&!TR.get.size){el.innerHTML='<span class="ok">Tick players on both sides to compare.</span>';return}
  const verdict=!TR.give.size||!TR.get.size?"Pick players on both sides.":d>0?`<span class="up">You gain ${d}</span>`:d<0?`<span class="down">You give up ${-d} more</span>`:"Even trade";
  const note=TR.give.size!==TR.get.size?`<div class="ok" style="margin-top:4px">Totals don't count roster spots: in a ${Math.max(TR.give.size,TR.get.size)}-for-${Math.min(TR.give.size,TR.get.size)||1}, the side getting the single best player often wins even when the sums are close.</div>`:"";
  el.innerHTML=`You give <b>${g}</b> · You get <b>${r}</b><div class="big">${verdict}</div>${note}`;
}
$("tr_go").onclick=()=>trRun();
$("tr_vsrc").value=TV_SRC[store.get("tv_src")]?store.get("tv_src"):"boone";
$("tr_vsrc").onchange=async()=>{store.set("tv_src",$("tr_vsrc").value);saveProfile();if(!TR)return;const st=$("tr_status");st.textContent=`Loading ${tvName()} values…`;
  const errs=await ensureValues(TR.sl.leagues.filter((lg,i)=>TR.sl.mineAll[i]));st.textContent=tvStatus(errs);showWarn("tr_warn",valueWarns());$("tr_ideas").innerHTML="";await trLeague()};
$("tr_league").onchange=()=>trLeague().catch(e=>$("tr_status").innerHTML=`<span class="err">${esc(e.message)}</span>`);
$("tr_team").onchange=()=>{TR.get.clear();trRender()};

// ---------- Trade idea generator ----------
// Lineup strength = sum of trade values of the best starting lineup (K/DEF have no values, so they're skipped).
const activeIds=r=>{const out=new Set([...(r.reserve||[]),...(r.taxi||[])]);return(r.players||[]).filter(id=>!out.has(id))};
function lineupStrength(ids,slots,val,pos,used=new Set()){
  const pool=ids.filter(id=>val[id]>0).sort((a,b)=>val[b]-val[a]);let total=0;
  const take=ok=>{for(const id of pool)if(!used.has(id)&&ok(pos[id])){used.add(id);total+=val[id];return}};
  for(const s of slots)if(STRICT.has(s))take(p=>p===s);
  for(const st of FLEX_ORDER)for(const s of slots)if(s===st)take(p=>FLEX[s].includes(p));
  return total;
}
const pairs=a=>{const r=[];for(let i=0;i<a.length;i++){r.push([a[i]]);for(let j=i+1;j<a.length;j++)r.push([a[i],a[j]])}return r};
function generateTrades(i,scope){
  const {sl}=TR,lg=sl.leagues[i],fmt=leagueFormat(lg),slots=(lg.roster_positions||[]).filter(s=>!NON.has(s)&&s!=="K"&&s!=="DEF");
  const active=activeIds;
  const val={},pos={};
  for(const r of sl.rosters[i])for(const id of r.players||[]){const p=sl.players[id];if(!p)continue;pos[id]=p.p;val[id]=tradeValue(p,fmt,id)??0}
  const me=sl.mineAll[i],mine=active(me),base=lineupStrength(mine,slots,val,pos);
  // Only players with value can move; cap each side at its 18 most valuable to keep the search quick
  const top=ids=>ids.filter(id=>val[id]>0).sort((a,b)=>val[b]-val[a]).slice(0,18);
  const giveSets=pairs(top(mine)),sum=a=>a.reduce((t,id)=>t+val[id],0);
  const teams=sl.rosters[i].filter(r=>r.owner_id!==sl.userId&&(scope==="all"||String(r.roster_id)===$("tr_team").value));
  const ideas=[];
  for(const t of teams){
    const theirs=active(t),theirBase=lineupStrength(theirs,slots,val,pos),getSets=pairs(top(theirs));
    for(const give of giveSets){const gv=sum(give),gs=new Set(give),myRest=mine.filter(id=>!gs.has(id));
      for(const get of getSets){const rv=sum(get);
        // Fair to them by Boone's chart: they may lose at most a small margin
        const tol=Math.max(3,Math.round(0.08*Math.max(gv,rv)));if(rv-gv>tol)continue;
        const myGain=lineupStrength(myRest.concat(get),slots,val,pos)-base;if(myGain<2)continue;
        // Their starting lineup must not get meaningfully worse, or they won't accept
        const ts=new Set(get),theirGain=lineupStrength(theirs.filter(id=>!ts.has(id)).concat(give),slots,val,pos)-theirBase;
        if(theirGain<-Math.max(2,Math.round(0.02*theirBase)))continue;
        const score=myGain+0.5*theirGain-0.3*Math.max(0,gv-rv)-(give.length+get.length-2);
        ideas.push({team:t,give,get,gv,rv,myGain,theirGain,score});
      }
    }
  }
  // Win-win first (their lineup holds or improves), then by score
  ideas.sort((a,b)=>(a.theirGain<0)-(b.theirGain<0)||b.score-a.score);
  // Variety: at most 2 ideas per team, per player you'd receive and per player you'd give; skip "same trade plus a throw-in"
  const seenGet={},seenGive={},seenTeam={},picked=[],has=(a,b)=>b.every(id=>a.includes(id));
  for(const x of ideas){if(picked.length>=6)break;
    if(x.get.some(id=>(seenGet[id]||0)>=2)||x.give.some(id=>(seenGive[id]||0)>=2))continue;
    if(scope==="all"&&(seenTeam[x.team.roster_id]||0)>=2)continue;
    if(picked.some(y=>y.team===x.team&&has(x.give,y.give)&&has(x.get,y.get)))continue;
    seenTeam[x.team.roster_id]=(seenTeam[x.team.roster_id]||0)+1;
    x.get.forEach(id=>seenGet[id]=(seenGet[id]||0)+1);x.give.forEach(id=>seenGive[id]=(seenGive[id]||0)+1);picked.push(x)}
  return{picked,base,checked:ideas.length};
}
function trGenerate(){
  if(!TR)return;
  const i=+$("tr_league").value,scope=$("tr_scope").value,{sl}=TR,out=$("tr_ideas");store.set("tr_scope",scope);
  const names=Object.fromEntries((TR.users[sl.leagues[i].league_id]||[]).map(u=>[u.user_id,u.metadata?.team_name||u.display_name||"Team"]));
  const fmt=leagueFormat(sl.leagues[i]),nm=id=>{const p=sl.players[id];return`${esc(p.n||`${p.f} ${p.l}`)} <span class="r">${esc(p.p)} ${esc(p.t||"FA")}</span> <b class="tv">${tradeValue(p,fmt,id)??0}</b>`};
  const {picked,base}=generateTrades(i,scope);
  if(!picked.length){out.innerHTML=`<div class="idea"><span class="ok">No trades found that improve your starting lineup without weakening theirs${scope==="one"?" with this team. Try All teams":""}.</span></div>`;return}
  TR.ideas=picked;
  out.innerHTML=`<div class="ok" style="margin-top:10px">Your starting lineup is worth ${base} by ${tvSrc()==="avg"?"the average":tvName()} values. Ideas that raise it without weakening the other team's starters, fair by those values:</div>`+
    picked.map((x,k)=>{const who=names[x.team.owner_id]||"Team "+x.team.roster_id,drop=x.give.length>x.get.length?" They'd need to free a roster spot.":x.get.length>x.give.length?" You'd need to free a roster spot.":"";
      return`<div class="idea"><h3>${scope==="all"?esc(who):"Trade idea "+(k+1)}<span>Lineup +${x.myGain}</span></h3>`+
        `<div class="side"><span class="lbl">You give</span>${x.give.map(nm).join(", ")}</div><div class="side"><span class="lbl">You get</span>${x.get.map(nm).join(", ")}</div>`+
        `<div class="meta"><span class="${x.theirGain>0?"up":x.theirGain<0?"down":""}">${x.theirGain>0?`Helps their lineup too (+${x.theirGain})`:x.theirGain<0?`Their lineup −${-x.theirGain} (slight)`:"Their lineup unchanged"}</span> · value ${x.gv} → ${x.rv}.${drop}</div>`+
        `<button data-idea="${k}">Open in comparer</button></div>`}).join("");
}
$("tr_gen").onclick=()=>{try{trGenerate()}catch(e){$("tr_ideas").innerHTML=`<div class="err">${esc(e.message)}</div>`}};
$("tr_scope").value=store.get("tr_scope")==="all"?"all":"one";
$("tr_ideas").addEventListener("click",e=>{const k=e.target.dataset.idea;if(k==null)return;const x=TR.ideas[+k];
  $("tr_team").value=String(x.team.roster_id);TR.give=new Set(x.give);TR.get=new Set(x.get);trRender();$("tr_sum").scrollIntoView({behavior:"smooth",block:"end"})});
$("tr_ui").addEventListener("change",e=>{const c=e.target;if(c.type!=="checkbox")return;const set=c.dataset.side==="give"?TR.give:TR.get;c.checked?set.add(c.dataset.id):set.delete(c.dataset.id);trSum()});

