// Standard 档接入层（设计文档 §7 S1b、§8.2 模型适配）：
//   配置解析 → HTTP 传输（OpenAI 兼容） → 磁盘缓存 → 成本估算与预算护栏。
// 三条硬约束：①钱要看得见、要能设上限；②同样的输入重复调用不再花钱（缓存）；
// ③任何失败都带 code 抛出，绝不静默降级成 Fast 档。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fnv1a } from '../util.js';

/** 带错误码的 LLM 异常：调用方必须显式处理（禁止 catch 后当没发生） */
export class LlmError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const llmError = (code, message, extra = {}) => new LlmError(code, message, extra);

/** 常见端点预设（都走 OpenAI 兼容协议） */
export const ENDPOINT_PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
};

/**
 * 估算单价（元 / 百万 token）。**这是护栏用的近似值，务必按你自己的账单核对。**
 * inHit = 命中上下文缓存的输入价（DeepSeek 比 miss 便宜约 10 倍）。
 */
export const PRICES = {
  'deepseek-chat': { inMiss: 2, inHit: 0.2, out: 3 },
  'deepseek-reasoner': { inMiss: 4, inHit: 0.4, out: 16 },
  'gpt-4o-mini': { inMiss: 1.1, inHit: 1.1, out: 4.4 },
};
export const DEFAULT_PRICE = { inMiss: 2, inHit: 0.2, out: 3 };

/** 把各家 usage 字段归一化后估算本次调用成本（元，6 位小数） */
export function estimateCost(usage, model) {
  const p = PRICES[model] ?? DEFAULT_PRICE;
  const inMiss = usage?.promptMiss ?? usage?.prompt_tokens ?? 0;
  const inHit = usage?.promptHit ?? 0;
  const out = usage?.completion ?? usage?.completion_tokens ?? 0;
  const yuan = (inMiss * p.inMiss + inHit * p.inHit + out * p.out) / 1e6;
  return Number(yuan.toFixed(6));
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return { promptMiss: 0, promptHit: 0, completion: 0, total: 0 };
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - hit);
  const completion = u.completion_tokens ?? 0;
  return { promptMiss: miss, promptHit: hit, completion, total: u.total_tokens ?? miss + hit + completion };
}

/**
 * 逐块读取 SSE 流（OpenAI 兼容协议：`data: {...}` 行，终止于 `data: [DONE]`）。
 * 每个 content 增量回调 onDelta(delta)（回调抛错视为消费方放弃本次结果，向上传播）；
 * 非法 JSON 行按铁律 4 计入 skippedEvents 留痕，不中断读取。
 */
async function consumeStream(res, { onDelta }) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    throw llmError('LLM_BAD_RESPONSE', '响应没有可读流，无法流式接收');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let usage = null;
  let skippedEvents = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        skippedEvents++;
        continue;
      }
      if (evt?.usage) usage = normalizeUsage(evt.usage);
      const delta = evt?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        text += delta;
        if (onDelta) onDelta(delta);
      }
    }
  }
  return { text, usage, skippedEvents };
}

/**
 * 从环境变量解析模型配置。优先级：PROMPT_OPTIMIZER_* > DEEPSEEK_API_KEY > OPENAI_API_KEY。
 * @returns {{ok:true,provider:string,apiKey:string,baseUrl:string,model:string,timeoutMs:number}
 *          |{ok:false,reason:string}}
 */
