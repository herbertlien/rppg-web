// @ts-nocheck 規則引擎是 JS，併入後不做型別檢查（handler.ts 另外檢查）
// Supabase Edge Function：intake（原始碼）
// 這個檔由 build.mjs 自動產生，請勿手改；改 handler.ts 或 engine/ 之後重新產生。
// 前端送 LINE ID token，這裡向 LINE 驗證身分後才讀寫資料庫；配方一律在這裡重算，不相信前端算的結果。
import { createClient } from "npm:@supabase/supabase-js@2";

// ---- 規則引擎（engine/engine.js）----
// Deerly 規則引擎：問卷答案 → 待審配方。純函式、不碰 AI、不碰網路。
// 同一份檔案給瀏覽器（預覽）和後端 Edge Function（正式計算）共用。
// 資料（品項、上限、題目、措辭）由呼叫端載入後傳進來，換資料不必改程式。

const ENGINE_VERSION = 'engine-0.1.0';

// 檢查資料檔彼此一致。回傳錯誤字串陣列，空陣列代表沒問題。
function validateData({ items, limits, questions, claims }) {
  const errs = [];
  const groups = items.groups || {};
  const ids = new Set();
  const needTags = new Set();
  const flagSet = new Set();
  for (const q of questions.questions) {
    for (const o of q.options) {
      Object.keys(o.needs || {}).forEach(t => needTags.add(t));
      (o.flags || []).forEach(f => flagSet.add(f));
      if (o.reject && !claims.rejectMessages[o.reject]) errs.push(`題目 ${q.id} 的拒收原因 ${o.reject} 沒有對應訊息`);
    }
  }
  for (const it of items.items) {
    if (ids.has(it.id)) errs.push(`品項 id 重複：${it.id}`);
    ids.add(it.id);
    if (!['confirmed', 'formula_only', 'placeholder'].includes(it.status)) errs.push(`品項 ${it.id} 狀態不明：${it.status}`);
    if (!(it.dailyCapsules > 0)) errs.push(`品項 ${it.id} 每日顆數需大於 0`);
    for (const g of it.groups || []) if (!groups[g]) errs.push(`品項 ${it.id} 的群組 ${g} 未定義`);
    for (const f of it.excludeIf || []) if (!flagSet.has(f)) errs.push(`品項 ${it.id} 的禁用條件 ${f} 沒有任何題目會觸發`);
    if (it.enabled) {
      for (const t of Object.keys(it.needs || {})) if (!needTags.has(t)) errs.push(`品項 ${it.id} 的需求 ${t} 沒有任何題目會加分`);
      if (!Object.keys(it.perCapsule || {}).length) errs.push(`啟用中的品項 ${it.id} 沒有成分資料`);
    }
    for (const k of Object.keys(it.perCapsule || {})) if (!limits.nutrients[k]) errs.push(`品項 ${it.id} 的成分 ${k} 未在 limits.json 登記名稱與單位`);
  }
  if (!questions.questions.some(q => q.options.some(o => o.tier))) errs.push('沒有選擇方案（tier）的題目');
  questions.questions.forEach((q, i) => {
    for (const [id, vals] of Object.entries(q.showIf || {})) {
      const j = questions.questions.findIndex(x => x.id === id);
      if (j < 0 || j >= i) errs.push(`題目 ${q.id} 的顯示條件必須引用前面的題目：${id}`);
      else for (const v of vals) if (!questions.questions[j].options.some(o => o.value === v)) errs.push(`題目 ${q.id} 的顯示條件引用不存在的選項：${id}=${v}`);
    }
  });
  return errs;
}

// 這題要不要問：showIf 指定的前一題，答案必須在清單內
function isShown(q, answers) {
  if (!q.showIf) return true;
  return Object.entries(q.showIf).every(([id, vals]) => {
    const a = answers[id];
    return (Array.isArray(a) ? a : [a]).some(v => vals.includes(v));
  });
}

// 檢查答案格式，並整理出拒收原因、個人旗標、需求分數、提醒、方案。
function readAnswers(answers, questions) {
  const errors = [];
  const rejects = [];
  const flags = new Set();
  const needs = {};          // tag → 分數
  const evidence = {};       // tag → [{ text, pts }]，給理由用
  const warns = [];          // 給審核者的提醒
  const flagLabels = {};     // 旗標 → 觸發它的選項文字，給跳過原因用
  let tier = null;

  for (const q of questions.questions) {
    if (!isShown(q, answers)) continue;   // 沒問到的題目不計
    const raw = answers[q.id];
    if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) {
      errors.push(`未回答：${q.id}`);
      continue;
    }
    const picked = q.type === 'multi' ? raw : [raw];
    if (q.type === 'multi' && !Array.isArray(raw)) { errors.push(`複選題需為陣列：${q.id}`); continue; }
    if (q.type === 'single' && Array.isArray(raw)) { errors.push(`單選題不能多選：${q.id}`); continue; }
    if (q.max && picked.length > q.max) errors.push(`${q.id} 最多選 ${q.max} 個`);
    if (new Set(picked).size !== picked.length) errors.push(`${q.id} 有重複選項`);
    const opts = picked.map(v => q.options.find(o => o.value === v));
    if (opts.some(o => !o)) { errors.push(`${q.id} 有不存在的選項`); continue; }
    if (opts.length > 1 && opts.some(o => o.exclusive)) errors.push(`${q.id}：「${opts.find(o => o.exclusive).label}」不能和其他選項同時選`);
    for (const o of opts) {
      if (o.reject) rejects.push(o.reject);
      if (o.warn) warns.push(o.warn);
      (o.flags || []).forEach(f => { flags.add(f); flagLabels[f] = o.label; });
      for (const [t, p] of Object.entries(o.needs || {})) {
        needs[t] = (needs[t] || 0) + p;
        const text = o.reason || (q.reason || '你選了「{label}」').replace('{label}', o.label);
        (evidence[t] ||= []).push({ text, pts: p });
      }
      if (o.tier) tier = o.tier;
    }
  }
  return { errors, rejects, flags, flagLabels, needs, evidence, warns, tier };
}

