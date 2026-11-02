// Owner sync: profile and saved lineups in the database (Worker, access code).
// Loaded as a plain script by index.html, in order; files share one global scope.
// ---------- Sync: profile and saved lineup builds (D1 via the Worker) ----------
const synced=()=>!!(apiBase()&&store.get("acode"));
async function me(path,opt={}){
  const r=await fetch(apiBase()+"/me"+path,{...opt,cache:"no-store",headers:{"Content-Type":"application/json",Authorization:"Bearer "+store.get("acode"),...(opt.headers||{})}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||`Sync error ${r.status}`);
  return d;
}
const settingsNow=()=>({rankSource:$("rsrc").value,faSource:$("fa_src").value,tvSource:$("tr_vsrc").value,pwSource:$("pw_src").value,espnLeagues:espnIds()});
let profTimer=null;
function saveProfile(){if(!synced())return;clearTimeout(profTimer);profTimer=setTimeout(()=>me("/profile",{method:"PUT",body:JSON.stringify({sleeperUsername:$("user").value.trim(),settings:settingsNow()})}).catch(()=>{}),800)}
// Sync is for the owner only: shown on browsers connected with the access code, or marked once by opening the app with ?owner
// (?owner=0 unmarks). It's only hidden from view; the data itself is protected by the access code.
{const q=new URLSearchParams(location.search);if(q.has("owner"))store.set("owner_ui",q.get("owner")==="0"?"":"1")}
const ownerUI=()=>!!(store.get("owner_ui")||store.get("acode"));
function syncUI(){const on=synced();$("sync").hidden=!ownerUI();$("sync_off").hidden=on;$("sync_on").hidden=!on;$("sync_state").textContent=on?"· connected":"";if(!on)$("saved").innerHTML=""}
async function connectSync(code){
  const msg=$("sync_msg");store.set("acode",code);msg.textContent="Connecting…";
  try{
    const p=await me("/profile");
    // On a new device the database is the source of truth; otherwise keep what's here and save it
    if(p.sleeperUsername&&!$("user").value.trim()){$("user").value=p.sleeperUsername;store.set("user",p.sleeperUsername)}
    const st=p.settings||{};
    if(!p.updatedAt)saveProfile();
    else{if(SRC_NAME[st.rankSource])($("rsrc").value=st.rankSource,store.set("rsrc",st.rankSource));if(PW_SRC[st.pwSource])($("pw_src").value=st.pwSource,store.set("pw_src",st.pwSource));if(TV_SRC[st.tvSource])($("tr_vsrc").value=st.tvSource,store.set("tv_src",st.tvSource));if(st.faSource&&$("fa_src").querySelector(`option[value="${st.faSource}"]`))($("fa_src").value=st.faSource,store.set("fa_src",st.faSource));if(Array.isArray(st.espnLeagues)){store.set("espn_leagues",st.espnLeagues.join(", "));$("espn_ids").value=store.get("espn_leagues")}}
    msg.textContent="";syncUI();await loadSaved();
  }catch(e){store.set("acode","");syncUI();msg.innerHTML=`<span class="err">${esc(e.message)}</span>`}
}
async function saveBuilds(season,week,source,collected){
  if(!collected.length)return;
  await me("/builds",{method:"POST",body:JSON.stringify({builds:collected.map(b=>({...b,season,week,source}))})});
  saveProfile();await loadSaved();
}
function buildStatus(b){
  const cw=+store.get("cur_week")||0;
  if(b.week&&cw&&b.week<cw)return["Past week","b-old"];
  if(!SRC_NAME[b.source]||!b.rankingsPub)return["Pasted lists","b-old"];
  // The consensus and projections move a little every few hours as experts update, so only call it expired once it's half a day newer
  if(b.latestPub&&b.latestPub>b.rankingsPub+(b.source!=="boone"?12*3600e3:60e3))return[`Expired · ${SRC_NAME[b.source]} updated ${fmtTime(b.latestPub)}`,"b-exp"];
  return["Current","b-ok"];
}
async function loadSaved(){
  const el=$("saved");if(!synced()){el.innerHTML="";return}
  try{
    const {builds}=await me("/builds?limit=60");
    if(!builds.length){el.innerHTML=`<div class="card"><h2>Saved lineups</h2><div class="ok">Your latest build for each league and rankings source is saved here when you tap Build my lineups.</div></div>`;return}
    el.innerHTML=`<h2 style="font-size:17px;margin:20px 0 4px">Saved lineups</h2><div class="ok">Latest build for each league and rankings source. Building again with the same source replaces it.</div>`+builds.map(b=>{const [t,c]=buildStatus(b),r=b.result||{};
      return`<details class="sv"><summary><b>${esc(b.leagueName||"League")}</b> <span class="r">· Week ${b.week??"?"}</span><span class="when">Built ${esc(fmtTime(Date.parse(b.createdAt)))}${SRC_NAME[b.source]?" · "+SRC_NAME[b.source]:""}${b.scoring?" · "+(b.scoring==="HALF"?"half-PPR":"PPR"):""}</span><span class="badge ${c}">${esc(t)}</span></summary><div class="body">`+
        (r.slots||[]).map(x=>`<div class="slot"><span class="s">${esc(x.slot.replace("_"," "))}</span><span>${x.name?esc(x.name)+` <span class="r">${esc(x.pos)} ${esc(x.team)}</span>`:"Nobody eligible"}</span><span class="r">${esc(x.rank||"")}${ptsHtml(x.pts)}</span></div>`).join("")+
        (r.matchup?`<div class="ok" style="margin-bottom:4px">vs ${esc(r.matchup.opp)}: projected ${r.matchup.my}–${r.matchup.them} · ${r.matchup.win}% to win</div>`:"")+`<div class="swaps">${!(r.starts||[]).length&&!(r.sits||[]).length?'<div class="ok">No changes were needed.</div>':(r.starts||[]).map(x=>`<div><span class="start">START</span> ${esc(x)}</div>`).join("")+(r.sits||[]).map(x=>`<div><span class="sit">SIT</span> ${esc(x)}</div>`).join("")}</div>`+
        `<button class="link" data-del="${b.id}">Delete</button></div></details>`}).join("");
  }catch(e){el.innerHTML=`<div class="ok err">Couldn't load saved lineups: ${esc(e.message)}</div>`}
}
$("acode_go").onclick=()=>{const c=$("acode").value.trim();if(c)connectSync(c)};
$("acode").addEventListener("keydown",e=>{if(e.key==="Enter")$("acode_go").click()});
$("acode_off").onclick=()=>{store.set("acode","");$("acode").value="";syncUI()};
$("saved").addEventListener("click",async e=>{const id=e.target.dataset.del;if(!id)return;e.target.disabled=true;try{await me("/builds/"+id,{method:"DELETE"});await loadSaved()}catch(err){e.target.textContent="Couldn't delete"}});
$("user").addEventListener("change",saveProfile);
$("espn_ids").value=store.get("espn_leagues")||"";
$("espn_ids").addEventListener("change",()=>{store.set("espn_leagues",$("espn_ids").value);store.set("espn_leagues",espnIds().join(", "));$("espn_ids").value=store.get("espn_leagues");saveProfile()});

