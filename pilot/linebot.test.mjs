import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { createHmac, webcrypto } from 'node:crypto';
import { catalog } from './products.js';

// Run the actual generated Edge Function, including signature verification and routing.
// All network is rejected except the in-memory LINE reply/menu API mock.
const source = stripTypeScriptTypes(readFileSync(new URL('../backend/linebot/index.ts',import.meta.url),'utf8').replace(/^import .*createClient.*;$/m,''));
function fixture({enabled=true,allow='invited',admin='',failTable=null,sharedTables=null}={}) {
  const tables=sharedTables ?? {users:[{id:'fake-user',line_sub:'invited'}],digital_relax_pilot_sessions:[],quiz_sessions:[],consents:[],packs:[],scans:[],rich_menus:[],intakes:[]};
  const calls=[], writes=[], replies=[];
  let serve;
  class Query {
    constructor(table){this.table=table;this.filters=[];this.mode='select';this.limitN=Infinity;}
    select(){return this;}
    eq(k,v){this.filters.push(r=>r[k]===v);return this;}
    gte(k,v){this.filters.push(r=>r[k]>=v);return this;}
    order(k,{ascending}){this.sort={k,ascending};return this;}
    limit(n){this.limitN=n;return this;}
    maybeSingle(){this.singleRow=true;return this;}
    single(){this.singleRow=true;return this;}
    insert(v){this.mode='insert';this.values=v;return this;}
    upsert(v,options){this.mode='upsert';this.values=v;this.options=options;return this;}
    update(v){this.mode='update';this.values=v;return this;}
    delete(){this.mode='delete';return this;}
    then(resolve,reject){return Promise.resolve().then(()=>{
      calls.push({table:this.table,mode:this.mode});
      if(this.table===failTable)return {data:null,error:new Error('simulated DB unavailable')};
      let rows=tables[this.table];assert.ok(rows,`Unexpected table ${this.table}`);
      let selected=rows.filter(r=>this.filters.every(f=>f(r)));
      if(this.mode!=='select')writes.push({table:this.table,mode:this.mode});
      if(this.mode==='delete'){tables[this.table]=rows.filter(r=>!selected.includes(r));}
      if(this.mode==='update')for(const r of selected)Object.assign(r,structuredClone(this.values));
      if(['insert','upsert'].includes(this.mode)){
        const v=structuredClone(this.values);
        const key=this.table==='users'?'line_sub':'user_id';
        let old=this.mode==='upsert'?rows.find(r=>r[key]===v[key]):null;
        if(!old){old={id:'fake-created',...v};rows.push(old);}
        else if(!this.options?.ignoreDuplicates)Object.assign(old,v);
        selected=[old];
      }
      if(this.sort)selected.sort((a,b)=>(a[this.sort.k]>b[this.sort.k]?1:-1)*(this.sort.ascending?1:-1));
      selected=selected.slice(0,this.limitN);
      return {data:structuredClone(this.singleRow?selected[0]??null:selected),error:null};
    }).then(resolve,reject);}
  }
  const variables={RELAX_PILOT_ENABLED:enabled?'1':'0',RELAX_PILOT_LINE_SUBS:allow,ADMIN_LINE_SUBS:admin,LINE_CHANNEL_SECRET:'synthetic-test-secret'};
  vm.runInNewContext(source,{
    createClient:()=>({from:table=>new Query(table)}),
    Deno:{env:{get:n=>variables[n]},serve:fn=>{serve=fn;}},
    fetch:async(url,options)=>{
      const path=new URL(url).pathname;
      assert.equal(new URL(url).host,'api.line.me','no external network');
      const body=options.body?JSON.parse(options.body):null;
      if(path==='/v2/bot/message/reply'){assert.ok(body.messages.length<=5);replies.push(body.messages);}
      else assert.match(path,/^\/v2\/bot\/user\/invited\/richmenu/);
      return new Response('{}');
    },Response,URL,URLSearchParams,TextEncoder,crypto:webcrypto,btoa,console:{error:()=>{}}
  });
  async function event(event,sub='invited',signature=true){
    const raw=JSON.stringify({events:[{...event,replyToken:'synthetic-reply',source:{userId:sub}}]});
    const sig=signature?createHmac('sha256',variables.LINE_CHANNEL_SECRET).update(raw).digest('base64'):'bad';
    const r=await serve(new Request('https://test.invalid',{method:'POST',headers:{'x-line-signature':sig},body:raw}));
    assert.equal(r.status,signature?200:401);
    return replies.at(-1);
  }
  const text=(text,sub)=>event({type:'message',message:{type:'text',text}},sub);
  const post=(data,sub)=>event({type:'postback',postback:{data}},sub);
  const session=()=>tables.digital_relax_pilot_sessions[0];
  const scoped=data=>`${data}~${session().flow_id}~${session().revision}`;
  const click=data=>post(scoped(data));
  const begin=()=>post('rlx|start|yes');
  const complete=async()=>{await begin();for(let i=0;i<5;i++)await click(`rlx|answer|${i}|${catalog.relax.questions[i].options[0].value}`);};
  return {tables,calls,writes,replies,event,text,post,begin,session,scoped,click,complete};
}
const serialized=x=>JSON.stringify(x);
const supplementSnapshot=f=>serialized(Object.fromEntries(['quiz_sessions','consents','packs','intakes'].map(t=>[t,f.tables[t]])));

