// Playoff odds for the Worker (weekly recap). simulateSeason and the lineup/strength rules are the same as the app's
// (index.html, "Playoff odds"); tests/reminders.test.mjs checks both give identical results for the same random numbers.

export const PO_SHRINK = 6, PO_UNC = 7; // pull toward average (games' worth); strength uncertainty (points per game)
const STRICT = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const FLEX_ORDER = ["REC_FLEX", "WRRB_FLEX", "FLEX", "SUPER_FLEX"];
const FLEX = { FLEX: ["RB", "WR", "TE"], REC_FLEX: ["WR", "TE"], WRRB_FLEX: ["WR", "RB"], SUPER_FLEX: ["QB", "RB", "WR", "TE"] };

// Best lineup total from `ids` for these slots (value per player in `val`, position in `pos`); same as the app's lineupStrength
export function lineupStrength(ids, slots, val, pos, used = new Set()) {
  const pool = ids.filter((id) => val[id] > 0).sort((a, b) => val[b] - val[a]); let total = 0;
  const take = (ok) => { for (const id of pool) if (!used.has(id) && ok(pos[id])) { used.add(id); total += val[id]; return; } };
  for (const s of slots) if (STRICT.has(s)) take((p) => p === s);
  for (const st of FLEX_ORDER) for (const s of slots) if (s === st) take((p) => FLEX[s].includes(p));
  return total;
}

// Team strengths as the app works them out: this week = projected best lineup; later weeks = points per game pulled
// toward the league average, with uncertainty. base: [{ id, owner, w, l, t, pf, g, proj }]
export function strengths(base) {
  const played = base.filter((t) => t.g > 0), avg = played.length ? played.reduce((a, t) => a + t.pf / t.g, 0) / played.length : null;
  const projAvg = base.filter((t) => t.proj > 0).reduce((a, t, _, x) => a + t.proj / x.length, 0) || 100;
  return base.map((t) => {
    const lg = avg ?? projAvg, ppg = t.g ? t.pf / t.g : null, mean = ppg != null ? lg + (t.g / (t.g + PO_SHRINK)) * (ppg - lg) : lg;
    return { ...t, mean, meanNow: t.proj > 0 ? t.proj : mean, unc: PO_UNC };
  });
}

export function bracketOrder(B){let o=[1,2];while(o.length<B){const m=o.length*2+1;o=o.flatMap(x=>[x,m-x])}return o}
// teams: [{id, w, l, t, pf, mean, meanNow, unc}]; weeks: per remaining week, its games as [teamIdA, teamIdB] (week 0 = this week).
// Each team's score ~ normal(mean, ~22% of mean). `unc` = how unsure we are of a team's true strength (points per game):
// each simulated season shifts the team's later-week mean by a random amount of that size (injuries, trades, luck). Returns per-team playoff / bye / title chances, expected wins, seed odds,
// and for team index `me` the playoff chance after winning or losing this week.
export function simulateSeason({teams,weeks,nPO,median=false,sims=10000,rng=Math.random,me=null}){
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
