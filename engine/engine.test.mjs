// 執行：node --test engine/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPack, checkPack, validateData, findBannedTerms } from './engine.js';

const load = f => JSON.parse(readFileSync(new URL(`./data/${f}.json`, import.meta.url), 'utf8'));
const data = { items: load('items'), limits: load('limits'), questions: load('questions'), claims: load('claims') };

// 一位典型的科技業上班族
const base = {
  age: '30_34', sex: 'female', pregnancy: 'no', medication: 'no', conditions: ['none'], allergy: ['none'],
  diet: 'omni', supplements: ['none'], focus: ['sleep', 'stress'], sleep_hours: 'lt6', sleep_quality: 'poor',
  stress: 'high', caffeine: '3plus', alcohol: 'rare', meals_out: 'most', veg: '0_1', bowel: 'regular',
  exercise: '0', tier: 'basic',
};

test('資料檔彼此一致', () => {
  assert.deepEqual(validateData(data), []);
});

test('基礎版給 3 項、進階版給 5 項，狀態一律待審', () => {
  const b = buildPack(base, data);
  assert.equal(b.status, 'needs_review');
  assert.equal(b.items.length, 3);
  const a = buildPack({ ...base, tier: 'advanced' }, data);
  assert.equal(a.items.length, 5);
});

test('同樣的答案永遠得到同樣的配方', () => {
  assert.deepEqual(buildPack(base, data), buildPack({ ...base }, data));
});

test('睡眠加壓力為主的人，會拿到鎂和紅景天', () => {
  const ids = buildPack(base, data).items.map(i => i.id);
  assert.ok(ids.includes('magnesium'));
  assert.ok(ids.includes('rhodiola'));
});

test('每項都有理由，且理由只引用客人自己的回答', () => {
  for (const it of buildPack({ ...base, tier: 'advanced' }, data).items) assert.match(it.reason, /^因為你/);
});

test('理由句不含禁用詞', () => {
  for (const it of buildPack({ ...base, tier: 'advanced' }, data).items) assert.deepEqual(findBannedTerms(it.reason, data.claims), []);
});

for (const [q, v, why] of [
  ['age', 'under18', 'under18'],
  ['pregnancy', 'yes', 'pregnancy'],
  ['conditions', ['kidney'], 'kidney'],
  ['conditions', ['liver'], 'liver'],
  ['conditions', ['treatment'], 'treatment'],
  ['medication', 'regular', 'medication'],
]) {
  test(`拒收：${why}`, () => {
    const r = buildPack({ ...base, [q]: v }, data);
    assert.equal(r.status, 'rejected');
    assert.ok(r.rejects.includes(why));
    assert.equal(r.items, undefined);
  });
}

test('安全題沒答就不產生配方', () => {
  const { medication, ...rest } = base;
  const r = buildPack(rest, data);
  assert.equal(r.status, 'invalid');
});

test('「都沒有」不能和其他選項一起選', () => {
  assert.equal(buildPack({ ...base, conditions: ['none', 'kidney'] }, data).status, 'invalid');
});

test('不存在的選項會被擋下', () => {
  assert.equal(buildPack({ ...base, tier: 'premium' }, data).status, 'invalid');
});

test('對芝麻過敏就不會拿到芝麻素', () => {
  const r = buildPack({ ...base, allergy: ['sesame'], alcohol: '3plus', tier: 'advanced' }, data);
  assert.ok(!r.items.some(i => i.id === 'sesamin'));
  assert.ok(r.skipped.some(s => s.id === 'sesamin'));
});

test('含暫定品項或藥師尚未核定時不可出貨', () => {
  const r = buildPack(base, data);
  assert.equal(r.shippable, false);
  assert.ok(r.blockers.length >= 1);
});

test('全部確認且藥師核定後才可出貨', () => {
  const items = structuredClone(data.items);
  items.pharmacistApproved = true;
  items.items.forEach(i => { i.status = 'confirmed'; });
  assert.equal(buildPack(base, { ...data, items }).shippable, true);
});

test('B 群類最多一項', () => {
  const r = checkPack(['b_complex_e', 'b_complex'], data);
  assert.equal(r.ok, false);
});

