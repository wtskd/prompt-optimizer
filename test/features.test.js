// 新功能测试：优化目标 / 语言一致性 / 流式 / 历史记录 / 行级对比。全部零网络零花费。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { optimize, optimizeAsync } from '../src/pipeline.js';
import { resolveConfig, createProvider } from '../src/llm/provider.js';
import { parseAnalysis, applyAnalysis } from '../src/llm/analyze.js';
import { resolveGoals, GOAL_IDS } from '../src/goals.js';
import { detectLanguage } from '../src/lang.js';
import { diffLines, formatDiff, diffStats } from '../src/diff.js';
import { createIR } from '../src/ir.js';
import {
  makeRecord, appendHistory, readHistory, listHistory, showHistory, clearHistory,
} from '../src/history.js';

const okJson = (extra = {}) =>
  JSON.stringify({
    task_type: 'write',
    confidence: 0.9,
    domain: 'content',
    slots: { goal: { value: '写周报', confidence: 0.9, evidence: '周报' } },
    ...extra,
  });

const mockProvider = (payloads) => {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      const p = payloads[Math.min(calls.length - 1, payloads.length - 1)];
      if (p instanceof Error) throw p;
      return { text: p, usage: { promptMiss: 1000, promptHit: 0, completion: 200 }, cost: 0.0026, cached: false, model: 'mock' };
    },
  };
};

// —— 优化目标 ——

test('resolveGoals：逗号分隔/数组/去重/未知目标报错', () => {
  assert.deepEqual(resolveGoals(null), []);
  assert.deepEqual(resolveGoals(''), []);
  assert.deepEqual(resolveGoals('concise, format'), ['concise', 'format']);
  assert.deepEqual(resolveGoals(['format', 'format', 'concise']), ['format', 'concise']);
  assert.throws(() => resolveGoals('nope'), /未知优化目标/);
  assert.throws(() => resolveGoals('concise,nope'), /nope/);
});

test('--goal 注入渲染层：章节出现在质量与风格之前，fast/standard 同效', () => {
  const r = optimize('帮我写周报', { goal: 'concise,format' });
  const gi = r.prompt.indexOf('# 优化目标（用户指定，优先满足）');
  const qi = r.prompt.indexOf('# 质量与风格');
  assert.ok(gi > 0, '必须渲染优化目标章节');
  assert.ok(qi > gi, '优化目标要排在质量与风格之前');
  assert.ok(r.prompt.includes('【更简洁】'));
  assert.ok(r.prompt.includes('【调整输出格式】'));
  assert.deepEqual(r.meta.goal, ['concise', 'format']);
  assert.equal(r.violations.length, 0);
});

test('不指定 goal 时渲染结果与旧路径一致（无优化目标章节）', () => {
  const r = optimize('帮我写周报');
  assert.ok(!r.prompt.includes('# 优化目标'));
  assert.deepEqual(r.meta.goal, []);
});

test('未知 goal 在进管线前就抛错，不做静默丢弃', async () => {
  assert.throws(() => optimize('写周报', { goal: 'nope' }), /未知优化目标/);
  await assert.rejects(
    () => optimizeAsync('写周报', { tier: 'standard', goal: 'nope', provider: mockProvider([okJson()]) }),
    /未知优化目标/,
  );
});

// —— 语言一致性 ——

test('detectLanguage：中/英/空/无字母', () => {
  assert.equal(detectLanguage('帮我把这段话压缩一下'), 'zh-CN');
  assert.equal(detectLanguage('Please summarize this text in three bullet points'), 'en');
  assert.equal(detectLanguage('   '), null);
  assert.equal(detectLanguage(''), null);
  assert.equal(detectLanguage('12345 !!!'), null);
});

test('英文输入（无显式指令）→ 输出语言跟随英文', () => {
  const r = optimize('Please summarize this text in three bullet points');
  assert.equal(r.ir.options.locale, 'en');
  assert.equal(r.ir.options.languageDetected, 'en');
  assert.ok(r.prompt.includes('输出语言：English'), r.prompt);
});

