// Reminders card: notification sign-up with the Worker.
// Loaded as a plain script by index.html, in order; files share one global scope.
// ---------- Reminders (notifications, sent by the Worker on its 3-hour schedule) ----------
// No account needed: this device signs up with the Sleeper username, whose lineups the Worker checks.
const pushOK=()=>"serviceWorker" in navigator&&"PushManager" in window&&"Notification" in window&&/^https?:$/.test(location.protocol);
const isStandalone=()=>matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;
const isIOS=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
const unb64=x=>Uint8Array.from(atob(x.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((x.length+3)%4)),c=>c.charCodeAt(0));
async function remSub(){if(!pushOK())return null;return(await navigator.serviceWorker.ready).pushManager.getSubscription()}
async function remPost(path,body){
  let r;try{r=await fetch(apiBase()+"/push/"+path,{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})}catch(e){throw new Error("Couldn't reach the app's server.")}
  const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`Error ${r.status}`);return d;
}
const remPrefs=()=>({rankings:$("rem_rank").checked,lineup:$("rem_lineup").checked,waivers:$("rem_waivers").checked,recap:$("rem_recap").checked});
const remRegister=sub=>remPost("subscribe",{subscription:sub.toJSON(),sleeperUsername:$("user").value.trim(),prefs:remPrefs(),tz:Intl.DateTimeFormat().resolvedOptions().timeZone});
async function remUI(){
  const note=$("rem_note"),ctl=$("rem_ctl");
  if(!pushOK()||(isIOS()&&!isStandalone())){
    note.textContent=isIOS()?"Get notified when new rankings are out and when a starter is out or on bye. On iPhone, add the app to your Home Screen (Share, then Add to Home Screen), open it from there, and turn reminders on here.":"This browser can't show notifications.";
    ctl.hidden=true;return}
  ctl.hidden=false;
  const on=!!(store.get("rem_on")&&await remSub().catch(()=>null));
  $("rem_on").hidden=on;$("rem_test").hidden=$("rem_off").hidden=!on;
  note.textContent=Notification.permission==="denied"?"Notifications are blocked for this app. Allow them in your phone's settings, then turn reminders on.":on?"Reminders are on for this device.":"Get a notification when new rankings are out, when one of your starters is out, doubtful or on bye before kickoff, plus a weekly recap and waiver pickups on Tuesday.";
}
$("rem_rank").checked=store.get("rem_rank")!=="0";$("rem_lineup").checked=store.get("rem_lineup")!=="0";$("rem_waivers").checked=store.get("rem_waivers")!=="0";$("rem_recap").checked=store.get("rem_recap")!=="0";
$("rem_on").onclick=async()=>{const m=$("rem_msg");
  if(!$("user").value.trim()){m.textContent="Enter your Sleeper username first.";return}
  $("rem_on").disabled=true;m.textContent="Turning on…";
  try{
    if(await Notification.requestPermission()!=="granted")throw new Error("Notifications weren't allowed.");
    let r;try{r=await fetch(apiBase()+"/push/key",{cache:"no-store"})}catch(e){throw new Error("Couldn't reach the app's server.")}
    const {publicKey,error}=await r.json().catch(()=>({}));if(!publicKey)throw new Error(error||"Reminders aren't available right now.");
    const reg=await navigator.serviceWorker.ready;let sub=await reg.pushManager.getSubscription();
    // A subscription made with a different server key can't be reused
    if(sub&&sub.options?.applicationServerKey&&b64eq(sub.options.applicationServerKey,unb64(publicKey))===false){await sub.unsubscribe();sub=null}
    sub=sub||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:unb64(publicKey)});
    await remRegister(sub);store.set("rem_on","1");m.textContent="Reminders are on. Tap Send a test to check.";
  }catch(e){m.innerHTML=`<span class="err">${esc(e.message)}</span>`}
  $("rem_on").disabled=false;remUI();
};
const b64eq=(a,b)=>{a=new Uint8Array(a);if(a.length!==b.length)return false;return a.every((x,i)=>x===b[i])};
$("rem_off").onclick=async()=>{const m=$("rem_msg");
  try{const sub=await remSub();if(sub){await remPost("unsubscribe",{endpoint:sub.endpoint}).catch(()=>{});await sub.unsubscribe()}store.set("rem_on","");m.textContent="Reminders are off for this device."}
  catch(e){m.innerHTML=`<span class="err">${esc(e.message)}</span>`}
  remUI();
};
$("rem_test").onclick=async()=>{const m=$("rem_msg");
  try{const sub=await remSub();if(!sub)throw new Error("Turn reminders on first.");m.textContent="Sending…";await remPost("test",{endpoint:sub.endpoint});m.textContent="Test sent. It should appear in a few seconds."}
  catch(e){m.innerHTML=`<span class="err">${esc(e.message)}</span>`}
};
for(const id of ["rem_rank","rem_lineup","rem_recap","rem_waivers"])$(id).addEventListener("change",async()=>{store.set(id,$(id).checked?"1":"0");
  if(store.get("rem_on"))try{const sub=await remSub();if(sub)await remRegister(sub)}catch(e){$("rem_msg").innerHTML=`<span class="err">${esc(e.message)}</span>`}});
// A new Sleeper username: point this device's reminders at it
$("user").addEventListener("change",async()=>{if(store.get("rem_on"))try{const sub=await remSub();if(sub)await remRegister(sub)}catch(e){}});
remUI();