// 一個品項每天的成分量
const dailyAmounts = it =>
  Object.fromEntries(Object.entries(it.perCapsule).map(([k, v]) => [k, v * it.dailyCapsules]));

function addTotals(totals, it) {
  const out = { ...totals };
  for (const [k, v] of Object.entries(dailyAmounts(it))) out[k] = round((out[k] || 0) + v);
  return out;
}

const round = n => Math.round(n * 1000) / 1000;

// 超過上限的成分（以整包加總計算）
function overLimits(totals, limits) {
  return Object.entries(totals)
    .filter(([k, v]) => limits.nutrients[k]?.max != null && v > limits.nutrients[k].max)
    .map(([k]) => k);
}

// 主函式：答案 → 配方草稿。永遠不會回傳「已核准」，核准只能由人在審核頁做。
function buildPack(answers, data) {
  const { items, limits, questions, claims } = data;
  const base = {
    engineVersion: ENGINE_VERSION,
    dataVersion: { items: items.version, questions: questions.version, claims: claims.version, limits: limits.source },
  };

  const a = readAnswers(answers, questions);
  if (a.errors.length) return { ...base, status: 'invalid', errors: a.errors };
  if (a.rejects.length) {
    return { ...base, status: 'rejected', rejects: a.rejects, messages: [...new Set(a.rejects)].map(r => claims.rejectMessages[r]) };
  }

  // 計分。同分時依 items.json 的順序，確保結果固定。
  const skipped = [];
  const candidates = [];
  items.items.forEach((it, order) => {
    if (!it.enabled) return;
    const hit = (it.excludeIf || []).find(f => a.flags.has(f));
    if (hit) { skipped.push({ id: it.id, name: it.name, why: `客人回答「${a.flagLabels[hit]}」` }); return; }
    let score = 0;
    let best = null;   // 貢獻最多的那個回答，拿來寫理由
    for (const [tag, w] of Object.entries(it.needs || {})) {
      score += w * (a.needs[tag] || 0);
      for (const e of a.evidence[tag] || []) if (!best || w * e.pts > best.v) best = { v: w * e.pts, text: e.text };
    }
    candidates.push({ it, order, score, best });
  });
  candidates.sort((x, y) => y.score - x.score || x.order - y.order);

  // 依分數放入，每放一項就檢查群組上限與整包成分上限
  const chosen = [];
  let totals = {};
  const groupCount = {};
  for (const c of candidates) {
    if (chosen.length >= a.tier) break;
    if (c.score <= 0) { skipped.push({ id: c.it.id, name: c.it.name, why: '沒有對應的需求' }); continue; }
    const full = (c.it.groups || []).find(g => (groupCount[g] || 0) >= items.groups[g].max);
    if (full) { skipped.push({ id: c.it.id, name: c.it.name, why: `同類已選（${items.groups[full].name}）` }); continue; }
    const next = addTotals(totals, c.it);
    const over = overLimits(next, limits);
    if (over.length) { skipped.push({ id: c.it.id, name: c.it.name, why: `加入後超過每日上限：${over.map(k => limits.nutrients[k].name).join('、')}` }); continue; }
    totals = next;
    (c.it.groups || []).forEach(g => { groupCount[g] = (groupCount[g] || 0) + 1; });
    chosen.push(c);
  }

  const warnings = [...a.warns];
  if (chosen.length < a.tier) warnings.push(`符合條件的品項只有 ${chosen.length} 項，少於方案的 ${a.tier} 項，需人工補選`);

  const totalRows = Object.entries(totals).map(([k, v]) => {
    const lim = limits.nutrients[k];
    const max = lim?.max ?? null;
    const pct = max != null ? Math.round((v / max) * 100) : null;
    if (pct !== null && pct >= limits.warnAtPct) warnings.push(`${lim.name} 已達每日上限的 ${pct}%`);
    return { key: k, name: lim?.name ?? k, amount: v, unit: lim?.unit ?? null, max, pct };
  });

  const notConfirmed = chosen.filter(c => c.it.status !== 'confirmed').map(c => c.it.name);
  const blockers = [];
  if (notConfirmed.length) blockers.push(`以下品項的成分或每日顆數尚未由南都確認：${notConfirmed.join('、')}`);
  if (!items.pharmacistApproved) blockers.push('品項資料尚未經藥師核定');

  return {
    ...base,
    status: 'needs_review',
    tier: a.tier,
    shippable: blockers.length === 0,
    blockers,
    items: chosen.map(c => ({
      id: c.it.id,
      name: c.it.name,
      dailyCapsules: c.it.dailyCapsules,
      status: c.it.status,
      score: c.score,
      reason: c.best ? `因為${c.best.text}` : '',
    })),
    totals: totalRows,
    skipped,
    warnings,
  };
}

