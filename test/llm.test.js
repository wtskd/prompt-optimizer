// Standard 档测试：全部用假 provider / 假 fetch，零网络、零花费。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { optimize, optimizeAsync, STAGES_STANDARD } from '../src/pipeline.js';
import { resolveConfig, createProvider, estimateCost } from '../src/llm/provider.js';
import { parseAnalysis } from '../src/llm/analyze.js';

const okJson = (extra = {}) =>
  JSON.stringify({
    task_type: 'transform',
    confidence: 0.9,
    domain: 'content',
    deliverable_format: 'table',
    slots: { goal: { value: '把原文压缩到一半', confidence: 0.9, evidence: '压缩一下' } },
    ...extra,
  });

/** 假 provider：按顺序吐 payload；payload 可以是字符串（当 text）或 Error（当失败） */
const mockProvider = (payloads) => {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      const p = payloads[Math.min(calls.length - 1, payloads.length - 1)];
      if (p instanceof Error) throw p;
      return {
        text: typeof p === 'string' ? p : JSON.stringify(p),
        usage: { promptMiss: 1000, promptHit: 0, completion: 200 },
        cost: 0.0026,
        cached: false,
        model: 'mock',
      };
    },
  };
};

test('fast 档：完全同步、不碰 provider、meta.llm 为 null', () => {
  const p = mockProvider([okJson()]);
  const r = optimize('写一份周报，给老板看', { provider: p });
  assert.equal(p.calls.length, 0);
  assert.equal(r.meta.llmCalls, 0);
  assert.equal(r.meta.llm, null);
  assert.equal(r.meta.degraded, false);
});

test('standard 档：模型结果合并进意图与槽位，渲染仍走确定性路径', () => {
  const p = mockProvider([okJson()]);
  return optimizeAsync('把这段文字压缩一下', { tier: 'standard', provider: p }).then((r) => {
    assert.equal(p.calls.length, 1);
    assert.equal(r.meta.llm.status, 'ok');
    assert.equal(r.meta.degraded, false);
    assert.equal(r.meta.llmCalls, 1);
    assert.equal(r.intent.task_type, 'transform');
    assert.equal(r.intent.by, 'llm');
    assert.equal(r.intent.rules.task_type, r.ir.intent.rules.task_type);
    assert.equal(r.slots.deliverable_format.value, 'table');
    assert.equal(r.slots.deliverable_format.source, 'inferred');
    assert.ok(r.meta.llm.merged.applied.includes('goal'));
    assert.deepEqual(r.meta.stages, STAGES_STANDARD);
    assert.equal(r.violations.length, 0);
  });
});

test('模型不覆盖用户显式表达（优先级 100 > 模型推断）', async () => {
  const text = '把这段话压缩一下，翻译成英文';
  const fast = optimize(text);
  const p = mockProvider([
    okJson({ slots: { language: { value: '简体中文', confidence: 0.99, evidence: '编的' } } }),
  ]);
  const r = await optimizeAsync(text, { tier: 'standard', provider: p });
  assert.equal(r.slots.language.value, fast.slots.language.value, '显式语言必须原样保留');
  assert.equal(fast.slots.language.source, 'explicit');
  const blocked = r.meta.llm.merged.blocked.find((b) => b.slot === 'language');
  assert.ok(blocked, '必须记录被拦下的槽位（可解释性）');
  assert.equal(blocked.kept, 'en');
  assert.equal(blocked.proposed, '简体中文');
});

test('模型返回非法 JSON：降到规则层，但 meta 明确标注降级', async () => {
  const text = '把这段文字压缩一下';
  const fast = optimize(text);
  const p = mockProvider(['当然可以！我先帮你分析一下……']);
  const r = await optimizeAsync(text, { tier: 'standard', provider: p });
  assert.equal(r.meta.llm.status, 'failed');
  assert.equal(r.meta.llm.code, 'LLM_BAD_JSON');
  assert.equal(r.meta.degraded, true);
  assert.equal(r.intent.task_type, fast.intent.task_type, '降级后应与 fast 档一致');
  assert.ok(r.meta.llm.reason.length > 0);
});

test('task_type 不在本体里：整份补丁作废（不猜测）', async () => {
  const p = mockProvider([okJson({ task_type: 'summarize' })]);
  const r = await optimizeAsync('把这段文字压缩一下', { tier: 'standard', provider: p });
  assert.equal(r.meta.llm.status, 'failed');
  assert.equal(r.meta.llm.code, 'LLM_SCHEMA');
  assert.equal(r.meta.degraded, true);
});

test('未知槽位被丢弃，其余结论照常采用（边缘字段不牵连核心）', async () => {
  const p = mockProvider([
    okJson({
      task_type: 'plan',
      deliverable_format: 'checklist',
      slots: {
        goal: { value: '排出上线步骤', confidence: 0.88, evidence: '怎么上线' },
        nonsense: { value: 'x', confidence: 0.9 },
      },
    }),
  ]);
  const r = await optimizeAsync('这个功能怎么上线，我要步骤', { tier: 'standard', provider: p });
  assert.equal(r.meta.llm.status, 'ok');
  assert.equal(r.slots.nonsense, undefined);
  assert.ok(r.meta.llm.merged.skipped.some((s) => s.includes('nonsense')));
  assert.equal(r.intent.task_type, 'plan');
});

