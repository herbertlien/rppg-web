// @ts-nocheck 規則引擎是 JS，併入後不做型別檢查（handler.ts 另外檢查）
// Supabase Edge Function：linebot（原始碼）
// 這個檔由 build.mjs 自動產生，請勿手改；改 handler.ts 或 engine/ 之後重新產生。
// 接收 LINE 官方帳號的訊息：用聊天室下方的選單圖一題一題作答，答完走和網頁問卷同一套規則引擎。
// 兩種呼叫：LINE 伺服器（帶 X-Line-Signature）與審核者的管理動作（帶 LINE ID token）。
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
    if (hit) { skipped.push({ id: it.id, name: it.name, why: `客人回答「${a.flagLabels[hit]}」`, flag: hit, label: a.flagLabels[hit] }); return; }
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
    focus: topNeeds(a, claims),
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

// 需求分數前三名，附上客人自己的答案當依據（報告用）
function topNeeds(a, claims) {
  const used = new Set();
  const out = [];
  const ranked = Object.entries(a.needs).filter(([, p]) => p > 0).sort((x, y) => y[1] - x[1]);
  for (const [tag, pts] of ranked) {
    if (out.length === 3) break;
    const ev = [...(a.evidence[tag] || [])].sort((x, y) => y.pts - x.pts);
    // 「你想多照顧…」只是重述客人的選擇，不算依據；已被前面的主題用過的依據不重複放
    const fresh = [...new Set(ev.map(e => e.text))].filter(t => !t.startsWith('你想多照顧') && !used.has(t));
    if (ev.length && !fresh.length && out.length) continue;
    const because = fresh.slice(0, 2);
    because.forEach(t => used.add(t));
    out.push({ tag, label: claims.needLabels?.[tag] ?? tag, pts, because });
  }
  return out;
}

// 專屬報告：只複述客人的答案與引擎做過的檢查，文字全部來自資料檔的模板，不由 AI 自由生成。
// 前三段不含品項成分與數量，所以問卷一結束就能給，不必等審核。
function buildReport(result, answers, data) {
  const { questions, claims } = data;
  const sq = questions.questions.find(q => q.id === 'supplements');
  const picked = [].concat(answers.supplements || []);
  const taking = sq ? sq.options.filter(o => picked.includes(o.value) && !o.exclusive).map(o => o.chip || o.label) : [];
  const avoided = (result.skipped || []).filter(x => x.flag).slice(0, 3).map(x => {
    if (x.flag.startsWith('taking_')) return `你已在吃「${x.label}」，這包不再放${x.name}`;
    if (x.flag.startsWith('allergy_')) return `你對「${x.label}」過敏，所以沒放${x.name}`;
    return `依你的回答「${x.label}」，先不放${x.name}`;
  });
  const tip = (claims.tips || []).find(t => Object.entries(t.when).every(([k, v]) => answers[k] === v));
  return {
    focus: result.focus || [],
    diet: (questions.questions.find(q => q.id === 'diet')?.options.find(o => o.value === answers.diet) || {}).label || null,
    taking,
    tier: result.tier,
    avoided,
    safety: '整包的成分加總，會逐項對照每日上限檢查，確認後才通知你。',
    tip: tip ? tip.text : null,
  };
}