// 換品項後重算（審核頁用）：給定品項 id 清單，只算總量與上限，不重新挑選。
function checkPack(itemIds, data) {
  const { items, limits } = data;
  const errors = [];
  let totals = {};
  const groupCount = {};
  for (const id of itemIds) {
    const it = items.items.find(x => x.id === id);
    if (!it) { errors.push(`不存在的品項：${id}`); continue; }
    if (!it.enabled) errors.push(`${it.name} 目前停用：${it.disabledReason || ''}`);
    for (const g of it.groups || []) {
      groupCount[g] = (groupCount[g] || 0) + 1;
      if (groupCount[g] === items.groups[g].max + 1) errors.push(`${items.groups[g].name} 最多 ${items.groups[g].max} 項`);
    }
    totals = addTotals(totals, it);
  }
  for (const k of overLimits(totals, limits)) {
    const l = limits.nutrients[k];
    errors.push(`${l.name} 合計 ${totals[k]} ${l.unit}，超過每日上限 ${l.max} ${l.unit}`);
  }
  return { ok: errors.length === 0, errors, totals };
}

// AI 輸出過濾：命中禁用詞就回傳命中的詞，呼叫端改用安全句並記錄。
function findBannedTerms(text, claims) {
  const t = String(text).replace(/\s+/g, '');
  return claims.bannedTerms.filter(w => t.includes(w));
}


