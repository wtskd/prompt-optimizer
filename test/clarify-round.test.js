// 多轮澄清闭环的单测：--ask 问出去的问题 → answers 回收 → 二次渲染。
// 纪律：回答是用户显式给出（explicit，优先级 100），在澄清层定稿之前合入 IR；
// 未知 key / 非法枚举必须报错，空回答必须留痕（skipped），一律不得静默丢弃。
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimize, optimizeAsync } from '../src/pipeline.js';
import { SLOT_DEFS } from '../src/schema.js';

const T = '帮我写点东西';
const round1 = (r) => r.meta.clarify.rounds[0];
const applied = (r) => r.meta.clarify.appliedAnswers;

test('① 回答填上 blocking 槽位 → 假设消失，契约与渲染出的提示词都含该值', () => {
  assert.equal(SLOT_DEFS.find((d) => d.id === 'deliverable_format').blocking, true);

  const before = optimize(T);
  assert.ok(before.assumptions.some((a) => a.slot === 'deliverable_format'), '未回答时应走"假设+标注"');
  assert.ok(before.contract.hard.some((c) => c.id === 'C-02' && c.text.includes('连贯段落')));
  assert.ok(before.prompt.includes('连贯段落（用户未指定，暂定）'));

  const after = optimize(T, { answers: { deliverable_format: 'table' } });
  assert.ok(!after.assumptions.some((a) => a.slot === 'deliverable_format'), '被回答的槽位不得再出现在假设里');
  assert.ok(!after.prompt.includes('连贯段落（用户未指定，暂定）'), '旧假设必须随回答一起消失');
  assert.ok(after.contract.hard.some((c) => c.id === 'C-02' && c.text.includes('表格')), '契约必须反映回答');
  assert.ok(after.prompt.includes('交付物形态：表格'), '渲染出的提示词必须反映回答');
  assert.deepEqual(after.violations, []);
  assert.deepEqual(round1(after).applied, ['deliverable_format']);
});

test('② 回答覆盖此前 inferred/assumed 值，source 一律 explicit，并留痕 previous', () => {
  const before = optimize(T);
  assert.equal(before.slots.goal.source, 'inferred');
  assert.equal(before.slots.background.source, 'assumed');
  assert.ok(before.assumptions.some((a) => a.slot === 'goal'));
  assert.ok(before.assumptions.some((a) => a.slot === 'background'));

  const after = optimize(T, { answers: { goal: '产出一份发布检查清单', background: '内部工具重构' } });
  assert.equal(after.slots.goal.value, '产出一份发布检查清单');
  assert.equal(after.slots.goal.source, 'explicit');
  assert.equal(after.slots.goal.confidence, 1);
  assert.equal(after.slots.goal.evidence, '产出一份发布检查清单');
  assert.equal(after.slots.background.value, '内部工具重构');
  assert.equal(after.slots.background.source, 'explicit');
  assert.ok(!after.assumptions.some((a) => a.slot === 'goal'), 'goal 被回答后不得再是假设');
  assert.ok(!after.assumptions.some((a) => a.slot === 'background'), 'background 被回答后不得再是假设');
  assert.equal(applied(after).goal.previous.source, 'inferred', '覆盖前来源必须留痕');
  assert.ok(after.prompt.includes('产出一份发布检查清单'));
  assert.deepEqual(after.violations, []);
});

test('③ 未知 key → code=CLARIFY_ANSWER_UNKNOWN，message 里列出未知 key 与可用 key', () => {
  assert.throws(
    () => optimize(T, { answers: { 交付物: '表格' } }),
    (e) => {
      assert.equal(e.code, 'CLARIFY_ANSWER_UNKNOWN');
      assert.match(e.message, /交付物/, 'message 必须点名未知 key');
      assert.match(e.message, /q_goal/, 'message 必须列出可用 key');
      assert.deepEqual(e.unknown, ['交付物']);
      assert.ok(e.available.includes('deliverable_format'));
      return true;
    },
  );
});

test('④ 空回答 → 记为 skipped、不报错、不写槽位，该槽位照旧被追问', () => {
  const r = optimize(T, { ask: true, answers: { background: '   ', q_goal: '' } });
  const rd = round1(r);
  assert.deepEqual(rd.skipped.map((s) => s.slot).sort(), ['background', 'goal']);
  for (const s of rd.skipped) assert.match(s.reason, /空回答/);
  assert.deepEqual(rd.applied, []);
  assert.deepEqual(rd.answered, {});
  assert.equal(r.slots.goal.source, 'inferred', '空回答不得覆盖既有槽位');
  assert.ok(r.questions.some((q) => q.slot === 'goal'), '空回答的槽位该问还是要问');
  assert.deepEqual(r.violations, []);
});

