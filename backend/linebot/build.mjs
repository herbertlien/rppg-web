// 產生可直接貼進 Supabase 的 linebot/index.ts：把規則引擎與資料檔併成一個檔案。
// 執行：node backend/linebot/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const here = new URL('./', import.meta.url);
const root = new URL('../../engine/', import.meta.url);
const read = u => readFileSync(u, 'utf8');

const engine = read(new URL('engine.js', root)).replace(/^export /gm, '');
const data = Object.fromEntries(['items', 'limits', 'questions', 'claims'].map(f => [f, JSON.parse(read(new URL(`data/${f}.json`, root)))]));
const handler = read(new URL('handler.ts', here));
const pilot = read(new URL('../../pilot/products.js', import.meta.url)).replace(/^export /gm, '');

const out = '// @ts-nocheck 規則引擎是 JS，併入後不做型別檢查（handler.ts 另外檢查）\n' + handler
  .replace('// 不要直接貼這個檔。執行 `node backend/linebot/build.mjs` 會把規則引擎與資料檔併進來，產生 index.ts，貼那個。',
           '// 這個檔由 build.mjs 自動產生，請勿手改；改 handler.ts 或 engine/ 之後重新產生。')
  .replace('// @@PILOT@@', `// ---- digital relax pilot config (pilot/products.js) ----\n${pilot}`)
  .replace('// @@ENGINE@@', `// ---- 規則引擎（engine/engine.js）----\n${engine}`)
  .replace('// @@DATA@@', `// ---- 資料檔（engine/data/*.json）----\n// deno-lint-ignore no-explicit-any\nconst DATA: any = ${JSON.stringify(data)};`);

writeFileSync(new URL('index.ts', here), out);
console.log(`已產生 backend/linebot/index.ts（${out.length} 字元，${data.items.version}，${data.questions.version}）`);
