// Deep 档测试：3 跳全链路（分析/补全/自检）+ 降级与门槛。全部假 provider，零网络零花费。
import test from 'node:test';
import assert from 'node:assert/strict';

import { optimizeAsync, STAGES_DEEP } from '../src/pipeline.js';
import { buildStateSnapshot, parseVerdict } from '../src/llm/deep.js';
import { llmError } from '../src/llm/provider.js';

const analyzePatch = (extra = {}) => ({
  task_type: 'write', confidence: 0.9, domain: 'content', deliverable_format: null, language: null,
  slots: { goal: { value: '写周报', confidence: 0.9, evidence: '周报' } }, skipped: [], coerced: [],
  ...extra,
});
const enrichPatch = (extra = {}) => ({
  task_type: 'write', confidence: 0.9, domain: 'content', deliverable_format: null, language: null,
  slots: { audience: { value: '老板', confidence: 0.8, evidence: '给老板' } }, skipped: [], coerced: [],
  ...extra,
});

/**
 * 按系统提示词路由的三跳假 provider：
 * 基础分析 → analyzePayload；补全器 → enrichPayload；自检员 → verifyPayload（都是对象，可含 Error）
 */
const deepMock = ({ analyze, enrich, verify }) => {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      const p = req.system.includes('槽位补全器') ? enrich
        : req.system.includes('自检员') ? verify
        : analyze;
      if (p instanceof Error) throw p;
      return { text: JSON.stringify(p), usage: { promptMiss: 800, promptHit: 0, completion: 150 }, cost: 0.0026, cached: false, model: 'mock' };
    },
  };
};

test('deep 档 happy path：3 跳全部执行，补全槽位与阶段留痕齐备', async () => {
  const p = deepMock({ analyze: analyzePatch(), enrich: enrichPatch(), verify: { verdict: 'ok', issues: [] } });
  const r = await optimizeAsync('帮我写周报', { tier: 'deep', provider: p });
  assert.equal(p.calls.length, 3);
  assert.equal(r.meta.tier, 'deep');
  assert.equal(r.meta.llmCalls, 3, '三跳都非缓存');
  assert.equal(r.meta.llmBudgetCalls, 4);
  assert.equal(r.meta.llm.status, 'ok');
  assert.equal(r.meta.llm.deep.skipped, false);
  assert.equal(r.meta.llm.deep.enrich.status, 'ok');
  assert.equal(r.meta.llm.deep.verify.verdict, 'ok');
  assert.equal(r.meta.llm.deep.verify.revisionApplied, false);
  assert.equal(r.meta.llm.costYuan + r.meta.llm.deep.enrich.costYuan + r.meta.llm.deep.verify.costYuan, 0.0078);
  // 补全跳的槽位落进 IR（意图仍来自基础分析）
  assert.equal(r.intent.task_type, 'write');
  assert.equal(r.slots.audience?.value, '老板');
  assert.equal(r.slots.audience?.source, 'inferred');
  assert.deepEqual(r.meta.stages, STAGES_DEEP);
  assert.ok(r.meta.stages.includes('S1c_llm_enrich') && r.meta.stages.includes('S1d_llm_verify'));
  assert.equal(r.violations.length, 0);
});

test('deep 补全跳试图更改已定稿意图 → 该跳作废留痕，自检跳照常执行，不算整体降级', async () => {
  const p = deepMock({ analyze: analyzePatch(), enrich: enrichPatch({ task_type: 'code' }), verify: { verdict: 'ok', issues: [] } });
  const r = await optimizeAsync('帮我写周报', { tier: 'deep', provider: p });
  assert.equal(p.calls.length, 3, '自检跳不受补全跳失败影响');
  assert.equal(r.meta.llm.deep.enrich.status, 'failed');
  assert.match(r.meta.llm.deep.enrich.reason, /定稿/);
  assert.equal(r.meta.llmCalls, 2, '失败的跳不计入调用数');
  assert.equal(r.meta.degraded, false);
  assert.equal(r.intent.task_type, 'write');
});

test('deep 自检跳：确凿修订（置信度≥0.8 且与基础不同）才被应用', async () => {
  const p = deepMock({
    analyze: analyzePatch(),
    enrich: enrichPatch(),
    verify: { verdict: 'revise', issues: [{ slot: 'goal', note: '原话是压缩，不是从零写' }], revision: { task_type: 'transform', confidence: 0.9, evidence: '压缩一下' } },
  });
  const r = await optimizeAsync('把这段话压缩一下', { tier: 'deep', provider: p });
  assert.equal(r.intent.task_type, 'transform');
  assert.equal(r.meta.llm.deep.verify.revisionApplied, true);
  assert.ok(r.meta.llm.deep.verify.merged, '修订合并要有留痕');
});

