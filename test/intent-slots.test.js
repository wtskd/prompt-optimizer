import test from 'node:test';
import assert from 'node:assert/strict';
import { optimize } from '../src/pipeline.js';

const irOf = (t, o) => optimize(t, o).ir;

test('意图：翻译类输入 → transform，且语言识别为 en', () => {
  const ir = irOf('把这段中文翻译成英文，保持专业术语');
  assert.equal(ir.intent.task_type, 'transform');
  assert.equal(ir.slots.language.value, 'en');
  assert.equal(ir.slots.language.source, 'explicit');
});

test('意图：计划类输入 → plan，交付物 → table', () => {
  const ir = irOf('帮我做一个三个月的健身计划，要表格形式');
  assert.equal(ir.intent.task_type, 'plan');
  assert.equal(ir.slots.deliverable_format.value, 'table');
});

test('意图：抽取类输入 → extract，交付物 → json', () => {
  const ir = irOf('从这段话里提取出所有日期，输出 JSON');
  assert.equal(ir.intent.task_type, 'extract');
  assert.equal(ir.slots.deliverable_format.value, 'json');
});

test('意图：无信号输入 → 回退且置信度低，不臆造高分', () => {
  const ir = irOf('嗯');
  assert.ok(ir.intent.confidence < 0.5, `confidence=${ir.intent.confidence}`);
  assert.equal(ir.intent.evidence.length, 0);
});

test('槽位：语气映射到枚举、受众抽取、语言默认来自 locale', () => {
  const a = irOf('帮我写一段产品介绍文案，面向非技术决策者，语气要专业一点');
  assert.ok(a.slots.tone_style.value.includes('technical'), JSON.stringify(a.slots.tone_style));
  assert.equal(a.slots.audience.value, '非技术决策者');

  const b = irOf('帮我写一段产品介绍文案');
  assert.equal(b.slots.language.value, 'zh-CN');
  assert.equal(b.slots.language.source, 'default');
});

test('槽位：篇幅上限优先于形容词，禁止项按字面抽取', () => {
  const ir = irOf('改写这份说明，不超过 200 字，不要直译');
  assert.equal(ir.slots.scope_length.value.kind, 'max');
  assert.equal(ir.slots.scope_length.value.n, 200);
  assert.ok(ir.slots.constraints_exclude.value.includes('直译'));
});
