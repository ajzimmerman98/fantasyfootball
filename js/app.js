// Install as an app, tabs, automatic tab loading, and start-up.
// Loaded as a plain script by index.html, in order; files share one global scope.
// ---------- Install as an app ----------
// Service worker (offline start), plus a one-time tip: iPhone/iPad = Share → Add to Home Screen; Android/desktop Chrome = Install button
if("serviceWorker" in navigator&&/^https?:$/.test(location.protocol))navigator.serviceWorker.register("sw.js").catch(()=>{});
{const standalone=matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
  const ok=!standalone&&Date.now()-(+store.get("install_tip")||0)>30*86400e3;
  const show=t=>{$("install_txt").textContent=t;$("install").hidden=false},hide=()=>{$("install").hidden=true;store.set("install_tip",String(Date.now()))};
  $("install_x").onclick=hide;
  if(ok&&ios)show("Install as an app: tap Share, then Add to Home Screen.");
  window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();if(!ok)return;$("install_go").hidden=false;show("Install Boone Lineups as an app on this device.");
    $("install_go").onclick=async()=>{e.prompt();await e.userChoice.catch(()=>{});hide()}});
}
const TABS=["lineup","fa","weather","trade","power","hist"];
function showTab(t){if(!TABS.includes(t))t="lineup";
  for(const k of TABS){$("p_"+k).hidden=k!==t;$("tb_"+k).setAttribute("aria-selected",String(k===t))}
  store.set("tab",t);if(location.hash!=="#"+t)history.replaceState(null,"","#"+t);
  autoLoad(t);
}
// Opening a tab loads it (when a Sleeper username is set), unless it loaded in the last 10 minutes or is loading now.
// The buttons stay for a manual refresh.
const AUTO={lineup:["go",()=>run(false,true)],fa:["fa_go",()=>faRun(true)],weather:["w_go",()=>wxRun(true)],trade:["tr_go",()=>trRun(true)],power:["pw_go",()=>pwRun(true)],hist:["hi_go",()=>hiRun(true)]};
let loadedAt={};
function autoLoad(t){
  const a=AUTO[t];if(!a||!$("user").value.trim()||$(a[0]).disabled||Date.now()-(loadedAt[t]||0)<10*60e3)return;
  loadedAt[t]=Date.now();a[1]();
}
// A new username: everything reloads for it
$("user").addEventListener("change",()=>{loadedAt={};SLC=null;FA=PW=null;autoLoad(store.get("tab")||"lineup")});
document.querySelector(".tabs").addEventListener("click",e=>{const t=e.target.dataset.tab;if(t)showTab(t)});
window.addEventListener("hashchange",()=>showTab(location.hash.slice(1)));
showTab(location.hash.slice(1)||store.get("tab")||"lineup");
$("go").onclick=()=>run(false);
$("refresh").onclick=()=>run(true);