test('以成分加總檢查上限：三種 B 群類疊加 B6 = 110 mg，超過 80 mg', () => {
  const r = checkPack(['b_complex', 'b_complex_e', 'vitamin_b6'], data);
  assert.equal(r.totals.vitamin_b6, 110);
  assert.ok(r.errors.some(e => e.includes('B6') && e.includes('超過')));
});

test('引擎挑選時，加入後會超過上限的品項會被跳過', () => {
  const items = structuredClone(data.items);
  items.items.find(i => i.id === 'magnesium').perCapsule.magnesium = 400;
  const r = buildPack(base, { ...data, items });
  assert.ok(!r.items.some(i => i.id === 'magnesium'));
  assert.ok(r.skipped.some(s => s.id === 'magnesium' && s.why.includes('上限')));
});

test('停用品項（減重、出血風險類）永遠不會被選', () => {
  const off = data.items.items.filter(i => !i.enabled).map(i => i.id);
  const r = buildPack({ ...base, tier: 'advanced', focus: ['energy', 'seasonal'] }, data);
  assert.ok(!r.items.some(i => off.includes(i.id)));
});

test('禁用詞過濾', () => {
  assert.deepEqual(findBannedTerms('這個可以改善失眠喔', data.claims), ['改善失眠']);
  assert.deepEqual(findBannedTerms('依你的作息，我們幫你整理了這包', data.claims), []);
  assert.ok(findBannedTerms('增 強 免 疫 力', data.claims).length > 0);
});

test('男性不問懷孕題，沒答也不算缺題', () => {
  const { pregnancy, ...rest } = base;
  assert.equal(buildPack({ ...rest, sex: 'male' }, data).status, 'needs_review');
  assert.equal(buildPack(rest, data).status, 'invalid');   // 女性沒答懷孕題 → 缺題
});

test('男性就算送了懷孕題的答案也不計入', () => {
  assert.equal(buildPack({ ...base, sex: 'male', pregnancy: 'yes' }, data).status, 'needs_review');
});

test('偶爾吃成藥不拒收，但提醒審核者', () => {
  const r = buildPack({ ...base, medication: 'occasional' }, data);
  assert.equal(r.status, 'needs_review');
  assert.ok(r.warnings.some(w => w.includes('成藥')));
});

test('吃素不會拿到膠原蛋白，並提醒膠囊殼材質', () => {
  const r = buildPack({ ...base, diet: 'lacto_ovo', focus: ['skin'], tier: 'advanced' }, data);
  assert.ok(!r.items.some(i => i.id === 'collagen'));
  assert.ok(r.warnings.some(w => w.includes('膠囊殼')));
});

test('已在吃綜合維他命就不給 B 群，並提醒審核者', () => {
  const r = buildPack({ ...base, focus: ['energy', 'stress'], supplements: ['multi'], tier: 'advanced' }, data);
  assert.ok(!r.items.some(i => i.id === 'b_complex_e'));
  assert.ok(r.warnings.some(w => w.includes('綜合維他命')));
});

test('已在吃的品項不重複給', () => {
  const r = buildPack({ ...base, focus: ['digestion'], bowel: 'constipation', supplements: ['probiotic'], tier: 'advanced' }, data);
  assert.ok(!r.items.some(i => i.id === 'probiotic'));
});

test('常喝酒、睡不夠的人會拿到芝麻素', () => {
  const r = buildPack({ ...base, alcohol: '3plus', tier: 'advanced' }, data);
  assert.ok(r.items.some(i => i.id === 'sesamin'));
});

test('每個想照顧的部分都至少對得到一個啟用品項', () => {
  const q = data.questions.questions.find(x => x.id === 'focus');
  for (const o of q.options) {
    const tag = Object.keys(o.needs)[0];
    const n = data.items.items.filter(i => i.enabled && i.needs[tag]).length;
    assert.ok(n >= 1, `${o.label} 沒有對到任何品項`);
  }
});

test('顯示條件必須引用前面的題目', () => {
  const questions = structuredClone(data.questions);
  questions.questions[0].showIf = { tier: ['basic'] };
  assert.ok(validateData({ ...data, questions }).length > 0);
});
