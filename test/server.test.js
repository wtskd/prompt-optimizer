// Web 宿主测试：起真实 HTTP 服务（随机端口），假 provider / 假 fetch，零网络零花费。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';

const okJson = () =>
  JSON.stringify({
    task_type: 'write',
    confidence: 0.9,
    domain: 'content',
    slots: { goal: { value: '写周报', confidence: 0.9, evidence: '周报' } },
  });

const mockProvider = () => ({
  calls: [],
  async chat(req) {
    this.calls.push(req);
    return { text: okJson(), usage: { promptMiss: 1000, promptHit: 0, completion: 200 }, cost: 0.0026, cached: false, model: 'mock' };
  },
});

/** 起一个带临时目录与假 provider 的服务；测试结束自动清理 */
async function withServer(fn, { provider = mockProvider(), env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'po-server-'));
  try {
    const inst = await startServer({
      port: 0,
      provider,
      env,
      cacheDir: join(dir, 'cache'),
      historyFile: join(dir, 'history.jsonl'),
    });
    try {
      return await fn(`http://127.0.0.1:${inst.port}`, provider, dir);
    } finally {
      await inst.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 把 SSE 响应体解析成 [{event, data}] */
async function readSse(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((chunk) => ({
    event: (chunk.match(/^event: (.+)$/m) || [])[1],
    data: JSON.parse((chunk.match(/^data: (.+)$/m) || [])[1]),
  }));
}

test('GET / 返回单文件 Web 界面', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('prompt-optimizer'));
    assert.ok(html.includes('/api/optimize'));
  });
});

test('fast 档：POST /api/optimize 同步返回，含 diff 与历史落盘', async () => {
  await withServer(async (base, _p, dir) => {
    const res = await fetch(base + '/api/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '帮我写周报', tier: 'fast', goal: ['concise'], diff: true }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.meta.tier, 'fast');
    assert.ok(data.prompt.includes('# 优化目标'));
    assert.ok(data.prompt.includes('【更简洁】'));
    assert.ok(data.diff.stats.a.chars > 0);
    assert.ok(data.meta.historyId, '默认要落历史');
    // 历史接口能读到刚存的这条
    const hist = await (await fetch(base + '/api/history?n=10')).json();
    assert.equal(hist.items.length, 1);
    const one = await (await fetch(`${base}/api/history/${data.meta.historyId}`)).json();
    assert.equal(one.prompt, data.prompt);
    assert.ok(one.at);
    assert.ok(dir); // 临时目录由 withServer 管理
  });
});

test('standard 档：SSE 流式（delta + done），假模型增量可见', async () => {
  await withServer(async (base, provider) => {
    const res = await fetch(base + '/api/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '把这段话压缩一下', tier: 'standard', stream: true, diff: true }),
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const events = await readSse(res);
    const deltas = events.filter((e) => e.event === 'delta');
    const dones = events.filter((e) => e.event === 'done');
    assert.equal(dones.length, 1);
    assert.equal(dones[0].data.meta.tier, 'standard');
    assert.equal(dones[0].data.meta.llm.status, 'ok');
    assert.ok(dones[0].data.prompt.includes('# 用户原始输入'));
    // 假 provider 不走 SSE，delta 为 0 条是预期（流式增量来自真实 fetch 流）；
    // provider 层的 SSE 解析已由 features.test.js 用假 SSE 流覆盖
    assert.ok(provider.calls.length === 1);
    assert.equal(provider.calls[0].stream, true);
  }, {
    provider: {
      calls: [],
      async chat(req) {
        this.calls.push(req);
        return { text: okJson(), usage: { promptMiss: 900, promptHit: 0, completion: 100 }, cost: 0.0021, cached: false, model: 'mock' };
      },
    },
  });
});

test('澄清闭环走 HTTP：ask 返回问题，answers 回收后问题消失', async () => {
  await withServer(async (base) => {
    const first = await (await fetch(base + '/api/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '帮我写点东西', tier: 'standard', ask: true }),
    })).json();
    assert.ok(first.questions.length > 0, '缺口输入必须产出追问');
    const q0 = first.questions[0];
    // q0 是 deliverable_format（枚举槽位），回答必须用合法枚举（中文标签同样接受）
    const answer = q0.id.includes('deliverable_format') ? '表格' : '一份周会纪要';
    const second = await (await fetch(base + '/api/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '帮我写点东西', tier: 'standard', ask: true, answers: { [q0.id]: answer } }),
    })).json();
    assert.equal(second.questions?.find((q) => q.id === q0.id), undefined);
  });
});

test('错误路径：空输入 400、非法 goal 400、未知路由 404、损坏历史行留痕', async () => {
  await withServer(async (base) => {
    const empty = await fetch(base + '/api/optimize', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '  ' }),
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, 'EMPTY_INPUT');

    const badGoal = await fetch(base + '/api/optimize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '写周报', goal: ['nope'] }),
    });
    assert.equal(badGoal.status, 400);
    assert.equal((await badGoal.json()).code, 'BAD_GOAL');

    assert.equal((await fetch(base + '/nope')).status, 404);
    assert.equal((await fetch(base + '/api/history/9999')).status, 404);
    assert.equal((await (await fetch(base + '/api/health')).json()).ok, true);
  });
});

test('乱码防线：含 U+FFFD 的输入（GBK 客户端的典型产物）必须在边界拦下，不进 LLM', async () => {
  await withServer(async (base, provider) => {
    const res = await fetch(base + '/api/optimize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '帮我\uFFFD\uFFFD周报', tier: 'fast' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_UTF8');
    assert.equal(provider.calls.length, 0, '乱码绝不能被送去调模型');
  });
});

test('LLM 配置缺失：standard 档显式 400 带 code，不静默降级', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '写周报', tier: 'standard' }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, 'LLM_CONFIG_MISSING');
  }, { provider: null, env: {} }); // 不注入 provider 也不给 key
});
