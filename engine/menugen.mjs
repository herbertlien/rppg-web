// 產生 LINE 聊天室下方的選單圖：每個單選題一張 2500×1686 的 PNG，加上點選區域座標。
// 執行：node engine/menugen.mjs（需要 playwright 與 Chromium）。輸出在 menus/，推上 GitHub Pages 後由後端建立選單。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const pw = await import(process.env.PLAYWRIGHT || 'playwright'); const chromium = pw.chromium || pw.default.chromium;

// 視覺基調集中在這裡，之後換品牌只改這一組
const C = { bg: '#F6F1EA', card: '#FFFFFF', ink: '#1E2A24', mut: '#7A8780', ac: '#2F7D5B', acDark: '#1F5C42', soft: '#E4EDE7', track: '#E3DACB' };
const FONT = '"Noto Sans TC","PingFang TC","WenQuanYi Zen Hei",sans-serif';
const W = 2500, H = 1686, PAD = 80, GAP = 48;
const data = JSON.parse(readFileSync(new URL('./data/questions.json', import.meta.url), 'utf8'));
const out = new URL('../menus/', import.meta.url);
mkdirSync(out, { recursive: true });

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const DONE_H = 170;
// 題目字級：15 字以內一行用大字，其餘折成兩行用同一個較大的字級，全部題目看起來一致
const QTOP = 195;
function qinfo(text) {
  const qfs = text.length <= 15 ? 150 : 125;
  const lines = Math.ceil(text.length * qfs / (W - PAD * 2));
  return { qfs, head: Math.round(QTOP + lines * qfs * 1.2 + 40) };
}

// 選項排版：依欄數排；複選題底部多一條「完成」
function layout(n, cols, head, multi = false) {
  const rows = Math.ceil(n / cols);
  const bottom = multi ? DONE_H + GAP : 0;
  const bw = (W - PAD * 2 - GAP * (cols - 1)) / cols;
  const bh = (H - head - PAD - bottom - GAP * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => ({
    x: Math.round(PAD + (i % cols) * (bw + GAP)),
    y: Math.round(head + Math.floor(i / cols) * (bh + GAP)),
    w: Math.round(bw), h: Math.round(bh),
  }));
}

// 估算字寬：中文約 1 個字級寬，英數與符號約 0.6
const wlen = t => [...t].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 1 : 0.6), 0);
// 手機上 2500 px 寬的圖約縮成 390 pt，字級 150 px 約等於 23 pt。字盡量大；一行放不下就允許折成兩行
function optionFont(q, boxes, side) {
  const n = q.options.length, longest = Math.max(...q.options.map(o => wlen(o.chip || o.label)));
  const base = n <= 3 ? 190 : n <= 8 ? 150 : 120;
  const room = boxes[0].w - side, h = boxes[0].h;
  const fs1 = Math.min(base, Math.floor(room / (longest * 1.04)), Math.floor((h - 40) / 1.3));
  const fs2 = Math.min(base, Math.floor(room / (Math.ceil(longest / 2) * 1.04)), Math.floor((h - 50) / 2.6));
  return fs2 > fs1 * 1.15 ? { fs: fs2, lines: 2 } : { fs: Math.max(72, fs1), lines: 1 };
}
// 單欄、雙欄、三欄都試一次，取字最大的（字一樣大就選欄數多的）
function bestLayout(q, head, multi) {
  const side = multi ? 120 : 160, n = q.options.length;
  const choices = n <= 3 ? [1] : n <= 6 ? [1, 2] : n <= 9 ? [2, 3] : [3];
  let best = null;
  for (const cols of choices) {
    const boxes = layout(n, cols, head, multi);
    const o = optionFont(q, boxes, side);
    const score = o.fs * (o.lines === 2 ? 0.85 : 1);   // 折行的版本扣分，同分取較少欄
    if (!best || score > best.score * 1.02) best = { cols, boxes, fs: o.fs, score };
  }
  return best;
}