test('deep 档：明确报未实现，不静默降级', async () => {
  await assert.rejects(() => optimizeAsync('随便什么输入', { tier: 'deep' }), /deep 档尚未实现/);
});

test('缺 API key：明确报错，不偷偷走 fast 档', async () => {
  await assert.rejects(
    () => optimizeAsync('随便什么输入', { tier: 'standard', env: {} }),
    /LLM_CONFIG_MISSING/,
  );
});

test('sync optimize() 遇到 standard 档会报错并指向 optimizeAsync', () => {
  assert.throws(() => optimize('写一份周报', { tier: 'standard' }), /fast 档/);
});

test('磁盘缓存：同一输入第二次调用不再请求模型、不再花钱', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-cache-'));
  try {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: okJson() } }],
            usage: { prompt_tokens: 1000, completion_tokens: 200 },
          }),
      };
    };
    const cfg = { ok: true, provider: 'mock', apiKey: 'k', baseUrl: 'https://example.invalid/v1', model: 'deepseek-chat', timeoutMs: 5000 };
    const mk = () => createProvider(cfg, { fetchImpl, cacheDir: dir });

    const r1 = await optimizeAsync('把这段文字压缩一下', { tier: 'standard', provider: mk() });
    const r2 = await optimizeAsync('把这段文字压缩一下', { tier: 'standard', provider: mk() });

    assert.equal(fetchCalls, 1, '第二次必须命中缓存');
    assert.equal(r1.meta.llm.cached, false);
    assert.equal(r2.meta.llm.cached, true);
    assert.equal(r2.meta.llmCalls, 0);
    assert.ok(r1.meta.llm.costYuan > 0, '首次调用要算钱');
    assert.equal(r2.meta.llm.costYuan, 0, '缓存命中不花钱');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('预算护栏：达到上限后拒绝继续调用', async () => {
  const cfg = { ok: true, provider: 'mock', apiKey: 'k', baseUrl: 'https://example.invalid/v1', model: 'deepseek-chat', timeoutMs: 5000 };
  const p = createProvider(cfg, { maxCostYuan: 0, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
  await assert.rejects(() => p.chat({ system: 's', user: 'u' }), (e) => e.code === 'LLM_BUDGET_EXCEEDED');
});

test('成本估算：命中缓存与未命中分开计价', () => {
  assert.equal(estimateCost({ promptMiss: 1_000_000, promptHit: 0, completion: 0 }, 'deepseek-chat'), 2);
  assert.equal(estimateCost({ promptMiss: 0, promptHit: 1_000_000, completion: 0 }, 'deepseek-chat'), 0.2);
  assert.equal(estimateCost({ promptMiss: 0, promptHit: 0, completion: 1_000_000 }, 'deepseek-chat'), 3);
});

test('本体校验：confidence 被夹到 0–1，缺少 evidence 会被记录', () => {
  const patch = parseAnalysis(
    JSON.stringify({ task_type: 'plan', confidence: 3, slots: { goal: { value: 'x', confidence: -1 } } }),
  );
  assert.equal(patch.confidence, 1);
  assert.equal(patch.slots.goal.confidence, 0);
  assert.ok(patch.skipped.some((s) => s.includes('evidence')));
});

test('resolveConfig：无 key 时给出可执行的提示，有 key 时给出端点', () => {
  const bad = resolveConfig({});
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /DEEPSEEK_API_KEY/);
  const good = resolveConfig({ DEEPSEEK_API_KEY: 'sk-test' });
  assert.equal(good.ok, true);
  assert.equal(good.provider, 'deepseek');
  assert.equal(good.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(good.model, 'deepseek-chat');
});

test('HTTP 传输层：真实 fetch 打到本机假端点，验证请求体与响应解析（不花钱）', async () => {
  const { createServer } = await import('node:http');
  let received = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      received = {
        auth: req.headers.authorization,
        url: req.url,
        model: parsed.model,
        responseFormat: parsed.response_format,
        roles: parsed.messages.map((m) => m.role),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: okJson() } }],
          usage: { prompt_tokens: 800, completion_tokens: 120 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'po-http-'));
  try {
    const cfg = { ok: true, provider: 'local', apiKey: 'sk-local', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'deepseek-chat', timeoutMs: 5000 };
    const p = createProvider(cfg, { cacheDir: dir });
    const res = await p.chat({ system: 'SYS', user: 'USR' });

    assert.equal(received.url, '/v1/chat/completions');
    assert.equal(received.auth, 'Bearer sk-local');
    assert.equal(received.model, 'deepseek-chat');
    assert.deepEqual(received.roles, ['system', 'user']);
    assert.deepEqual(received.responseFormat, { type: 'json_object' });
    assert.match(res.text, /"task_type":"transform"/);
    assert.deepEqual(res.usage, { promptMiss: 800, promptHit: 0, completion: 120, total: 920 });
    assert.ok(res.cost > 0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