// ---- 資料檔（engine/data/*.json）----
// deno-lint-ignore no-explicit-any
const DATA: any = {"items":{"_note":"品項資料。status：confirmed＝成分與每日顆數都由南都確認；formula_only＝有每顆成分、每日顆數未確認；placeholder＝成分與顆數都是暫定數字。只要配方含非 confirmed 品項，就不能出貨。","version":"items-2026-10-23-draft","pharmacistApproved":false,"groups":{"b_complex":{"name":"B 群類","max":1},"opc":{"name":"葡萄籽／前花青素","max":1},"bleeding_risk":{"name":"可能增加出血風險類","max":1}},"items":[{"id":"b_complex_e","name":"維生素 B 群 + E","enabled":true,"status":"formula_only","source":"南都配方表 2026-08-26","groups":["b_complex"],"dailyCapsules":1,"perCapsule":{"vitamin_b1":48,"pantothenic_acid":50,"vitamin_b6":30,"vitamin_b12":500,"vitamin_e":20.4,"gamma_oryzanol":35},"needs":{"energy":3,"stress":2,"eating_out":2,"drinking":1},"excludeIf":["taking_b","taking_multivitamin"]},{"id":"b_complex","name":"維生素 B 群（綜合型）","enabled":false,"disabledReason":"含鐵、維生素 A、當歸與色素，和其他品項重疊多；驗證期改用 B 群 + E","status":"formula_only","source":"南都配方表 2026-08-26","groups":["b_complex"],"dailyCapsules":1,"perCapsule":{"vitamin_b1":50,"vitamin_b2":50,"vitamin_b6":50,"pantothenic_acid":50,"niacinamide":30,"vitamin_b12":400,"folate":400,"vitamin_c":100,"vitamin_e":30,"vitamin_a":5000,"vitamin_d":2.5,"iron":7.5,"zinc":10,"magnesium":12.5,"calcium":74},"needs":{"energy":3,"eating_out":3},"excludeIf":[]},{"id":"vitamin_b6","name":"維生素 B6","enabled":false,"disabledReason":"與 B 群疊加容易超過 B6 上限","status":"formula_only","source":"南都配方表 2026-08-26","groups":["b_complex"],"dailyCapsules":1,"perCapsule":{"vitamin_b6":30,"calcium":108},"needs":{"energy":1},"excludeIf":[]},{"id":"magnesium","name":"鎂","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"magnesium":100},"needs":{"sleep":3,"stress":2,"exercise":2,"caffeine":1},"excludeIf":[]},{"id":"vitamin_c","name":"維生素 C","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"vitamin_c":250},"needs":{"low_veg":3,"eating_out":1,"seasonal":2,"skin":1},"excludeIf":["taking_c"]},{"id":"zinc","name":"鋅","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"zinc":10},"needs":{"low_veg":1,"exercise":1,"seasonal":2,"skin":1},"excludeIf":[]},{"id":"rhodiola","name":"紅景天","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"rhodiola_extract":200},"needs":{"stress":3,"energy":2},"excludeIf":[]},{"id":"sesamin","name":"芝麻素","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"sesamin":10},"needs":{"late_nights":3,"drinking":3,"sleep":1},"excludeIf":["allergy_sesame"]},{"id":"probiotic","name":"專利益生菌","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"probiotic":100},"needs":{"digestion":4,"eating_out":1},"excludeIf":["taking_probiotic","allergy_milk"]},{"id":"digestive_enzyme","name":"綜合消化酵素","enabled":false,"disabledReason":"建議加入：「消化與排便」目前只對到益生菌一項，待 Herbert 決定","status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{},"needs":{"digestion":3,"eating_out":1},"excludeIf":[]},{"id":"grape_seed","name":"葡萄籽多酚","enabled":true,"status":"placeholder","source":"暫定","groups":["opc"],"dailyCapsules":1,"perCapsule":{"grape_seed_extract":100},"needs":{"skin":2,"late_nights":1},"excludeIf":[]},{"id":"collagen","name":"膠原蛋白","enabled":true,"status":"placeholder","source":"暫定（原料來源待確認，可能為魚）","dailyCapsules":2,"perCapsule":{"collagen":400},"needs":{"skin":3,"exercise":1},"excludeIf":["allergy_fish","vegetarian","taking_collagen"]},{"id":"elderberry","name":"接骨木莓","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"elderberry_extract":200},"needs":{"seasonal":3},"excludeIf":[]},{"id":"nattokinase","name":"納豆激酶","enabled":false,"disabledReason":"可能增加出血風險，驗證期不納入","status":"placeholder","source":"暫定","groups":["bleeding_risk"],"dailyCapsules":1,"perCapsule":{},"needs":{},"excludeIf":["surgery_soon","allergy_soy"]},{"id":"ginkgo","name":"銀杏萃取","enabled":false,"disabledReason":"可能增加出血風險，驗證期不納入","status":"placeholder","source":"暫定","groups":["bleeding_risk"],"dailyCapsules":1,"perCapsule":{},"needs":{},"excludeIf":["surgery_soon"]},{"id":"garlic","name":"大蒜精","enabled":false,"disabledReason":"可能增加出血風險，驗證期不納入","status":"placeholder","source":"暫定","groups":["bleeding_risk"],"dailyCapsules":1,"perCapsule":{},"needs":{},"excludeIf":["surgery_soon"]},{"id":"curcumin","name":"薑黃素","enabled":false,"disabledReason":"可能增加出血風險，驗證期不納入","status":"placeholder","source":"暫定","groups":["bleeding_risk"],"dailyCapsules":1,"perCapsule":{},"needs":{},"excludeIf":["surgery_soon"]}]},"limits":{"_note":"成分字典與每日上限。每個品項用到的成分都要在這裡登記名稱與單位；有 max 的才會檢查上限（來源：南都 2026-10-18 回覆的 UL 表），沒有 max 的只加總、顯示。","source":"南都 UL 表 2026-10-18","warnAtPct":80,"nutrients":{"vitamin_c":{"name":"維生素 C","unit":"mg","max":2000},"vitamin_d":{"name":"維生素 D","unit":"µg","max":50},"calcium":{"name":"鈣","unit":"mg","max":2500},"magnesium":{"name":"鎂（補充劑）","unit":"mg","max":350},"zinc":{"name":"鋅","unit":"mg","max":35},"iron":{"name":"鐵","unit":"mg","max":40},"epa_dha":{"name":"魚油 EPA + DHA","unit":"mg","max":2000},"lutein":{"name":"葉黃素","unit":"mg","max":30},"vitamin_b6":{"name":"維生素 B6","unit":"mg","max":80},"niacin":{"name":"菸鹼酸","unit":"mg","max":35},"folate":{"name":"葉酸","unit":"µg","max":1000},"vitamin_b1":{"name":"維生素 B1","unit":"mg"},"vitamin_b2":{"name":"維生素 B2","unit":"mg"},"pantothenic_acid":{"name":"泛酸鈣","unit":"mg"},"niacinamide":{"name":"菸鹼醯胺","unit":"mg"},"vitamin_b12":{"name":"維生素 B12","unit":"µg"},"vitamin_a":{"name":"維生素 A","unit":"IU"},"vitamin_e":{"name":"維生素 E","unit":"IU"},"gamma_oryzanol":{"name":"米胚芽萃取（γ-oryzanol）","unit":"mg"},"rhodiola_extract":{"name":"紅景天萃取","unit":"mg"},"sesamin":{"name":"芝麻素","unit":"mg"},"probiotic":{"name":"益生菌","unit":"億 CFU"},"grape_seed_extract":{"name":"葡萄籽萃取","unit":"mg"},"collagen":{"name":"膠原蛋白","unit":"mg"},"elderberry_extract":{"name":"接骨木莓萃取","unit":"mg"}}},"questions":{"_note":"問卷題目。safety＝安全題，一定要答。reject＝不接單；flags＝個人禁用旗標；warn＝給審核者的提醒；needs＝需求加分；showIf＝只在前面某題選了指定選項時才問；reason＝理由句型，{label} 換成選項文字（選項上也可直接寫整句）；short＝送出前總覽用的短標題；why＝這題存在的理由（只給內部看）。","version":"questions-2026-10-23","questions":[{"id":"age","short":"年齡","type":"single","text":"先確認一下，你的年齡是？","safety":true,"why":"年齡門檻（未滿 18 歲不接單）與客群分析；25–39 歲細分是為了看主力客群。不影響選品。","options":[{"value":"under18","label":"未滿 18 歲","reject":"under18"},{"value":"18_24","label":"18–24 歲"},{"value":"25_29","label":"25–29 歲"},{"value":"30_34","label":"30–34 歲"},{"value":"35_39","label":"35–39 歲"},{"value":"40_49","label":"40–49 歲"},{"value":"50plus","label":"50 歲以上"}]},{"id":"sex","short":"生理性別","type":"single","text":"你的生理性別是？","safety":true,"why":"決定是否要問懷孕題；客群分析。不影響選品。","options":[{"value":"female","label":"女性"},{"value":"male","label":"男性"},{"value":"na","label":"不想透露"}]},{"id":"pregnancy","short":"懷孕、哺乳或備孕","type":"single","text":"你目前是否懷孕、哺乳中，或正在準備懷孕？","safety":true,"showIf":{"sex":["female","na"]},"why":"不接單條件。男性不顯示這題。","options":[{"value":"yes","label":"是","reject":"pregnancy"},{"value":"no","label":"否"}]},{"id":"medication","short":"吃藥","type":"single","text":"你目前有在吃藥嗎？","safety":true,"why":"不接單條件。區分偶爾吃成藥和固定用藥，避免把偶爾吃止痛藥的人全部擋掉。","options":[{"value":"no","label":"沒有"},{"value":"occasional","label":"只有不舒服時偶爾吃（例如止痛藥、感冒藥、過敏藥）","warn":"客人偶爾服用成藥，請確認沒有和品項衝突"},{"value":"regular","label":"有，每天或固定吃（例如口服避孕藥、抗凝血藥、阿斯匹靈、慢性病用藥）","reject":"medication"}]},{"id":"conditions","short":"健康狀況","type":"multi","text":"以下有沒有符合你的情況？可以複選。","safety":true,"why":"不接單條件；手術題併進來少一題。","options":[{"value":"kidney","label":"慢性腎臟疾病","reject":"kidney"},{"value":"liver","label":"慢性肝臟疾病","reject":"liver"},{"value":"treatment","label":"其他正在看醫師治療中的疾病","reject":"treatment"},{"value":"surgery","label":"一個月內有安排手術或拔牙","flags":["surgery_soon"],"warn":"客人一個月內有手術或拔牙安排，請人工確認"},{"value":"none","label":"都沒有","exclusive":true}]},{"id":"allergy","short":"食物過敏","type":"multi","text":"有沒有對以下食物過敏？可以複選。","safety":true,"why":"排除含過敏原的品項（膠原蛋白可能是魚來源、芝麻素、益生菌載體可能含乳）。","options":[{"value":"fish","label":"魚類或海鮮","flags":["allergy_fish"]},{"value":"soy","label":"大豆","flags":["allergy_soy"]},{"value":"sesame","label":"芝麻","flags":["allergy_sesame"]},{"value":"milk","label":"牛奶或乳製品","flags":["allergy_milk"]},{"value":"other","label":"其他食物","warn":"客人對其他食物過敏，請向客人確認過敏原"},{"value":"none","label":"都沒有","exclusive":true}]},{"id":"diet","short":"飲食習慣","type":"single","text":"你的飲食習慣是？","safety":true,"why":"素食者不能吃動物來源的膠原蛋白，也要確認膠囊殼。台灣素食人口約一成。","options":[{"value":"omni","label":"葷食"},{"value":"lacto_ovo","label":"蛋奶素","flags":["vegetarian"],"warn":"客人吃素：膠囊殼材質（明膠或植物性）待南都確認"},{"value":"vegan","label":"全素","flags":["vegetarian","vegan"],"warn":"客人吃全素：膠囊殼材質與益生菌載體待南都確認"}]},{"id":"supplements","short":"正在吃的保健食品","type":"multi","text":"目前有固定在吃哪些保健食品？可以複選。","safety":true,"why":"避免重複與超量：已在吃的不再給，吃綜合維他命時不給 B 群並提醒審核。魚油、葉黃素我們還沒有，但可看需求。","options":[{"value":"multi","label":"綜合維他命","flags":["taking_multivitamin"],"warn":"客人已在吃綜合維他命，請確認整包加總"},{"value":"b","label":"B 群","flags":["taking_b"]},{"value":"c","label":"維生素 C","flags":["taking_c"]},{"value":"probiotic","label":"益生菌","flags":["taking_probiotic"]},{"value":"collagen","label":"膠原蛋白","flags":["taking_collagen"]},{"value":"fish_oil","label":"魚油"},{"value":"lutein","label":"葉黃素"},{"value":"other","label":"其他","warn":"客人另有在吃其他保健食品，請詢問品項"},{"value":"none","label":"目前沒有","exclusive":true}]},{"id":"focus","short":"最想照顧","type":"multi","text":"最近最想照顧自己哪個部分？最多選兩個。","max":2,"reason":"你想多照顧{label}","why":"客人自己最在意的事，權重最高。「消化與排便」目前只對到益生菌一項。","options":[{"value":"energy","label":"白天的精神","needs":{"energy":3}},{"value":"sleep","label":"睡眠","needs":{"sleep":3}},{"value":"stress","label":"壓力與緊繃感","needs":{"stress":3}},{"value":"digestion","label":"消化與排便","needs":{"digestion":3}},{"value":"skin","label":"肌膚狀態","needs":{"skin":3}},{"value":"seasonal","label":"換季時的保養","needs":{"seasonal":3}},{"value":"recovery","label":"運動後的恢復","needs":{"exercise":3}}]},{"id":"sleep_hours","short":"睡眠時數","type":"single","text":"平常一晚大概睡幾小時？","reason":"你平均一晚睡 {label}","why":"比「幾點睡」更能反映睡眠不足；輪班或晚睡晚起的人也答得準。","options":[{"value":"lt6","label":"不到 6 小時","needs":{"late_nights":2,"sleep":1},"reason":"你平均一晚睡不到 6 小時"},{"value":"6_7","label":"6–7 小時","needs":{"late_nights":1},"reason":"你平均一晚睡 6–7 小時"},{"value":"7plus","label":"7 小時以上"}]},{"id":"sleep_quality","short":"睡眠品質","type":"single","text":"最近兩週睡得好嗎？","reason":"你說最近{label}","options":[{"value":"good","label":"大多睡得好"},{"value":"so_so","label":"偶爾難入睡或半夜醒來","needs":{"sleep":1}},{"value":"poor","label":"常常睡不好","needs":{"sleep":2}}]},{"id":"stress","short":"壓力","type":"single","text":"最近工作或生活的壓力感覺如何？","reason":"你說最近{label}","why":"用感受描述取代 0–10 分，比較好答。","options":[{"value":"low","label":"還好，應付得來"},{"value":"mid","label":"有點緊繃","needs":{"stress":1}},{"value":"high","label":"壓力很大","needs":{"stress":2}}]},{"id":"caffeine","short":"咖啡因飲料","type":"single","text":"咖啡、茶或能量飲料，一天大概幾杯？","reason":"你一天喝 {label}含咖啡因的飲料","why":"科技業常見，靠咖啡撐精神的人通常也睡不好；也是之後分析留存的好指標。","options":[{"value":"0_1","label":"0–1 杯"},{"value":"2","label":"2 杯","needs":{"caffeine":1}},{"value":"3plus","label":"3 杯以上","needs":{"caffeine":2}}]},{"id":"alcohol","short":"喝酒","type":"single","text":"一週大概喝幾次酒（含聚餐應酬）？","reason":"你一週喝酒 {label}","why":"對應芝麻素與 B 群的選品（只做內部選品依據，對外不寫任何功效）。","options":[{"value":"rare","label":"幾乎不喝"},{"value":"1_2","label":"1–2 次","needs":{"drinking":1}},{"value":"3plus","label":"3 次以上","needs":{"drinking":2}}]},{"id":"meals_out","short":"外食","type":"single","text":"一週大概幾餐是外食或外送？","reason":"你一週外食約 {label}","options":[{"value":"few","label":"5 餐以下"},{"value":"some","label":"6–10 餐","needs":{"eating_out":1}},{"value":"most","label":"11 餐以上","needs":{"eating_out":2}}]},{"id":"veg","short":"蔬菜","type":"single","text":"一天三餐裡，大概有幾餐吃得到蔬菜？","reason":"你一天只有 {label}吃得到蔬菜","why":"比「幾份蔬果」好估，一般人算不出份數。","options":[{"value":"3","label":"3 餐都有"},{"value":"2","label":"2 餐","needs":{"low_veg":1}},{"value":"0_1","label":"0–1 餐","needs":{"low_veg":2}}]},{"id":"bowel","short":"排便","type":"single","text":"最近排便狀況如何？","reason":"你說最近{label}","why":"比只放在「想照顧的部分」更客觀，對應益生菌。","options":[{"value":"regular","label":"大多規律"},{"value":"constipation","label":"常常便秘","needs":{"digestion":2}},{"value":"loose","label":"常常拉肚子或時好時壞","needs":{"digestion":2}}]},{"id":"exercise","short":"運動","type":"single","text":"一週運動幾次（每次 30 分鐘以上）？","reason":"你一週運動 {label}","options":[{"value":"0","label":"幾乎沒有"},{"value":"1_2","label":"1–2 次","needs":{"exercise":1}},{"value":"3plus","label":"3 次以上","needs":{"exercise":2}}]},{"id":"tier","short":"方案","type":"single","text":"最後，想要每天幾種？","options":[{"value":"basic","label":"基礎版，每天 3 種","tier":3},{"value":"advanced","label":"進階版，每天 5 種","tier":5}]}]},"claims":{"_note":"對外措辭。理由只描述客人自己的回答，不寫任何功效。禁用詞清單用於 AI 輸出過濾與文案自我檢查，上線前需專業審閱。","version":"claims-2026-10-22-draft","rejectMessages":{"under18":"目前只提供給 18 歲以上的朋友，謝謝你的興趣。","pregnancy":"懷孕、哺乳或備孕期間的營養需求比較特別，我們目前不提供，建議和你的醫師或營養師討論。","medication":"有固定用藥時，保健食品可能和藥物互相影響。我們目前不提供，建議先和你的醫師或藥師討論。","kidney":"有慢性腎臟疾病時需要特別留意，我們目前不提供，建議先和你的醫師討論。","liver":"有慢性肝臟疾病時需要特別留意，我們目前不提供，建議先和你的醫師討論。","treatment":"正在治療中的朋友，我們目前不提供，建議先和你的醫師討論。"},"bannedTerms":["治療","治癒","根治","預防","療效","藥效","診斷","處方","疾病","病症","降血壓","降低血壓","降血糖","降血脂","降膽固醇","溶解血栓","溶血栓","抗病毒","抗癌","防癌","抗發炎","消炎","殺菌","抗菌","改善失眠","治失眠","安眠","減肥","減重","瘦身","燃脂","排毒","抗憂鬱","憂鬱症","焦慮症","增強免疫力","提升免疫力","增強抵抗力","保肝","護肝","顧肝","壯陽","回春","延緩老化","抗老","泌尿道感染","關節炎","骨質疏鬆","痛風","糖尿病","高血壓","心血管疾病","保證有效","百分之百","100%","無副作用","醫師推薦","醫生推薦","臨床證實","掃臉算出","掃描計算配方"]}};