test('⑤ 列表型槽位回答归一为列表（标量 → 单元素；数组原样），并进入契约与提示词', () => {
  const a = optimize(T, { answers: { constraints_include: '包含具体步骤' } });
  assert.deepEqual(a.slots.constraints_include.value, ['包含具体步骤']);
  assert.equal(a.slots.constraints_include.source, 'explicit');
  assert.ok(a.contract.hard.some((c) => c.text === '必须：包含具体步骤'));
  assert.ok(a.prompt.includes('必须包含（缺一即不合格）：包含具体步骤'));

  const b = optimize(T, { answers: { constraints_include: ['包含具体步骤', '包含验收标准'] } });
  assert.deepEqual(b.slots.constraints_include.value, ['包含具体步骤', '包含验收标准']);
  assert.ok(b.prompt.includes('包含具体步骤；包含验收标准'));
});

test('⑥ 确定性（两次 promptHash 一致）且被回答的问题从 questions 中移除', () => {
  const opts = { ask: true, answers: { deliverable_format: 'table' } };
  const a = optimize(T, opts);
  const b = optimize(T, opts);
  assert.equal(a.prompt, b.prompt);
  assert.equal(a.meta.promptHash, b.meta.promptHash);

  const none = optimize(T, { ask: true });
  assert.ok(none.questions.some((q) => q.slot === 'deliverable_format'), '未回答时它会被追问');
  assert.ok(!a.questions.some((q) => q.slot === 'deliverable_format'), '回答后不得再追问该槽位');
  assert.ok(a.questions.length < none.questions.length, 'questions 必须减少');

  const rd = round1(a);
  assert.ok(rd.asked.includes('q_deliverable_format'), '本轮确实问过它');
  assert.ok(!rd.remaining.includes('q_deliverable_format'), '回答后不再留在待澄清清单里');
});

test('⑦ 枚举型槽位非法取值 → code=CLARIFY_ANSWER_INVALID，message 给出允许值', () => {
  assert.throws(
    () => optimize(T, { answers: { deliverable_format: '视频' } }),
    (e) => {
      assert.equal(e.code, 'CLARIFY_ANSWER_INVALID');
      assert.match(e.message, /视频/);
      assert.match(e.message, /table/);
      return true;
    },
  );
});

test('⑧ 追问选项里的中文标签按本体枚举归一（表格 → table、英文 → en）', () => {
  const r = optimize(T, { answers: { deliverable_format: '表格', language: '英文' } });
  assert.equal(r.slots.deliverable_format.value, 'table');
  assert.equal(r.slots.language.value, 'en');
  assert.equal(r.slots.language.source, 'explicit');
  assert.ok(r.contract.hard.some((c) => c.id === 'C-01' && c.text.includes('English')));
  assert.ok(r.prompt.includes('English'));
  assert.deepEqual(r.violations, []);
});

test('⑨ 问题 id（q_<slot>）与槽位 id 等价；无 answers 时不产生澄清轮次', () => {
  const r = optimize(T, { answers: { q_goal: '产出一份发布检查清单' } });
  assert.equal(r.slots.goal.value, '产出一份发布检查清单');
  assert.equal(applied(r).goal.key, 'q_goal');
  assert.equal(round1(r).answered.goal, '产出一份发布检查清单');

  assert.equal(optimize(T, { ask: true }).meta.clarify, null, '无 answers 时既有路径逐字节不变');
});

test('⑩ standard 档：回答在 LLM 之后、澄清层之前合入，只调用一次模型', async () => {
  let calls = 0;
  const provider = {
    async chat() {
      calls += 1;
      return {
        text: JSON.stringify({
          task_type: 'write', confidence: 0.9, domain: 'content', deliverable_format: 'prose', slots: {},
        }),
        usage: { promptMiss: 10, promptHit: 0, completion: 5, total: 15 },
        cost: 0.0001,
        cached: false,
        model: 'mock',
      };
    },
  };
  const r = await optimizeAsync(T, { tier: 'standard', provider, answers: { deliverable_format: 'table' } });
  assert.equal(calls, 1, '答案来自用户，不得为此再调一次模型');
  assert.equal(r.meta.llmCalls, 1);
  assert.equal(r.slots.deliverable_format.value, 'table');
  assert.equal(r.slots.deliverable_format.source, 'explicit');
  assert.equal(applied(r).deliverable_format.previous.source, 'inferred', '模型结论被覆盖要留痕');
  assert.ok(r.prompt.includes('交付物形态：表格'));
  assert.deepEqual(r.violations, []);
});
