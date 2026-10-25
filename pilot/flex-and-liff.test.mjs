import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { catalog,createPreview } from './products.js';
import { relaxColors,relaxWelcome,relaxScanCard,relaxResultCard,relaxInterestCard,relaxHeartCard } from './relax-flex.js';
import { relaxFlowFromSearch,notifyRelaxScan } from './relax-liff.js';
const flow='12345678-1234-4234-8234-123456789abc';
const data=x=>`${x}~${flow}~1`;
const answers=Object.fromEntries(catalog.relax.questions.map(q=>[q.id,q.options[0].value]));
const preview=createPreview(catalog.relax,answers);
const cards=[relaxWelcome(),relaxScanCard(data),relaxScanCard(data,`https://liff.line.me/example/?relaxPilot=${flow}`),relaxResultCard(preview),relaxHeartCard(80,74),relaxHeartCard(80),relaxInterestCard(preview,data)];
function visit(node,fn){if(!node||typeof node!=='object')return;fn(node);for(const v of Object.values(node))if(Array.isArray(v))v.forEach(x=>visit(x,fn));else visit(v,fn);}
test('Flex payloads follow bounded LINE bubble/text/action structure',()=>{
  for(const card of cards){
    assert.equal(card.type,'flex');assert.ok(card.altText.length>0&&card.altText.length<=400);
    assert.equal(card.contents.type,'bubble');assert.ok(Buffer.byteLength(JSON.stringify(card.contents))<30000);
    let primaries=0;
    visit(card.contents,n=>{
      if(n.type==='text'){assert.ok(n.text.length>0&&n.text.length<=2000);assert.equal(n.wrap,true);assert.ok(!n.maxLines,'do not clip enlarged text');}
      if(n.type==='button'){assert.ok(n.action.label.length<=20);assert.equal(n.height,'md');if(n.style==='primary')primaries++;}
      if(n.type==='postback'){assert.ok(n.data.length<=300);assert.match(n.data,/^rlx\|/);}
      if(n.type==='uri')assert.match(n.uri,/^https:\/\/liff.line.me\//);
    });
    assert.ok(primaries<=1);
  }
});
function luminance(hex){const c=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722;}
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
test('all text/button brand pairs satisfy WCAG AA normal text contrast',()=>{
  for(const foreground of [relaxColors.ink,relaxColors.deep,relaxColors.muted])for(const background of [relaxColors.surface,relaxColors.canvas])assert.ok(contrast(foreground,background)>=4.5);
  assert.ok(contrast('#FFFFFF',relaxColors.deep)>=4.5);
});
test('personalization stays deterministic and independent of heart rate across all 432 answer combinations',()=>{
  let count=0;
  const walk=(i,a)=>{
    if(i===5){const p=createPreview(catalog.relax,a);assert.equal(p.tasks.length,14);assert.match(p.headline,new RegExp(a.minutes+' 分鐘'));assert.ok(!JSON.stringify(p).includes('undefined'));assert.deepEqual(createPreview(catalog.relax,a),p);count++;return;}
    const q=catalog.relax.questions[i];for(const o of q.options)walk(i+1,{...a,[q.id]:o.value});
  };walk(0,{});assert.equal(count,432);
  assert.deepEqual(relaxResultCard(preview).contents.body.contents.slice(0,4),relaxResultCard(preview,99).contents.body.contents.slice(0,4));
});
test('LIFF parses only valid scoped flow IDs, including liff.state redirects',()=>{
  assert.equal(relaxFlowFromSearch(''),null);assert.equal(relaxFlowFromSearch('?relaxPilot=bad'),null);
  assert.equal(relaxFlowFromSearch(`?relaxPilot=${flow}`),flow);
  assert.equal(relaxFlowFromSearch('?liff.state='+encodeURIComponent('/?relaxPilot='+flow)),flow);
  assert.equal(relaxFlowFromSearch('?liff.state='+encodeURIComponent('http://[')),null);
});
test('LIFF notification sends only for saved qualifying scans and handles missing permission',async()=>{
  const messages=[];const liffClient={isInClient:()=>true,sendMessages:async m=>messages.push(m)};
  for(const [saved,quality] of [[false,0.8],[true,0.1],[true,NaN]])await notifyRelaxScan({flow,saved,quality,liffClient});
  assert.equal(messages.length,0);
  assert.match(await notifyRelaxScan({flow,saved:true,quality:0.8,liffClient}),/完成/);
  assert.equal(messages[0][0].text,'我量好了');
  liffClient.sendMessages=async()=>{throw new Error('permission denied');};
  assert.match(await notifyRelaxScan({flow,saved:true,quality:0.8,liffClient}),/我量好了/);
  liffClient.isInClient=()=>false;assert.match(await notifyRelaxScan({flow,saved:true,quality:0.8,liffClient}),/回 LINE 聊天室/);
});
test('camera page scripts parse without syntax errors and original cloud endpoints are unchanged',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1].replace(/^import .*;$/gm,''));
  assert.match(html,/id="relaxPilotBack"/);assert.match(html,/gokvjcwjkhhnmckbbyxl.supabase.co\/functions\/v1\/scan/);
});
