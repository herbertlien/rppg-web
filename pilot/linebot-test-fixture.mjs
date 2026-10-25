import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHmac,webcrypto} from 'node:crypto';
import {catalog} from './products.js';
// Run the actual generated Edge Function, including signature verification and routing.
// All network is rejected except the in-memory LINE reply/menu API mock.
const source = stripTypeScriptTypes(readFileSync(new URL('../backend/linebot/index.ts',import.meta.url),'utf8').replace(/^import .*createClient.*;$/m,''));
export function fixture({enabled=true,allow='invited',admin='',failTable=null,sharedTables=null,menu=false,productionScope=false,previousMenu=null,wrongBot=false,script=null}={}) {
  const tables=sharedTables ?? {users:[{id:'fake-user',line_sub:'invited'}],digital_relax_pilot_sessions:[],quiz_sessions:[],consents:[],packs:[],scans:[],rich_menus:[],intakes:[]};
  const calls=[], writes=[], replies=[],menuRequests=[];
  const menuState={defaultMenu:null,assigned:previousMenu,menus:new Map(previousMenu?[[previousMenu,{name:'original-supplement-menu'}]]:[]),failure:null,next:0};
  let serve;
  class Query {
    constructor(table){this.table=table;this.filters=[];this.mode='select';this.limitN=Infinity;}
    select(){return this;}
    eq(k,v){this.filters.push(r=>r[k]===v);return this;}
    is(k,v){this.filters.push(r=>(r[k]??null)===v);return this;}
    gte(k,v){this.filters.push(r=>r[k]>=v);return this;}
    lt(k,v){this.filters.push(r=>r[k]<v);return this;}
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
  const variables={RELAX_PILOT_ENABLED:enabled?'1':'0',RELAX_PILOT_LINE_SUBS:allow,ADMIN_LINE_SUBS:admin,LINE_CHANNEL_SECRET:'synthetic-test-secret',RELAX_ISOLATED_TEST:'1',RELAX_PILOT_RICH_MENU_ENABLED:menu?'1':'0',SUPABASE_URL:productionScope?'https://production.invalid':'https://rswcmlujwcwxvsffzise.supabase.co'};
  const activeSource=script??(menu&&!productionScope?source.replace('https://liff.line.me/2012160129-CwL40nTW','https://liff.line.me/2012194363-LYirSkEL'):source);
  vm.runInNewContext(activeSource,{
    createClient:()=>({from:table=>new Query(table)}),
    Deno:{env:{get:n=>variables[n]},serve:fn=>{serve=fn;}},
    fetch:async(url,options={})=>{
      const parsed=new URL(url),path=parsed.pathname,method=options.method??'GET';
      if(parsed.host==='glittery-longma-b8be7c.netlify.app'){
        assert.match(path,/^\/pilot\/relax-menus\/[a-z]+\.png$/);
        if(menuState.failure==='asset')return new Response('',{status:503});
        const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);const view=new DataView(bytes.buffer);view.setUint32(16,2500);view.setUint32(20,1686);
        return new Response(bytes);
      }
      assert.ok(['api.line.me','api-data.line.me'].includes(parsed.host),'no external network');
      if(path==='/v2/bot/info')return new Response(JSON.stringify({basicId:wrongBot?'@wrongbot':'@607idvzb'}));
      if(path.includes('/richmenu')){
        menuRequests.push({path,method});
        if(path.endsWith('/content'))return new Response('{}',{status:menuState.failure==='upload'?500:200});
        if(path==='/v2/bot/richmenu'&&method==='POST'){
          const id='richmenu-synthetic-'+(++menuState.next);menuState.menus.set(id,JSON.parse(options.body));return new Response(JSON.stringify({richMenuId:id}));
        }
        if(path==='/v2/bot/richmenu/list'&&method==='GET')return new Response(JSON.stringify({richmenus:[...menuState.menus].map(([richMenuId,m])=>({richMenuId,...m}))}));
        const all=path.match(/^\/v2\/bot\/user\/all\/richmenu(?:\/([^/]+))?$/);
        if(all){
          if(method==='GET')return menuState.defaultMenu?new Response(JSON.stringify({richMenuId:menuState.defaultMenu})):new Response('{}',{status:404});
          if(method==='POST'){assert.match(menuState.menus.get(all[1])?.name??'',/-home$/,'only the home menu may become the default');menuState.defaultMenu=all[1];return new Response('{}');}
        }
        const user=path.match(/^\/v2\/bot\/user\/invited\/richmenu(?:\/([^/]+))?$/);
        if(user){
          if(method==='GET')return menuState.assigned?new Response(JSON.stringify({richMenuId:menuState.assigned})):new Response('{}',{status:404});
          if(method==='DELETE'){menuState.assigned=null;return new Response('{}');}
          if(method==='POST'){
            if(menuState.failure==='link')return new Response('{}',{status:500});
            menuState.assigned=user[1];return new Response('{}');
          }
        }
        const rich=path.match(/^\/v2\/bot\/richmenu\/([^/]+)$/);
        if(rich){
          if(method==='GET')return menuState.menus.has(rich[1])?new Response(JSON.stringify(menuState.menus.get(rich[1]))):new Response('{}',{status:404});
          if(method==='DELETE'){assert.notEqual(rich[1],previousMenu,'never delete original menu');menuState.menus.delete(rich[1]);return new Response('{}');}
        }
        if(!menu)return new Response('{}');
        assert.fail('Unexpected menu API '+method+' '+path);
      }
      const body=options.body?JSON.parse(options.body):null;
      if(path==='/v2/bot/message/reply'){assert.ok(body.messages.length<=5);replies.push(body.messages);return new Response('{}');}
      assert.fail('Unexpected external API '+path);
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
  return {tables,calls,writes,replies,event,text,post,begin,session,scoped,click,complete,menuState,menuRequests,variables};
}

export {source};
