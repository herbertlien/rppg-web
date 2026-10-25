import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {stripTypeScriptTypes} from 'node:module';
import {prepare} from './isolated-test/prepare.mjs';
import {catalog} from './products.js';
import {relaxMenuLayout,relaxMenuDefinition,relaxMenuSize} from './relax-rich-menu.js';
import {fixture} from './linebot-test-fixture.mjs';
test('all 5 menu images have valid dimensions, bounded nonoverlapping touch areas and scoped postbacks',()=>{
 for(const [step,q] of catalog.relax.questions.entries()){
  const image=readFileSync(new URL(`./relax-menus/${q.id}.png`,import.meta.url));
  assert.ok(image.length<1_000_000);assert.equal(image.readUInt32BE(16),2500);assert.equal(image.readUInt32BE(20),1686);
  const menu=relaxMenuDefinition(q,{flow_id:'synthetic-flow',revision:12,step});
  assert.deepEqual(menu.size,relaxMenuSize);assert.ok(menu.name.length<=300);assert.ok(menu.chatBarText.length<=14);
  for(const {bounds:b,action:a} of menu.areas){
   assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=2500&&b.y+b.height<=1686);
   assert.ok(b.height/2500*360>=44,'navigation targets remain touchable');
   assert.match(a.data,/~synthetic-flow~12$/);assert.ok(a.data.length<=300);
  }
  for(let i=0;i<menu.areas.length;i++)for(let j=i+1;j<menu.areas.length;j++){
   const a=menu.areas[i].bounds,b=menu.areas[j].bounds;assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y);
  }
  assert.equal(relaxMenuLayout(q).length,q.options.length);
 }
});
test('five large menus advance with scoped actions; duplicate clicks do not skip; no global default change',async()=>{
 const f=fixture({menu:true});await f.begin();
 for(let step=0;step<5;step++){
  assert.equal(f.session().step,step);const menu=f.menuState.menus.get(f.menuState.assigned);
  assert.ok(menu);const action=menu.areas[0].action.data;await f.post(action);await f.post(action);
 }
 assert.equal(f.session().status,'scan');assert.equal(f.menuState.assigned,null);assert.equal(f.menuState.menus.size,0);
 assert.ok(!f.menuRequests.some(r=>r.path.includes('/all/')));
});
test('back/pause/resume preserves progress and restores original per-user menu; deletion restores it too',async()=>{
 const f=fixture({menu:true,previousMenu:'original-menu'});await f.begin();await f.click('rlx|answer|0|evening');
 assert.notEqual(f.menuState.assigned,'original-menu');await f.click('rlx|back');assert.equal(f.session().step,0);
 await f.click('rlx|pause');assert.equal(f.menuState.assigned,'original-menu');assert.equal(f.menuState.menus.size,1);
 await f.click('rlx|resume');assert.notEqual(f.menuState.assigned,'original-menu');await f.text('刪除放鬆測試資料');
 assert.equal(f.menuState.assigned,'original-menu');assert.equal(f.session(),undefined);assert.equal(f.menuState.menus.size,1);
});
test('repeating resume reuses existing menu; stale old-menu action cannot alter a restarted flow',async()=>{
 const f=fixture({menu:true});await f.begin();const old=f.menuState.menus.get(f.menuState.assigned).areas[0].action.data;
 const count=f.menuState.next;await f.click('rlx|resume');assert.equal(f.menuState.next,count);
 await f.click('rlx|restart');await f.begin();await f.post(old);assert.equal(f.session().step,0);
});
test('missing images, uploads or linking failures fall back to Quick Reply without losing original menu',async()=>{
 for(const failure of ['asset','upload','link']){
  const f=fixture({menu:true,previousMenu:'original-menu'});f.menuState.failure=failure;await f.begin();
  assert.equal(f.menuState.assigned,'original-menu');assert.match(JSON.stringify(f.replies.at(-1)),/訊息下方按鈕/);
  assert.equal(f.menuState.menus.size,1);f.menuState.failure=null;await f.click('rlx|resume');assert.notEqual(f.menuState.assigned,'original-menu');
 }
});
test('production scope, wrong bot and nonallowlisted users cannot create or change menus',async()=>{
 for(const options of [{menu:true,productionScope:true},{menu:true,wrongBot:true},{menu:true,allow:''}]){
  const f=fixture(options);await f.begin();assert.equal(f.menuRequests.filter(r=>r.method!=='GET').length,0);
 }
});
test('restoration does not overwrite a menu selected by another flow; original quiz records stay unchanged',async()=>{
 const f=fixture({menu:true,previousMenu:'original-menu'});f.tables.quiz_sessions.push({user_id:'fake-user',cur:'sex',answers:{age:'30_34'},multi:[],history:['age']});
 const original=JSON.stringify(f.tables.quiz_sessions);await f.begin();
 f.menuState.menus.set('another-flow',{name:'another-flow'});f.menuState.assigned='another-flow';
 await f.click('rlx|pause');assert.equal(f.menuState.assigned,'another-flow');assert.equal(JSON.stringify(f.tables.quiz_sessions),original);
});
test('explicit menu-stop command restores default and pauses without deleting answers',async()=>{
 const f=fixture({menu:true});await f.begin();await f.click('rlx|answer|0|evening');await f.text('收起放鬆選單');
 assert.equal(f.menuState.assigned,null);assert.equal(f.session().paused,true);assert.equal(f.session().answers.goal,'evening');
});

