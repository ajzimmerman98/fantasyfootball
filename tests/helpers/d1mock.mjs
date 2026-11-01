// Minimal D1 API over node:sqlite for tests
import { DatabaseSync } from 'node:sqlite';
export function makeD1(){
  const db=new DatabaseSync(':memory:');
  const stmt=(sql,args=[])=>({
    bind:(...a)=>stmt(sql,a),
    async run(){const r=db.prepare(sql).run(...args);return{success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}},
    async all(){return{results:db.prepare(sql).all(...args).map(o=>({...o}))}},
    async first(){const r=db.prepare(sql).get(...args);return r?{...r}:null},
  });
  return{prepare:sql=>stmt(sql),async batch(list){const out=[];db.exec('BEGIN');try{for(const s of list)out.push(await s.run());db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return out},_db:db};
}