test('中文输入不发多余的语言约束（保持旧行为）', () => {
  const r = optimize('帮我把这段话压缩一下');
  assert.equal(r.ir.options.languageDetected, 'zh-CN');
  assert.ok(!r.prompt.includes('输出语言：'));
});

test('显式语言指令永远优先于检测（"翻译成英文"仍判 explicit）', () => {
  const r = optimize('把这段话翻译成英文');
  assert.equal(r.ir.slots.language.source, 'explicit');
  assert.ok(r.prompt.includes('输出语言：English'));
});

test('模型判出的语言只在没有显式表达时采纳（llmLanguage 留痕）', async () => {
  const ir = createIR('帮我写周报');
  ir.intent = { task_type: 'write', confidence: 0.5, domain: 'other' }; // 真实管线里 S1 先于合并
  ir.slots.language = { value: 'zh-CN', confidence: 1, evidence: 'locale 默认 zh-CN', source: 'default' };
  const patch = parseAnalysis(okJson({ language: 'en' }));
  applyAnalysis(ir, patch);
  assert.equal(ir.options.llmLanguage, 'en');
  // 显式表达优先：模型 language 被无视
  const ir2 = createIR('翻译成英文');
  ir2.intent = { task_type: 'transform', confidence: 0.5, domain: 'other' };
  ir2.slots.language = { value: 'en', confidence: 0.92, evidence: '翻译成英文', source: 'explicit' };
  applyAnalysis(ir2, parseAnalysis(okJson({ language: 'zh-CN' })));
  assert.equal(ir2.options.llmLanguage, undefined);
});

test('parseAnalysis：language 非法值进 skipped 不牵连整体', () => {
  const p = parseAnalysis(okJson({ language: 'fr' }));
  assert.equal(p.language, null);
  assert.ok(p.skipped.some((s) => s.includes('language=fr')));
  const p2 = parseAnalysis(okJson({ language: 'en' }));
  assert.equal(p2.language, 'en');
});

// —— 流式 ——

/** 把 SSE 文本切成随机小块，模拟网络分片（含跨行边界） */
function sseResponse(sseText, { chunkEvery = 7 } = {}) {
  const bytes = new TextEncoder().encode(sseText);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkEvery) controller.enqueue(bytes.slice(i, i + chunkEvery));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const sseLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