function html(q, boxes, fs, idx, total, qfs, title) {
  const multi = q.type === 'multi';
  const lab = o => o.chip || o.label;
  const btn = (o, b) => `<div class="b" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"><span style="font-size:${fs}px">${esc(lab(o))}</span>${multi ? '' : `<i style="font-size:${Math.round(fs * 0.9)}px">›</i>`}</div>`;
  const done = multi ? `<div class="done" style="left:${PAD}px;top:${H - PAD - DONE_H}px;width:${W - PAD * 2}px;height:${DONE_H}px">${q.options.some(o => o.exclusive) ? '選好了（沒有也按這裡）✔' : '選好了，按這裡完成 ✔'}</div>` : '';
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:${C.bg};font-family:${FONT};position:relative;overflow:hidden}
  .brand{position:absolute;left:${PAD}px;top:44px;font-size:68px;color:${C.ac};font-weight:700;letter-spacing:6px}
  .n{position:absolute;right:${PAD}px;top:44px;font-size:68px;color:${C.mut};font-weight:700}
  .bar{position:absolute;left:${PAD}px;right:${PAD}px;top:150px;height:22px;border-radius:11px;background:${C.track}}
  .bar div{height:100%;border-radius:11px;background:${C.ac};width:${Math.round(idx / total * 100)}%}
  .q{position:absolute;left:${PAD}px;right:${PAD}px;top:${QTOP}px;font-size:${qfs}px;font-weight:900;color:${C.ink};line-height:1.2}
  .b{position:absolute;box-sizing:border-box;background:${C.card};border:8px solid ${C.ac};border-radius:${multi ? 56 : 72}px;box-shadow:0 14px 0 ${C.soft};display:flex;align-items:center;justify-content:center;text-align:center;padding:0 ${multi ? 36 : 130}px 0 ${multi ? 36 : 60}px;color:${C.acDark};font-weight:700;line-height:1.25}
  .b i{position:absolute;right:56px;font-style:normal;color:${C.ac};font-weight:400}
  .done{position:absolute;box-sizing:border-box;background:${C.ac};border-radius:72px;box-shadow:0 14px 0 ${C.acDark};display:flex;align-items:center;justify-content:center;color:#fff;font-size:100px;font-weight:800;letter-spacing:4px}
  </style><div class="brand">Deerly</div><div class="n">${idx} / ${total}</div><div class="bar"><div></div></div><div class="q">${esc(title)}</div>
  ${q.options.map((o, i) => btn(o, boxes[i])).join('')}${done}`;
}

const total = data.questions.length;
const areas = {};
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
for (const q of data.questions) {
  const multi = q.type === 'multi';
  const title = multi ? q.text.replace(/可以複選。?$/, '') : q.text;
  const { qfs, head } = qinfo(title);
  const { boxes, fs } = bestLayout(q, head, multi);
  await page.setContent(html(q, boxes, fs, data.questions.indexOf(q) + 1, total, qfs, title));
  await page.screenshot({ path: new URL(`${q.id}.png`, out).pathname });
  areas[q.id] = q.options.map((o, i) => ({ value: o.value, ...boxes[i] }));
  if (multi) areas[q.id].push({ value: '__done', x: PAD, y: H - PAD - DONE_H, w: W - PAD * 2, h: DONE_H });
}
// 開始問卷時送出的操作說明圖：告訴使用者答案在下方選單，不用打字
await page.setViewportSize({ width: 1040, height: 1040 });
await page.setContent(`<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:1040px;height:1040px;background:#f4efe8;font-family:"Noto Sans TC","PingFang TC","WenQuanYi Zen Hei",sans-serif;position:relative;overflow:hidden;color:#222}
h1{position:absolute;left:60px;right:60px;top:50px;margin:0;font-size:66px;line-height:1.3}
h1 b{color:#2f7d5b}
.chat{position:absolute;left:60px;top:260px;width:620px;background:#fff;border-radius:40px;padding:34px 40px;font-size:46px;line-height:1.4;box-shadow:0 4px 0 #ddd}
.bar{position:absolute;left:0;right:0;bottom:0;height:230px;background:#2f7d5b;display:flex;align-items:center;justify-content:center;color:#fff;font-size:70px;font-weight:700;letter-spacing:4px}
.arr{position:absolute;left:0;right:0;bottom:250px;text-align:center;font-size:130px;color:#2f7d5b;line-height:1}
.tip{position:absolute;left:60px;right:60px;bottom:420px;text-align:center;font-size:56px;font-weight:700;color:#2f7d5b}
</style><h1>答案在<b>下方選單</b>，<br>點一下就好，不用打字</h1>
<div class="chat">（1/19）先確認一下，你的年齡是？</div>
<div class="tip">看到這個就點它 ↓</div><div class="arr">▼</div>
<div class="bar">點這裡作答 ▴</div>`);
await page.screenshot({ path: new URL('intro.png', out).pathname });

// 主選單：三步驟卡片，編號與箭頭表達先後順序
const HW = 2500, HH = 1120, STRIP = 340, hb = [['scan', '今日電量', '30 秒掃臉看狀態'], ['quiz', '每日問卷', '整理你的組合'], ['pack', '我的組合', '看目前狀態']];
const hg = 110, hw = Math.floor((HW - 60 * 2 - hg * 2) / 3);
const logoUri = 'data:image/png;base64,' + readFileSync(new URL('../menus/brand-logo.png', import.meta.url)).toString('base64');
await page.setViewportSize({ width: HW, height: HH });
await page.setContent(`<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:${HW}px;height:${HH}px;background:${C.bg};font-family:${FONT};position:relative;overflow:hidden}
.brandrow{position:absolute;left:60px;right:60px;top:40px;height:${STRIP - 80}px;display:flex;align-items:center;gap:56px}
.brandrow img{width:250px;height:250px;border-radius:56px;background:#fff;box-shadow:0 10px 0 ${C.soft}}
.brandrow .t small{display:block;font-size:56px;font-weight:700;letter-spacing:16px;color:${C.ac};margin-bottom:8px}
.brandrow .t b{font-size:132px;font-weight:900;color:${C.ink};line-height:1.15;white-space:nowrap}
.brandrow .t b em{font-style:normal;color:${C.ac}}
.b{position:absolute;top:${STRIP}px;height:${HH - STRIP - 50}px;width:${hw}px;box-sizing:border-box;background:${C.card};border:8px solid ${C.ac};border-radius:72px;box-shadow:0 14px 0 ${C.soft};display:flex;flex-direction:column;align-items:center;justify-content:center;color:${C.acDark}}
.b .no{width:190px;height:190px;border-radius:95px;background:${C.ac};color:#fff;font-size:130px;font-weight:800;display:flex;align-items:center;justify-content:center;margin-bottom:26px}
.b b{font-size:140px;font-weight:800;line-height:1.1}.b i{font-style:normal;font-size:78px;color:${C.mut};margin-top:14px;font-weight:600}
.ar{position:absolute;top:${STRIP + (HH - STRIP - 50) / 2 - 70}px;width:${hg}px;text-align:center;font-size:120px;color:${C.ac};line-height:1}
</style><div class="brandrow"><img src="${logoUri}"><div class="t"><small>DEERLY</small><b>把每天的保養，整理成<em>一包</em></b></div></div>` + hb.map((h, i) => `<div class="b" style="left:${60 + i * (hw + hg)}px"><div class="no">${i + 1}</div><b>${h[1]}</b><i>${h[2]}</i></div>`).join('') +
  [0, 1].map(i => `<div class="ar" style="left:${60 + (i + 1) * hw + i * hg}px">›</div>`).join(''));
await page.screenshot({ path: new URL('home.png', out).pathname });
areas.home = hb.map((h, i) => ({ key: h[0], x: i === 0 ? 0 : 60 + i * (hw + hg) - hg / 2, y: STRIP, w: i === 0 ? 60 + hw + hg / 2 : i === 2 ? HW - (60 + i * (hw + hg) - hg / 2) : hw + hg, h: HH - STRIP }));
writeFileSync(new URL('areas.json', out), JSON.stringify({ version: data.version, areas }, null, 2));
await browser.close();
console.log('產生', data.questions.length, '張，題目版本', data.version);
