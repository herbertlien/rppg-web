// 每次改了 engine/、quiz/、review/ 的檔案後執行：node engine/stamp.mjs
// 更新版本號，讓 LINE 內建瀏覽器丟掉快取、載入新版（頁面發現版本不同會自動重新載入）。
import { readFileSync, writeFileSync } from 'node:fs';

const v = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);   // 例：202610230512
const root = new URL('../', import.meta.url);
writeFileSync(new URL('engine/version.json', root), JSON.stringify({ v }) + '\n');
for (const f of ['quiz/index.html', 'review/index.html', 'me/index.html', 'engine/index.html']) {
  const u = new URL(f, root);
  const s = readFileSync(u, 'utf8');
  const out = s.replace(/const V = '[^']*';/, `const V = '${v}';`).replace(/style\.css\?v=[^"]*/, `style.css?v=${v}`);
  if (out === s) throw new Error(`${f} 找不到 const V`);
  writeFileSync(u, out);
}
console.log('版本號', v);