const LINE_CHANNEL_ID = "2012160129";
const ALLOWED_ORIGIN = "https://herbertlien.github.io";
const CONSENT_VERSION = "intake-v0";
// 審核者的 LINE 使用者 ID，多個用逗號分隔。在 Supabase 的 Edge Function Secrets 設定 ADMIN_LINE_SUBS。
const ADMINS = (Deno.env.get("ADMIN_LINE_SUBS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

async function verifyLine(idToken: string): Promise<string | null> {
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return typeof j.sub === "string" ? j.sub : null;
}

async function findUser(sub: string, create: boolean): Promise<string | null> {
  const found = await db.from("users").select("id").eq("line_sub", sub).maybeSingle();
  if (found.error) throw found.error;
  if (found.data) return found.data.id;
  if (!create) return null;
  const ins = await db.from("users").insert({ line_sub: sub }).select("id").single();
  if (ins.error) throw ins.error;
  return ins.data.id;
}

async function hasConsent(uid: string): Promise<boolean> {
  const c = await db.from("consents").select("id").eq("user_id", uid).eq("version", CONSENT_VERSION).limit(1);
  if (c.error) throw c.error;
  return !!c.data?.length;
}

const itemById = (id: string) => DATA.items.items.find((i: { id: string }) => i.id === id);

// 核准前用目前的資料重新判斷能不能出貨，不看當初存下的結果
function approveBlockers(itemIds: string[]): string[] {
  const out: string[] = [];
  const check = checkPack(itemIds, DATA);
  out.push(...check.errors);
  const pending = itemIds.map(itemById).filter((i) => i && i.status !== "confirmed").map((i) => i.name);
  if (pending.length) out.push(`尚未由南都確認：${pending.join("、")}`);
  if (!DATA.items.pharmacistApproved) out.push("品項資料尚未經藥師核定");
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply({ error: "method" }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return reply({ error: "json" }, 400); }

  const sub = typeof b.idToken === "string" ? await verifyLine(b.idToken) : null;
  if (!sub) return reply({ error: "auth" }, 401);
  const admin = ADMINS.includes(sub);

  try {
    if (b.action === "whoami") return reply({ sub, admin });

    // ---- 審核者 ----
    if (b.action === "review_list") {
      if (!admin) return reply({ error: "forbidden" }, 403);
      const r = await db.from("packs")
        .select("id,created_at,status,item_ids,result,review_note,intakes(answers,questions_version)")
        .eq("status", "needs_review").order("created_at", { ascending: true }).limit(50);
      if (r.error) throw r.error;
      return reply({ packs: r.data, items: DATA.items.items.map((i: { id: string; name: string; enabled: boolean }) => ({ id: i.id, name: i.name, enabled: i.enabled })) });
    }

    if (b.action === "review_check") {
      if (!admin) return reply({ error: "forbidden" }, 403);
      const ids = Array.isArray(b.itemIds) ? b.itemIds.map(String) : [];
      return reply({ ...checkPack(ids, DATA), blockers: approveBlockers(ids) });
    }

    if (b.action === "review_decide") {
      if (!admin) return reply({ error: "forbidden" }, 403);
      const packId = Number(b.packId);
      const decision = b.decision === "approve" ? "approved" : b.decision === "return" ? "returned" : null;
      if (!Number.isInteger(packId) || !decision) return reply({ error: "input" }, 400);
      const cur = await db.from("packs").select("status,item_ids").eq("id", packId).maybeSingle();
      if (cur.error) throw cur.error;
      if (!cur.data) return reply({ error: "not_found" }, 404);
      if (cur.data.status !== "needs_review") return reply({ error: "already_decided" }, 409);
      const ids = Array.isArray(b.itemIds) ? b.itemIds.map(String) : cur.data.item_ids;
      if (decision === "approved") {
        const blockers = approveBlockers(ids);
        if (blockers.length) return reply({ error: "blocked", blockers }, 409);
      }
      const up = await db.from("packs").update({
        status: decision,
        item_ids: ids,
        reviewed_at: new Date().toISOString(),
        review_note: String(b.note ?? "").slice(0, 500) || null,
      }).eq("id", packId).eq("status", "needs_review");
      if (up.error) throw up.error;
      return reply({ ok: true });
    }

    // ---- 客人 ----
    const uid = await findUser(sub, b.action === "consent");
    if (!uid) {
      if (b.action === "mine") return reply({ consented: false, pack: null });
      if (b.action === "delete") return reply({ ok: true });
      return reply({ error: "consent" }, 403);
    }

    if (b.action === "consent") {
      if (!(await hasConsent(uid))) {
        const r = await db.from("consents").insert({ user_id: uid, version: CONSENT_VERSION });
        if (r.error) throw r.error;
      }
      return reply({ ok: true });
    }

    if (b.action === "mine") {
      const consented = await hasConsent(uid);
      const r = await db.from("packs").select("status,created_at,item_ids,result")
        .eq("user_id", uid).order("created_at", { ascending: false }).limit(1);
      if (r.error) throw r.error;
      const p = r.data?.[0];
      if (!p) return reply({ consented, pack: null });
      // 核准前只告訴客人「整理中」，不顯示引擎草稿
      const items = p.status === "approved"
        ? p.item_ids.map((id: string) => {
          const it = itemById(id);
          const fromEngine = (p.result.items ?? []).find((x: { id: string }) => x.id === id);
          return { name: it?.name ?? id, dailyCapsules: it?.dailyCapsules ?? null, reason: fromEngine?.reason ?? "" };
        })
        : null;
      return reply({ consented, pack: { status: p.status, createdAt: p.created_at, items } });
    }

    if (b.action === "delete") {
      // 刪除使用者會連同掃描、同意、問卷、配方一起刪除
      const r = await db.from("users").delete().eq("id", uid);
      if (r.error) throw r.error;
      return reply({ ok: true });
    }

    if (b.action === "submit") {
      if (!(await hasConsent(uid))) return reply({ error: "consent" }, 403);
      const answers = b.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) return reply({ error: "input" }, 400);
      if (JSON.stringify(answers).length > 4000) return reply({ error: "input" }, 400);

      const last = await db.from("intakes").select("created_at").eq("user_id", uid)
        .order("created_at", { ascending: false }).limit(1);
      if (last.error) throw last.error;
      if (last.data?.length && Date.now() - new Date(last.data[0].created_at).getTime() < 30_000) {
        return reply({ error: "too_fast" }, 429);
      }

      // 網頁和後端的題目版本不同（例如網頁還是快取的舊版）時，請客人重開，避免用錯題目算配方
      if (b.questionsVersion !== DATA.questions.version) {
        return reply({ error: "outdated", expected: DATA.questions.version }, 409);
      }

      const result = buildPack(answers, DATA);
      if (result.status === "invalid") return reply({ error: "invalid", errors: result.errors }, 400);
      // 不接單的情況不保存答案（含懷孕、用藥等敏感資料），只回覆說明
      if (result.status === "rejected") return reply({ status: "rejected", messages: result.messages });

      // 只保存題目裡有的欄位
      const clean = Object.fromEntries(DATA.questions.questions.map((q: { id: string }) => [q.id, (answers as Record<string, unknown>)[q.id]]));
      const it = await db.from("intakes").insert({ user_id: uid, questions_version: DATA.questions.version, answers: clean })
        .select("id").single();
      if (it.error) throw it.error;
      const pk = await db.from("packs").insert({
        intake_id: it.data.id,
        user_id: uid,
        engine_version: result.engineVersion,
        data_version: result.dataVersion,
        result,
        item_ids: result.items.map((i: { id: string }) => i.id),
        status: "needs_review",
      });
      if (pk.error) throw pk.error;
      return reply({ status: "received" });
    }

    return reply({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: "server" }, 500);
  }
});