// ---- 資料檔（engine/data/*.json）----
// deno-lint-ignore no-explicit-any
const DATA: any = {"items":{"_note":"品項資料。status：confirmed＝成分與每日顆數都由南都確認；formula_only＝有每顆成分、每日顆數未確認；placeholder＝成分與顆數都是暫定數字。只要配方含非 confirmed 品項，就不能出貨。","version":"items-2026-10-23-draft","pharmacistApproved":false,"groups":{"b_complex":{"name":"B 群類","max":1},"opc":{"name":"葡萄籽／前花青素","max":1},"bleeding_risk":{"name":"可能增加出血風險類","max":1}},"items":[{"id":"b_complex_e","name":"維生素 B 群 + E","enabled":true,"status":"formula_only","source":"南都配方表 2026-08-26","groups":["b_complex"],"dailyCapsules":1,"perCapsule":{"vitamin_b1":48,"pantothenic_acid":50,"vitamin_b6":30,"vitamin_b12":500,"vitamin_e":20.4,"gamma_oryzanol":35},"needs":{"energy":3,"stress":2,"eating_out":2,"drinking":1,"period":2},"excludeIf":["taking_b","taking_multivitamin"]},{"id":"b_complex","name":"維生素 B 群（綜合型）","enabled":false,"disabledReason":"含鐵、維生素 A、當歸與色素，和其他品項重疊多；驗證期改用 B 群 + E","status":"formula_only","source":"南都配方表 2026-08-26","groups":["b_complex"],"dailyCapsules":1,"perCapsule":{"vitamin_b1":50,"vitamin_b2":50,"vitamin_b6":50,"pantothenic_acid":50,"niacinamide":30,"vitamin_b12":400,"folate":400,"vitamin_c":100,"vitamin_e":30,"vitamin_a":5000,"vitamin_d":2.5,"iron":7.5,"zinc":10,"magnesium":12.5,"calcium":74},"needs":{"energy":3,"eating_out":3},"excludeIf":[]},{"id":"vitamin_b6","name":"維生素 B6","enabled":false,"disabledReason":"與 B 群疊加容易超過 B6 上限","status":"formula_only","source":"南都配方表 2026-08-26","groups":["b_complex"],"dailyCapsules":1,"perCapsule":{"vitamin_b6":30,"calcium":108},"needs":{"energy":1},"excludeIf":[]},{"id":"magnesium","name":"鎂","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"magnesium":100},"needs":{"sleep":3,"stress":2,"exercise":2,"caffeine":1,"period":2},"excludeIf":[]},{"id":"vitamin_c","name":"維生素 C","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"vitamin_c":250},"needs":{"low_veg":3,"eating_out":1,"seasonal":2,"skin":1},"excludeIf":["taking_c"]},{"id":"zinc","name":"鋅","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"zinc":10},"needs":{"low_veg":1,"exercise":1,"seasonal":2,"skin":1,"hair":2},"excludeIf":[]},{"id":"rhodiola","name":"紅景天","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"rhodiola_extract":200},"needs":{"stress":3,"energy":2},"excludeIf":[]},{"id":"sesamin","name":"芝麻素","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"sesamin":10},"needs":{"late_nights":3,"drinking":3,"sleep":1},"excludeIf":["allergy_sesame"]},{"id":"probiotic","name":"專利益生菌","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"probiotic":100},"needs":{"digestion":4,"eating_out":1},"excludeIf":["taking_probiotic","allergy_milk"]},{"id":"digestive_enzyme","name":"綜合消化酵素","enabled":false,"disabledReason":"建議加入：「消化與排便」目前只對到益生菌一項，待 Herbert 決定","status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{},"needs":{"digestion":3,"eating_out":1},"excludeIf":[]},{"id":"grape_seed","name":"葡萄籽多酚","enabled":true,"status":"placeholder","source":"暫定","groups":["opc"],"dailyCapsules":1,"perCapsule":{"grape_seed_extract":100},"needs":{"skin":2,"late_nights":1},"excludeIf":[]},{"id":"collagen","name":"膠原蛋白","enabled":true,"status":"placeholder","source":"暫定（原料來源待確認，可能為魚）","dailyCapsules":2,"perCapsule":{"collagen":400},"needs":{"skin":3,"exercise":1,"hair":2},"excludeIf":["allergy_fish","vegetarian","taking_collagen"]},{"id":"elderberry","name":"接骨木莓","enabled":true,"status":"placeholder","source":"暫定","dailyCapsules":1,"perCapsule":{"elderberry_extract":200},"needs":{"seasonal":3},"excludeIf":[]},{"id":"nattokinase","name":"納豆激酶","enabled":false,"disabledReason":"可能增加出血風險，驗證期不納入","status":"placeholder","source":"暫定","groups":["bleeding_risk"],"dailyCapsules":1,"perCapsule":{},"needs":{},"excludeIf":["surgery_soon","allergy_soy"]},{"id":"ginkgo","name":"銀杏萃取","enabled":false,"disabledReason":"可能增加出血風險，驗證期不納入","status":"placeholder","source":"暫定","groups":["bleeding_risk"],"dailyCapsules":1,"perCapsule":{},"needs":{},"excludeIf":["surgery_soon"]},{"id":"garlic","name":"大蒜精","enabled":false,"disabledReason":"可能增加出血風險，驗證期不納入","status":"placeholder","source":"暫定","groups":["bleeding_risk"],"dailyCapsules":1,"perCapsule":{},"needs":{},"excludeIf":["surgery_soon"]},{"id":"curcumin","name":"薑黃素","enabled":false,"disabledReason":"可能增加出血風險，驗證期不納入","status":"placeholder","source":"暫定","groups":["bleeding_risk"],"dailyCapsules":1,"perCapsule":{},"needs":{},"excludeIf":["surgery_soon"]}]},"limits":{"_note":"成分字典與每日上限。每個品項用到的成分都要在這裡登記名稱與單位；有 max 的才會檢查上限（來源：南都 2026-10-18 回覆的 UL 表），沒有 max 的只加總、顯示。","source":"南都 UL 表 2026-10-18","warnAtPct":80,"nutrients":{"vitamin_c":{"name":"維生素 C","unit":"mg","max":2000},"vitamin_d":{"name":"維生素 D","unit":"µg","max":50},"calcium":{"name":"鈣","unit":"mg","max":2500},"magnesium":{"name":"鎂（補充劑）","unit":"mg","max":350},"zinc":{"name":"鋅","unit":"mg","max":35},"iron":{"name":"鐵","unit":"mg","max":40},"epa_dha":{"name":"魚油 EPA + DHA","unit":"mg","max":2000},"lutein":{"name":"葉黃素","unit":"mg","max":30},"vitamin_b6":{"name":"維生素 B6","unit":"mg","max":80},"niacin":{"name":"菸鹼酸","unit":"mg","max":35},"folate":{"name":"葉酸","unit":"µg","max":1000},"vitamin_b1":{"name":"維生素 B1","unit":"mg"},"vitamin_b2":{"name":"維生素 B2","unit":"mg"},"pantothenic_acid":{"name":"泛酸鈣","unit":"mg"},"niacinamide":{"name":"菸鹼醯胺","unit":"mg"},"vitamin_b12":{"name":"維生素 B12","unit":"µg"},"vitamin_a":{"name":"維生素 A","unit":"IU"},"vitamin_e":{"name":"維生素 E","unit":"IU"},"gamma_oryzanol":{"name":"米胚芽萃取（γ-oryzanol）","unit":"mg"},"rhodiola_extract":{"name":"紅景天萃取","unit":"mg"},"sesamin":{"name":"芝麻素","unit":"mg"},"probiotic":{"name":"益生菌","unit":"億 CFU"},"grape_seed_extract":{"name":"葡萄籽萃取","unit":"mg"},"collagen":{"name":"膠原蛋白","unit":"mg"},"elderberry_extract":{"name":"接骨木莓萃取","unit":"mg"}}},"questions":{"_note":"問卷題目。safety＝安全題，一定要答。reject＝不接單；flags＝個人禁用旗標；warn＝給審核者的提醒；needs＝需求加分；showIf＝只在前面某題選了指定選項時才問；reason＝理由句型，{label} 換成選項文字（選項上也可直接寫整句）；short＝送出前總覽用的短標題；why＝這題存在的理由（只給內部看）。","version":"questions-2026-10-23e","questions":[{"id":"age","short":"年齡","type":"single","text":"先確認一下，你的年齡是？","safety":true,"why":"年齡門檻（未滿 18 歲不接單）與客群分析；25–39 歲細分是為了看主力客群。不影響選品。","options":[{"value":"under18","label":"未滿 18 歲","reject":"under18"},{"value":"18_24","label":"18–24 歲"},{"value":"25_29","label":"25–29 歲"},{"value":"30_34","label":"30–34 歲"},{"value":"35_39","label":"35–39 歲"},{"value":"40_49","label":"40–49 歲"},{"value":"50_59","label":"50–59 歲"},{"value":"60_69","label":"60–69 歲"},{"value":"70plus","label":"70 歲以上"}]},{"id":"sex","short":"生理性別","type":"single","text":"你的生理性別是？","safety":true,"why":"決定是否要問懷孕題；客群分析。不影響選品。","options":[{"value":"female","label":"女性"},{"value":"male","label":"男性"},{"value":"na","label":"不想透露"}]},{"id":"pregnancy","short":"懷孕、哺乳或備孕","type":"single","text":"你目前是否懷孕、哺乳中，或正在準備懷孕？","safety":true,"showIf":{"sex":["female","na"]},"why":"不接單條件。男性不顯示這題。","options":[{"value":"yes","label":"是","reject":"pregnancy"},{"value":"no","label":"否"}]},{"id":"medication","short":"吃藥","type":"single","text":"你目前有在吃藥嗎？","safety":true,"why":"安全題。口服避孕藥在 28–38 歲女性很常見，所以單獨一個選項：目前不接單，南都藥師確認後只要改這個選項就能放寬。其他固定用藥一律不接單。","options":[{"value":"no","label":"沒有","chip":"沒有"},{"value":"occasional","label":"只有不舒服時偶爾吃（例如止痛藥、感冒藥、過敏藥）","warn":"客人偶爾服用成藥，請確認沒有和品項衝突","chip":"偶爾吃成藥"},{"value":"contraceptive","label":"只有口服避孕藥","reject":"contraceptive","chip":"只有口服避孕藥"},{"value":"regular","label":"有，每天或固定吃（例如抗凝血藥、阿斯匹靈、慢性病用藥）","reject":"medication","chip":"每天或固定吃藥"}],"hint":"偶爾吃：例如止痛藥、感冒藥、過敏藥。固定吃：例如抗凝血藥、阿斯匹靈、慢性病用藥。"},{"id":"conditions","short":"健康狀況","type":"multi","text":"以下有沒有符合你的情況？可以複選。","safety":true,"why":"不接單條件；手術題併進來少一題。","options":[{"value":"kidney","label":"慢性腎臟疾病","reject":"kidney"},{"value":"liver","label":"慢性肝臟疾病","reject":"liver"},{"value":"treatment","label":"其他正在看醫師治療中的疾病","reject":"treatment","chip":"其他治療中疾病"},{"value":"surgery","label":"一個月內有安排手術或拔牙","flags":["surgery_soon"],"warn":"客人一個月內有手術或拔牙安排，請人工確認","chip":"近期手術或拔牙"},{"value":"none","label":"都沒有","exclusive":true}]},{"id":"allergy","short":"食物過敏","type":"multi","text":"有沒有對以下食物過敏？可以複選。","safety":true,"why":"排除含過敏原的品項（膠原蛋白可能是魚來源、芝麻素、益生菌載體可能含乳）。","options":[{"value":"fish","label":"魚類或海鮮","flags":["allergy_fish"]},{"value":"soy","label":"大豆","flags":["allergy_soy"]},{"value":"sesame","label":"芝麻","flags":["allergy_sesame"]},{"value":"milk","label":"牛奶或乳製品","flags":["allergy_milk"]},{"value":"other","label":"其他食物","warn":"客人對其他食物過敏，請向客人確認過敏原"},{"value":"none","label":"都沒有","exclusive":true}]},{"id":"diet","short":"飲食習慣","type":"single","text":"你的飲食習慣是？","safety":true,"why":"素食者不能吃動物來源的膠原蛋白，也要確認膠囊殼。台灣素食人口約一成。","options":[{"value":"omni","label":"葷食"},{"value":"lacto_ovo","label":"蛋奶素","flags":["vegetarian"],"warn":"客人吃素：膠囊殼材質（明膠或植物性）待南都確認"},{"value":"vegan","label":"全素","flags":["vegetarian","vegan"],"warn":"客人吃全素：膠囊殼材質與益生菌載體待南都確認"}]},{"id":"supplements","short":"正在吃的保健食品","type":"multi","text":"目前有固定在吃哪些保健食品？可以複選。","safety":true,"why":"避免重複與超量：已在吃的不再給，吃綜合維他命時不給 B 群並提醒審核。主要客群常同時吃好幾種，這題也是「整包幫你檢查」這個賣點的資料來源。","options":[{"value":"multi","label":"綜合維他命","flags":["taking_multivitamin"],"warn":"客人已在吃綜合維他命，請確認整包加總"},{"value":"b","label":"B 群","flags":["taking_b"]},{"value":"c","label":"維生素 C","flags":["taking_c"]},{"value":"probiotic","label":"益生菌","flags":["taking_probiotic"]},{"value":"collagen","label":"膠原蛋白","flags":["taking_collagen"]},{"value":"fish_oil","label":"魚油"},{"value":"lutein","label":"葉黃素"},{"value":"iron","label":"鐵劑","flags":["taking_iron"],"warn":"客人在吃鐵劑，請確認和鋅、鈣的間隔與整包加總"},{"value":"vitd_ca","label":"鈣或維生素 D","flags":["taking_vitd_ca"],"warn":"客人在吃鈣或維生素 D，請確認整包加總"},{"value":"beauty","label":"美容類（玻尿酸、彈力蛋白、膠原以外的美容保健品）","warn":"客人在吃美容類保健品，請詢問品項，避免和葡萄籽、維 C 重複","chip":"美容類"},{"value":"other","label":"其他","warn":"客人另有在吃其他保健食品，請詢問品項"},{"value":"none","label":"目前沒有","exclusive":true}],"hint":"美容類是指玻尿酸、彈力蛋白等（膠原蛋白請選上面的膠原蛋白）。"},{"id":"spend","short":"每月保健品花費","type":"single","text":"你現在每個月大概花多少錢在保健食品上？","why":"不影響選品。用來驗證主要客群是不是真的已經在花錢，也是定價的依據。","options":[{"value":"0","label":"目前沒有花","chip":"目前沒花"},{"value":"lt500","label":"500 元以下","chip":"500 以下"},{"value":"500_1000","label":"500–1,000 元","chip":"500–1,000"},{"value":"1000_2000","label":"1,000–2,000 元","chip":"1,000–2,000"},{"value":"2000plus","label":"2,000 元以上","chip":"2,000 以上"}]},{"id":"focus","short":"最想照顧","type":"multi","text":"最近最想照顧自己哪個部分？最多選兩個。","max":2,"reason":"你想多照顧{label}","why":"最想照顧的面向，是選品最直接的依據，最多選兩個。針對 28–38 歲女性，新增「頭髮與指甲」「經期前後的不舒服」，拿掉「運動後的恢復」（運動量仍由運動題計入）。","options":[{"value":"energy","label":"白天的精神","needs":{"energy":3}},{"value":"sleep","label":"睡眠","needs":{"sleep":3}},{"value":"stress","label":"壓力與緊繃感","needs":{"stress":3}},{"value":"digestion","label":"消化與排便","needs":{"digestion":3}},{"value":"skin","label":"肌膚狀態","needs":{"skin":3}},{"value":"hair","label":"頭髮與指甲","needs":{"hair":3}},{"value":"period","label":"經期前後的不舒服","needs":{"period":3}},{"value":"seasonal","label":"換季時的保養","needs":{"seasonal":3}}]},{"id":"sleep_hours","short":"睡眠時數","type":"single","text":"平常一晚大概睡幾小時？","reason":"你平均一晚睡 {label}","why":"比「幾點睡」更能反映睡眠不足；輪班或晚睡晚起的人也答得準。","options":[{"value":"lt6","label":"不到 6 小時","needs":{"late_nights":2,"sleep":1},"reason":"你平均一晚睡不到 6 小時"},{"value":"6_7","label":"6–7 小時","needs":{"late_nights":1},"reason":"你平均一晚睡 6–7 小時"},{"value":"7plus","label":"7 小時以上"}]},{"id":"sleep_quality","short":"睡眠品質","type":"single","text":"最近兩週睡得好嗎？","reason":"你說最近{label}","options":[{"value":"good","label":"大多睡得好"},{"value":"so_so","label":"偶爾難入睡或半夜醒來","needs":{"sleep":1}},{"value":"poor","label":"常常睡不好","needs":{"sleep":2}}]},{"id":"stress","short":"壓力","type":"single","text":"最近工作或生活的壓力感覺如何？","reason":"你說最近{label}","why":"用感受描述取代 0–10 分，比較好答。","options":[{"value":"low","label":"還好，應付得來"},{"value":"mid","label":"有點緊繃","needs":{"stress":1}},{"value":"high","label":"壓力很大","needs":{"stress":2}}]},{"id":"caffeine","short":"咖啡因飲料","type":"single","text":"咖啡、茶（含手搖飲）或能量飲料，一天大概幾杯？","reason":"你一天喝 {label}含咖啡因的飲料","why":"靠咖啡或含咖啡因手搖飲撐精神的人通常也睡不好；也是之後分析留存的好指標。","options":[{"value":"0_1","label":"0–1 杯"},{"value":"2","label":"2 杯","needs":{"caffeine":1}},{"value":"3plus","label":"3 杯以上","needs":{"caffeine":2}}]},{"id":"alcohol","short":"喝酒","type":"single","text":"一週大概喝幾次酒（含聚餐應酬）？","reason":"你一週喝酒 {label}","why":"對應芝麻素與 B 群的選品（只做內部選品依據，對外不寫任何功效）。","options":[{"value":"rare","label":"幾乎不喝"},{"value":"1_2","label":"1–2 次","needs":{"drinking":1}},{"value":"3plus","label":"3 次以上","needs":{"drinking":2}}]},{"id":"meals_out","short":"外食","type":"single","text":"一週大概幾餐是外食或外送？","reason":"你一週外食約 {label}","options":[{"value":"few","label":"5 餐以下"},{"value":"some","label":"6–10 餐","needs":{"eating_out":1}},{"value":"most","label":"11 餐以上","needs":{"eating_out":2}}]},{"id":"veg","short":"蔬菜","type":"single","text":"一天三餐裡，大概有幾餐吃得到蔬菜？","reason":"你一天只有 {label}吃得到蔬菜","why":"比「幾份蔬果」好估，一般人算不出份數。","options":[{"value":"3","label":"3 餐都有"},{"value":"2","label":"2 餐","needs":{"low_veg":1}},{"value":"0_1","label":"0–1 餐","needs":{"low_veg":2}}]},{"id":"bowel","short":"排便","type":"single","text":"最近排便狀況如何？","reason":"你說最近{label}","why":"比只放在「想照顧的部分」更客觀，對應益生菌。","options":[{"value":"regular","label":"大多規律"},{"value":"constipation","label":"常常便秘","needs":{"digestion":2}},{"value":"loose","label":"常常拉肚子或時好時壞","needs":{"digestion":2}}]},{"id":"exercise","short":"運動","type":"single","text":"一週運動幾次（每次 30 分鐘以上）？","reason":"你一週運動 {label}","options":[{"value":"0","label":"幾乎沒有"},{"value":"1_2","label":"1–2 次","needs":{"exercise":1}},{"value":"3plus","label":"3 次以上","needs":{"exercise":2}}]},{"id":"tier","short":"方案","type":"single","text":"最後，想要每天幾種？","options":[{"value":"basic","label":"基礎版，每天 3 種","tier":3},{"value":"advanced","label":"進階版，每天 5 種","tier":5}]}]},"claims":{"_note":"對外措辭。理由只描述客人自己的回答，不寫任何功效。禁用詞清單用於 AI 輸出過濾與文案自我檢查，上線前需專業審閱。","version":"claims-2026-10-23-draft","rejectMessages":{"under18":"目前只提供給 18 歲以上的朋友，謝謝你的興趣。","pregnancy":"懷孕、哺乳或備孕期間的營養需求比較特別，我們目前不提供，建議和你的醫師或營養師討論。","medication":"有固定用藥時，保健食品可能和藥物互相影響。我們目前不提供，建議先和你的醫師或藥師討論。","kidney":"有慢性腎臟疾病時需要特別留意，我們目前不提供，建議先和你的醫師討論。","liver":"有慢性肝臟疾病時需要特別留意，我們目前不提供，建議先和你的醫師討論。","treatment":"正在治療中的朋友，我們目前不提供，建議先和你的醫師討論。","contraceptive":"口服避孕藥是否能和我們的品項一起吃，我們還在請藥師確認，目前先不提供。確認後再通知你，謝謝你的耐心。"},"bannedTerms":["治療","治癒","根治","預防","療效","藥效","診斷","處方","疾病","病症","降血壓","降低血壓","降血糖","降血脂","降膽固醇","溶解血栓","溶血栓","抗病毒","抗癌","防癌","抗發炎","消炎","殺菌","抗菌","改善失眠","治失眠","安眠","減肥","減重","瘦身","燃脂","排毒","抗憂鬱","憂鬱症","焦慮症","增強免疫力","提升免疫力","增強抵抗力","保肝","護肝","顧肝","壯陽","回春","延緩老化","抗老","泌尿道感染","關節炎","骨質疏鬆","痛風","糖尿病","高血壓","心血管疾病","保證有效","百分之百","100%","無副作用","醫師推薦","醫生推薦","臨床證實","掃臉算出","掃描計算配方"],"needLabels":{"energy":"白天的精神","sleep":"睡眠","stress":"壓力與緊繃感","digestion":"消化與排便","skin":"肌膚狀態","hair":"頭髮與指甲","period":"經期前後的狀態","seasonal":"換季時的保養","caffeine":"咖啡因","drinking":"應酬與飲酒","eating_out":"外食比較多","low_veg":"蔬菜吃得少","exercise":"運動習慣","late_nights":"熬夜"},"tips":[{"id":"caffeine","when":{"caffeine":"3plus"},"text":"下午兩點後，把含咖啡因的飲料換成無咖啡因的或白開水，先試一週。"},{"id":"sleep","when":{"sleep_hours":"lt6"},"text":"這週固定起床時間，不管前一晚幾點睡，先讓作息規律。"},{"id":"veg","when":{"veg":"0_1"},"text":"外食時多加一份蔬菜，例如燙青菜或生菜沙拉，先從一天一餐開始。"},{"id":"exercise","when":{"exercise":"0"},"text":"每天走 10 分鐘就好，先把動一動變成習慣。"},{"id":"default","when":{},"text":"先維持目前的作息，每個月我們會依你的狀況調整一次組合。"}]}};

const LINE_CHANNEL_ID = "2012194363"; // LINE Login 頻道（網頁登入用），驗審核者的 ID token
const CONSENT_VERSION = "intake-v1";
const ADMINS = (Deno.env.get("ADMIN_LINE_SUBS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const LIFF_URL = "https://liff.line.me/2012194363-LYirSkEL";
const ASSET_BASE = "https://glittery-longma-b8be7c.netlify.app/menus/";


// This generated artifact is locked to the declared isolated test project.
if (Deno.env.get("RELAX_ISOLATED_TEST") !== "1" || (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "") !== "https://rswcmlujwcwxvsffzise.supabase.co") {
  throw new Error("Isolated test project mismatch; refusing to start");
}
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// 管理動作從審核頁（網頁）呼叫，需要 CORS；LINE 伺服器不受影響
const cors = {
  "Access-Control-Allow-Origin": "https://glittery-longma-b8be7c.netlify.app",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

// ---------- LINE API ----------
async function line(path: string, method = "POST", body?: unknown, host = "api.line.me") {
  if (path.includes("/richmenu")) return {};
  const r = await fetch(`https://${host}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`LINE ${method} ${path} ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const reply = (replyToken: string, messages: unknown[]) => line("/v2/bot/message/reply", "POST", { replyToken, messages });

async function verifySignature(raw: string, sig: string | null): Promise<boolean> {
  if (!sig || !SECRET) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return btoa(String.fromCharCode(...mac)) === sig;
}

async function verifyIdToken(idToken: string): Promise<string | null> {
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return typeof j.sub === "string" ? j.sub : null;
}

// ---------- 使用者與同意 ----------
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

// ---------- 題目流程 ----------
type Opt = { value: string; label: string; chip?: string; exclusive?: boolean; reject?: string };
type Q = { id: string; type: "single" | "multi"; text: string; hint?: string; max?: number; options: Opt[] };
const QS: Q[] = DATA.questions.questions;
const QTOTAL = QS.length;

function nextQuestion(answers: Record<string, unknown>, afterId: string | null): Q | null {
  const start = afterId ? QS.findIndex((q) => q.id === afterId) + 1 : 0;
  for (let i = start; i < QS.length; i++) if (isShown(QS[i], answers)) return QS[i];
  return null;
}

type Session = { user_id: string; answers: Record<string, unknown>; cur: string | null; multi: string[]; history: string[] };

async function loadSession(uid: string): Promise<Session | null> {
  const r = await db.from("quiz_sessions").select("*").eq("user_id", uid).maybeSingle();
  if (r.error) throw r.error;
  return r.data;
}
async function saveSession(s: Session) {
  const r = await db.from("quiz_sessions").upsert({ ...s, updated_at: new Date().toISOString() });
  if (r.error) throw r.error;
}
async function clearSession(uid: string) {
  const r = await db.from("quiz_sessions").delete().eq("user_id", uid);
  if (r.error) throw r.error;
}

const quick = (items: { label: string; data?: string; text?: string; uri?: string }[]) => ({
  items: items.map((i) => ({
    type: "action",
    action: i.uri
      ? { type: "uri", label: i.label.slice(0, 20), uri: i.uri }
      : i.data
      ? { type: "postback", label: i.label.slice(0, 20), data: i.data, displayText: i.label.slice(0, 20) }
      : { type: "message", label: i.label.slice(0, 20), text: i.text ?? i.label },
  })),
});

async function menuIds(): Promise<Record<string, string>> {
  const r = await db.from("rich_menus").select("question_id,rich_menu_id,questions_version");
  if (r.error) throw r.error;
  return Object.fromEntries((r.data ?? []).filter((x: { questions_version: string }) => x.questions_version === DATA.questions.version)
    .map((x: { question_id: string; rich_menu_id: string }) => [x.question_id, x.rich_menu_id]));
}

// 送出目前這一題：換上這一題的選單圖
async function askQuestion(sub: string, replyToken: string, s: Session, notice?: string, intro = false) {
  const q = QS.find((x) => x.id === s.cur)!;
  const n = QS.filter((x) => isShown(x, s.answers)).indexOf(q) + 1;
  const total = QS.filter((x) => isShown(x, s.answers)).length;
  const text = `（${n}/${total}）${q.text}${q.hint ? `\n${q.hint}` : ""}${q.type === "multi" ? `\n${q.max ? `最多選 ${q.max} 項。` : ""}點選項加入、再點一次取消，選好請按選單最下面的「完成」。${q.options.some((o) => o.exclusive) ? "都沒有的話，直接按「完成」就可以。" : ""}` : ""}`;
  const back = s.history.length ? [{ label: "‹ 上一題", data: "back" }] : [];
  const messages: unknown[] = [];
  if (notice) messages.push({ type: "text", text: notice });
  if (intro) messages.push({ type: "image", originalContentUrl: `${ASSET_BASE}intro.png`, previewImageUrl: `${ASSET_BASE}intro.png` });
  // 單選、複選都用下方選單圖；複選的選單最下面有「完成」，點選項只回報目前選了什麼，選單不換
  const ids = await menuIds();
  if (ids[q.id]) await line(`/v2/bot/user/${sub}/richmenu/${ids[q.id]}`);
  else await line(`/v2/bot/user/${sub}/richmenu`, "DELETE").catch(() => {});
  messages.push({ type: "text", text, ...(back.length ? { quickReply: quick(back) } : {}) });
  await reply(replyToken, messages);
}

const CONSENT_TEXT = "開始前請先看一下：\n接下來會問你年齡、是否懷孕或用藥、過敏、目前吃的保健食品，以及作息與飲食習慣，用來整理適合你的每日組合。\n・回答只有 Deerly 負責審核的人看得到，不會提供給第三方。\n・如果依回答我們不適合提供服務，這次的回答不會被保存。\n・如果你也用過心率量測，量測的數字（沒有影像）會一起給審核者參考。\n・配方由固定規則整理，再由人工確認後才通知你；這不是醫療建議。\n・你隨時可以刪除所有資料。\n（草稿，正式對外前會請專業人士審閱）";

async function startFlow(sub: string, replyToken: string, force = false) {
  if(relaxMenuTestScope()){
    const priorUid=await findUser(sub,false),prior=priorUid?await relaxSession(priorUid):null;
    if(prior)await relaxMenusRestore(sub,prior);
  }
  const uid = await findUser(sub, true);
  if (!uid) return;
  if (!(await hasConsent(uid))) {
    return reply(replyToken, [{
      type: "text", text: CONSENT_TEXT,
      quickReply: quick([{ label: "我同意，開始", data: "consent|yes" }, { label: "先不要", data: "consent|no" }]),
    }]);
  }
  if (!force) {
    // 還有沒答完的問卷（已經答過至少一題）時，先問要繼續還是重來，不要直接清掉進度
    const old = await loadSession(uid);
    if (old?.cur && old.history.length) {
      return reply(replyToken, [{
        type: "text", text: `你有一份還沒答完的問卷（已答 ${old.history.length} 題）。要繼續，還是重新開始？`,
        quickReply: quick([{ label: "繼續", data: "resume|go" }, { label: "重新開始", data: "restart|go" }]),
      }]);
    }
  }
  const first = nextQuestion({}, null)!;
  const s: Session = { user_id: uid, answers: {}, cur: first.id, multi: [], history: [] };
  await saveSession(s);
  await askQuestion(sub, replyToken, s, "好的，我們開始，大約兩分鐘。", true);
}

async function finish(sub: string, replyToken: string, s: Session) {
  await line(`/v2/bot/user/${sub}/richmenu`, "DELETE").catch(() => {});
  const result = buildPack(s.answers, DATA);
  await clearSession(s.user_id);
  if (result.status === "invalid") return reply(replyToken, [{ type: "text", text: "資料有些問題，請輸入「開始問卷」重新來一次，不好意思。" }]);
  if (result.status === "rejected") return reply(replyToken, result.messages.map((t: string) => ({ type: "text", text: t })));
  const clean = Object.fromEntries(QS.map((q) => [q.id, s.answers[q.id]]));
  const it = await db.from("intakes").insert({ user_id: s.user_id, questions_version: DATA.questions.version, answers: clean }).select("id").single();
  if (it.error) throw it.error;
  const pk = await db.from("packs").insert({
    intake_id: it.data.id, user_id: s.user_id, engine_version: result.engineVersion, data_version: result.dataVersion,
    result, item_ids: result.items.map((i: { id: string }) => i.id), status: "needs_review",
  });
  if (pk.error) throw pk.error;
  return reply(replyToken, [
    { type: "text", text: "謝謝你！這是依你的回答整理的專屬報告。品項我們確認後，會在這裡通知你。" },
    reportFlexV2(buildReport(result, s.answers, DATA)),
  ]);
}

// ---------- 專屬報告（LINE Flex 卡片）----------
type Report = { focus: { label: string; because: string[] }[]; taking: string[]; tier: number; avoided: string[]; safety: string; tip: string | null; diet?: string | null };
const T = (text: string, o: Record<string, unknown> = {}) => ({ type: "text", text, wrap: true, ...o });
const bubble = (title: string, lines: unknown[], footer?: unknown) => ({
  type: "bubble", size: "mega",
  styles: { body: { backgroundColor: "#F6F1EA" }, footer: { backgroundColor: "#F6F1EA" } },
  body: { type: "box", layout: "vertical", spacing: "lg", paddingAll: "20px", contents: [
    T("DEERLY 專屬報告", { size: "xs", weight: "bold", color: "#2F7D5B" }),
    T(title, { size: "xl", weight: "bold", color: "#1E2A24" }),
    ...lines,
  ] },
  ...(footer ? { footer } : {}),
});

// ---------- 新版卡片視覺（頁頭圖＋圓角數字＋圓點）----------
const CARD_HEADER = "https://glittery-longma-b8be7c.netlify.app/cards/header.png";
const C = { bg: "#FCF8EF", deep: "#1F5C42", brand: "#2F7D5B", ink: "#1E2A24", mute: "#6B7A72", chip: "#E3EBE4", line: "#D9DFD6" };
const num = (n: number) => ({ type: "box", layout: "vertical", width: "30px", height: "30px", cornerRadius: "15px", backgroundColor: C.chip,
  justifyContent: "center", alignItems: "center", flex: 0, contents: [T(String(n).padStart(2, "0"), { size: "xs", weight: "bold", color: C.deep, wrap: false })] });
const dots = (active: number, total: number) => ({ type: "box", layout: "horizontal", spacing: "sm", justifyContent: "center", contents: Array.from({ length: total }, (_, i) => (
  { type: "box", layout: "vertical", width: "8px", height: "8px", cornerRadius: "4px", backgroundColor: i === active ? C.deep : "#D3D6D1", contents: [{ type: "filler" }] })) });
const cardV2 = (i: number, total: number, eyebrow: string, title: string, sub: string, body: unknown[], button?: { label: string; uri: string }, hint?: string) => ({
  type: "bubble", size: "mega",
  styles: { body: { backgroundColor: C.bg }, footer: { backgroundColor: C.bg } },
  hero: { type: "image", url: CARD_HEADER, size: "full", aspectRatio: "1040:225", aspectMode: "cover" },
  body: { type: "box", layout: "vertical", spacing: "md", paddingTop: "4px", paddingAll: "20px", contents: [
    T(`${String(i + 1).padStart(2, "0")} / ${eyebrow}`, { size: "xs", weight: "bold", color: C.deep }),
    T(title, { size: "xl", weight: "bold", color: C.deep }),
    T(sub, { size: "sm", color: C.mute }),
    ...body,
  ] },
  footer: { type: "box", layout: "vertical", spacing: "md", paddingTop: "0px", paddingAll: "16px", contents: [
    ...(button ? [{ type: "button", style: "secondary", height: "md", action: { type: "uri", label: button.label, uri: button.uri } }] : []),
    ...(hint ? [T(hint, { size: "xs", color: C.mute, align: "center" })] : []),
    dots(i, total),
  ] },
});

// 問卷答完（A 組）：封面、你的回答、為什麼這樣整理、下一步；不含品項。nick 是客人自己設定的稱呼，沒有就不叫名字。
function reportFlexV2(r: Report, nick?: string) {
  const pills = [
    `最想照顧：${r.focus.map(f => f.label).join("、") || "還沒選"}`,
    `目前固定補充：${r.taking.join("、") || "沒有"}`,
    ...(r.diet ? [`飲食習慣：${r.diet}`] : []),
    `希望每天：${r.tier} 項`,
  ];
  const pill = (t: string, n: number) => ({ type: "box", layout: "horizontal", spacing: "md", alignItems: "center", paddingAll: "8px",
    cornerRadius: "20px", borderWidth: "1px", borderColor: C.line, contents: [num(n), T(t, { size: "sm", color: C.deep, weight: "bold" })] });
  const why = [
    ["目前固定補充的品項", "避免和既有習慣重複。"], ["想優先照顧的日常狀態", "先整理你最在意的方向。"],
    ["飲食習慣與生活作息", "作為後續整理的參考。"], ["安全與重複補充確認", "讓建議更一致。"],
  ];
  const whyRow = (t: [string, string], n: number) => ({ type: "box", layout: "vertical", spacing: "sm", contents: [
    { type: "box", layout: "horizontal", spacing: "md", alignItems: "center", contents: [num(n), { type: "box", layout: "vertical", contents: [T(t[0], { size: "sm", weight: "bold", color: C.deep }), T(t[1], { size: "xs", color: C.mute })] }] },
    ...(n < 4 ? [{ type: "separator", color: C.line, margin: "sm" }] : []),
  ] });
  const steps = ["整理你的問卷回答", "確認目前固定補充的內容", "完成後通知你查看本月組合"];
  const step = (t: string, n: number) => ({ type: "box", layout: "horizontal", spacing: "md", alignItems: "center", contents: [num(n), T(t, { size: "sm", color: C.ink })] });
  const total = 4;
  return { type: "flex", altText: "你的 Deerly 專屬報告", contents: { type: "carousel", contents: [
    cardV2(0, total, "PERSONAL EDITION", nick ? `Hi，${nick}。` : "你好。", "你的專屬營養補充品提案，依照你的問卷回答整理。", [], undefined, "向左滑動查看 ›"),
    cardV2(1, total, "YOUR RESPONSES", "這次，我們先從你的問卷回答開始", "以下內容會作為後續整理的參考", pills.map((t, i) => pill(t, i + 1)), undefined, "繼續向左滑 ›"),
    cardV2(2, total, "MADE FOR YOU", "為什麼會先整理成這樣的方向？", "我們會依照你的問卷回答逐項查看", why.map((t, i) => whyRow(t as [string, string], i + 1)), undefined, "再向左滑一張 ›"),
    cardV2(3, total, "NEXT STEP", "接下來，Deerly 會怎麼做？", "我們會先整理你的問卷回答，再通知你查看後續內容", steps.map((t, i) => step(t, i + 1)), { label: "前往我的 Deerly", uri: `${LIFF_URL}/me/` }),
  ] } };
}

// 核准後：本月組合（每項一張，附原因）
function packFlex(tier: number, items: { name: string; dailyCapsules: number | null; reason: string }[]) {
  const head = bubble("本月組合", [
    T(`每天 ${tier} 項，一包整理好。`, { size: "lg", weight: "bold", color: "#1F5C42" }),
    T("每項都附上為什麼放進來，向左滑看。每個月我們會依你的回答調整一次，並寫下調整的原因。", { size: "md", color: "#7A8780" }),
  ]);
  const cards = items.map((it, i) => bubble(`${i + 1}　${it.name}`, [
    ...(it.dailyCapsules ? [T(`每天 ${it.dailyCapsules} 顆`, { size: "md", color: "#1E2A24" })] : []),
    T(it.reason || "依你的回答放入", { size: "md", color: "#7A8780" }),
  ]));
  const last = bubble("下一步", [
    T("看完整的組合、過去的報告和量測紀錄。", { size: "md", color: "#1E2A24" }),
  ], { type: "box", layout: "vertical", paddingAll: "16px", contents: [
    { type: "button", style: "primary", color: "#2F7D5B", height: "md", action: { type: "uri", label: "打開我的 Deerly", uri: `${LIFF_URL}/me/` } },
  ] });
  return { type: "flex", altText: "你的 Deerly 本月組合", contents: { type: "carousel", contents: [head, ...cards, last] } };
}

// 管理者預覽用的固定測試資料：真的跑一次規則引擎，確保卡片內容和正式一致
const PREVIEW_ANSWERS = {
  age: "30_34", sex: "female", pregnancy: "no", medication: "no", conditions: ["none"], allergy: ["none"], diet: "omni",
  supplements: ["b"], spend: "500_1000", focus: ["sleep", "stress"], sleep_hours: "lt6", sleep_quality: "poor", stress: "high",
  caffeine: "3plus", alcohol: "1_2", meals_out: "most", veg: "0_1", bowel: "regular", exercise: "0", tier: "basic",
};
function previewCards(kind: "report" | "pack") {
  const result = buildPack(PREVIEW_ANSWERS, DATA);
  const note = { type: "text", text: "（預覽：固定測試資料，只有管理者看得到）" };
  if (kind === "report") return [note, reportFlexV2(buildReport(result, PREVIEW_ANSWERS, DATA))];
  return [note, packFlex(result.tier, result.items)];
}

// 套用一個答案後往下走
async function advance(sub: string, replyToken: string, s: Session, q: Q, notice?: string) {
  const rejectOpt = q.options.find((o) => o.reject && [].concat(s.answers[q.id] as never).includes(o.value as never));
  if (rejectOpt) {
    await clearSession(s.user_id);
    await line(`/v2/bot/user/${sub}/richmenu`, "DELETE").catch(() => {});
    return reply(replyToken, [{ type: "text", text: DATA.claims.rejectMessages[rejectOpt.reject!] }, {
      type: "text", text: "如果是選錯了，輸入「開始問卷」可以重新來。", quickReply: quick([{ label: "開始問卷", text: "開始問卷" }]),
    }]);
  }
  s.history.push(q.id);
  const nq = nextQuestion(s.answers, q.id);
  if (!nq) return finish(sub, replyToken, s);
  s.cur = nq.id;
  s.multi = [];
  await saveSession(s);
  return askQuestion(sub, replyToken, s, notice);
}

const startQuick = quick([{ label: "開始問卷", text: "開始問卷" }]);
const reportQuick = quick([{ label: "看專屬報告", text: "我的報告" }]);

// 主選單「我的組合」：看最近一份的狀態
async function showPack(sub: string, replyToken: string) {
  const uid = await findUser(sub, false);
  const p = uid
    ? await db.from("packs").select("status,item_ids,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(1).maybeSingle()
    : null;
  if (p?.error) throw p.error;
  if (!p?.data) return reply(replyToken, [{ type: "text", text: "你還沒有組合。回答 20 題問卷，我們就能整理一份給你。", quickReply: startQuick }]);
  if (p.data.status === "approved") {
    const names = (p.data.item_ids as string[]).map((id) => DATA.items.items.find((i: { id: string }) => i.id === id)?.name ?? id);
    return reply(replyToken, [{ type: "text", text: `你目前的每日組合：\n${names.map((n) => `・${n}`).join("\n")}\n\n每月會依你的狀況調整一次。`, quickReply: reportQuick }]);
  }
  if (p.data.status === "returned") return reply(replyToken, [{ type: "text", text: "上一份組合需要再調整，請重新回答問卷。", quickReply: startQuick }]);
  return reply(replyToken, [{ type: "text", text: "你的組合整理中，確認後會在這裡通知你。", quickReply: reportQuick }]);
}

// 重看最近一份問卷的專屬報告
async function showReport(sub: string, replyToken: string) {
  const uid = await findUser(sub, false);
  const p = uid
    ? await db.from("packs").select("result,intakes(answers)").eq("user_id", uid).order("created_at", { ascending: false }).limit(1).maybeSingle()
    : null;
  if (p?.error) throw p.error;
  const answers = (p?.data as { intakes?: { answers?: Record<string, unknown> } } | null)?.intakes?.answers;
  if (!p?.data || !answers) return reply(replyToken, [{ type: "text", text: "你還沒有報告。回答 20 題問卷，我們就能整理一份給你。", quickReply: startQuick }]);
  return reply(replyToken, [reportFlexV2(buildReport(p.data.result, answers, DATA))]);
}

// 掃臉完成後，使用者端會自動送出「我量好了」，這裡回覆最新一次的結果
async function onScanDone(sub: string, replyToken: string) {
  const uid = await findUser(sub, false);
  const rows = uid
    ? await db.from("scans").select("bpm,quality,scanned_at").eq("user_id", uid).order("scanned_at", { ascending: false }).limit(60)
    : null;
  if (rows?.error) throw rows.error;
  const last = rows?.data?.[0];
  const again = quick([{ label: "再量一次", uri: LIFF_URL }]);
  if (!last || Date.now() - new Date(last.scanned_at).getTime() > 15 * 60e3) {
    return reply(replyToken, [{ type: "text", text: "還沒看到新的量測結果，請點下方選單的「今日電量」。", quickReply: again }]);
  }
  if (last.quality < 0.35) return reply(replyToken, [{ type: "text", text: "這次訊號不太穩，請在光線充足的地方再量一次。", quickReply: again }]);
  const base = (rows!.data as { bpm: number; quality: number; scanned_at: string }[]).slice(1)
    .filter((r) => r.quality >= 0.55 && Date.now() - new Date(r.scanned_at).getTime() < 28 * 864e5).map((r) => r.bpm).sort((a, b) => a - b);
  let cmp = "";
  if (base.length >= 3) {
    const m = base.length >> 1, med = base.length % 2 ? base[m] : (base[m - 1] + base[m]) / 2;
    const d = Math.round(last.bpm - med);
    cmp = d === 0 ? "，和你平常差不多" : `，比你平常${d > 0 ? "高" : "低"} ${Math.abs(d)} 下`;
  }
  const hasPack = uid ? !!(await db.from("packs").select("id").eq("user_id", uid).limit(1)).data?.length : false;
  const next = hasPack ? "" : "\n\n心率只是讓你認識自己，組合由問卷回答決定。接著回答問卷，整理你的每日組合。";
  return reply(replyToken, [{
    type: "text", text: `你剛剛量到每分鐘 ${Math.round(last.bpm)} 下${cmp}。心率僅供參考，不影響配方。${next}`,
    ...(hasPack ? {} : { quickReply: startQuick }),
  }]);
}

async function onPostback(sub: string, replyToken: string, data: string) {
  if (data.startsWith('rlx|')) return relaxGuard(sub, replyToken, () => relaxPostback(sub, replyToken, data));
  const [kind, qid, value] = data.split("|");
  if (kind === "home") return qid === "pack" ? showPack(sub, replyToken) : startFlow(sub, replyToken);
  if (kind === "restart") return startFlow(sub, replyToken, true);
  if (kind === "consent") {
    if (qid !== "yes") return reply(replyToken, [{ type: "text", text: "好的，需要的時候輸入「開始問卷」就可以。" }]);
    const uid = await findUser(sub, true);
    if (!uid) return;
    if (!(await hasConsent(uid))) {
      const r = await db.from("consents").insert({ user_id: uid, version: CONSENT_VERSION });
      if (r.error) throw r.error;
    }
    return startFlow(sub, replyToken);
  }
  const uid = await findUser(sub, false);
  const s = uid ? await loadSession(uid) : null;
  if (!uid || !s || !s.cur) return reply(replyToken, [{ type: "text", text: "輸入「開始問卷」就可以開始。", quickReply: quick([{ label: "開始問卷", text: "開始問卷" }]) }]);

  if (kind === "resume") return askQuestion(sub, replyToken, s);

  if (kind === "back") {
    const prev = s.history.pop();
    if (!prev) return askQuestion(sub, replyToken, s);
    delete s.answers[prev];
    s.cur = prev;
    s.multi = [];
    await saveSession(s);
    return askQuestion(sub, replyToken, s);
  }

  const q = QS.find((x) => x.id === qid);
  // 點到舊的選單（不是目前這一題）就忽略，重送目前這一題
  if (!q || q.id !== s.cur) return askQuestion(sub, replyToken, s);

  if (kind === "a" && q.type === "single") {
    if (!q.options.some((o) => o.value === value)) return askQuestion(sub, replyToken, s);
    s.answers[q.id] = value;
    return advance(sub, replyToken, s, q);
  }
  if (kind === "m" && q.type === "multi") {
    const o = q.options.find((x) => x.value === value);
    if (!o) return askQuestion(sub, replyToken, s);
    const sel = new Set(s.multi);
    let notice: string | undefined;
    if (sel.has(o.value)) sel.delete(o.value);
    else if (o.exclusive) { sel.clear(); sel.add(o.value); }
    else {
      for (const x of q.options) if (x.exclusive) sel.delete(x.value);
      if (q.max && sel.size >= q.max) notice = `最多選 ${q.max} 項，要換的話請先點掉一項。`;
      else sel.add(o.value);
    }
    s.multi = q.options.map((x) => x.value).filter((v) => sel.has(v));
    await saveSession(s);
    const names = s.multi.map((v) => { const x = q.options.find((y) => y.value === v)!; return x.chip ?? x.label; });
    const now = names.length ? `目前選了：${names.join("、")}` : "目前還沒選";
    return reply(replyToken, [{ type: "text", text: `${notice ? notice + "\n" : ""}${now}\n（再點一次可取消，選好請按「完成」）` }]);
  }
  if (kind === "d" && q.type === "multi") {
    if (!s.multi.length) {
      // 什麼都沒選就按完成，視為「都沒有」；沒有這個選項的題目（如重點關注）才要求至少選一項
      const none = q.options.find((o) => o.exclusive);
      if (!none) return askQuestion(sub, replyToken, s, "請至少選一項。");
      s.answers[q.id] = [none.value];
      return advance(sub, replyToken, s, q, `沒有選的話，記為「${none.chip ?? none.label}」。`);
    }
    s.answers[q.id] = [...s.multi];
    return advance(sub, replyToken, s, q);
  }
  return askQuestion(sub, replyToken, s);
}

async function onText(sub: string, replyToken: string, text: string) {
  const t = text.trim();
  if(["繼續","繼續放鬆測試"].includes(t) && relaxMenuTestScope() && relaxAllowed(sub))return relaxGuard(sub,replyToken,async()=>{
    const uid=await findUser(sub,false),s=uid?await relaxSession(uid):null;
    if(!s)return relaxStart(sub,replyToken);
    return relaxAsk(sub,replyToken,s.paused?await relaxUpdate(s,{paused:false}):s);
  });
  if(t === "選單診斷")return relaxGuard(sub,replyToken,()=>relaxMenuDiagnose(sub,replyToken));
  if(t === "收起放鬆選單")return relaxGuard(sub,replyToken,async()=>{
    if(!relaxMenuTestScope())return reply(replyToken,[{type:"text",text:"這個操作只適用測試帳號。"}]);
    const uid=await findUser(sub,false),s=uid?await relaxSession(uid):null;
    if(s){await relaxMenusRestore(sub,s);if(!s.paused)await relaxUpdate(s,{paused:true});}
    return reply(replyToken,[{type:"text",text:"已收起選單，進度幫你留著。想繼續時傳任何訊息就可以。"}]);
  });
  if (["放鬆測試","放鬆練習","14天放鬆","14 天放鬆","重新開始放鬆測試"].includes(t)) return relaxGuard(sub,replyToken,()=>relaxStart(sub,replyToken));
  if (["刪除我的資料","刪除放鬆測試資料"].includes(t)) return relaxGuard(sub,replyToken,()=>relaxDelete(sub,replyToken));
  if (/^放鬆量測完成 /.test(t)) return relaxGuard(sub,replyToken,async()=>{
    if (!relaxAllowed(sub)) return reply(replyToken,[{type:"text",text:"放鬆測試目前未開放。"}]);
    const uid=await findUser(sub,false), s=uid?await relaxSession(uid):null;
    if (s && t === `放鬆量測完成 ${s.flow_id}`) return relaxScanDone(sub,replyToken,s);
    return reply(replyToken,[{type:"text",text:"這個量測連結已經過期了，傳任何訊息就能接著做。"}]);
  });
  if (t === "我量好了" && relaxAllowed(sub)) {
    const handled=await relaxGuard(sub,replyToken,async()=>{
      const uid=await findUser(sub,false), s=uid?await relaxSession(uid):null;
      if (s?.status === "scan" && !s.paused) { await relaxScanDone(sub,replyToken,s); return true; }
      return false;
    });
    if (handled !== false) return;
  }
  // The isolated test bot only runs the relaxation quiz: any other text re-shows where the tester is.
  if (relaxMenuTestScope() && relaxAllowed(sub)) return relaxGuard(sub,replyToken,async()=>{
    const uid=await findUser(sub,false),s=uid?await relaxSession(uid):null;
    return s?relaxAsk(sub,replyToken,s):relaxStart(sub,replyToken);
  });
  if (/^(開始問卷|開始|問卷)$/.test(text.trim())) return startFlow(sub, replyToken);
  if (/^我量好了/.test(text.trim())) return onScanDone(sub, replyToken);
  if (/^(我的報告|報告|看報告)$/.test(text.trim())) return showReport(sub, replyToken);
  if (text.trim() === "我的組合") return showPack(sub, replyToken);
  if (ADMINS.includes(sub) && /^預覽(報告|組合)$/.test(text.trim())) return reply(replyToken, previewCards(text.trim() === "預覽報告" ? "report" : "pack"));
  if (text.trim() === "上一題") return onPostback(sub, replyToken, "back");
  const uid = await findUser(sub, false);
  const s = uid ? await loadSession(uid) : null;
  if (s?.cur) return askQuestion(sub, replyToken, s, "請用下方的按鈕作答。");
  return reply(replyToken, [{ type: "text", text: "嗨，歡迎來到 Deerly。想整理你的每日組合，點下面開始。", quickReply: quick([{ label: "開始問卷", text: "開始問卷" }]) }]);
}

async function onEvent(ev: { type: string; replyToken?: string; source?: { userId?: string }; message?: { type: string; text?: string }; postback?: { data: string } }) {
  const sub = ev.source?.userId;
  if (!sub || !ev.replyToken) return;
  if (ev.type === "follow") return onText(sub, ev.replyToken, "");
  if (ev.type === "message" && ev.message?.type === "text") return onText(sub, ev.replyToken, ev.message.text ?? "");
  if (ev.type === "postback" && ev.postback) return onPostback(sub, ev.replyToken, ev.postback.data);
}


// ---------- 自願參加的數位放鬆方案測試（與既有保健品流程隔離）----------
// ---- digital relax pilot config (pilot/products.js) ----
// 試驗商品的「題庫＋規則式數位計畫」設定。此版本不呼叫 AI、也不保存個資。
const catalog = {
  relax: {
    id: 'relax', label: '14 天放鬆練習', eyebrow: '日常練習・14 天',
    title: '每天留幾分鐘，建立自己的放鬆節奏',
    tagline: '用生活情境問卷，安排適合你時間的練習。心率紀錄是可選的自我觀察，不作診斷。',
    price: 1290, days: 14,
    questions: [
      { id: 'goal', text: '你最想在哪個時段安排練習？', options: [
        {value:'break',label:'工作中間，短暫休息'}, {value:'evening',label:'下班後，轉換節奏'},
        {value:'beforebed',label:'睡前，建立安靜的流程'} ] },
      { id:'minutes', text:'每天願意花幾分鐘？', options: [
        {value:'3',label:'3 分鐘'}, {value:'5',label:'5 分鐘'}, {value:'10',label:'10 分鐘'} ] },
      { id:'barrier', text:'過去最難持續的原因是？', options: [
        {value:'forget',label:'常常忘記'}, {value:'busy',label:'時間總是不夠'},
        {value:'distract',label:'很容易分心'}, {value:'unsure',label:'不知道怎麼開始'} ] },
      { id:'format', text:'你喜歡怎麼接受練習引導？', options: [
        {value:'audio',label:'聽語音'}, {value:'visual',label:'看動畫'},
        {value:'text',label:'讀簡短文字'} ] },
      { id:'reminder', text:'哪個時段提醒最不打擾你？', options: [
        {value:'morning',label:'早上'}, {value:'noon',label:'午休前後'},
        {value:'night',label:'晚上'}, {value:'none',label:'暫時不提醒'} ] }
    ]
  },
  stage: {
    id: 'stage', label: '7 天重要場合準備', eyebrow: '重要時刻・7 天',
    title: '面對重要場合，先把能準備的事情準備好',
    tagline: '依你的場合、時程和困擾，安排每日演練。心率只作練習前的可選觀察，不代表表現或心理狀態。',
    price: 1490, days: 7,
    questions: [
      { id:'occasion', text:'你正準備哪一種場合？', options: [
        {value:'interview',label:'求職面試'}, {value:'presentation',label:'公開簡報'},
        {value:'pitch',label:'客戶提案'}, {value:'conversation',label:'重要的一對一對話'} ] },
      { id:'when', text:'距離重要場合還有多久？', options: [
        {value:'soon',label:'1–3 天'}, {value:'week',label:'4–7 天'},
        {value:'later',label:'8 天以上'} ] },
      { id:'challenge', text:'你最想改善什麼？', options: [
        {value:'structure',label:'內容不夠有條理'}, {value:'pace',label:'講太快／容易卡住'},
        {value:'questions',label:'不知道怎麼應對提問'}, {value:'start',label:'開頭不知道怎麼講'} ] },
      { id:'minutes', text:'每天能投入多少時間？', options: [
        {value:'5',label:'5 分鐘'}, {value:'10',label:'10 分鐘'}, {value:'15',label:'15 分鐘'} ] },
      { id:'format', text:'想要哪種練習形式？', options: [
        {value:'outline',label:'有結構的文字提綱'}, {value:'rehearsal',label:'自己開口演練'},
        {value:'both',label:'兩種都要'} ] }
    ]
  }
};
const label = (p, id, value) => p.questions.find(q=>q.id===id)?.options.find(o=>o.value===value)?.label || '';
function createPreview(p, a) {
  const minutes = Number(a.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('缺少每日練習時間');
  if (p.id === 'relax') {
    const context = {
      break:'工作休息時', evening:'下班後', beforebed:'睡前'
    }[a.goal];
    const focus = {
      forget:'每天在固定時段設定提示；不用補做錯過的練習',
      busy:'從短版開始；不追求一次做滿',
      distract:'先關閉通知，把注意力帶回眼前的引導',
      unsure:'照著預先安排好的步驟開始，不用自己挑選內容'
    }[a.barrier];
    const kinds = [
      '找到安靜的坐姿，觀察自然呼吸，不必改變節奏',
      '放鬆肩膀與手部，留意接觸椅子的感覺',
      '以舒服的速度做緩和呼吸，不憋氣、不強迫',
      '短暫移開螢幕，注意周圍三個聲音',
      '記下今天什麼時候最需要休息',
      '練習在任務之間留一段短暫空白',
      '回顧哪些練習比較容易持續'
    ];
    return {
      headline:`適合你的 ${p.days} 天・每天 ${minutes} 分鐘練習`,
      reason:`你想在${context}練習，所以計畫都排在固定時段，每天一個做得到的小步驟。`,
      notes:[focus, a.reminder==='none'?'你選擇不接收提醒':`你偏好的提醒時段：${label(p,'reminder',a.reminder)}`],
      tasks:Array.from({length:14},(_,i)=>(i===6||i===13
        ?{day:i+1,title:`第 ${i+1} 天・前後對比：練習前後各量一次心跳`,detail:`${minutes} 分鐘；看看${i===6?'一週':'兩週'}來身體的變化，不想量也可以略過。`}
        :{day:i+1,title:`第 ${i+1} 天・${kinds[i%kinds.length]}`,detail:`${minutes} 分鐘；做完記下一句感受就好。`}))
    };
  }
  const scenes={interview:'面試',presentation:'簡報',pitch:'客戶提案',conversation:'重要對話'};
  const focuses={
    structure:'先寫出一句核心訊息，再安排三個支持要點',
    pace:'分段說話，在每一個重點後自然停頓',
    questions:'先準備最可能被問的三個問題，練習直接回答',
    start:'先練一句清晰的開場和這場對話的目的'
  };
  const lessons=[
    '釐清目標：寫下一句你最想讓對方記住的話',
    '建立架構：以開頭、三個重點和結尾組成提綱',
    '大聲練習：用手機計時，完整說一遍',
    '問題演練：回答三個常見或可能出現的問題',
    '內容精簡：刪去不必要的資訊，保留關鍵例子',
    '情境模擬：照實際場合的時間限制練習',
    '最後檢查：確認開場、關鍵內容及結尾'
  ];
  const format={outline:'文字提綱',rehearsal:'口說演練',both:'文字提綱加口說演練'}[a.format];
  return {
    headline:`你的 ${p.days} 天${scenes[a.occasion]}準備方案`,
    reason:`你正在準備「${scenes[a.occasion]}」，希望改善「${label(p,'challenge',a.challenge)}」。練習會優先圍繞你能直接準備的表達內容。`,
    notes:[`每日 ${minutes} 分鐘・${format}`,focuses[a.challenge],a.when==='soon'?'重要場合只剩 1–3 天：請優先完成前面三個任務，無須急著全部補做。':'每天循序練習，不需追求一次就完美。'],
    tasks:lessons.map((title,i)=>({day:i+1,title:`第 ${i+1} 天・${title}`,detail:`建議 ${minutes} 分鐘，以${format}完成今天的任務。`}))
  };
}

// LINE Flex builders: no user identity, credentials or network calls.
const relaxColors = { canvas:'#F6F1EA', surface:'#FFFFFF', forest:'#2F7D5B', deep:'#1F5C42', ink:'#1E2A24', muted:'#52655B', sage:'#E4EDE7', line:'#E3DACB' };
const paragraph = (text, extra = {}) => ({ type:'text', text, wrap:true, size:'md', color:relaxColors.ink, ...extra });
// A line is either plain text or {note:'...'} for the small, muted fine print at the end of a card.
const relaxLine = x => typeof x === 'string' ? paragraph(x) : paragraph(x.note,{size:'xs',color:relaxColors.muted});
const action = (label, data, primary = false, uri = false) => ({ type:'button', style:primary?'primary':'link', height:'md', color:relaxColors.deep, action:uri?{type:'uri',label,uri:data}:{type:'postback',label,data,displayText:label} });
const card = (altText, title, lines, buttons) => ({
  type:'flex', altText,
  contents:{ type:'bubble', size:'mega',
    header:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'20px',spacing:'sm',contents:[paragraph('DEERLY・14 天放鬆練習',{size:'xs',color:relaxColors.deep,weight:'bold'}),paragraph(title,{size:'xl',weight:'bold'})]},
    body:{type:'box',layout:'vertical',backgroundColor:relaxColors.surface,paddingAll:'20px',spacing:'md',contents:lines.map(relaxLine)},
    footer:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'16px',spacing:'sm',contents:buttons}
  }
});
const relaxPrivacy = [
  '【資料怎麼使用】\n我們只記錄你的 5 題回答、同意時間，以及你是否對方案有興趣，用來排出你的練習計畫。這些資料不和 Deerly 其他服務共用，只有 Deerly 管理者看得到。',
  '心率量測可以略過，不影響計畫。前鏡頭影像只在你的手機上處理、不會上傳；量測頁會另外詢問是否保存數字。心率不是壓力、情緒或疾病的判斷。',
  '你的回答最多保存 30 天，隨時可以輸入「刪除我的資料」立即刪除（心率紀錄請在量測頁刪除）。目前不收費，也不會自動傳提醒；語音與動畫引導還在準備中。'
];
function relaxWelcome() {
  return card('14 天放鬆練習｜回答 5 題，約 1 分鐘，排出你的練習計畫。','每天幾分鐘，留給自己',[
    '回答 5 題（約 1 分鐘），幫你排出 14 天、每天 3–10 分鐘的放鬆練習。',
    '想的話，也可以用手機前鏡頭量一下心跳。',
    {note:'按下同意後，會保存你的回答最多 30 天，隨時可以刪除。'}
  ],[action('同意並開始','rlx|start|yes',true),action('資料怎麼使用','rlx|privacy'),action('先不要','rlx|start|no')]);
}
function relaxScanCard(data, uri) {
  return card('要量一下心跳嗎？約 30 秒，也可以略過。','要量一下心跳嗎？',[
    '用手機前鏡頭，大約 30 秒，不用穿戴裝置。',
    uri?'量完按「回聊天室」，就會看到你的計畫。':'不量也會拿到一樣的計畫。',
    {note:'影像只在手機上處理、不上傳；量測頁會另外詢問是否保存。這不是醫療檢測。'}
  ],[action(uri?'開始量測':'量一下',uri||data('rlx|scan|yes'),true,!!uri),action('略過，直接看計畫',data('rlx|scan|skip'))]);
}
// Before/after heart rate around one minute of slow breathing. Self-observation only, never feeds the plan.
function relaxHeartCard(before, after) {
  const b=Math.round(before), a=Number.isFinite(after)?Math.round(after):null, d=a===null?0:b-a;
  const big=(text,label,color)=>({type:'box',layout:'vertical',flex:1,contents:[
    {type:'text',text,size:'3xl',weight:'bold',color,align:'center',wrap:true},{type:'text',text:label,size:'xs',color:relaxColors.muted,align:'center',wrap:true}]});
  const numbers=a===null?[big(String(b),'次／分',relaxColors.deep)]:[
    big(String(b),'放鬆前',relaxColors.muted),
    {type:'text',text:'→',size:'xl',color:relaxColors.muted,align:'center',gravity:'center',flex:0,wrap:true},
    big(String(a),'放鬆後',relaxColors.deep)];
  const message=a===null?'這次只量了一次。下次可以試試「先量、慢呼吸 1 分鐘、再量」，看看自己的變化。'
    :d>=3?`慢了 ${d} 下。慢慢呼吸時，心跳跟著放緩是很常見的反應。`
    :d<=-3?`這次快了 ${-d} 下，可能剛好說話或換了姿勢。下次先靜坐一下再量看看。`
    :'變化不大，這很常見。多練幾天，身體會慢慢熟悉這個節奏。';
  return {type:'flex',altText:a===null?`你的心跳：每分鐘 ${b} 下`:`這一分鐘，你的心跳：${b} → ${a}`,
    contents:{type:'bubble',size:'mega',
      header:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'20px',spacing:'sm',contents:[
        paragraph('DEERLY・14 天放鬆練習',{size:'xs',color:relaxColors.deep,weight:'bold'}),paragraph(a===null?'你的心跳':'這一分鐘，你的心跳',{size:'xl',weight:'bold'})]},
      body:{type:'box',layout:'vertical',backgroundColor:relaxColors.surface,paddingAll:'20px',spacing:'lg',contents:[
        {type:'box',layout:'horizontal',backgroundColor:relaxColors.sage,cornerRadius:'12px',paddingAll:'16px',contents:numbers},
        paragraph(message),
        paragraph('計畫第 7 天和第 14 天會再做一次前後對比，看看兩週來的變化。'),
        relaxLine({note:'只是自我觀察，不是醫療檢測，也不影響你的計畫；單次差異也可能來自量測誤差。'})]}}};
}
function relaxResultCard(preview) {
  return card('你的 14 天放鬆計畫｜'+preview.headline,'你的 14 天放鬆計畫',[
    preview.headline,preview.reason,...preview.notes,
    {note:'練習中覺得不舒服就停下來，不需要憋氣或刻意改變呼吸。'}
  ],[action('資料怎麼使用','rlx|privacy')]);
}
function relaxInterestCard(preview, data) {
  return card('先試前兩天｜完整 14 天 NT$1,290，目前只開放登記。','先試前兩天',[
    ...preview.tasks.slice(0,2).map(t=>t.title+'\n'+t.detail),
    '完整 14 天計畫 NT$1,290',
    {note:'目前只開放登記，不會收費，也不會成立訂單。'}
  ],[action('我有興趣',data('rlx|interest'),true),action('再看一次計畫',data('rlx|resume')),action('刪除我的資料',data('rlx|delete'))]);
}

// Shared image geometry + per-question postbacks. No LINE calls here.
const relaxMenuVersion = 'relax-menu-20261025-v1';
const relaxMenuSize = {width:2500,height:1686};
const relaxMenuLabels = {
  goal:['工作空檔','下班後','睡前'],
  minutes:['3 分鐘','5 分鐘','10 分鐘'],
  barrier:['常常忘記','總是太忙','容易分心','不知怎麼開始'],
  format:['聽語音','看動畫','讀短文字'],
  reminder:['早上','午休前後','晚上','暫不提醒']
};
function relaxMenuLayout(question) {
  const columns=2,rows=2;
  const pad=110,gap=34,top=520,bottom=1280;
  const width=Math.floor((2500-pad*2-gap*(columns-1))/columns),height=Math.floor((bottom-top-gap*(rows-1))/rows);
  return question.options.map((o,i)=>({value:o.value,label:relaxMenuLabels[question.id][i],bounds:{x:pad+(i%columns)*(width+gap),y:top+Math.floor(i/columns)*(height+gap),width:question.options.length===3&&i===2?2280:width,height}}));
}
// One shared menu per question (created once on the test bot, then only linked per user).
// Taps carry the question number; the handler ignores taps that no longer match the current step.
const relaxMenuSet = 'relax-static-v4';
function relaxMenuDefinition(question,step) {
  const menu=data=>`${data}~menu`;
  const areas=relaxMenuLayout(question).map(o=>({bounds:o.bounds,action:{type:'postback',data:menu(`rlx|answer|${step}|${o.value}`),displayText:o.label}}));
  if(step>0)areas.push({bounds:{x:110,y:1340,width:1090,height:310},action:{type:'postback',data:menu(`rlx|back|${step}`),displayText:'上一題'}});
  areas.push({bounds:{x:1300,y:1340,width:1090,height:310},action:{type:'postback',data:menu(`rlx|pause|${step}`),displayText:'先暫停'}});
  return {size:relaxMenuSize,selected:true,name:`${relaxMenuSet}-${question.id}`,chatBarText:'放鬆練習・點這裡作答',areas};
}

// Test-only Rich Menu adapter. Official Deerly menus are never managed by this adapter.
// Pure image geometry is embedded separately from pilot/relax-rich-menu.js.
const RELAX_MENU_TEST_PROJECT = "https://rswcmlujwcwxvsffzise.supabase.co";
const RELAX_MENU_TEST_SITE = "https://glittery-longma-b8be7c.netlify.app";
const relaxMenuTestScope = () => Deno.env.get("RELAX_ISOLATED_TEST") === "1"
  && (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "") === RELAX_MENU_TEST_PROJECT
  && LIFF_URL === "https://liff.line.me/2012194363-LYirSkEL";
const relaxMenusEnabled = () => relaxMenuTestScope() && Deno.env.get("RELAX_PILOT_RICH_MENU_ENABLED") === "1";
const RELAX_MENU_BUILD = "relax-menu-static-v4";
function relaxMenuFailure(e: unknown): string {
  const message=e instanceof Error?e.message:"";
  if(/^MENU_[A-Z_0-9]+$/.test(message))return message;
  if(message.includes("identity mismatch"))return "MENU_WRONG_BOT";
  if(message.includes("verify test bot"))return "MENU_BOT_AUTH_FAILED";
  if(message.includes("image unavailable"))return "MENU_IMAGE_UNAVAILABLE";
  if(message.includes("Invalid menu PNG")||message.includes("dimensions"))return "MENU_IMAGE_INVALID";
  if(e && typeof e==="object" && "code" in e && typeof e.code==="string" && /^[A-Z0-9]+$/.test(e.code))return "MENU_DATABASE_"+e.code;
  return "MENU_OPERATION_FAILED";
}
async function relaxMenuDiagnose(sub: string, token: string) {
  if(!relaxAllowed(sub))return reply(token,[{type:"text",text:"選單診斷只開放受邀測試者。"}]);
  const lines=["選單診斷｜"+RELAX_MENU_BUILD,
    "測試環境核對："+(relaxMenuTestScope()?"通過":"未通過"),
    "Rich Menu 開關："+(Deno.env.get("RELAX_PILOT_RICH_MENU_ENABLED")==="1"?"已開啟":"未開啟，請設 RELAX_PILOT_RICH_MENU_ENABLED=1")];
  if(!relaxMenuTestScope())return reply(token,[{type:"text",text:lines.join("\n")}]);
  try{await relaxMenuIdentity();lines.push("測試官方帳號：通過");}catch(e){lines.push("測試官方帳號："+relaxMenuFailure(e));return reply(token,[{type:"text",text:lines.join("\n")}]);}
  const uid=await findUser(sub,false);
  if(uid){
    const row=await db.from("digital_relax_pilot_sessions").select("current_rich_menu_id,previous_rich_menu_id,rich_menu_captured").eq("user_id",uid).maybeSingle();
    lines.push("選單資料欄位："+(row.error?relaxMenuFailure(row.error):"通過"));
  }else lines.push("問卷紀錄：尚未同意開始");
  try{
    const list=await relaxMenuApi("/v2/bot/richmenu/list");
    const n=(list?.richmenus??[]).filter((m: {name?: string})=>m?.name?.startsWith(relaxMenuSet+"-")).length;
    lines.push("五題共用選單："+(n?`已建立 ${n}/5`:"尚未建立（第一次作答時自動建立）"));
  }catch(e){lines.push("五題共用選單："+relaxMenuFailure(e));}
  try{
    const res=await fetch(`${RELAX_MENU_TEST_SITE}/pilot/relax-menus/goal.png?v=${relaxMenuVersion}`,{redirect:"error"});
    const bytes=new Uint8Array(await res.arrayBuffer());
    lines.push("第一題圖片：HTTP "+res.status+(bytes.length>=24&&bytes.slice(0,8).join(",")==="137,80,78,71,13,10,26,10"?"，PNG 正確":"，不是有效 PNG"));
  }catch{lines.push("第一題圖片：連線或重新導向失敗");}
  return reply(token,[{type:"text",text:lines.join("\n")}]);
}
let relaxMenuBotCheck: Promise<void> | null = null;
async function relaxMenuIdentity() {
  if (!relaxMenuTestScope()) throw new Error("Rich Menu is restricted to the isolated test project");
  const expected = "@607idvzb"; // user-confirmed test official account, never overridable by a secret
  if (!/^@[A-Za-z0-9._-]+$/.test(expected)) throw new Error("Missing test bot basic ID");
  if (!relaxMenuBotCheck) relaxMenuBotCheck = (async () => {
    const res = await fetch("https://api.line.me/v2/bot/info", {headers:{authorization:`Bearer ${TOKEN}`}});
    if (!res.ok) throw new Error("MENU_BOT_HTTP_"+res.status);
    const bot = await res.json();
    if (bot.basicId !== expected) throw new Error("Test bot identity mismatch; menu changes refused");
  })().catch(e => { relaxMenuBotCheck = null; throw e; });
  await relaxMenuBotCheck;
}
async function relaxMenuApi(path: string, method="GET", body?: unknown, image=false) {
  await relaxMenuIdentity();
  const host = image ? "api-data.line.me" : "api.line.me";
  const res = await fetch(`https://${host}${path}`, {method,
    headers:{authorization:`Bearer ${TOKEN}`,...(body!==undefined?{"content-type":image?"image/png":"application/json"}:{})},
    body: body===undefined?undefined:image?body as Uint8Array:JSON.stringify(body)});
  if (res.status===404 && method==="GET") return null;
  if (!res.ok) {
    const stage=image?"UPLOAD":path==="/v2/bot/richmenu"?"CREATE":path==="/v2/bot/richmenu/list"?"LIST":path.includes("/user/")?(method==="GET"?"LOOKUP":"LINK"):"CLEANUP";
    throw new Error(`MENU_${stage}_HTTP_${res.status}`);
  }
  const text=await res.text();return text?JSON.parse(text):{};
}
async function relaxMenuState(s: RelaxSession): Promise<RelaxSession | null> {
  const r=await db.from("digital_relax_pilot_sessions").select("*").eq("user_id",s.user_id).eq("flow_id",s.flow_id).maybeSingle();
  if(r.error)throw r.error;return r.data;
}
// Menus made per user by the v1–v3 builds; the shared v4 menus are never deleted here.
async function relaxDeleteOwnedMenu(id: string | null | undefined, flow: string) {
  if(!id)return;
  const menu=await relaxMenuApi(`/v2/bot/richmenu/${id}`);
  if(menu?.name?.startsWith(`${relaxMenuVersion}-${flow}-`)) await relaxMenuApi(`/v2/bot/richmenu/${id}`,"DELETE");
}
async function relaxMenusRestore(sub: string, snapshot: RelaxSession) {
  if(!snapshot.current_rich_menu_id && !snapshot.rich_menu_captured)return;
  const s=await relaxMenuState(snapshot);if(!s||(!s.current_rich_menu_id&&!s.rich_menu_captured))return;
  await relaxMenuIdentity();
  const assigned=await relaxMenuApi(`/v2/bot/user/${sub}/richmenu`);
  // If another flow has assigned a menu, do not overwrite it.
  if(assigned?.richMenuId===s.current_rich_menu_id){
    if(s.previous_rich_menu_id)await relaxMenuApi(`/v2/bot/user/${sub}/richmenu/${s.previous_rich_menu_id}`,"POST");
    else await relaxMenuApi(`/v2/bot/user/${sub}/richmenu`,"DELETE"); // reveals account default; never changes default
  }
  const clear=await db.from("digital_relax_pilot_sessions").update({current_rich_menu_id:null,previous_rich_menu_id:null,rich_menu_captured:false})
    .eq("user_id",s.user_id).eq("flow_id",s.flow_id).eq("revision",s.revision).eq("current_rich_menu_id",s.current_rich_menu_id).select("*").maybeSingle();
  if(clear.error)throw clear.error;
  if(clear.data)await relaxDeleteOwnedMenu(s.current_rich_menu_id,s.flow_id);
}
// The five shared menus are found by name on the test bot, created once if missing, then cached per instance.
let relaxStaticMenus: Promise<Record<string,string>> | null = null;
function relaxMenuIds(): Promise<Record<string,string>> {
  if(!relaxStaticMenus)relaxStaticMenus=(async()=>{
    const list=await relaxMenuApi("/v2/bot/richmenu/list");
    const ids: Record<string,string>={};
    for(const m of list?.richmenus??[])if(typeof m?.name==="string"&&m.name.startsWith(relaxMenuSet+"-"))ids[m.name.slice(relaxMenuSet.length+1)]=m.richMenuId;
    for(const [step,question] of catalog.relax.questions.entries()){
      if(ids[question.id])continue;
      const asset=await fetch(`${RELAX_MENU_TEST_SITE}/pilot/relax-menus/${question.id}.png?v=${relaxMenuVersion}`,{redirect:"error"});
      if(!asset.ok)throw new Error("MENU_IMAGE_HTTP_"+asset.status);
      const bytes=new Uint8Array(await asset.arrayBuffer());
      if(bytes.length>1_000_000||bytes.length<24||bytes.slice(0,8).join(",")!=="137,80,78,71,13,10,26,10")throw new Error("Invalid menu PNG");
      const view=new DataView(bytes.buffer);if(view.getUint32(16)!==2500||view.getUint32(20)!==1686)throw new Error("Wrong menu image dimensions");
      const created=await relaxMenuApi("/v2/bot/richmenu","POST",relaxMenuDefinition(question,step));
      const id=created?.richMenuId;if(typeof id!=="string")throw new Error("Missing test menu ID");
      try{await relaxMenuApi(`/v2/bot/richmenu/${id}/content`,"POST",bytes,true);}
      catch(e){await relaxMenuApi(`/v2/bot/richmenu/${id}`,"DELETE").catch(()=>console.error("Test menu cleanup needs retry"));throw e;}
      ids[question.id]=id;
    }
    return ids;
  })().catch(e=>{relaxStaticMenus=null;throw e;});
  return relaxStaticMenus;
}
async function relaxMenusShow(sub: string, snapshot: RelaxSession): Promise<boolean> {
  if(!relaxMenusEnabled()){
    if(snapshot.current_rich_menu_id)await relaxMenusRestore(sub,snapshot);
    return false;
  }
  await relaxMenuIdentity();
  const s=await relaxMenuState(snapshot);if(!s||s.revision!==snapshot.revision||s.paused||s.status!=="quiz")return false;
  const ids=await relaxMenuIds(), id=ids[catalog.relax.questions[s.step].id];
  let previous=s.previous_rich_menu_id??null;
  if(!s.rich_menu_captured){
    // Remember the tester's own menu once so pause/finish can put it back.
    const assigned=(await relaxMenuApi(`/v2/bot/user/${sub}/richmenu`))?.richMenuId??null;
    previous=Object.values(ids).includes(assigned)?null:assigned;
  }
  let query=db.from("digital_relax_pilot_sessions").update({current_rich_menu_id:id,previous_rich_menu_id:previous,rich_menu_captured:true})
    .eq("user_id",s.user_id).eq("flow_id",s.flow_id).eq("revision",s.revision);
  query=s.current_rich_menu_id?query.eq("current_rich_menu_id",s.current_rich_menu_id):query.is("current_rich_menu_id",null);
  const save=await query.select("*").maybeSingle();if(save.error)throw save.error;if(!save.data)return false;
  await relaxMenuApi(`/v2/bot/user/${sub}/richmenu/${id}`,"POST");
  if(s.current_rich_menu_id&&!Object.values(ids).includes(s.current_rich_menu_id)){
    try{await relaxDeleteOwnedMenu(s.current_rich_menu_id,s.flow_id);}catch{console.error("Test menu cleanup needs retry");}
  }
  return true;
}
async function relaxMenusTryRestore(sub: string, s: RelaxSession) {
  try{await relaxMenusRestore(sub,s);}catch{console.error("Test menu restore failed; retry with menu-stop command");}
}

const RELAX_PILOT_ENABLED = Deno.env.get("RELAX_PILOT_ENABLED") === "1";
const RELAX_PILOT_LINE_SUBS = (Deno.env.get("RELAX_PILOT_LINE_SUBS") ?? "").split(",").map(s => s.trim()).filter(Boolean);
const relaxAllowed = (sub: string) => RELAX_PILOT_ENABLED && (ADMINS.includes(sub) || RELAX_PILOT_LINE_SUBS.includes(sub));
const RELAX_CONSENT_VERSION = "relax-pilot-2026-10";
type RelaxSession = {
  user_id: string; answers: Record<string, string>; step: number;
  status: "quiz" | "scan" | "preview"; scan_opt_in: boolean;
  scan_started_at?: string | null; flow_id: string; revision: number;
  current_rich_menu_id?: string | null; previous_rich_menu_id?: string | null; rich_menu_captured?: boolean;
  paused: boolean; interest_clicked_at?: string | null; created_at: string;
};
const relaxData = (s: RelaxSession) => (data: string) => `${data}~${s.flow_id}~${s.revision}`;
const relaxScanUrl = (s: RelaxSession) => `${LIFF_URL}/?relaxPilot=${encodeURIComponent(s.flow_id)}`;
async function relaxSession(uid: string): Promise<RelaxSession | null> {
  const q = await db.from("digital_relax_pilot_sessions").select("*").eq("user_id", uid).maybeSingle();
  if (q.error) throw q.error;
  if (q.data && Date.now() - Date.parse(q.data.created_at) >= 30 * 864e5) {
    const u=await db.from("users").select("line_sub").eq("id",uid).maybeSingle();
    if(u.error)throw u.error;
    if(u.data?.line_sub)await relaxMenusRestore(u.data.line_sub,q.data);
    const expired = await db.from("digital_relax_pilot_sessions").delete().eq("user_id", uid).eq("flow_id", q.data.flow_id);
    if (expired.error) throw expired.error;
    return null;
  }
  return q.data as RelaxSession | null;
}
// Optimistic concurrency: stale/replayed buttons cannot advance a new step or reset a new run.
async function relaxUpdate(s: RelaxSession, changes: Record<string, unknown>): Promise<RelaxSession> {
  const q = await db.from("digital_relax_pilot_sessions")
    .update({ ...changes, revision: s.revision + 1, updated_at: new Date().toISOString() })
    .eq("user_id", s.user_id).eq("flow_id", s.flow_id).eq("revision", s.revision).select("*").maybeSingle();
  if (q.error) throw q.error;
  if (!q.data) throw new Error("RELAX_STALE_ACTION");
  return q.data as RelaxSession;
}
async function relaxStart(sub: string, token: string) {
  if (!relaxAllowed(sub)) return reply(token, [{ type: "text", text: "這個放鬆服務目前只開放受邀測試；原本的 Deerly 服務不受影響。" }]);
  const uid = await findUser(sub, false);
  const existing = uid ? await relaxSession(uid) : null;
  if (existing) {
    const data = relaxData(existing);
    return reply(token, [{ type:"text", text:"你上次的放鬆練習還沒做完。要接著做，還是重新開始？",
      quickReply:quick([{label:"接著做",data:data("rlx|resume")},{label:"重新開始",data:data("rlx|restart")},{label:"刪除我的資料",data:data("rlx|delete")}]) }]);
  }
  return reply(token, [relaxWelcome()]);
}
async function relaxAsk(sub: string, token: string, s: RelaxSession) {
  const data = relaxData(s);
  if (s.paused) { await relaxMenusTryRestore(sub,s); return reply(token,[{type:"text",text:"先暫停囉，進度幫你留著。想繼續時傳任何訊息就可以。",quickReply:quick([{label:"繼續",data:data("rlx|resume")},{label:"刪除我的資料",data:data("rlx|delete")}])}]); }
  if (s.status === "preview") return relaxPreview(sub,token, s);
  if (s.status === "scan") return relaxOfferScan(sub,token, s);
  const q = catalog.relax.questions[s.step];
  if (!q) throw new Error("RELAX_INVALID_STEP");
  const items = q.options.map((o: {value:string;label:string})=>({label:o.label,data:data("rlx|answer|"+s.step+"|"+o.value)}));
  if (s.step > 0) items.push({label:"上一題",data:data("rlx|back")});
  items.push({label:"先暫停",data:data("rlx|pause")});
  let rich=false;
  let menuStatus=relaxMenuTestScope()?(Deno.env.get("RELAX_PILOT_RICH_MENU_ENABLED")==="1"?"MENU_STATE_CHANGED":"MENU_SWITCH_OFF"):"MENU_TEST_SCOPE_MISMATCH";
  try{rich=await relaxMenusShow(sub,s);}catch(e){menuStatus=relaxMenuFailure(e);console.error("Test menu fallback",menuStatus);}
  const prompt=`放鬆練習 ${s.step+1}/5\n${q.text}`;
  if(rich)return reply(token,[{type:"text",text:prompt+(s.step===0?"\n請點下方選單作答。":"")}]);
  return reply(token,[{type:"text",text:prompt+`\n請用訊息下方按鈕作答。大字選單狀態：${menuStatus}；可輸入「選單診斷」查詢。`,quickReply:quick(items)}]);
}
async function relaxOfferScan(sub: string, token: string, s: RelaxSession) {
  await relaxMenusTryRestore(sub,s);
  const message = relaxScanCard(relaxData(s), s.scan_opt_in ? relaxScanUrl(s) : undefined);
  message.quickReply = quick([{label:"我量好了",data:relaxData(s)("rlx|done")},{label:"先暫停",data:relaxData(s)("rlx|pause")}]);
  return reply(token,[message]);
}
async function relaxPreview(sub: string, token: string, s: RelaxSession, heart?: {before:number;after?:number}) {
  await relaxMenusTryRestore(sub,s);
  const preview = createPreview(catalog.relax,s.answers);
  return reply(token,[...(heart?[relaxHeartCard(heart.before,heart.after)]:[]),relaxResultCard(preview),relaxInterestCard(preview,relaxData(s))]);
}
async function relaxScanDone(sub: string, token: string, s: RelaxSession) {
  if (s.status !== "scan" || s.paused || !s.scan_opt_in || !s.scan_started_at) return relaxAsk(sub,token,s);
  // The scan page saves one reading before and one after a minute of slow breathing.
  const scans = await db.from("scans").select("bpm,quality,scanned_at").eq("user_id",s.user_id)
    .gte("scanned_at",s.scan_started_at).order("scanned_at",{ascending:true}).limit(10);
  if (scans.error) throw scans.error;
  const now = Date.now(), started = Date.parse(s.scan_started_at);
  const valid = (scans.data ?? []).filter((x: {bpm:number;quality:number;scanned_at:string}) => {
    const time = Date.parse(x.scanned_at ?? "");
    return Number.isFinite(time) && Number.isFinite(started) && time >= started && time <= now && now-time <= 15*60e3 &&
      Number.isFinite(x.quality) && x.quality >= 0.35 && Number.isFinite(x.bpm) && x.bpm >= 30 && x.bpm <= 220;
  });
  if (!valid.length) {
    return reply(token,[{type:"text",text:"這次沒有量到清楚的心跳。沒關係，可以再量一次，或直接看計畫。",
      quickReply:quick([{label:"再量一次",uri:relaxScanUrl(s)},{label:"直接看計畫",data:relaxData(s)("rlx|scan|skip")}])}]);
  }
  const next = await relaxUpdate(s,{status:"preview"});
  return relaxPreview(sub,token,next,{before:valid[0].bpm,after:valid.length>1?valid[valid.length-1].bpm:undefined});
}
async function relaxPostback(sub: string, token: string, raw: string) {
  if (!relaxAllowed(sub)) return reply(token,[{type:"text",text:"放鬆測試目前未開放。"}]);
  const [data,flow,revision] = raw.split("~");
  const [prefix,kind,detail,value] = data.split("|");
  if (prefix !== "rlx") return;
  if (kind === "privacy") return reply(token,relaxPrivacy.map(text=>({type:"text",text})));
  if (kind === "start" && detail === "no") return reply(token,[{type:"text",text:"好的，沒有保存任何資料。想試的時候，傳任何訊息給我就可以。"}]);
  if (kind === "start" && detail === "yes") {
    const uid = await findUser(sub,true);
    if (!uid) throw new Error("RELAX_USER_MISSING");
    const existing = await relaxSession(uid);
    if (existing) return relaxAsk(sub,token,existing); // repeated consent never resets progress
    const up = await db.from("digital_relax_pilot_sessions").upsert({
      user_id:uid,consent_version:RELAX_CONSENT_VERSION,created_at:new Date().toISOString(),
      flow_id:crypto.randomUUID(),revision:0,paused:false,answers:{},step:0,status:"quiz",scan_opt_in:false,
      scan_started_at:null,interest_clicked_at:null,updated_at:new Date().toISOString()
    },{onConflict:"user_id",ignoreDuplicates:true});
    if (up.error) throw up.error;
    const s = await relaxSession(uid);
    if (!s) throw new Error("RELAX_SESSION_MISSING");
    return relaxAsk(sub,token,s);
  }
  const uid = await findUser(sub,false), s = uid ? await relaxSession(uid) : null;
  if (!s) return relaxStart(sub,token);
  // Shared menu taps carry the question number instead of flow/revision; only the current question counts.
  const current = flow === "menu"
    ? s.status === "quiz" && ["answer","back","pause"].includes(kind) && detail === String(s.step)
    : flow === s.flow_id && revision === String(s.revision);
  if (!current) return relaxAsk(sub,token,s);
  if (kind === "delete") return relaxDelete(sub,token,s);
  if (kind === "restart") {
    // Explicit, scoped reset, followed by a fresh consent screen; duplicate old buttons cannot reset again.
    await relaxDelete(sub,token,s,false);
    return reply(token,[relaxWelcome()]);
  }
  if (kind === "resume") return relaxAsk(sub,token,s.paused?await relaxUpdate(s,{paused:false}):s);
  if (kind === "pause") return relaxAsk(sub,token,await relaxUpdate(s,{paused:true}));
  if (s.paused) return relaxAsk(sub,token,s);
  if (kind === "back" && s.status === "quiz" && s.step>0) {
    const step=s.step-1;
    const answers=Object.fromEntries(catalog.relax.questions.slice(0,step).map(q=>[q.id,s.answers[q.id]]));
    return relaxAsk(sub,token,await relaxUpdate(s,{step,answers}));
  }
  if (kind === "answer" && s.status === "quiz") {
    const q=catalog.relax.questions[s.step];
    if (detail !== String(s.step) || !q || !q.options.some(o=>o.value===value)) return relaxAsk(sub,token,s);
    const step=s.step+1;
    return relaxAsk(sub,token,await relaxUpdate(s,{answers:{...s.answers,[q.id]:value},step,status:step===5?"scan":"quiz"}));
  }
  if (kind === "scan" && s.status === "scan") {
    if (detail === "skip") return relaxPreview(sub,token,await relaxUpdate(s,{status:"preview",scan_opt_in:false,scan_started_at:null}));
    if (detail === "yes") return relaxOfferScan(sub,token,s.scan_opt_in?s:await relaxUpdate(s,{scan_opt_in:true,scan_started_at:new Date().toISOString()}));
  }
  if (kind === "done") return relaxScanDone(sub,token,s);
  if (kind === "interest" && s.status === "preview") {
    if (!s.interest_clicked_at) await relaxUpdate(s,{interest_clicked_at:new Date().toISOString()});
    return reply(token,[{type:"text",text:"謝謝，已幫你登記！目前不會收費，也沒有成立訂單。"}]);
  }
  return relaxAsk(sub,token,s);
}
async function relaxDelete(sub: string, token: string, session?: RelaxSession, respond = true) {
  if (!relaxAllowed(sub)) return reply(token,[{type:"text",text:"放鬆測試目前未開放。"}]);
  const uid = session?.user_id ?? await findUser(sub,false);
  if (uid) {
    const existing=session??await relaxSession(uid);
    if(existing)await relaxMenusRestore(sub,existing);
    let query = db.from("digital_relax_pilot_sessions").delete().eq("user_id",uid);
    if (session) query=query.eq("flow_id",session.flow_id).eq("revision",session.revision);
    const r=await query.select("user_id");
    if (r.error) throw r.error;
    if (session && !r.data?.length) throw new Error("RELAX_STALE_ACTION");
  }
  if (respond) return reply(token,[{type:"text",text:"已刪除你的放鬆練習回答與紀錄。心率紀錄請到量測頁刪除。"}]);
}
// In-instance ordering + DB revision comparisons protect rapid clicks across instances.
const relaxQueues = new Map<string, Promise<unknown>>();
async function relaxGuard(sub: string, token: string, work: () => Promise<unknown>) {
  const previous=relaxQueues.get(sub) ?? Promise.resolve();
  const current=previous.catch(()=>{}).then(work).catch(async e=>{
    // Do not log answer values, LINE IDs or raw DB errors.
    console.error("Relax pilot operation failed");
    const text=e instanceof Error && e.message==="RELAX_STALE_ACTION"
      ?"進度剛剛更新過，傳任何訊息就能接著做。"
      :"剛才沒有完成，傳任何訊息就能接著做；也可以輸入「刪除我的資料」。";
    return reply(token,[{type:"text",text}]);
  });
  relaxQueues.set(sub,current);
  try { return await current; } finally { if (relaxQueues.get(sub)===current) relaxQueues.delete(sub); }
}

// ---------- 管理：建立選單 ----------
async function setupMenus() {
  throw new Error("Rich menu setup disabled in isolated test artifacts");
  const areasRes = await fetch(`${ASSET_BASE}areas.json`);
  if (!areasRes.ok) throw new Error(`areas.json ${areasRes.status}`);
  const { version, areas } = await areasRes.json();
  if (version !== DATA.questions.version) throw new Error(`選單圖版本 ${version} 與題目版本 ${DATA.questions.version} 不一致，請先更新選單圖`);
  const old = await db.from("rich_menus").select("question_id,rich_menu_id");
  if (old.error) throw old.error;
  const done: string[] = [];
  for (const q of QS) {
    const a = areas[q.id];
    if (!a) throw new Error(`缺少 ${q.id} 的選單圖`);
    const created = await line("/v2/bot/richmenu", "POST", {
      size: { width: 2500, height: 1686 }, selected: true, name: `q-${q.id}`, chatBarText: "點這裡作答",
      areas: a.map((x: { x: number; y: number; w: number; h: number; value: string }) => ({
        bounds: { x: x.x, y: x.y, width: x.w, height: x.h },
        action: x.value === "__done"
          ? { type: "postback", data: `d|${q.id}`, displayText: "完成 ✔" }
          : { type: "postback", data: `${q.type === "multi" ? "m" : "a"}|${q.id}|${x.value}`, displayText: (q.options.find((o) => o.value === x.value)?.chip ?? q.options.find((o) => o.value === x.value)?.label ?? "").slice(0, 300) },
      })),
    });
    const img = await fetch(`${ASSET_BASE}${q.id}.png`);
    if (!img.ok) throw new Error(`${q.id}.png ${img.status}`);
    const up = await fetch("https://api-data.line.me/v2/bot/richmenu/" + created.richMenuId + "/content", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" }, body: new Uint8Array(await img.arrayBuffer()),
    });
    if (!up.ok) throw new Error(`上傳 ${q.id} 失敗 ${up.status}`);
    const prev = (old.data ?? []).find((x: { question_id: string }) => x.question_id === q.id);
    const u = await db.from("rich_menus").upsert({ question_id: q.id, rich_menu_id: created.richMenuId, questions_version: DATA.questions.version });
    if (u.error) throw u.error;
    if (prev) await line(`/v2/bot/richmenu/${prev.rich_menu_id}`, "DELETE").catch(() => {});
    done.push(q.id);
  }
  done.push(await setupHome(areas.home));
  return done;
}

// 主選單（預設選單）：今日電量、每日問卷、我的 Deerly（開 LIFF 頁）。沒有在作答的人都看這個
async function setupHome(a: { key: string; x: number; y: number; w: number; h: number }[]) {
  if (!a) throw new Error("缺少主選單的圖");
  const act = (k: string) => k === "scan"
    ? { type: "uri", uri: LIFF_URL }
    : k === "me"
    ? { type: "uri", uri: `${LIFF_URL}/me/` }
    : { type: "postback", data: `home|${k}`, displayText: "開始問卷" };
  const created = await line("/v2/bot/richmenu", "POST", {
    size: { width: 2500, height: 1120 }, selected: false, name: "home", chatBarText: "主選單",
    areas: a.map((x) => ({ bounds: { x: x.x, y: x.y, width: x.w, height: x.h }, action: act(x.key) })),
  });
  const img = await fetch(`${ASSET_BASE}home.png`);
  if (!img.ok) throw new Error(`home.png ${img.status}`);
  const up = await fetch("https://api-data.line.me/v2/bot/richmenu/" + created.richMenuId + "/content", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" }, body: new Uint8Array(await img.arrayBuffer()),
  });
  if (!up.ok) throw new Error(`上傳 home 失敗 ${up.status}`);
  await line(`/v2/bot/user/all/richmenu/${created.richMenuId}`);
  const prev = await db.from("rich_menus").select("rich_menu_id").eq("question_id", "_home").maybeSingle();
  const u = await db.from("rich_menus").upsert({ question_id: "_home", rich_menu_id: created.richMenuId, questions_version: DATA.questions.version });
  if (u.error) throw u.error;
  if (prev.data) await line(`/v2/bot/richmenu/${prev.data.rich_menu_id}`, "DELETE").catch(() => {});
  return "home";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "GET") return json({ ok: true, build: RELAX_MENU_BUILD, richMenuTestScope: relaxMenuTestScope(), richMenuSwitchOn: Deno.env.get("RELAX_PILOT_RICH_MENU_ENABLED") === "1" });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const raw = await req.text();

  // 管理動作：審核者帶 LINE ID token
  const sig = req.headers.get("x-line-signature");
  if (!sig) {
    let b: Record<string, unknown>;
    try { b = JSON.parse(raw); } catch { return json({ error: "json" }, 400); }
    const sub = typeof b.idToken === "string" ? await verifyIdToken(b.idToken) : null;
    if (!sub || !ADMINS.includes(sub)) return json({ error: "forbidden" }, 403);
    try {
      if (b.action === "setup") return json({ ok: true, menus: await setupMenus() });
      return json({ error: "action" }, 400);
    } catch (e) {
      console.error(e);
      return json({ error: "server", detail: (e instanceof Error ? e.message : JSON.stringify(e)).slice(0, 300) }, 500);
    }
  }

  // LINE 伺服器的事件
  if (!(await verifySignature(raw, sig))) return json({ error: "signature" }, 401);
  let body: { events?: unknown[] };
  try { body = JSON.parse(raw); } catch { return json({ error: "json" }, 400); }
  for (const ev of body.events ?? []) {
    try { await onEvent(ev as never); } catch (e) { console.error(e); }
  }
  return json({ ok: true });
});
