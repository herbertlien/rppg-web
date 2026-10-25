// Render static test menu images with installed Chromium; no LINE/DB requests.
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {catalog} from './products.js';
import {relaxMenuLayout,relaxMenuVersion} from './relax-rich-menu.js';
const out=new URL('./relax-menus/',import.meta.url);mkdirSync(out,{recursive:true});
const temp=mkdtempSync(join(tmpdir(),'relax-menu-render-'));
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const browser=await chromium.launch({executablePath:process.env.CHROME||'/usr/bin/chromium',headless:true,args:['--no-sandbox'],env:{...process.env,XDG_CONFIG_HOME:join(temp,'config'),XDG_CACHE_HOME:join(temp,'cache')}});
const page=await browser.newPage({viewport:{width:2500,height:1686},deviceScaleFactor:1});
await page.route('**/*',route=>route.abort());
try{
 for(const [i,q] of catalog.relax.questions.entries()){
  const options=relaxMenuLayout(q);
  const html=`<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;width:2500px;height:1686px;position:relative;background:#F6F1EA;color:#1E2A24;font-family:"Noto Sans CJK TC","Noto Sans TC",sans-serif}
  .brand{position:absolute;top:46px;left:110px;font-size:72px;font-weight:700;letter-spacing:6px;color:#1F5C42}.count{position:absolute;right:110px;top:46px;font-size:78px;color:#52655B}
  .bar{position:absolute;left:110px;top:172px;width:2280px;height:16px;border-radius:8px;background:#E3DACB}.bar div{height:100%;background:#2F7D5B;border-radius:8px;width:${i/5*100}%}
  h1{position:absolute;left:110px;right:110px;top:230px;margin:0;font-size:126px;line-height:1.6;font-weight:800}
  .opt{position:absolute;background:#fff;border:5px solid #2F7D5B;border-radius:48px;box-shadow:0 10px 0 #E4EDE7;display:flex;align-items:center;justify-content:center;color:#1F5C42;font-size:150px;font-weight:700;line-height:1.2;padding:20px 35px;text-align:center}
  .nav{position:absolute;top:1340px;height:310px;display:flex;align-items:center;justify-content:center;font-size:90px;color:#1F5C42;border-radius:40px;border:4px solid #E3DACB}.back{left:110px;width:1090px}.pause{left:1300px;width:1090px;background:#E4EDE7}.disabled{color:#52655B;border-color:transparent}
  </style><div class="brand">Deerly <span style="font-size:48px;font-weight:400">/ 放鬆練習</span></div><div class="count">${i+1} / 5</div><div class="bar"><div></div></div><h1>${esc(q.text)}</h1>
  ${options.map(o=>`<div class="opt" style="left:${o.bounds.x}px;top:${o.bounds.y}px;width:${o.bounds.width}px;height:${o.bounds.height}px">${esc(o.label)}</div>`).join('')}
  <div class="nav back ${i===0?'disabled':''}">${i===0?'點選答案，開始練習':'‹ 上一題'}</div><div class="nav pause">先暫停</div>`;
  await page.setContent(html,{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>document.fonts.ready);
  const overflow=await page.locator('.opt,h1,.nav').evaluateAll(nodes=>nodes.filter(n=>n.scrollWidth>n.clientWidth||n.scrollHeight>n.clientHeight).map(n=>({text:n.textContent,w:n.clientWidth,sw:n.scrollWidth,h:n.clientHeight,sh:n.scrollHeight})));
  if(overflow.length)throw new Error('Text overflow in '+q.id+': '+JSON.stringify(overflow));
  await page.screenshot({path:new URL(q.id+'.png',out).pathname});
  const png=readFileSync(new URL(q.id+'.png',out));if(png.length>1_000_000)throw new Error('Image exceeds LINE 1MB: '+q.id);
 }
 writeFileSync(new URL('manifest.json',out),JSON.stringify({version:relaxMenuVersion,size:{width:2500,height:1686},questions:catalog.relax.questions.map(q=>({id:q.id,areas:relaxMenuLayout(q)}))},null,2)+'\n');
 writeFileSync(new URL('preview.html',out),`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deerly 測試問卷選單預覽</title><style>body{background:#F6F1EA;color:#1E2A24;font:17px/1.6 sans-serif;margin:24px}main{max-width:800px;margin:auto}img{display:block;width:100%;max-width:390px;border-radius:12px;border:1px solid #E3DACB}section{margin:32px 0}p{max-width:600px}</style><main><h1>Deerly 放鬆問卷・大字選單</h1><p>這是設計預覽，非 LINE App 截圖。選單原圖為 2500×1686；此頁以最多 390px 寬呈現。實際需在 LINE 點聊天室底部選單列展開。</p>${catalog.relax.questions.map((q,i)=>`<section><h2>${i+1}/5 ${esc(q.text)}</h2><img src="${q.id}.png" alt="${esc(q.text)}：${relaxMenuLayout(q).map(o=>esc(o.label)).join('、')}" loading="lazy"></section>`).join('')}</main></html>`);
 console.log('Rendered 5 Rich Menu PNGs, geometry manifest and 390px design preview.');
}finally{await browser.close();rmSync(temp,{recursive:true,force:true});}
