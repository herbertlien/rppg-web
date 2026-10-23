// 產生 LINE 聊天室下方的選單圖：每個單選題一張 2500×1686 的 PNG，加上點選區域座標。
// 執行：node engine/menugen.mjs（需要 playwright 與 Chromium）。輸出在 menus/，推上 GitHub Pages 後由後端建立選單。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const W = 2500, H = 1686, HEAD = 430, PAD = 70, GAP = 44;
const data = JSON.parse(readFileSync(new URL('./data/questions.json', import.meta.url), 'utf8'));
const out = new URL('../menus/', import.meta.url);
mkdirSync(out, { recursive: true });

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// 選項排版：4 個以內單欄，5 個以上雙欄
function layout(n) {
  const cols = n <= 4 ? 1 : 2, rows = Math.ceil(n / cols);
  const bw = (W - PAD * 2 - GAP * (cols - 1)) / cols;
  const bh = (H - HEAD - PAD - GAP * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => ({
    x: Math.round(PAD + (i % cols) * (bw + GAP)),
    y: Math.round(HEAD + Math.floor(i / cols) * (bh + GAP)),
    w: Math.round(bw), h: Math.round(bh),
  }));
}

function html(q, boxes, idx, total) {
  const lab = o => o.chip || o.label;
  const fs = q.options.length <= 4 ? 120 : q.options.some(o => lab(o).length > 12) ? 84 : 104;
  const qfs = q.text.length <= 16 ? 118 : q.text.length <= 30 ? 100 : 86;
  const btn = (o, b) => `<div class="b" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"><span style="font-size:${fs}px">${esc(lab(o))}</span></div>`;
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#f4efe8;font-family:"Noto Sans TC","PingFang TC","WenQuanYi Zen Hei",sans-serif;position:relative;overflow:hidden}
  .h{position:absolute;left:${PAD}px;top:50px;right:${PAD}px}
  .brand{font-size:64px;color:#2f7d5b;font-weight:700;letter-spacing:4px}
  .n{position:absolute;right:${PAD}px;top:50px;font-size:64px;color:#8a8a8a}
  .q{font-size:${qfs}px;font-weight:700;color:#222;margin-top:34px;line-height:1.2}
  .b{position:absolute;box-sizing:border-box;background:#fff;border:8px solid #2f7d5b;border-radius:70px;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 60px;color:#1f5c42;font-weight:600;line-height:1.25}
  </style><div class="h"><div class="brand">Deerly</div><div class="n">${idx} / ${total}</div><div class="q">${esc(q.text)}</div></div>
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
await browser.close();
writeFileSync(new URL('areas.json', out), JSON.stringify({ version: data.version, areas }, null, 2));
console.log('產生', single.length, '張，題目版本', data.version);