export function resolveConfig(env = process.env) {
  const e = env ?? {};
  const pick = (...names) => {
    for (const n of names) {
      const v = e[n];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  const genericKey = pick('PROMPT_OPTIMIZER_API_KEY');
  const key = genericKey ?? pick('DEEPSEEK_API_KEY', 'OPENAI_API_KEY');
  if (!key) {
    return {
      ok: false,
      reason:
        '缺少 API key。设置 DEEPSEEK_API_KEY（或 OPENAI_API_KEY / PROMPT_OPTIMIZER_API_KEY）后重试：'
        + '  export DEEPSEEK_API_KEY=sk-xxx',
    };
  }
  const provider = genericKey ? pick('PROMPT_OPTIMIZER_PROVIDER') ?? 'deepseek' : (pick('DEEPSEEK_API_KEY') ? 'deepseek' : 'openai');
  const preset = ENDPOINT_PRESETS[provider] ?? ENDPOINT_PRESETS.deepseek;
  return {
    ok: true,
    provider,
    apiKey: key,
    baseUrl: (pick('PROMPT_OPTIMIZER_BASE_URL') ?? preset.baseUrl).replace(/\/+$/, ''),
    model: pick('PROMPT_OPTIMIZER_MODEL') ?? preset.model,
    timeoutMs: Number(pick('PROMPT_OPTIMIZER_TIMEOUT_MS') ?? 30000),
  };
}

/**
 * 建一个 provider。默认走 HTTP + 磁盘缓存；测试用 fetchImpl 注入假模型，零网络零花费。
 * @param {object} cfg resolveConfig 的成功结果
 * @param {{fetchImpl?:Function, cacheDir?:string, cache?:boolean, maxCostYuan?:number}} [opts]
 */
export function createProvider(cfg, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const cacheDir = opts.cacheDir ?? resolve(process.cwd(), '.cache/llm');
  const useCache = opts.cache !== false && process.env.PROMPT_OPTIMIZER_NO_CACHE !== '1';
  const maxCostYuan = opts.maxCostYuan ?? Number(process.env.PROMPT_OPTIMIZER_MAX_COST_YUAN ?? 0.5);
  let calls = 0;
  let hits = 0;
  let spent = 0;

  async function chat({ system, user, temperature = 0, maxTokens = 900, json = true, stream = false, onDelta = null }) {
    if (!cfg?.ok) throw llmError('LLM_CONFIG_MISSING', cfg?.reason ?? '模型未配置');
    // baseUrl 也进 key：本地假端点/自建网关绝不能与真实端点共用缓存条目
    const cacheKey = fnv1a(JSON.stringify([cfg.baseUrl, cfg.model, temperature, maxTokens, system, user]));
    const cachePath = resolve(cacheDir, `${cacheKey}.json`);

    if (useCache && existsSync(cachePath)) {
      try {
        const rec = JSON.parse(readFileSync(cachePath, 'utf8'));
        if (typeof rec?.text === 'string' && rec.text.trim()) {
          hits++;
          return { ...rec, cached: true, cost: 0 };
        }
      } catch {
        // 缓存损坏就当未命中，不阻塞主流程
      }
    }

    if (spent >= maxCostYuan) {
      throw llmError(
        'LLM_BUDGET_EXCEEDED',
        `本次会话已花 ¥${spent.toFixed(4)}，达到上限 ¥${maxCostYuan}；不再调用模型（改 maxCostYuan 或重跑）。`,
        { spent, maxCostYuan },
      );
    }

    const body = {
      model: cfg.model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    };
    if (json) body.response_format = { type: 'json_object' };
    // include_usage：OpenAI 兼容协议下，最后一个 SSE chunk 会带 usage，成本护栏靠它
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    let res;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(cfg.timeoutMs) : undefined,
      });
    } catch (e) {
      const code = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'LLM_TIMEOUT' : 'LLM_NETWORK';
      throw llmError(code, `调用模型失败（${code}）：${e?.message ?? e}`);
    }

    let text;
    let usage;
    let streamExtra = null;
    if (stream) {
      if (!res.ok) {
        const raw = await res.text();
        throw llmError(`LLM_HTTP_${res.status}`, `模型返回 HTTP ${res.status}：${raw.slice(0, 200)}`, { status: res.status });
      }
      const s = await consumeStream(res, { onDelta });
      text = s.text;
      usage = s.usage ?? normalizeUsage(null);
      streamExtra = { skippedEvents: s.skippedEvents };
    } else {
      const raw = await res.text();
      if (!res.ok) {
        throw llmError(`LLM_HTTP_${res.status}`, `模型返回 HTTP ${res.status}：${raw.slice(0, 200)}`, { status: res.status });
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        throw llmError('LLM_BAD_RESPONSE', `响应不是合法 JSON：${e.message}`);
      }
      text = data?.choices?.[0]?.message?.content;
      usage = normalizeUsage(data.usage);
    }
    if (typeof text !== 'string' || !text.trim()) throw llmError('LLM_BAD_RESPONSE', '模型返回了空内容');

    const cost = estimateCost(usage, cfg.model);
    spent = Number((spent + cost).toFixed(6));
    calls++;

    const rec = { text, usage, model: cfg.model, provider: cfg.provider ?? null, at: new Date().toISOString() };
    if (useCache) {
      try {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify(rec), 'utf8');
      } catch {
        // 缓存写不进去不影响结果
      }
    }
    return { ...rec, ...streamExtra, cached: false, cost };
  }

  return {
    chat,
    config: cfg,
    stats: () => ({ calls, hits, spent, maxCostYuan, cacheDir, cacheEnabled: useCache }),
  };
}
