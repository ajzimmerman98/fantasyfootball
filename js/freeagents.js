// Free Agents tab.
// Loaded as a plain script by index.html, in order; files share one global scope.
// ---------- Free Agents tab ----------
// Free agents = ranked players on no roster in the league. Each one is checked against your own players at his position:
// ranked over one of your current starters (an upgrade) or over your worst ranked bench player (a swap for depth).
const secOf=pos=>pos==="QB"?"QB":["RB","WR","TE"].includes(pos)?"FLEX":pos==="K"?"K":pos==="DEF"?"DEF":null;
const FA_TOP={QB:5,RB:8,WR:8,TE:5,K:3,DEF:3};
const fmtAdds=n=>n>=1000?(n/1000).toFixed(n>=10000?0:1)+"k":String(n);
let FA=null;
// Rest-of-season trade values as free agent rankings: QB list and a FLEX list mixing RB/WR/TE, both ordered by value.
// Values depend on more of the league format than rankings do, so lists are keyed per format.
const isValueSrc=src=>src==="tvboone"||src==="tvfc";
function faKey(source,lg){const f=leagueFormat(lg);return source==="tvboone"?f.sc+"|"+f.qb:source==="tvfc"?fcKey(f):f.sc}
function faFmtLabel(source,f){
  if(!isValueSrc(source))return f.sc==="HALF"?"Half-PPR":"PPR";
  return`${source==="tvfc"?(f.ppr===1?"PPR":f.ppr===0.5?"Half-PPR":"Standard"):f.sc==="PPR"?"PPR":"Half-PPR"} · ${f.qb==="2QB"?"Superflex":"1QB"}${source==="tvfc"?` · ${f.teams} teams`:""}`;
}
async function valueLists(source,f){
  let rows,pub;
  if(source==="tvboone"){const tv=await ensureTV();rows=[];pub=tv.ts;
    for(const [pos,c] of Object.entries(tv.data.charts||{}))for(const p of c.players){const k=pos==="QB"?f.qb:f.sc,v=p.values[k],pv=tv.prev?.[pos]?.[norm(p.name)]?.[k];if(typeof v==="number"&&v>0)rows.push({n:p.name,pos,t:null,v,d:typeof pv==="number"?v-pv:null})}}
  else{const d=await ensureFC(f);pub=Date.parse(d.data.fetchedAt)||d.ts;rows=d.data.players.map(p=>({n:p.name,pos:p.pos,t:teamKey(p.team),v:p.value,d:typeof p.trend==="number"?p.trend:null}))}
  const mk=a=>a.sort((x,y)=>y.v-x.v).map((p,i)=>({...p,r:i+1}));
  const qb=mk(rows.filter(p=>p.pos==="QB")).map(p=>({...p,pos:""})),fl=mk(rows.filter(p=>p.pos!=="QB"));
  return LISTS.map(([k])=>k==="QB"?{ps:qb,pub}:k==="FLEX"?{ps:fl,pub}:{ps:[],pub:0});
}
async function faRun(auto){
  const user=$("user").value.trim(),st=$("fa_status");store.set("user",user);
  if(!user){st.textContent="Enter your Sleeper username.";return}
  const [source,kind]=$("fa_src").value.split(":");
  $("fa_go").disabled=true;showWarn("fa_warn",[]);
  try{
    const sl=auto&&FA&&FA.user===user&&Date.now()-FA.ts<10*60e3?FA.sl:await loadSleeper(user,false,st,auto);
    const idx=sl.leagues.map((lg,i)=>sl.mineAll[i]?i:-1).filter(i=>i>=0);
    if(!idx.length)throw new Error("No leagues with your roster found.");
    store.set("cur_week",String(sl.week));
    const vs=isValueSrc(source);
    st.textContent=`Loading ${srcLabel(source,kind)} ${vs?"values":"rankings"}…`;
    const fmts={};for(const i of idx)fmts[faKey(source,sl.leagues[i])]=leagueFormat(sl.leagues[i]);
    const scs=Object.keys(fmts);
    const [trending,...res]=await Promise.all([api("/players/nfl/trending/add?lookback_hours=24&limit=300").catch(()=>[]),
      ...scs.map(key=>vs?valueLists(source,fmts[key]).catch(e=>LISTS.map(()=>({err:e}))):rankLists(source,kind,sl.state.season,sl.week,fmts[key].sc))]);
    const fatal=res.flat().find(r=>r.err&&/not Boone/.test(r.err.message));if(fatal)throw fatal.err;
    showWarn("fa_warn",[...res.map(r=>r.warn),...(vs?valueWarns(source==="tvfc"?"fc":"boone"):[])]);
    // Justin Boone's charts have no NFL team: take it from the player database when the name is unique at that position
    if(vs){const tm={};for(const p of Object.values(sl.players)){if(!p.t||!["QB","RB","WR","TE"].includes(p.p))continue;const k=p.p+"|"+norm(p.n||`${p.f} ${p.l}`);tm[k]=k in tm&&tm[k]!==p.t?null:p.t}
      for(const r of res.flat())for(const e of r.ps||[])if(!e.t)e.t=tm[(e.pos||"QB")+"|"+norm(e.n)]||null}
    const lists={};let pub=0;
    scs.forEach((sc,j)=>{if(!res[j].some(r=>r.ps&&r.ps.length))return;lists[sc]={};
      LISTS.forEach(([k],n)=>{const r=res[j][n];if(!r.ps||!r.ps.length)return;lists[sc][k]={ps:r.ps,table:parseList(listText(r.ps),k),adds:{},v:Object.fromEntries(r.ps.map(p=>[p.r,p.v]))};pub=Math.max(pub,r.pub)});
      for(const t of trending||[]){const p=sl.players[t.player_id],k=p&&secOf(p.p),l=k&&lists[sc][k];if(!l)continue;const rk=lookup(l.table,p);if(rk!=null)l.adds[rk]=t.count}
    });
    if(!Object.keys(lists).length){const e=res.flat().find(r=>r.err);throw e?e.err:new Error(`${srcLabel(source,kind)} rankings for week ${sl.week} aren't published yet.`)}
    FA={user,ts:FA&&FA.sl===sl?FA.ts:Date.now(),sl,source,kind,lists};
    const last=store.get("fa_league");
    $("fa_league").innerHTML=idx.map(i=>{const n=faCompute(i).filter(x=>x.note&&x.note.up).length;return`<option value="${i}">${esc(sl.leagues[i].name)}${n?` · ${n} upgrade${n>1?"s":""}`:""}</option>`}).join("");
    const keep=idx.find(i=>sl.leagues[i].league_id===last);if(keep!=null)$("fa_league").value=String(keep);
    $("fa_ui").hidden=false;
    st.textContent=(vs?`Ranked by ${srcLabel(source,kind)}s in each league's format (updated ${fmtTime(pub)}).`:`${srcLabel(source,kind)} ${kind==="ros"?"":`week ${sl.week} `}rankings (updated ${fmtTime(pub)}).`)+(trending&&trending.length?" Adds from Sleeper.":"");
    faRender();
  }catch(e){st.innerHTML=`<span class="err">${esc(e.message)}</span>`}
  $("fa_go").disabled=false;
}
function faCompute(i){
  const {sl,lists,kind,source}=FA,lg=sl.leagues[i],L=lists[faKey(source,lg)]||{};
  const elig=new Set(lg.roster_positions.filter(p=>!NON.has(p)).flatMap(s=>FLEX[s]||[s]));
  const rostered={QB:new Set(),FLEX:new Set(),K:new Set(),DEF:new Set()};
  for(const r of sl.rosters[i])for(const id of r.players||[]){const p=sl.players[id],k=p&&secOf(p.p);if(!k||!L[k])continue;const rk=lookup(L[k].table,p);if(rk!=null)rostered[k].add(rk)}
  const starters=new Set(realIds(sl.curAll[i]?.starters)),my={};
  for(const id of sl.mineAll[i].players||[]){const p=sl.players[id],k=p&&secOf(p.p);if(!k||!L[k])continue;const rk=lookup(L[k].table,p);
    (my[p.p]||(my[p.p]=[])).push({name:p.n||`${p.f} ${p.l}`,rank:rk??Infinity,pr:rk==null?null:k==="FLEX"?lookupPosRank(L.FLEX.table,p)||"#"+rk:p.p+rk,start:starters.has(id)})}
  const worst=a=>a.reduce((w,m)=>!w||m.rank>w.rank?m:w,null),out=[];
  for(const [k] of LISTS){const l=L[k];if(!l)continue;const pc={};
    for(const e of l.ps){const pos=k==="FLEX"?e.pos:k;if(!pos)continue;pc[pos]=(pc[pos]||0)+1;
      if(!elig.has(pos)||rostered[k].has(e.r))continue;
      const ms=my[pos]||[],ws=worst(ms.filter(m=>m.start));
      // This week, an unranked bench player is usually on bye, so he isn't a fair comparison
      const wb=worst(ms.filter(m=>!m.start&&(m.rank!==Infinity||kind==="ros")));
      // With trade values, a tie isn't "over"
      const over=(m,l)=>m&&e.r<m.rank&&!(e.v!=null&&l.v[m.rank]!=null&&e.v<=l.v[m.rank]);
      const note=over(ws,l)?{up:true,txt:`Over your starter ${ws.name} (${ws.pr||"unranked"})`}:over(wb,l)?{up:false,txt:`Over your bench ${wb.name} (${wb.pr||"unranked"})`}:null;
      out.push({...e,pos,prl:pos+pc[pos],flex:k==="FLEX",adds:l.adds[e.r]||0,note});
    }}
  return out;
}
function faRender(){
  if(!FA)return;
  const i=+$("fa_league").value,pos=$("fa_pos").value,all=faCompute(i);store.set("fa_league",FA.sl.leagues[i].league_id);store.set("fa_pos",pos);
  const row=e=>{const meta=[e.v!=null?`Value ${e.v}${e.d?` (${e.d>0?"▲":"▼"}${Math.abs(e.d)})`:""}`:"",e.pts!=null?`Proj ${e.pts} pts`:"",e.o!=null?`Rostered ${e.o}%`:"",e.adds?`+${fmtAdds(e.adds)} adds`:""].filter(Boolean).join(" · ");
    return`<div class="fa"><span class="s">${esc(e.prl)}</span><span>${esc(e.n)} <span class="r">${esc(e.pos)}${e.t?" "+esc(e.t):""}</span>${meta?`<div class="m">${esc(meta)}</div>`:""}${e.note?`<div class="${e.note.up?"up":"bnch"}">${esc(e.note.txt)}</div>`:""}</span><span class="r">${e.flex?"#"+e.r:""}</span></div>`};
  const lg=FA.sl.leagues[i],sc=faKey(FA.source,lg),fl=faFmtLabel(FA.source,leagueFormat(lg)),vs=isValueSrc(FA.source);
  if(!FA.lists[sc]){$("fa_out").innerHTML=`<div class="card ok">No ${fl} ${vs?"values":"rankings"} available.</div>`;return}
  const elig=new Set(FA.sl.leagues[i].roster_positions.filter(p=>!NON.has(p)).flatMap(s=>FLEX[s]||[s]));
  const groups=(pos==="ALL"?["QB","RB","WR","TE","K","DEF"].filter(p=>elig.has(p)&&FA.lists[sc][secOf(p)]):[pos]).map(p=>[p,all.filter(e=>e.pos===p).slice(0,pos==="ALL"?FA_TOP[p]:30)]);
  const ups=all.filter(e=>e.note&&e.note.up).length;
  $("fa_out").innerHTML=`<div class="ok" style="margin:10px 0 0">${fl} ${vs?"values":"rankings"} · ${ups?`<span class="start">${ups} upgrade${ups>1?"s":""}</span> over your starters`:"No free agent is ranked over your starters"}</div>`+
    groups.map(([p,a])=>`<div class="card"><h2>${p==="DEF"?"Defenses":p==="K"?"Kickers":p}</h2>${a.length?a.map(row).join(""):`<div class="ok">${!elig.has(p)?`This league has no ${p} spot.`:FA.lists[sc][secOf(p)]?"No ranked free agents.":vs?`Trade values don't cover ${p==="K"?"kickers":"defenses"}.`:`No ${p} list.`}</div>`}</div>`).join("");
}
$("fa_src").value=store.get("fa_src")||"boone:week";if(!$("fa_src").value)$("fa_src").value="boone:week";
$("fa_pos").value=store.get("fa_pos")||"ALL";if(!$("fa_pos").value)$("fa_pos").value="ALL";
$("fa_go").onclick=()=>faRun();$("fa_league").onchange=faRender;$("fa_pos").onchange=faRender;
$("fa_src").onchange=()=>{store.set("fa_src",$("fa_src").value);saveProfile();if(FA)faRun(true)};
$("rsrc").value=SRC_NAME[store.get("rsrc")]?store.get("rsrc"):"boone";
$("rsrc").onchange=()=>{store.set("rsrc",$("rsrc").value);saveProfile();if($("out").innerHTML&&!$("go").disabled)run(false,true)};

$("user").value=store.get("user")||"";syncUI();sleeperWeek().catch(()=>{}).then(()=>{if(synced())loadSaved()});
