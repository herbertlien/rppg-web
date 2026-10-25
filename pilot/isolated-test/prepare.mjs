// Prepare artifacts only. Never deploy, contact LINE, or open a database.
import { readFileSync,writeFileSync,mkdirSync,cpSync,mkdtempSync,rmSync,readdirSync,lstatSync,realpathSync,existsSync } from 'node:fs';
import { resolve,join,relative,extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root=fileURLToPath(new URL('../../',import.meta.url));
const production=['gokvjcwjkhhnmckbbyxl','2012160129','herbertlien.github.io'];
export function validateConfig(config){
  const keys=['isolatedTest','supabaseUrl','siteUrl','liffId','lineChannelId'];
  if(Object.keys(config).some(k=>!keys.includes(k)))throw new Error('Unknown field; public config must not contain tokens or secrets');
  if(config.isolatedTest!==true)throw new Error('isolatedTest must explicitly be true');
  for(const key of keys.slice(1)){
    if(typeof config[key]!=='string'||!config[key]||production.some(p=>config[key].toLowerCase().includes(p)))throw new Error('Missing or production setting: '+key);
  }
  for(const key of ['supabaseUrl','siteUrl']){
    const u=new URL(config[key]);
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!/^[a-zA-Z0-9.-]+$/.test(u.hostname)||!/^\/[a-zA-Z0-9/_-]*$/.test(u.pathname))throw new Error('Use a plain HTTPS public URL: '+key);
    if(key==='supabaseUrl'&&u.pathname!=='/')throw new Error('Supabase URL must have no path');
    config[key]=config[key].replace(/\/$/,'');
  }
  if(!/^[0-9]{5,15}-[A-Za-z0-9_-]+$/.test(config.liffId)||!/^[0-9]{5,15}$/.test(config.lineChannelId))throw new Error('Invalid LINE public IDs');
  if(config.liffId.split('-')[0]!==config.lineChannelId)throw new Error('LIFF ID must belong to the declared LINE Login channel');
  return config;
}
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
  const path=join(dir,e.name);
  if(lstatSync(path).isSymbolicLink())throw new Error('Symlinks are not allowed in artifacts');
  return e.isDirectory()?files(path):[path];
});}
function rewrite(text,c){
  return text.replaceAll('https://gokvjcwjkhhnmckbbyxl.supabase.co',c.supabaseUrl)
    .replaceAll('2012160129-CwL40nTW',c.liffId).replaceAll('2012160129',c.lineChannelId)
    .replaceAll('https://herbertlien.github.io/rppg-web',c.siteUrl)
    .replaceAll('https://herbertlien.github.io',new URL(c.siteUrl).origin);
}
export function prepare(configPath,output){
  const c=validateConfig(JSON.parse(readFileSync(configPath,'utf8')));
  // Require a new, sibling artifact directory, never a checkout/subdirectory or existing output.
  output=resolve(output);
  const parent=realpathSync(resolve(output,'..'));
  const actual=join(parent,output.split('/').at(-1));
  const inside=relative(root,actual);
  if(!(inside==='..'||inside.startsWith('../'))||actual===root||existsSync(output))throw new Error('Output must be new and outside the repository');
  const work=mkdtempSync(join(tmpdir(),'deerly-test-build-'));
  let madeOutput=false;
  try{
    for(const dir of ['engine','backend','pilot'])cpSync(join(root,dir),join(work,dir),{recursive:true});
    execFileSync(process.execPath,[join(work,'backend/linebot/build.mjs')],{stdio:'pipe'});
    execFileSync(process.execPath,[join(work,'backend/intake/build.mjs')],{stdio:'pipe'});
    mkdirSync(output);madeOutput=true;
    const site=join(output,'site');mkdirSync(site);
    cpSync(join(root,'index.html'),join(site,'index.html'));
    for(const dir of ['vendor','engine','me','quiz','review','menus','cards'])cpSync(join(root,dir),join(site,dir),{recursive:true});
    mkdirSync(join(site,'pilot'));
    for(const name of ['relax-liff.js','products.js'])cpSync(join(root,'pilot',name),join(site,'pilot',name));
    // Drop development-only files from the public website.
    for(const path of files(site))if(['.md','.mjs'].includes(extname(path))&&!path.includes('/vendor/'))rmSync(path);
    for(const path of files(site))if(['.html','.js','.json'].includes(extname(path)))writeFileSync(path,rewrite(readFileSync(path,'utf8'),c));
    const supabase=join(output,'supabase');mkdirSync(join(supabase,'migrations'),{recursive:true});
    writeFileSync(join(supabase,'config.toml'),'project_id = "deerly-isolated-test"\n\n'+['scan','intake','linebot'].map(name=>`[functions.${name}]\nverify_jwt = false\n`).join('\n'));
    const guard=`\n// This generated artifact is locked to the declared isolated test project.\nif (Deno.env.get("RELAX_ISOLATED_TEST") !== "1" || (Deno.env.get("SUPABASE_URL") ?? "").replace(/\\/$/, "") !== ${JSON.stringify(c.supabaseUrl)}) {\n  throw new Error("Isolated test project mismatch; refusing to start");\n}\n`;
    for(const [name,source] of [['scan','backend/scan-function.ts'],['intake','backend/intake/index.ts'],['linebot','backend/linebot/index.ts']]){
      const sourceRoot=name==='scan'?root:work;
      let text=rewrite(readFileSync(join(sourceRoot,source),'utf8'),c);
      const client=text.indexOf('const db = createClient(');if(client<0)throw new Error('Cannot install project guard');
      text=text.slice(0,client)+guard+text.slice(client);
      if(name==='linebot'){
        // Never create/update/delete rich menus, even with mistakenly supplied management requests.
        text=text.replace('async function setupMenus() {','async function setupMenus() {\n  throw new Error("Rich menu setup disabled in isolated test artifacts");');
        text=text.replace('async function line(path: string, method = "POST", body?: unknown, host = "api.line.me") {',
          'async function line(path: string, method = "POST", body?: unknown, host = "api.line.me") {\n  if (path.includes("/richmenu")) return {};');
        text=text.replace('const ASSET_BASE = Deno.env.get("ASSET_BASE") ??', 'const ASSET_BASE =');
      }
      mkdirSync(join(supabase,'functions',name),{recursive:true});writeFileSync(join(supabase,'functions',name,'index.ts'),text);
    }
    const migrations=['schema.sql','schema-intake.sql','schema-linebot.sql','schema-digital-relax-pilot.sql'];
    migrations.forEach((name,i)=>{
      const pre=i===0?"-- Fresh, empty TEST database only. Never import production data.\ndo $$ begin if to_regclass('public.users') is not null then raise exception 'Refusing bootstrap: users table already exists'; end if; end $$;\n":'';
      writeFileSync(join(supabase,'migrations',`2026102500000${i}_${name}`),pre+readFileSync(join(root,'backend',name),'utf8'));
    });
    mkdirSync(join(output,'operations'));
    for(const name of ['cleanup-digital-relax-pilot.sql','rollback-digital-relax-pilot.sql'])cpSync(join(root,'backend',name),join(output,'operations',name));
    const template=[c.supabaseUrl,c.siteUrl].some(s=>new URL(s).hostname.endsWith('.invalid'))||c.liffId==='0000000000-testonly'||c.lineChannelId==='0000000000';
    writeFileSync(join(output,'manifest.json'),JSON.stringify({mode:template?'template-not-connectable':'configured-not-deployed',publicConfig:c,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),deployed:false,containsSecrets:false,requiredSecretNames:['SUPABASE_SERVICE_ROLE_KEY','LINE_CHANNEL_SECRET','LINE_CHANNEL_ACCESS_TOKEN'],requiredVariables:['RELAX_ISOLATED_TEST=1','RELAX_PILOT_ENABLED=1','RELAX_PILOT_LINE_SUBS=<test IDs only>'],cleanupScheduled:false},null,2)+'\n');
    for(const path of files(output))if(['.html','.js','.mjs','.ts','.json','.sql','.toml'].includes(extname(path))){
      const text=readFileSync(path,'utf8').toLowerCase();if(production.some(p=>text.includes(p)))throw new Error('Production reference remains in '+relative(output,path));
    }
    return {output,mode:template?'template-not-connectable':'configured-not-deployed'};
  }catch(e){if(madeOutput)rmSync(output,{recursive:true,force:true});throw e;}
  finally{rmSync(work,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [config,output]=process.argv.slice(2);if(!config||!output)throw new Error('Usage: node pilot/isolated-test/prepare.mjs <public-config.json> <new-directory-outside-checkout>');
  console.log(JSON.stringify(prepare(config,output)));
}
