// Weather tab: NFL schedule, stadiums, forecasts and weather flags.
// Loaded as a plain script by index.html, in order; files share one global scope.
// ---------- Weather tab ----------
// Home stadiums: [name, city, lat, lon, roof]. roof: dome (fixed roof, weather irrelevant), ret (retractable), open
const STADIUMS={
  ARI:["State Farm Stadium","Glendale, AZ",33.5276,-112.2626,"ret"],ATL:["Mercedes-Benz Stadium","Atlanta, GA",33.7554,-84.4008,"ret"],
  BAL:["M&T Bank Stadium","Baltimore, MD",39.2780,-76.6227,"open"],BUF:["Highmark Stadium","Orchard Park, NY",42.7738,-78.7870,"open"],
  CAR:["Bank of America Stadium","Charlotte, NC",35.2258,-80.8528,"open"],CHI:["Soldier Field","Chicago, IL",41.8623,-87.6167,"open"],
  CIN:["Paycor Stadium","Cincinnati, OH",39.0954,-84.5160,"open"],CLE:["Huntington Bank Field","Cleveland, OH",41.5061,-81.6995,"open"],
  DAL:["AT&T Stadium","Arlington, TX",32.7473,-97.0945,"ret"],DEN:["Empower Field at Mile High","Denver, CO",39.7439,-105.0201,"open"],
  DET:["Ford Field","Detroit, MI",42.3400,-83.0456,"dome"],GB:["Lambeau Field","Green Bay, WI",44.5013,-88.0622,"open"],
  HOU:["NRG Stadium","Houston, TX",29.6847,-95.4107,"ret"],IND:["Lucas Oil Stadium","Indianapolis, IN",39.7601,-86.1639,"ret"],
  JAX:["EverBank Stadium","Jacksonville, FL",30.3239,-81.6373,"open"],KC:["GEHA Field at Arrowhead Stadium","Kansas City, MO",39.0489,-94.4839,"open"],
  LV:["Allegiant Stadium","Las Vegas, NV",36.0909,-115.1833,"dome"],LAC:["SoFi Stadium","Inglewood, CA",33.9535,-118.3392,"dome"],
  LAR:["SoFi Stadium","Inglewood, CA",33.9535,-118.3392,"dome"],MIA:["Hard Rock Stadium","Miami Gardens, FL",25.9580,-80.2389,"open"],
  MIN:["U.S. Bank Stadium","Minneapolis, MN",44.9737,-93.2577,"dome"],NE:["Gillette Stadium","Foxborough, MA",42.0909,-71.2643,"open"],
  NO:["Caesars Superdome","New Orleans, LA",29.9511,-90.0812,"dome"],NYG:["MetLife Stadium","East Rutherford, NJ",40.8135,-74.0745,"open"],
  NYJ:["MetLife Stadium","East Rutherford, NJ",40.8135,-74.0745,"open"],PHI:["Lincoln Financial Field","Philadelphia, PA",39.9008,-75.1675,"open"],
  PIT:["Acrisure Stadium","Pittsburgh, PA",40.4468,-80.0158,"open"],SF:["Levi's Stadium","Santa Clara, CA",37.4030,-121.9700,"open"],
  SEA:["Lumen Field","Seattle, WA",47.5952,-122.3316,"open"],TB:["Raymond James Stadium","Tampa, FL",27.9759,-82.5033,"open"],
  TEN:["Nissan Stadium","Nashville, TN",36.1665,-86.7713,"open"],WAS:["Northwest Stadium","Landover, MD",38.9077,-76.8645,"open"]
};
const TEAM_FIX={WSH:"WAS",JAC:"JAX",LA:"LAR",OAK:"LV",SD:"LAC"};
const teamKey=t=>t?(TEAM_FIX[t]||t):t;
const ESPN="https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const ROOF={dome:["Indoors","c-in"],ret:["Retractable roof","c-ret"],open:["Outdoors","c-out"]};

