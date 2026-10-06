import test from 'node:test';
import assert from 'node:assert/strict';
import { optimize, STAGES } from '../src/pipeline.js';
import { validateIR } from '../src/ir.js';

test('确定性：同一输入两次输出逐字节一致（INV-4）', () => {
  const t = '帮我写一份发布方案，用表格给出，不超过 300 字';
  const a = optimize(t);
  const b = optimize(t);
  assert.equal(a.prompt, b.prompt);
  assert.equal(a.meta.promptHash, b.meta.promptHash);
  assert.equal(a.meta.sourceHash, b.meta.sourceHash);
});

test('硬不变量：正常输入下 validateIR 返回空；原文保真进输出', () => {
  const t = '帮我写一份发布方案，用表格给出，不超过 300 字';
  const r = optimize(t);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(validateIR(r.ir, r.prompt), []);
  assert.ok(r.prompt.includes(t), '渲染结果必须保留原始输入');
  assert.equal(r.meta.ok, true);
});

test('假设必须被渲染进输出（INV-5），并带可追溯依据', () => {
  const r = optimize('帮我写点东西');
  assert.ok(r.assumptions.length > 0);
  assert.ok(r.prompt.includes('# 假设'));
  for (const a of r.assumptions) assert.ok(a.reason.length > 0);
});

test('语言硬约束：英文输入进入提示词与契约', () => {
  const r = optimize('用英文回答：解释一下 CAP 定理');
  assert.equal(r.ir.slots.language.value, 'en');
  assert.ok(r.prompt.includes('English'));
  assert.ok(r.contract.hard.some((c) => c.text.includes('English')));
});

test('档位守卫：fast 档 0 次 LLM；未实现的档位必须明确报错而非静默降级', () => {
  const r = optimize('写一份周报');
  assert.equal(r.meta.llmCalls, 0);
  assert.equal(r.meta.tier, 'fast');
  assert.throws(() => optimize('写一份周报', { tier: 'standard' }), /fast 档/);
  assert.throws(() => optimize('写一份周报', { tier: 'nope' }), /未知档位/);
});

test('阶段留痕：S1–S8 全部执行且计时可读', () => {
  const r = optimize('帮我把这份周报改写成三点式清单');
  assert.deepEqual(r.meta.stages, STAGES);
  assert.equal(r.ir.trace.length, STAGES.length);
  for (const t of r.ir.trace) assert.ok(typeof t.ms === 'number' && t.ms >= 0);
});

test('目标模型自适应：不同 targetModel 产出不同表达约束', () => {
  const a = optimize('写一份周报', { targetModel: 'reasoning' });
  const b = optimize('写一份周报', { targetModel: 'fast' });
  assert.ok(a.prompt.includes('推理'));
  assert.ok(b.prompt.includes('直接给结论'));
  assert.notEqual(a.meta.promptHash, b.meta.promptHash);
});

test('空输入会被不变量拦下', () => {
  const r = optimize('   ');
  assert.ok(r.violations.some((v) => v.code === 'INV-1'));
  assert.equal(r.meta.ok, false);
});
