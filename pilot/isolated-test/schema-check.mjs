// Check the prepared migrations only in an in-memory PostgreSQL/WASM database.
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
if(!process.env.PGLITE_MODULE||!process.argv[2])throw new Error('Usage: PGLITE_MODULE=<local module URL> node schema-check.mjs <artifact directory>');
const {PGlite}=await import(process.env.PGLITE_MODULE);
const root=resolve(process.argv[2]),db=new PGlite();
try{
 await db.exec('create role anon; create role authenticated; create role service_role;');
 const migrations=readdirSync(join(root,'supabase/migrations')).sort();
 for(const file of migrations)await db.exec(readFileSync(join(root,'supabase/migrations',file),'utf8'));
 for(const name of ['users','consents','scans','intakes','packs','quiz_sessions','rich_menus','digital_relax_pilot_sessions']){
  const r=await db.query(`select relrowsecurity from pg_class where oid='public.${name}'::regclass`);assert.equal(r.rows[0].relrowsecurity,true);
 }
 await db.exec("insert into public.users(id,line_sub) values ('00000000-0000-4000-8000-000000000001','synthetic-only'); insert into public.digital_relax_pilot_sessions(user_id) values ('00000000-0000-4000-8000-000000000001');");
 const first=readdirSync(join(root,'supabase/migrations')).sort()[0];
 await assert.rejects(db.exec(readFileSync(join(root,'supabase/migrations',first),'utf8')),/Refusing bootstrap/);
 await db.exec(readFileSync(join(root,'operations/cleanup-digital-relax-pilot.sql'),'utf8'));
 assert.equal((await db.query('select count(*)::int as n from public.digital_relax_pilot_sessions')).rows[0].n,1);
 await db.query('select current_rich_menu_id, previous_rich_menu_id, rich_menu_captured from public.digital_relax_pilot_sessions');
 console.log(`PASS: all ${migrations.length} prepared migrations, 8 RLS tables, menu restoration columns, synthetic pilot insert, cleanup, nonempty-database bootstrap refused (in memory only).`);
}finally{await db.close();}
