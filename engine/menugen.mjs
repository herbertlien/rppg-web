// 產生 LINE 聊天室下方的選單圖：每個單選題一張 2500×1686 的 PNG，加上點選區域座標。
// 執行：node engine/menugen.mjs（需要 playwright 與 Chromium）。輸出在 menus/，推上 GitHub Pages 後由後端建立選單。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const pw = await import(process.env.PLAYWRIGHT || 'playwright'); const chromium = pw.chromium || pw.default.chromium;

// 視覺基調集中在這裡，之後換品牌只改這一組
const C = { bg: '#F6F1EA', card: '#FFFFFF', ink: '#1E2A24', mut: '#7A8780', ac: '#2F7D5B', acDark: '#1F5C42', soft: '#E4EDE7', track: '#E3DACB' };
const FONT = '"Noto Sans TC","PingFang TC","WenQuanYi Zen Hei",sans-serif';
const W = 2500, H = 1686, HEAD = 520, PAD = 80, GAP = 48;
const data = JSON.parse(readFileSync(new URL('./data/questions.json', import.meta.url), 'utf8'));
const out = new URL('../menus/', import.meta.url);
mkdirSync(out, { recursive: true });

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// 選項排版：3 個以內單欄，4 個以上雙欄
function layout(n) {
  const cols = n <= 3 ? 1 : 2, rows = Math.ceil(n / cols);
  const bw = (W - PAD * 2 - GAP * (cols - 1)) / cols;
  const bh = (H - HEAD - PAD - GAP * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => ({
    x: Math.round(PAD + (i % cols) * (bw + GAP)),
    y: Math.round(HEAD + Math.floor(i / cols) * (bh + GAP)),
    w: Math.round(bw), h: Math.round(bh),
  }));
}

// 手機上 2500 px 寬的圖約縮成 390 pt，字級 150 px 約等於 23 pt。選項字盡量大，長的才縮
function optionFont(q, boxes) {
  const n = q.options.length, longest = Math.max(...q.options.map(o => (o.chip || o.label).length));
  const base = n <= 3 ? 190 : n <= 4 ? 170 : 150;
  return Math.max(84, Math.min(base, Math.floor((boxes[0].w - 220) / (longest * 1.04))));
}

function html(q, boxes, idx, total) {
  const lab = o => o.chip || o.label;
  const fs = optionFont(q, boxes);
  const qfs = q.text.length <= 12 ? 150 : q.text.length <= 16 ? 130 : q.text.length <= 20 ? 108 : 92;
  const btn = (o, b) => `<div class="b" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"><span style="font-size:${fs}px">${esc(lab(o))}</span><i style="font-size:${Math.round(fs * 0.9)}px">›</i></div>`;
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:${C.bg};font-family:${FONT};position:relative;overflow:hidden}
  .brand{position:absolute;left:${PAD}px;top:44px;font-size:68px;color:${C.ac};font-weight:700;letter-spacing:6px}
  .n{position:absolute;right:${PAD}px;top:44px;font-size:68px;color:${C.mut};font-weight:700}
  .bar{position:absolute;left:${PAD}px;right:${PAD}px;top:150px;height:22px;border-radius:11px;background:${C.track}}
  .bar div{height:100%;border-radius:11px;background:${C.ac};width:${Math.round(idx / total * 100)}%}
  .q{position:absolute;left:${PAD}px;right:${PAD}px;top:215px;font-size:${qfs}px;font-weight:900;color:${C.ink};line-height:1.2}
  .b{position:absolute;box-sizing:border-box;background:${C.card};border:8px solid ${C.ac};border-radius:72px;box-shadow:0 14px 0 ${C.soft};display:flex;align-items:center;justify-content:center;text-align:center;padding:0 130px 0 60px;color:${C.acDark};font-weight:700;line-height:1.25}
  .b i{position:absolute;right:56px;font-style:normal;color:${C.ac};font-weight:400}
  </style><div class="brand">Deerly</div><div class="n">${idx} / ${total}</div><div class="bar"><div></div></div><div class="q">${esc(q.text)}</div>
  ${q.options.map((o, i) => btn(o, boxes[i])).join('')}`;
}

const single = data.questions.filter(q => q.type === 'single');
const total = data.questions.length;
const areas = {};
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
for (const q of single) {
  const boxes = layout(q.options.length);
  await page.setContent(html(q, boxes, data.questions.indexOf(q) + 1, total));
  await page.screenshot({ path: new URL(`${q.id}.png`, out).pathname });
  areas[q.id] = q.options.map((o, i) => ({ value: o.value, ...boxes[i] }));
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
const HW = 2500, HH = 843, hb = [['scan', '今日電量', '30 秒掃臉看狀態'], ['quiz', '每日問卷', '整理你的組合'], ['pack', '我的組合', '看目前狀態']];
const hg = 110, hw = Math.floor((HW - 60 * 2 - hg * 2) / 3);
await page.setViewportSize({ width: HW, height: HH });
await page.setContent(`<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:${HW}px;height:${HH}px;background:${C.bg};font-family:${FONT};position:relative;overflow:hidden}
.b{position:absolute;top:50px;height:${HH - 100}px;width:${hw}px;box-sizing:border-box;background:${C.card};border:8px solid ${C.ac};border-radius:72px;box-shadow:0 14px 0 ${C.soft};display:flex;flex-direction:column;align-items:center;justify-content:center;color:${C.acDark}}
.b .no{width:110px;height:110px;border-radius:55px;background:${C.ac};color:#fff;font-size:70px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-bottom:22px}
.b b{font-size:140px;font-weight:800;line-height:1.1}.b i{font-style:normal;font-size:70px;color:${C.mut};margin-top:14px;font-weight:600}
.ar{position:absolute;top:${HH / 2 - 70}px;width:${hg}px;text-align:center;font-size:120px;color:${C.ac};line-height:1}
</style>` + hb.map((h, i) => `<div class="b" style="left:${60 + i * (hw + hg)}px"><div class="no">${i + 1}</div><b>${h[1]}</b><i>${h[2]}</i></div>`).join('') +
  [0, 1].map(i => `<div class="ar" style="left:${60 + (i + 1) * hw + i * hg}px">›</div>`).join(''));
await page.screenshot({ path: new URL('home.png', out).pathname });
areas.home = hb.map((h, i) => ({ key: h[0], x: i === 0 ? 0 : 60 + i * (hw + hg) - hg / 2, y: 0, w: i === 0 ? 60 + hw + hg / 2 : i === 2 ? HW - (60 + i * (hw + hg) - hg / 2) : hw + hg, h: HH }));
writeFileSync(new URL('areas.json', out), JSON.stringify({ version: data.version, areas }, null, 2));
await browser.close();
console.log('產生', single.length, '張，題目版本', data.version);
