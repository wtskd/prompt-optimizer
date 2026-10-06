// Standard 档"模型合并"规则的单测：模型的提议什么时候被采纳、什么时候被拦下、什么时候只是"同意"。
// 铁律：任何一次"模型说了但没生效"都必须留痕（blocked / agreed / skipped），不得静默丢弃。
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeAsync } from '../src/pipeline.js';

function mockProvider(payloads) {
  let i = 0;
  return {
    async chat() {
      const p = payloads[Math.min(i++, payloads.length - 1)];
      return {
        text: typeof p === 'string' ? p : JSON.stringify(p),
        usage: { promptMiss: 10, promptHit: 0, completion: 5, total: 15 },
        cost: 0.0001,
        cached: false,
        model: 'mock',
      };
    },
  };
}

test('模型不得覆盖用户显式说出的交付物形态，且必须留痕', async () => {
  const text = '把这份周报改写成三点式清单';
  const r = await optimizeAsync(text, {
    tier: 'standard',
    provider: mockProvider([
      {
        task_type: 'transform',
        confidence: 0.95,
        domain: 'content',
        deliverable_format: 'prose',
        slots: { deliverable_format: { value: 'prose', confidence: 0.95, evidence: '整段文字' } },
      },
    ]),
  });

  assert.equal(r.slots.deliverable_format.value, 'list', '用户显式要清单，模型给的 prose 不得生效');
  const blocked = r.meta.llm.merged.blocked.find((b) => b.slot === 'deliverable_format');
  assert.ok(blocked, '"被拦下"必须留痕，不得静默丢弃');
  assert.equal(blocked.kept, 'list');
  assert.equal(blocked.proposed, 'prose');
});

test('模型结论与现有槽位一致时记 agreed，不算被拦下（避免污染审计口径）', async () => {
  const r = await optimizeAsync('帮我看看这个报错到底啥原因', {
    tier: 'standard',
    provider: mockProvider([
      {
        task_type: 'analyze',
        confidence: 0.9,
        domain: 'other',
        slots: { language: { value: 'zh-CN', confidence: 0.4, evidence: '帮我看看' } },
      },
    ]),
  });

  assert.deepEqual(r.meta.llm.merged.agreed, ['language']);
  assert.deepEqual(r.meta.llm.merged.blocked, []);
  assert.equal(r.slots.language.value, 'zh-CN');
});

test('非法 domain 记 skipped 且不覆盖规则层结论', async () => {
  const r = await optimizeAsync('帮我看看这个报错到底啥原因', {
    tier: 'standard',
    provider: mockProvider([{ task_type: 'analyze', confidence: 0.9, domain: 'nope', slots: {} }]),
  });

  assert.deepEqual(r.meta.llm.merged.skipped, ['domain=nope']);
  assert.equal(r.intent.domain, 'other', '规则层结论必须保留');
  assert.equal(r.intent.task_type, 'analyze');
  assert.equal(r.intent.by, 'llm');
});

test('合法 domain 会被采纳（software）', async () => {
  const r = await optimizeAsync('帮我看看这个报错到底啥原因', {
    tier: 'standard',
    provider: mockProvider([{ task_type: 'analyze', confidence: 0.9, domain: 'software', slots: {} }]),
  });

  assert.equal(r.intent.domain, 'software');
  assert.deepEqual(r.meta.llm.merged.skipped, []);
});

test('本地计算耗时与用户实际等待分开记账（totalMs = 本地 + LLM）', async () => {
  const r = await optimizeAsync('帮我看看这个报错到底啥原因', {
    tier: 'standard',
    provider: mockProvider([{ task_type: 'analyze', confidence: 0.9, domain: 'software', slots: {} }]),
  });

  assert.equal(typeof r.meta.ms, 'number');
  assert.ok(r.meta.totalMs >= r.meta.ms, 'totalMs 必须包含本地耗时');
  assert.equal(r.meta.totalMs, r.meta.ms + (r.meta.llm.ms ?? 0));
  assert.equal(r.meta.llmCalls, 1);
  assert.equal(r.meta.degraded, false);
});

test('列表型槽位收到标量字符串 → 归一为单元素列表并留痕（真实端点 u02 崩溃的回归）', async () => {
  const r = await optimizeAsync('多县城下这个 list 报错 concurrentmodificationexception 怎么改', {
    tier: 'standard',
    provider: mockProvider([
      {
        task_type: 'code',
        confidence: 0.9,
        domain: 'software',
        deliverable_format: 'code',
        slots: { constraints_include: { value: '需要给出修改后的代码', confidence: 0.7, evidence: '怎么改' } },
      },
    ]),
  });

  assert.deepEqual(r.slots.constraints_include.value, ['需要给出修改后的代码']);
  assert.deepEqual(r.meta.llm.merged.coerced, ['constraints_include（标量 → 单元素列表）']);
  assert.ok(r.contract.hard.some((c) => c.text === '必须：需要给出修改后的代码'), '契约必须拿到可判定的列表值');
  assert.ok(
    r.prompt.includes('必须包含（缺一即不合格）：需要给出修改后的代码'),
    '必含项必须进入渲染出的提示词，不能只躺在结构化契约里',
  );
  assert.equal(r.violations.length, 0);
});

test('标量槽位收到数组 → 记 skipped，不写入非法形态', async () => {
  const r = await optimizeAsync('帮我看看这个报错到底啥原因', {
    tier: 'standard',
    provider: mockProvider([
      {
        task_type: 'analyze',
        confidence: 0.9,
        domain: 'software',
        slots: { goal: { value: ['a', 'b'], confidence: 0.9, evidence: '报错' } },
      },
    ]),
  });

  assert.deepEqual(r.meta.llm.merged.skipped, ['goal 应为标量却收到数组']);
  assert.ok(!Array.isArray(r.slots.goal?.value), '模型给的数组不得落进标量槽位');
});