test('configured isolated artifact executes the same guarded Rich Menu flow as source',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relax-configured-menu-'));
 try{
  const config={isolatedTest:true,supabaseUrl:'https://rswcmlujwcwxvsffzise.supabase.co',siteUrl:'https://glittery-longma-b8be7c.netlify.app',liffId:'2012194363-LYirSkEL',lineChannelId:'2012194363'};
  writeFileSync(join(dir,'config.json'),JSON.stringify(config));prepare(join(dir,'config.json'),join(dir,'out'));
  const raw=readFileSync(join(dir,'out/supabase/functions/linebot/index.ts'),'utf8');
  const script=stripTypeScriptTypes(raw.replace(/^import .*createClient.*;$/m,''));
  const f=fixture({menu:true,previousMenu:'original-menu',script});await f.complete();
  assert.equal(f.session().status,'scan');assert.equal(f.menuState.assigned,'original-menu');assert.equal(f.menuState.menus.size,1);
  const wrong=fixture({menu:true,wrongBot:true,script});await wrong.begin();assert.equal(wrong.menuRequests.length,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('read-only diagnostics distinguish disabled switch, wrong bot and image HTTP failure without creating menus',async()=>{
 const off=fixture({menu:true});off.variables.RELAX_PILOT_RICH_MENU_ENABLED='0';await off.begin();
 assert.match(JSON.stringify(off.replies.at(-1)),/MENU_SWITCH_OFF/);
 const writes=off.writes.length;await off.text('選單診斷');
 assert.match(JSON.stringify(off.replies.at(-1)),/未開啟/);assert.equal(off.writes.length,writes);
 assert.equal(off.menuRequests.filter(r=>r.method!=='GET').length,0);
 const wrong=fixture({menu:true,wrongBot:true});await wrong.text('選單診斷');assert.match(JSON.stringify(wrong.replies.at(-1)),/MENU_WRONG_BOT/);
 assert.equal(wrong.menuRequests.length,0);
 const image=fixture({menu:true});image.menuState.failure='asset';await image.begin();
 assert.match(JSON.stringify(image.replies.at(-1)),/MENU_IMAGE_HTTP_503/);
 await image.text('選單診斷');assert.match(JSON.stringify(image.replies.at(-1)),/HTTP 503/);
});
test('fallback reports upload and link stages and HTTP status without disclosing credentials or LINE user IDs',async()=>{
 for(const [failure,code] of [['upload','MENU_UPLOAD_HTTP_500'],['link','MENU_LINK_HTTP_500']]){
  const f=fixture({menu:true});f.menuState.failure=failure;await f.begin();
  const text=JSON.stringify(f.replies.at(-1));assert.ok(text.includes(code));assert.ok(!text.includes('synthetic-test-secret'));assert.ok(!text.includes('fake-user'));
 }
});

test('typed continue resumes pilot instead of legacy supplement quiz on the isolated test bot',async()=>{
 const f=fixture({menu:true});f.tables.quiz_sessions.push({user_id:'fake-user',cur:'sex',answers:{age:'30_34'},multi:[],history:['age']});
 const original=JSON.stringify(f.tables.quiz_sessions);await f.begin();await f.click('rlx|pause');
 await f.text('繼續');assert.equal(f.session().paused,false);assert.match(JSON.stringify(f.replies.at(-1)),/放鬆練習 1\/5/);
 assert.equal(JSON.stringify(f.tables.quiz_sessions),original);assert.ok(f.menuState.assigned);
 const legacy=fixture({menu:true,productionScope:true});legacy.tables.quiz_sessions.push({user_id:'fake-user',cur:'sex',answers:{age:'30_34'},multi:[],history:['age']});
 await legacy.text('繼續');assert.match(JSON.stringify(legacy.replies.at(-1)),/性別/);assert.equal(legacy.menuRequests.filter(r=>r.method!=='GET').length,1); // existing original flow request, no pilot creation
});

test('Rich Menu is the sole answer surface on success; later questions omit repeated instructions',async()=>{
 const f=fixture({menu:true});await f.begin();
 let message=f.replies.at(-1)[0];assert.equal(message.quickReply,undefined);assert.match(message.text,/答案在下方大字選單/);
 for(let step=0;step<4;step++){
  const menu=f.menuState.menus.get(f.menuState.assigned);await f.post(menu.areas[0].action.data);
  message=f.replies.at(-1)[0];assert.equal(message.quickReply,undefined);
  assert.equal(message.text,`放鬆練習 ${step+2}/5\n${catalog.relax.questions[step+1].text}`);
 }
 const fallback=fixture({menu:true});fallback.menuState.failure='asset';await fallback.begin();
 assert.ok(fallback.replies.at(-1)[0].quickReply.items.length>0);
});