const SSE_BODY = [
  sseLine({ choices: [{ delta: { content: '{"task_' } }] }),
  ': keep-alive 注释行\n',
  'data: 不是合法JSON\n\n',
  sseLine({ choices: [{ delta: { content: 'type":"write"}' } }] }),
  sseLine({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
  'data: [DONE]\n\n',
].join('');

test('provider.chat 流式：增量回调、usage 计费、非法行留痕、结果写缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-stream-'));
  try {
    const cfg = resolveConfig({ PROMPT_OPTIMIZER_API_KEY: 'sk-test' });
    const deltas = [];
    const provider = createProvider(cfg, {
      cacheDir: join(dir, 'cache'),
      fetchImpl: async () => sseResponse(SSE_BODY),
    });
    const res = await provider.chat({ system: 's', user: 'u', stream: true, onDelta: (d) => deltas.push(d) });
    assert.equal(res.text, '{"task_type":"write"}');
    assert.equal(res.cached, false);
    assert.equal(res.skippedEvents, 1, '非法 JSON 行必须计数留痕');
    assert.equal(res.usage.completion, 20);
    assert.ok(res.cost > 0);
    assert.deepEqual(deltas.join(''), '{"task_type":"write"}');
    // 结果照常落缓存：同样的输入再调一次应该命中、0 成本
    const res2 = await provider.chat({ system: 's', user: 'u', stream: true });
    assert.equal(res2.cached, true);
    assert.equal(res2.cost, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('流式请求体带 stream 标志；optimizeAsync 透传 stream/onDelta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-stream2-'));
  try {
    let seenBody = null;
    const deltas = [];
    const r = await optimizeAsync('帮我写周报', {
      tier: 'standard', env: { PROMPT_OPTIMIZER_API_KEY: 'sk-test' }, cacheDir: join(dir, 'cache'),
      fetchImpl: async (url, init) => {
        seenBody = JSON.parse(init.body);
        return sseResponse(sseLine({ choices: [{ delta: { content: okJson() } }] }) + 'data: [DONE]\n\n');
      },
      stream: true,
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(seenBody.stream, true);
    assert.deepEqual(seenBody.stream_options, { include_usage: true });
    assert.equal(r.meta.llm.status, 'ok');
    assert.equal(r.meta.degraded, false);
    assert.ok(deltas.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— 历史记录 ——

test('历史：追加/列出/按序号与 id 取单条/损坏行留痕/清空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-history-'));
  const file = join(dir, 'h.jsonl');
  try {
    const mk = (input) => makeRecord({ input, prompt: `P:${input}`, tier: 'fast', taskType: 'write', confidence: 0.9, costYuan: 0, totalMs: 3 });
    assert.equal(appendHistory(file, mk('第一条')), 1);
    assert.equal(appendHistory(file, mk('第二条')), 1);
    assert.equal(appendHistory(file, mk('第三条')), 1);
    // 损坏行：JSON 坏一行 + 缺 id 一行
    appendFileSync(file, '{broken\n');
    appendFileSync(file, '{"noId":1}\n');
    assert.equal(appendHistory(file, mk('第四条')), 1);

    const { records, skipped } = readHistory(file);
    assert.equal(records.length, 4);
    assert.equal(skipped.length, 2, '损坏行必须暴露行号，不得静默');

    const items = listHistory(file, 20);
    assert.equal(items.length, 4);
    assert.equal(items[3].no, 4);
    assert.equal(items[3].record.input, '第四条');

    assert.equal(showHistory(file, 2).input, '第二条');
    assert.equal(showHistory(file, items[0].record.id.slice(0, 8)).input, '第一条');
    assert.equal(showHistory(file, 99), null);

    assert.equal(clearHistory(file), true);
    assert.equal(existsSync(file), false);
    assert.equal(clearHistory(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— 行级对比 ——

test('diff：删/增/同标记正确，统计口径一致', () => {
  const changes = diffLines('hello\nworld', 'hello\nbrave\nworld\n!');
  assert.deepEqual(
    changes.map((c) => `${c.t}${c.line}`),
    ['=hello', '+brave', '=world', '+!'],
  );
  assert.ok(formatDiff(changes).includes('- ') === false);
  const rm = diffLines('a\nb\nc', 'a\nc');
  assert.deepEqual(rm.filter((c) => c.t === '-').map((c) => c.line), ['b']);
  const st = diffStats('abc', 'abcdef');
  assert.equal(st.a.chars, 3);
  assert.equal(st.b.chars, 6);
});

// —— 真实 CLI 组合（不起子进程，直接走模块边界）——

test('optimize + makeRecord：历史记录能完整回放一次优化', () => {
  const r = optimize('帮我写周报，给老板看', { goal: 'concise' });
  const rec = makeRecord({
    input: '帮我写周报，给老板看', prompt: r.prompt, tier: r.meta.tier,
    taskType: r.intent.task_type, confidence: r.intent.confidence,
    costYuan: r.meta.llm?.costYuan ?? 0, totalMs: r.meta.totalMs, degraded: r.meta.degraded,
  });
  assert.equal(rec.tier, 'fast');
  assert.equal(rec.degraded, false);
  assert.ok(rec.prompt.includes('# 优化目标'));
  assert.ok(rec.id.length >= 8);
});
