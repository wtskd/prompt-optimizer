import test from 'node:test';
import assert from 'node:assert/strict';
import { optimize } from '../src/pipeline.js';

test('缺口决策：默认（无交互宿主）不追问，全部降级为带依据的假设', () => {
  const r = optimize('帮我写点东西');
  assert.equal(r.questions.length, 0);
  assert.ok(r.assumptions.length >= 1, JSON.stringify(r.assumptions));
  for (const a of r.assumptions) assert.match(a.reason, /缺口评分/);
});

test('追问预算：开启 --ask 后 ≤2 个必答 + ≤3 个可选，选项数 2–5，且每条都有依据', () => {
  const r = optimize('帮我写点东西', { ask: true });
  assert.ok(r.questions.length >= 1);
  assert.ok(r.questions.filter((q) => q.blocking).length <= 2);
  assert.ok(r.questions.filter((q) => !q.blocking).length <= 3);
  for (const q of r.questions) {
    assert.ok(q.options.length >= 2 && q.options.length <= 5, JSON.stringify(q));
    assert.match(q.reason, /缺口评分/);
    assert.equal(q.round, 1);
  }
});

test('三档决策齐备：高缺口→ask、中缺口→assume、低缺口→default', () => {
  const r = optimize('帮我写点东西', { ask: true });
  const bySlot = Object.fromEntries(r.ir.decisions.map((d) => [d.slot, d.decision]));
  assert.equal(bySlot.goal, 'ask');
  assert.equal(bySlot.deliverable_format, 'ask');
  assert.equal(bySlot.background, 'assume');
  assert.equal(bySlot.language, 'default');
});

test('追问预算用尽时转为假设，并注明原因（不丢信息、不静默）', () => {
  const r = optimize('帮我写点东西', { ask: true });
  const overflow = r.ir.decisions.filter((d) => d.decision === 'ask' && !d.queued);
  assert.ok(overflow.length >= 1);
  for (const d of overflow) {
    assert.ok(r.assumptions.some((a) => a.slot === d.slot), `槽位 ${d.slot} 既未追问也未成为假设`);
  }
});

test('低缺口槽位使用静默默认，且来源标记为 default', () => {
  const r = optimize('帮我写点东西');
  const lang = r.ir.slots.language;
  assert.equal(lang.source, 'default');
  assert.equal(lang.value, 'zh-CN');
});