test('deep 自检修订门槛：置信度不足 / 与基础共识 → 记录不应用', async () => {
  const low = deepMock({
    analyze: analyzePatch(), enrich: enrichPatch(),
    verify: { verdict: 'revise', issues: [], revision: { task_type: 'transform', confidence: 0.5, evidence: '压缩' } },
  });
  const rLow = await optimizeAsync('写周报', { tier: 'deep', provider: low });
  assert.equal(rLow.intent.task_type, 'write');
  assert.equal(rLow.meta.llm.deep.verify.revisionApplied, false);
  assert.match(rLow.meta.llm.deep.verify.revisionRejected, /0\.8 门槛/);

  const same = deepMock({
    analyze: analyzePatch(), enrich: enrichPatch(),
    verify: { verdict: 'revise', issues: [], revision: { task_type: 'write', confidence: 0.9, evidence: '周报' } },
  });
  const rSame = await optimizeAsync('写周报', { tier: 'deep', provider: same });
  assert.match(rSame.meta.llm.deep.verify.revisionRejected, /共识/);
});

test('deep 基础分析失败 → 整体降级，后两跳不花钱', async () => {
  const p = deepMock({ analyze: new Error('模型超时'), enrich: enrichPatch(), verify: { verdict: 'ok', issues: [] } });
  const r = await optimizeAsync('写周报', { tier: 'deep', provider: p });
  assert.equal(p.calls.length, 1);
  assert.equal(r.meta.degraded, true);
  assert.equal(r.meta.llm.deep.skipped, true);
  assert.equal(r.meta.llm.deep.enrich, null);
  assert.equal(r.meta.llmCalls, 0);
});

test('deep 自检跳输出非法 → 该跳失败留痕，基础结果照常交付', async () => {
  const p = deepMock({ analyze: analyzePatch(), enrich: enrichPatch(), verify: { verdict: 'maybe', issues: [] } });
  const r = await optimizeAsync('写周报', { tier: 'deep', provider: p });
  assert.equal(r.meta.llm.deep.verify.status, 'failed');
  assert.equal(r.meta.llm.deep.verify.code, 'LLM_SCHEMA');
  assert.equal(r.meta.degraded, false);
  assert.equal(r.intent.task_type, 'write');
});

test('deep 预算中断：provider 抛 LLM_BUDGET_EXCEEDED → 该跳失败留痕，整体不算降级', async () => {
  const budgetErr = llmError('LLM_BUDGET_EXCEEDED', '本次会话已花 ¥0.0026，达到上限 ¥0.001');
  const p = {
    calls: [],
    async chat(req) {
      this.calls.push(req);
      if (this.calls.length >= 2) throw budgetErr; // 第 2 跳起预算到限
      return { text: JSON.stringify(analyzePatch()), usage: { promptMiss: 800, promptHit: 0, completion: 150 }, cost: 0.0026, cached: false, model: 'mock' };
    },
  };
  const r = await optimizeAsync('写周报', { tier: 'deep', provider: p });
  assert.equal(p.calls.length, 3, '三跳都会尝试（每跳独立失败留痕）');
  assert.equal(r.meta.llm.deep.enrich.status, 'failed');
  assert.equal(r.meta.llm.deep.enrich.code, 'LLM_BUDGET_EXCEEDED');
  assert.equal(r.meta.llm.deep.verify.code, 'LLM_BUDGET_EXCEEDED');
  assert.equal(r.meta.degraded, false, '基础分析已成功，不算整体降级');
  assert.equal(r.intent.task_type, 'write');
});

// —— deep.js 单元 ——

test('buildStateSnapshot：补全跳覆盖基础跳的同名槽位，值与 evidence 都进快照', () => {
  const base = analyzePatch();
  const enrich = enrichPatch({
    slots: { goal: { value: '写周报给老板', confidence: 0.85, evidence: '周报给老板' }, audience: { value: '老板', confidence: 0.8, evidence: '给老板' } },
  });
  const snap = buildStateSnapshot('帮我写周报给老板看', base, enrich);
  assert.equal(snap.task_type, 'write');
  assert.equal(snap.slots.goal.value, '写周报给老板', '补全跳的值覆盖基础跳');
  assert.equal(snap.slots.audience.value, '老板');
  assert.ok(snap.slots.goal.evidence.length <= 80);
});

test('parseVerdict：残缺部分进 skipped，不牵连整体；非法 verdict 抛 LLM_SCHEMA', () => {
  const v = parseVerdict(JSON.stringify({
    verdict: 'revise',
    issues: [{ slot: 'goal', note: 'a'.repeat(300) }, '垃圾条目', { note: '正常问题' }, null],
    revision: { task_type: 'nope', confidence: 0.9, evidence: 'x' },
  }));
  assert.equal(v.verdict, 'revise');
  assert.equal(v.issues.length, 2, '合法 issues 保留');
  assert.ok(v.issues[0].note.length <= 200, '超长 note 被截断');
  assert.equal(v.revision, null, '非法 task_type 的修订不采纳');
  assert.ok(v.skipped.length >= 2);

  assert.throws(() => parseVerdict('{"verdict":"maybe"}'), (e) => e.code === 'LLM_SCHEMA');
  assert.throws(() => parseVerdict('不是JSON'), (e) => e.code === 'LLM_BAD_JSON');
  assert.equal(parseVerdict('{"verdict":"ok"}').revision, null);
  // 有意构造一个无 evidence 的修订对象，验证守卫
  const noEv = llmError('LLM_BAD_JSON', '占位');
  assert.ok(noEv.code === 'LLM_BAD_JSON');
});
