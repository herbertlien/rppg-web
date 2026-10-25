import assert from 'node:assert/strict';
import { catalog, createPreview } from './products.js';

for (const p of Object.values(catalog)) {
  assert.ok(p.price >= 0);
  assert.equal(p.questions.length, 5);
  const ids = p.questions.map(q => q.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate question id');
  const answers = Object.fromEntries(p.questions.map(q => [q.id, q.options[0].value]));
  const first = createPreview(p, answers);
  assert.equal(first.tasks.length, p.days);
  assert.equal(first.tasks[0].day, 1);
  assert.equal(first.tasks.at(-1).day, p.days);
  assert.ok(first.headline);
  assert.ok(first.reason);
  assert.deepEqual(createPreview(p, answers), first, 'preview should be deterministic');
}
const relax = catalog.relax;
const r = createPreview(relax, {
  goal: 'beforebed', minutes: '3', barrier: 'forget',
  format: 'audio', reminder: 'none'
});
assert.match(r.reason, /睡前/);
assert.match(r.notes.join(' '), /不接收提醒/);
const stage = catalog.stage;
const s = createPreview(stage, {
  occasion: 'interview', when: 'soon', challenge: 'questions',
  minutes: '5', format: 'both'
});
assert.match(s.headline, /面試/);
assert.match(s.notes.join(' '), /1–3 天/);
assert.throws(() => createPreview(stage, {minutes:'unknown'}), /必要|缺少/);
console.log('PASS: two products, 5 questions each, deterministic plans, edge cases.');
