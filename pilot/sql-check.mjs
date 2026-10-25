// Optional isolated PostgreSQL/WASM migration check; never opens an external database.
// npm install --cache /tmp/rppg-npm-cache --prefix /tmp/rppg-sql-check --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.3.14
// PGLITE_MODULE=file:///tmp/rppg-sql-check/node_modules/@electric-sql/pglite/dist/index.js node pilot/sql-check.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
if(!process.env.PGLITE_MODULE)throw new Error('Set PGLITE_MODULE to a local PGlite module path (see this file). No database URL is accepted.');
const {PGlite}=await import(process.env.PGLITE_MODULE);
const db=new PGlite(); // in memory, no network
const sql=name=>readFileSync(new URL('../backend/'+name,import.meta.url),'utf8');
try {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(sql('schema.sql'));
  await db.exec(sql('schema-linebot.sql'));
  // Representative original table layout; the migration must not touch these sentinel rows.
  await db.exec("create table public.intakes(id int primary key); create table public.packs(id int primary key); insert into public.intakes values(11); insert into public.packs values(12);");
  await db.exec("insert into public.users(id,line_sub) values ('00000000-0000-4000-8000-000000000001','synthetic-invited'),('00000000-0000-4000-8000-000000000002','synthetic-expired');");
  await db.exec("insert into public.quiz_sessions(user_id,answers) values ('00000000-0000-4000-8000-000000000001','{\"age\":\"30_34\"}');");
  for(let i=0;i<2;i++)await db.exec(sql('schema-digital-relax-pilot.sql'));
  await db.exec("insert into public.digital_relax_pilot_sessions(user_id) values ('00000000-0000-4000-8000-000000000001'); insert into public.digital_relax_pilot_sessions(user_id,created_at) values ('00000000-0000-4000-8000-000000000002',now()-interval '31 days');");
  // Simulate upgrading the previous pilot schema with existing answers.
  await db.exec('alter table public.digital_relax_pilot_sessions drop column flow_id, drop column revision, drop column paused;');
  await db.exec(sql('schema-digital-relax-pilot.sql'));
  assert.equal((await db.query('select count(*)::int as n from public.digital_relax_pilot_sessions')).rows[0].n,2);
  const result=await db.query("select relrowsecurity from pg_class where oid='public.digital_relax_pilot_sessions'::regclass");
  assert.equal(result.rows[0].relrowsecurity,true);
  for(const role of ['anon','authenticated']){
    const r=await db.query(`select has_table_privilege('${role}','public.digital_relax_pilot_sessions','SELECT') as allowed`);
    assert.equal(r.rows[0].allowed,false);
  }
  for(let i=0;i<2;i++)await db.exec(sql('cleanup-digital-relax-pilot.sql'));
  assert.equal((await db.query('select count(*)::int as n from public.digital_relax_pilot_sessions')).rows[0].n,1);
  for(let i=0;i<2;i++)await db.exec(sql('rollback-digital-relax-pilot.sql'));
  for(const table of ['quiz_sessions','intakes','packs'])assert.equal((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int as n from public.users')).rows[0].n,2);
  console.log('PASS: isolated PostgreSQL/WASM: migration x2, RLS/roles, retention cleanup x2, rollback x2, original tables preserved.');
} finally {await db.close();}
