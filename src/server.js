// 宿主集成 S-H1（设计文档 §7）：零依赖本地 Web 服务，验证"优化后提示词直接进下游"。
// 复用与 CLI 完全相同的管线/缓存/预算护栏；API key 只留在服务端环境变量里，绝不发给浏览器。
import { createServer as httpCreate } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimize, optimizeAsync } from './pipeline.js';
import { resolveGoals } from './goals.js';
import { diffLines, diffStats } from './diff.js';
import {
  DEFAULT_HISTORY_FILE, makeRecord, appendHistory, listHistory, showHistory, clearHistory,
} from './history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = () => readFileSync(join(__dirname, 'web', 'index.html'));

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** 读 JSON 请求体；超限/非法直接抛错（带 code），不做静默截断 */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolveP, rejectP) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        rejectP(Object.assign(new Error('请求体超过 1MB 上限'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      if (!raw.trim()) return resolveP({});
      try {
        resolveP(JSON.parse(raw));
      } catch {
        rejectP(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' }));
      }
    });
    req.on('error', rejectP);
  });
}

/**
 * 起一个 Web 宿主。
 * @param {{port?:number, host?:string, provider?:object, env?:object, cacheDir?:string,
 *          maxCostYuan?:number, historyFile?:string, saveHistory?:boolean}} opts
 *   provider/env/cacheDir 供测试注入假模型（零网络零花费）；生产路径全部走默认。
 * @returns {Promise<{server:object, port:number, close:Function}>}
 */
export function startServer(opts = {}) {
  const historyFile = opts.historyFile ?? DEFAULT_HISTORY_FILE();
  const saveHistory = opts.saveHistory !== false;
  const maxCostYuan = opts.maxCostYuan ?? Number(process.env.PROMPT_OPTIMIZER_MAX_COST_YUAN ?? 0.5);

  /** 每次请求独立解析配置/建 provider：key 只从服务端环境来；测试可注入假 provider */
  function runOpts(body, extra = {}) {
    return {
      tier: body.tier === 'standard' || body.tier === 'deep' ? body.tier : 'fast',
      targetModel: typeof body.model === 'string' && body.model ? body.model : 'generic',
      ask: body.ask === true,
      goal: body.goal ?? null,
      answers: body.answers && typeof body.answers === 'object' ? body.answers : null,
      maxCostYuan,
      provider: opts.provider ?? undefined,
      env: opts.env ?? undefined,
      cacheDir: opts.cacheDir ?? undefined,
      ...extra,
    };
  }

  function buildPayload(text, result, { wantDiff = false } = {}) {
    if (saveHistory) {
      const rec = makeRecord({
        input: text, prompt: result.prompt, tier: result.meta.tier,
        taskType: result.intent?.task_type ?? null, confidence: result.intent?.confidence ?? null,
        costYuan: result.meta.llm?.costYuan ?? 0, totalMs: result.meta.totalMs ?? result.meta.ms,
        degraded: result.meta.degraded === true,
      });
      if (appendHistory(historyFile, rec) === 1) result.meta.historyId = rec.id;
    }
    return {
      prompt: result.prompt,
      intent: result.intent,
      questions: result.questions,
      assumptions: result.assumptions,
      conflicts: result.conflicts,
      violations: result.violations,
      meta: result.meta,
      diff: wantDiff
        ? { changes: diffLines(text, result.prompt), stats: diffStats(text, result.prompt) }
        : null,
    };
  }

  async function handleOptimize(body, res) {
    const text = String(body?.text ?? '').trim();
    if (!text) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: '缺少输入文本（text）', code: 'EMPTY_INPUT' }));
      return;
    }
    // 乱码防线：客户端用错误编码（如 Windows 控制台把中文按 GBK 发出）会产生 U+FFFD；
    // 带着乱码去调 LLM 既浪费钱又产出错误分析，必须在边界拦下并报清楚原因
    if (text.includes('\uFFFD')) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({
        error: '输入含无效 UTF-8 序列（U+FFFD）：大概率是客户端用了 GBK 等非 UTF-8 编码发送。请以 UTF-8 重发。',
        code: 'INVALID_UTF8',
      }));
      return;
    }
    let goalIds;
    try {
      goalIds = resolveGoals(body.goal);
    } catch (e) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: e.message, code: 'BAD_GOAL' }));
      return;
    }
    const runConfig = runOpts(body, { goal: goalIds });
    const wantDiff = body.diff === true;

    // 流式（standard/deep 档）：SSE 推送分析增量 + 最终完整结果；fast 档同步跑，直接 done
    if (body.stream === true && runConfig.tier !== 'fast') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      try {
        const result = await optimizeAsync(text, {
          ...runConfig,
          stream: true,
          onDelta: (d) => sse('delta', { text: d }),
        });
        sse('done', buildPayload(text, result, { wantDiff }));
      } catch (e) {
        sse('error', { code: e?.code ?? 'SERVER_ERROR', message: e?.message ?? String(e) });
      }
      res.end();
      return;
    }

    try {
      const result = runConfig.tier === 'fast'
        ? optimize(text, runConfig)
        : await optimizeAsync(text, runConfig);
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(buildPayload(text, result, { wantDiff })));
    } catch (e) {
      // optimizeAsync 的配置错误是带 "LLM_CONFIG_MISSING：" 前缀的普通 Error，从消息里恢复 code
      const msg = String(e?.message ?? e);
      const code = e?.code ?? (msg.match(/^(LLM_[A-Z_]+)\s*[:：]/) ?? [])[1] ?? 'SERVER_ERROR';
      const status = code === 'LLM_CONFIG_MISSING' || code === 'BAD_GOAL' || code === 'EMPTY_INPUT' ? 400 : 502;
      res.writeHead(status, JSON_HEADERS);
      res.end(JSON.stringify({ error: e?.message ?? String(e), code }));
    }
  }

  const server = httpCreate(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(INDEX_HTML());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/optimize') {
        await handleOptimize(await readJsonBody(req), res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/history') {
        const n = Math.min(200, Math.max(1, Number(url.searchParams.get('n')) || 20));
        const items = listHistory(historyFile, n);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ items }));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/history/')) {
        const rec = showHistory(historyFile, decodeURIComponent(url.pathname.slice('/api/history/'.length)));
        if (!rec) {
          res.writeHead(404, JSON_HEADERS);
          res.end(JSON.stringify({ error: '历史里没有这条记录', code: 'HISTORY_NOT_FOUND' }));
          return;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(rec));
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/api/history') {
        const removed = clearHistory(historyFile);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ cleared: removed }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ error: e?.message ?? String(e), code: e?.code ?? 'SERVER_ERROR' }));
    }
  });

  return new Promise((resolveP) => {
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({
        server,
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// 直接运行：node src/server.js（PORT 环境变量可改端口，默认 8787）
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const port = Number(process.env.PORT) || 8787;
  const { port: actual } = await startServer({ port, host: process.env.HOST ?? '127.0.0.1' });
  console.log(`prompt-optimizer Web 宿主已启动：http://localhost:${actual}`);
  console.log('API key 从环境变量读取（DEEPSEEK_API_KEY 等），不会下发到浏览器。');
}
