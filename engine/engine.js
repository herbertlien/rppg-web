// Deerly 規則引擎：問卷答案 → 待審配方。純函式、不碰 AI、不碰網路。
// 同一份檔案給瀏覽器（預覽）和後端 Edge Function（正式計算）共用。
// 資料（品項、上限、題目、措辭）由呼叫端載入後傳進來，換資料不必改程式。

export const ENGINE_VERSION = 'engine-0.1.0';

// 檢查資料檔彼此一致。回傳錯誤字串陣列，空陣列代表沒問題。
export function validateData({ items, limits, questions, claims }) {
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
  return errs;
}

// 檢查答案格式，並整理出拒收原因、個人旗標、需求分數、方案。
export function readAnswers(answers, questions) {
  const errors = [];
  const rejects = [];
  const flags = new Set();
  const needs = {};          // tag → 分數
  const evidence = {};       // tag → [{ text, pts }]，給理由用
  let tier = null;

  for (const q of questions.questions) {
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
      (o.flags || []).forEach(f => flags.add(f));
      for (const [t, p] of Object.entries(o.needs || {})) {
        needs[t] = (needs[t] || 0) + p;
        const text = (q.reason || '你選了「{label}」').replace('{label}', o.label);
        (evidence[t] ||= []).push({ text, pts: p });
      }
      if (o.tier) tier = o.tier;
    }
  }
  return { errors, rejects, flags, needs, evidence, tier };
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
export function buildPack(answers, data) {
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
    if (hit) { skipped.push({ id: it.id, name: it.name, why: `個人禁用條件：${hit}` }); return; }
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

  const warnings = [];
  if (chosen.length < a.tier) warnings.push(`符合條件的品項只有 ${chosen.length} 項，少於方案的 ${a.tier} 項，需人工補選`);
  if (a.flags.has('surgery_soon')) warnings.push('客人一個月內有手術或拔牙安排，請人工確認');

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
export function checkPack(itemIds, data) {
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
export function findBannedTerms(text, claims) {
  const t = String(text).replace(/\s+/g, '');
  return claims.bannedTerms.filter(w => t.includes(w));
}