test('disabled, non-allowlisted and bad signatures do not create or read pilot records',async()=>{
  for(const options of [{enabled:false},{allow:''}]){
    const f=fixture(options);await f.text('放鬆測試');await f.post('rlx|start|yes');assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  }
  const f=fixture();await f.event({type:'postback',postback:{data:'rlx|start|yes'}},'invited',false);assert.equal(f.calls.length,0);
});
test('welcome, full disclosure and refusal do not create a user/session; admin may participate',async()=>{
  const f=fixture();const msg=await f.text('放鬆測試');assert.equal(msg[0].type,'flex');assert.match(serialized(msg),/完整資料說明/);
  await f.post('rlx|privacy');assert.match(serialized(f.replies.at(-1)),/30 天/);
  await f.post('rlx|start|no');assert.equal(f.writes.length,0);
  const admin=fixture({allow:'',admin:'invited'});await admin.begin();assert.equal(admin.session().step,0);
});
test('five questions, invalid options, back, pause, resume and repeated consent preserve state',async()=>{
  const f=fixture();await f.begin();assert.match(serialized(f.replies.at(-1)),/1\/5/);
  await f.click('rlx|answer|0|bogus');assert.equal(f.session().step,0);
  const a=f.scoped('rlx|answer|0|evening');await Promise.all([f.post(a),f.post(a)]);assert.equal(f.session().step,1);
  await f.begin();assert.equal(f.session().step,1);
  const back=f.scoped('rlx|back');await f.post(back);assert.deepEqual(f.session().answers,{});await f.post(back);assert.equal(f.session().step,0);
  await f.click('rlx|pause');assert.equal(f.session().paused,true);
  await f.click('rlx|answer|0|evening');assert.equal(f.session().step,0);
  await f.text('放鬆測試');await f.click('rlx|resume');assert.equal(f.session().paused,false);
  for(let i=0;i<5;i++)await f.click(`rlx|answer|${i}|${catalog.relax.questions[i].options[0].value}`);
  assert.equal(f.session().status,'scan');assert.equal(Object.keys(f.session().answers).length,5);
  assert.match(serialized(f.replies.at(-1)),/用前鏡頭看看心跳/);
});
test('skip requires no scan read and interest is recorded once, with no order or reminders',async()=>{
  const f=fixture();await f.complete();await f.click('rlx|scan|skip');assert.equal(f.session().status,'preview');
  assert.equal(f.calls.filter(c=>c.table==='scans').length,0);
  assert.equal(f.replies.at(-1).filter(m=>m.type==='flex').length,2);
  assert.match(serialized(f.replies.at(-1)),/尚未開放購買／不會扣款/);
  const interest=f.scoped('rlx|interest');await Promise.all([f.post(interest),f.post(interest)]);
  const time=f.session().interest_clicked_at;await f.click('rlx|interest');assert.equal(f.session().interest_clicked_at,time);
  assert.deepEqual([...new Set(f.writes.map(w=>w.table))],['digital_relax_pilot_sessions']);
});
test('old, low quality, future, invalid and missing scans never surface as current heart rate',async()=>{
  for(const bad of [null,{quality:0.1,bpm:70},{quality:null,bpm:70},{quality:0.8,bpm:null},{quality:0.8,bpm:300},{quality:0.8,bpm:70,scanned_at:'2099-01-01T00:00:00Z'},{quality:0.8,bpm:70,scanned_at:'2000-01-01T00:00:00Z'}]){
    const f=fixture();await f.complete();await f.click('rlx|scan|yes');
    if(bad)f.tables.scans.push({user_id:'fake-user',scanned_at:new Date().toISOString(),...bad});
    await f.text('我量好了');assert.equal(f.session().status,'scan');assert.match(serialized(f.replies.at(-1)),/略過/);
    await f.click('rlx|scan|skip');assert.equal(f.session().status,'preview');
  }
});
test('fresh high quality scan only displays transiently; scoped LIFF completion and duplicate completion are safe',async()=>{
  const f=fixture();await f.complete();await f.click('rlx|scan|yes');const started=f.session().scan_started_at;
  await f.click('rlx|scan|yes');assert.equal(f.session().scan_started_at,started);
  f.tables.scans.push({user_id:'fake-user',bpm:72,quality:0.8,scanned_at:new Date().toISOString()});
  await f.text('放鬆量測完成 old-flow');assert.equal(f.session().status,'scan');
  const done=`放鬆量測完成 ${f.session().flow_id}`;await f.text(done);assert.equal(f.session().status,'preview');
  assert.match(serialized(f.replies.at(-1)),/72 次／分鐘/);assert.doesNotMatch(serialized(f.session()),/bpm|quality/);
  const rev=f.session().revision;await f.text(done);assert.equal(f.session().revision,rev);
});
test('pilot and supplement/member state coexist; deletion and restarting never touch original data',async()=>{
  const f=fixture();f.tables.quiz_sessions.push({user_id:'fake-user',answers:{age:'30_34'},cur:'sex',multi:[],history:['age']});
  f.tables.consents.push({user_id:'fake-user',version:'intake-v1'});f.tables.packs.push({id:'original-pack',user_id:'fake-user'});f.tables.intakes.push({id:'original-intake'});
  const original=supplementSnapshot(f);await f.complete();const old=f.scoped('rlx|scan|skip');
  await f.click('rlx|restart');assert.equal(f.session(),undefined);await f.begin();await f.post(old);assert.equal(f.session().status,'quiz');
  await f.click('rlx|delete');assert.equal(f.session(),undefined);assert.equal(supplementSnapshot(f),original);
  await f.text('刪除放鬆測試資料');assert.equal(supplementSnapshot(f),original);
});
test('legacy supplement start/resume and member link routing still work while pilot exists',async()=>{
  const f=fixture();await f.begin();
  f.tables.consents.push({user_id:'fake-user',version:'intake-v1'});
  f.tables.quiz_sessions.push({user_id:'fake-user',answers:{age:'30_34'},cur:'sex',multi:[],history:['age']});
  const pilot=serialized(f.session());await f.text('開始問卷');assert.match(serialized(f.replies.at(-1)),/還沒答完/);
  await f.post('resume|go');assert.match(serialized(f.replies.at(-1)),/性別/);assert.equal(serialized(f.session()),pilot);
  await f.post('a|sex|male');assert.equal(f.tables.quiz_sessions[0].answers.sex,'male');
  assert.notEqual(f.tables.quiz_sessions[0].cur,'sex');assert.equal(serialized(f.session()),pilot);
  await f.text('我的組合');assert.match(serialized(f.replies.at(-1)),/還沒有組合/);
  assert.equal(serialized(f.session()),pilot);
  // Membership entry is an existing LIFF URI: validate it remains in the generated home menu code.
  assert.match(source,/\$\{LIFF_URL\}\/me\//);
});
test('storage errors provide a recovery response and do not leak details',async()=>{
  const f=fixture({failTable:'digital_relax_pilot_sessions'});await f.text('放鬆測試');
  assert.match(serialized(f.replies.at(-1)),/恢復進度/);assert.doesNotMatch(serialized(f.replies.at(-1)),/simulated DB/);
});
test('expired pilot records are removed without extending retention or touching supplement records',async()=>{
  const f=fixture();await f.begin();f.session().created_at='2000-01-01T00:00:00Z';await f.text('放鬆測試');
  assert.equal(f.session(),undefined);assert.equal(f.replies.at(-1)[0].type,'flex');
});

test('separate function instances use DB revision to reject concurrent writes',async()=>{
  const first=fixture();await first.begin();
  const second=fixture({sharedTables:first.tables});
  const action=first.scoped('rlx|answer|0|evening');
  await Promise.all([first.post(action),second.post(action)]);
  assert.equal(first.session().step,1);assert.equal(first.session().revision,1);
  assert.equal(first.writes.filter(w=>w.table==='quiz_sessions').length,0);
});
test('text deletion is idempotent and a previous run button cannot alter a new run',async()=>{
  const f=fixture();await f.begin();const old=f.scoped('rlx|answer|0|evening');
  await f.text('刪除放鬆測試資料');await f.text('刪除放鬆測試資料');
  await f.begin();await f.post(old);assert.equal(f.session().step,0);
});
