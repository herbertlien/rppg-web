import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {prepare,validateConfig} from './prepare.mjs';
const template=JSON.parse(readFileSync(new URL('./config.example.json',import.meta.url)));
const list=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?list(join(dir,e.name)):[join(dir,e.name)]);
test('configuration rejects production URLs/IDs, secrets, insecure URLs and mismatched channels',()=>{
  for(const patch of [{isolatedTest:false},{supabaseUrl:'https://gokvjcwjkhhnmckbbyxl.supabase.co'},{liffId:'2012160129-CwL40nTW'},{siteUrl:'https://herbertlien.github.io/rppg-web'},{supabaseUrl:'http://test.invalid'},{supabaseUrl:'https://user:pass@test.invalid'},{siteUrl:"https://test'.invalid"},{LINE_CHANNEL_SECRET:'never-accepted'},{lineChannelId:'1234567890'}])assert.throws(()=>validateConfig({...template,...patch}));
  assert.equal(validateConfig({...template}).isolatedTest,true);
});
test('prepared artifacts replace every production identifier and refuse startup on a wrong project',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'deerly-artifact-test-')),out=join(dir,'artifacts');
  try{
    const result=prepare(new URL('./config.example.json',import.meta.url),out);assert.equal(result.mode,'template-not-connectable');
    const manifest=JSON.parse(readFileSync(join(out,'manifest.json')));assert.equal(manifest.deployed,false);assert.equal(manifest.containsSecrets,false);
    for(const file of list(out))if(/\.(html|js|ts|json|toml|sql)$/.test(file))assert.doesNotMatch(readFileSync(file,'utf8'),/gokvjcwjkhhnmckbbyxl|2012160129|herbertlien\.github\.io/);
    for(const name of ['scan','intake','linebot']){
      const code=stripTypeScriptTypes(readFileSync(join(out,'supabase/functions',name,'index.ts'),'utf8').replace(/^import .*createClient.*;$/m,''));
      let clients=0;const ctx={Deno:{env:{get:()=>undefined},serve:()=>{}},createClient:()=>{clients++;return {};}};
      assert.throws(()=>vm.runInNewContext(code,ctx),/Isolated test project mismatch/);assert.equal(clients,0);
      ctx.Deno.env.get=n=>n==='RELAX_ISOLATED_TEST'?'1':n==='SUPABASE_URL'?'https://wrong-test.invalid':undefined;
      assert.throws(()=>vm.runInNewContext(code,{...ctx}),/Isolated test project mismatch/);assert.equal(clients,0);
      const fetches=[];
      const good={Deno:{env:{get:n=>n==='RELAX_ISOLATED_TEST'?'1':n==='SUPABASE_URL'?template.supabaseUrl:undefined},serve:()=>{}},createClient:()=>({}),Response,fetch:async(...args)=>{fetches.push(args);throw new Error('External network forbidden');}};
      const suffix=name==='linebot'?'\nglobalThis.controls={line,setupMenus};':'';
      vm.runInNewContext(code+suffix,good);
      if(name==='linebot'){
        await good.controls.line('/v2/bot/user/synthetic/richmenu/anything');
        await assert.rejects(good.controls.setupMenus(),/disabled/);assert.equal(fetches.length,0);
      }
    }
    assert.throws(()=>prepare(new URL('./config.example.json',import.meta.url),out),/Output must be new/);
    assert.ok(existsSync(join(out,'site/vendor/face_landmarker.task')));
    assert.ok(existsSync(join(out,'supabase/migrations/20261025000000_schema.sql')));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