async function getJSON(url,what){let r;try{r=await fetch(url,{cache:"no-store"})}catch(e){throw new Error(`Couldn't reach ${what}.`)}if(!r.ok)throw new Error(`${what} error ${r.status}`);return r.json()}
function espnWeek(state,week){
  if(state.season_type==="post"){const w=week-18;return{st:3,wk:w>=4?5:w}} // ESPN skips postseason week 4 (Pro Bowl)
  return{st:state.season_type==="pre"?1:2,wk:week};
}
async function loadSchedule(state,week){
  const {st,wk}=espnWeek(state,week);
  const j=await getJSON(`${ESPN}?dates=${state.season}&seasontype=${st}&week=${wk}`,"ESPN schedule");
  return (j.events||[]).map(ev=>{
    const c=ev.competitions?.[0]||{},side=k=>teamKey((c.competitors||[]).find(x=>x.homeAway===k)?.team?.abbreviation);
    const s=ev.status?.type||c.status?.type||{};
    return{id:ev.id,date:new Date(c.date||ev.date),home:side("home"),away:side("away"),venue:c.venue||{},neutral:!!c.neutralSite,state:s.state,detail:s.shortDetail};
  }).filter(g=>g.home&&g.away&&!isNaN(g.date));
}
async function geocode(city,country){
  if(!city)return null;const k="geo_"+city+"|"+(country||"");
  try{const c=JSON.parse(store.get(k)||"null");if(c)return c}catch(e){}
  const j=await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=en&format=json`,"Geocoding");
  const rs=j.results||[],r=(country&&rs.find(x=>norm(x.country||"")===norm(country)))||rs[0];
  if(!r)return null;const g={lat:r.latitude,lon:r.longitude};store.set(k,JSON.stringify(g));return g;
}
async function venueInfo(g){
  const s=STADIUMS[g.home],v=g.venue,a=v.address||{};
  if(!g.neutral&&s)return{name:v.fullName||s[0],city:s[1],lat:s[2],lon:s[3],roof:s[4]};
  // Neutral site (international games etc.): trust ESPN's venue and look up its coordinates
  const geo=await geocode(a.city,a.country).catch(()=>null);
  return{name:v.fullName||"Neutral site",city:[a.city,a.state||a.country].filter(Boolean).join(", "),lat:geo?.lat,lon:geo?.lon,roof:v.indoor?"dome":"open"};
}
async function forecast(lat,lon,kick){
  const day=t=>new Date(t).toISOString().slice(0,10);
  const q=new URLSearchParams({latitude:lat,longitude:lon,
    hourly:"temperature_2m,apparent_temperature,precipitation_probability,rain,showers,snowfall,wind_speed_10m,wind_gusts_10m,weather_code",
    temperature_unit:"fahrenheit",wind_speed_unit:"mph",precipitation_unit:"inch",timeformat:"unixtime",timezone:"GMT",
    start_date:day(kick),end_date:day(+kick+4*3600e3)});
  const h=(await getJSON("https://api.open-meteo.com/v1/forecast?"+q,"Open-Meteo")).hourly||{};
  const t0=Math.floor(kick/3600e3)*3600,idx=(h.time||[]).map((t,i)=>t>=t0&&t<=t0+3*3600?i:-1).filter(i=>i>=0);
  if(!idx.length)return null;
  const vals=k=>idx.map(i=>(h[k]||[])[i]).filter(x=>typeof x==="number");
  const max=k=>{const v=vals(k);return v.length?Math.max(...v):null},sum=k=>vals(k).reduce((a,b)=>a+b,0),at=k=>(h[k]||[])[idx[0]];
  return{temp:at("temperature_2m"),feels:at("apparent_temperature"),code:at("weather_code"),wind:max("wind_speed_10m"),gust:max("wind_gusts_10m"),
    pop:max("precipitation_probability"),rain:sum("rain")+sum("showers"),snow:sum("snowfall")};
}
function sky(c){
  if(c==null)return"";if(c===0)return"Clear";if(c===1)return"Mostly clear";if(c===2)return"Partly cloudy";if(c===3)return"Overcast";
  if(c===45||c===48)return"Fog";if(c>=51&&c<=55)return"Drizzle";if(c===56||c===57)return"Freezing drizzle";if(c>=61&&c<=65)return"Rain";
  if(c===66||c===67)return"Freezing rain";if(c>=71&&c<=77)return"Snow";if(c>=80&&c<=82)return"Rain showers";if(c===85||c===86)return"Snow showers";
  if(c>=95)return"Thunderstorms";return"";
}
function wxFlags(w){
  const f=[];if(!w)return f;
  // Wind: label on sustained speed; gusts alone only earn "Gusty"
  const wind=w.wind??0,gust=w.gust??0;
  if(wind>=20)f.push(["Very windy","c-bad"]);else if(wind>=15)f.push(["Windy","c-flag"]);else if(gust>=30)f.push(["Gusty","c-flag"]);
  // Precip: the label follows the chance; the amount only decides whether a likely event is "Heavy"
  const pop=w.pop??0,snowy=w.snow>=0.05||((w.temp??99)<=34&&w.rain<0.01);
  const [kind,amt,heavy]=snowy?["snow",w.snow,0.5]:["rain",w.rain,0.25],K=kind[0].toUpperCase()+kind.slice(1);
  if(pop>=60&&amt>=heavy)f.push([`Heavy ${kind}`,"c-bad"]);
  else if(pop>=60)f.push([`${K} likely`,"c-flag"]);
  else if(pop>=30)f.push([`${K} possible`,"c-in"]);
  if((w.code??0)>=95)f.push(["Thunderstorms","c-bad"]);
  if((w.feels??99)<=15)f.push(["Frigid","c-bad"]);else if((w.temp??99)<=28)f.push(["Cold","c-flag"]);
  if((w.temp??0)>=88)f.push(["Hot","c-flag"]);
  return f;
}
function precipText(w){
  const p=w.pop==null?"":` ${Math.round(w.pop)}%`;
  if(w.snow>=0.05)return`Snow${p} · ${w.snow.toFixed(1)} in`;
  if(w.rain>=0.01)return`Rain${p} · ${w.rain.toFixed(2)} in`;
  return`None expected${p?" ("+p.trim()+")":""}`;
}
// Kickoff, venue and (for open-air games not yet started) forecast for every game this week, by team. Cached 20 minutes.
const GI={};
function gameInfo(state,week){
  const k=state.season+"|"+week,c=GI[k];if(c&&Date.now()-c.ts<20*60e3)return c.p;
  const p=(async()=>{const games=await loadSchedule(state,week);
    await Promise.all(games.map(async g=>{try{g.v=await venueInfo(g);if(g.state==="pre"&&g.v.roof==="open"&&g.v.lat!=null)g.wx=await forecast(g.v.lat,g.v.lon,g.date)}catch(e){}}));
    const by={};for(const g of games){by[g.home]=g;by[g.away]=g}return by})();
  GI[k]={ts:Date.now(),p};p.catch(()=>{delete GI[k]});return p;
}
let wxData=null;
async function wxRun(auto){
  const user=$("user").value.trim(),st=$("w_status");store.set("user",user);
  $("w_out").innerHTML="";
  if(!user){st.textContent="Enter your Sleeper username.";return}
  $("w_go").disabled=true;
  try{
    const sl=await loadSleeper(user,false,st,auto);
    st.textContent="Loading NFL schedule…";
    const games=await loadSchedule(sl.state,sl.week);
    if(!games.length)throw new Error(`No games found for week ${sl.week}.`);
    st.textContent="Loading forecasts…";
    await Promise.all(games.map(async g=>{
      g.v=await venueInfo(g);
      if(g.v.roof!=="dome"&&g.v.lat!=null)g.wx=await forecast(g.v.lat,g.v.lon,g.date).catch(e=>({err:e.message}));
    }));
    // My players by NFL team, deduped across leagues
    const mine={};
    sl.mineAll.forEach((r,i)=>{if(!r)return;const starters=new Set(realIds(sl.curAll[i].starters));
      for(const id of r.players||[]){const p=sl.players[id];if(!p||!p.t)continue;
        const e=mine[id]??=({id,name:p.n||`${p.f} ${p.l}`,pos:p.p,team:teamKey(p.t),inj:p.i,starter:false,leagues:[]});
        e.leagues.push(sl.leagues[i].name);if(starters.has(id))e.starter=true}});
    wxData={games:games.sort((a,b)=>a.date-b.date),mine:Object.values(mine),week:sl.week,multi:sl.leagues.length>1};
    wxRender();
  }catch(e){st.innerHTML=`<span class="err">${esc(e.message)}</span>`}
  $("w_go").disabled=false;
}
function wxRender(){
  if(!wxData)return;
  const onlyStart=$("w_starters").checked,allGames=$("w_allgames").checked;
  store.set("w_starters",onlyStart?"1":"0");store.set("w_allgames",allGames?"1":"0");
  const {games,week,multi}=wxData,mine=wxData.mine.filter(p=>!onlyStart||p.starter);
  const byTeam={};for(const p of mine)(byTeam[p.team]??=[]).push(p);
  const fmt=d=>d.toLocaleString([],{weekday:"short",hour:"numeric",minute:"2-digit"});
  let h="",shown=0;const playing=new Set();
  for(const g of games){
    const ps=[...(byTeam[g.away]||[]),...(byTeam[g.home]||[])].sort((a,b)=>b.starter-a.starter||a.name.localeCompare(b.name));
    playing.add(g.away);playing.add(g.home);
    if(!ps.length&&!allGames)continue;shown++;
    const v=g.v,[rl,rc]=ROOF[v.roof]||ROOF.open,w=g.wx&&!g.wx.err?g.wx:null;
    const when=g.state==="pre"||!g.detail?fmt(g.date):g.detail;
    h+=`<div class="card"><div class="gh"><h2>${esc(g.away)} @ ${esc(g.home)}</h2><span class="when">${esc(when)}</span></div>`;
    h+=`<div class="venue">${esc(v.name)}${v.city?" · "+esc(v.city):""}</div><div><span class="chip ${rc}">${rl}</span>`;
    if(v.roof!=="dome")h+=wxFlags(w).map(([t,c])=>`<span class="chip ${c}">${t}</span>`).join("");
    h+=`</div>`;
    if(v.roof==="dome")h+=`<div class="ok">Weather isn't a factor.</div>`;
    else if(w)h+=`<div class="wx"><div><b>Kickoff temp</b>${Math.round(w.temp)}°F${w.feels!=null&&Math.abs(w.feels-w.temp)>=3?` (feels ${Math.round(w.feels)}°)`:""}</div>`+
      `<div><b>Sky</b>${esc(sky(w.code)||"--")}</div><div><b>Wind</b>${w.wind==null?"--":Math.round(w.wind)+" mph"}${w.gust!=null?`, gusts ${Math.round(w.gust)}`:""}</div>`+
      `<div><b>Rain / snow</b>${esc(precipText(w))}</div></div>`+(v.roof==="ret"?`<div class="ok">Roof may be closed — check before kickoff.</div>`:"");
    else h+=`<div class="ok">${g.wx?.err?"Forecast unavailable ("+esc(g.wx.err)+")":"Forecast not available yet."}</div>`;
    if(ps.length)h+=`<div class="pl">`+ps.map(p=>`<div>${p.starter?'<span class="star">★</span> ':""}${esc(p.name)} <span class="r">${esc(p.pos)} ${esc(p.team)}${multi?" · "+esc(p.leagues.join(", ")):""}</span>${p.inj?` <span class="n">${esc(p.inj)}</span>`:""}</div>`).join("")+`</div>`;
    h+=`</div>`;
  }
  const bye=mine.filter(p=>!playing.has(p.team)).sort((a,b)=>a.name.localeCompare(b.name));
  if(bye.length)h+=`<div class="card"><h2>No game this week</h2><div class="pl" style="border:0;margin:0;padding:0">`+bye.map(p=>`<div>${esc(p.name)} <span class="r">${esc(p.pos)} ${esc(p.team)}</span></div>`).join("")+`</div></div>`;
  $("w_out").innerHTML=h;
  $("w_status").textContent=`Week ${week}: ${shown} game(s)${allGames?"":onlyStart?" with your starters":" with your players"}. ★ = starting in at least one league.`;
}
$("w_starters").checked=store.get("w_starters")!=="0";$("w_allgames").checked=store.get("w_allgames")==="1";
$("w_go").onclick=()=>wxRun();$("w_starters").onchange=wxRender;$("w_allgames").onchange=wxRender;

