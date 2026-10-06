// 阶段编排 S1…S8（设计文档 §7）。三档位分工是刻意的：
//   fast     —— 0 次 LLM 调用，纯规则 + 模板（同步 optimize）
//   standard —— 1 次 LLM 调用做「意图 + 槽位」分析，之后 S3–S8 仍是确定性代码（异步 optimizeAsync）
//   deep     —— 尚未实现，明确报错，不做静默降级
import { TIERS } from './schema.js';
import { createIR, validateIR } from './ir.js';
import { detectIntent } from './intent.js';
import { extractSlots } from './slots.js';
import { runClarificationRound } from './clarify.js';
import { runRules } from './rules.js';
import { detectConflicts } from './conflict.js';
import { buildContract } from './contract.js';
import { renderPrompt } from './render.js';
import { hashObject } from './util.js';
import { resolveConfig, createProvider } from './llm/provider.js';
import { buildAnalysisMessages, parseAnalysis, applyAnalysis } from './llm/analyze.js';

export const STAGES = ['S1_intent', 'S2_slots', 'S3_clarify', 'S4_rules', 'S5_conflict', 'S6_contract', 'S7_render', 'S8_validate'];

/** standard 档真正跑的阶段（比 fast 多一步 LLM 分析） */
export const STAGES_STANDARD = ['S1_intent', 'S2_slots', 'S1b_llm_analyze', ...STAGES.slice(2)];

/**
 * 同步核心：给定（可选的）LLM 补丁，跑完 S1–S8。
 * @param {string} rawText
 * @param {object} opts answers（可选）= { 问题 id 或槽位 id → 回答字符串 }，在 S3 澄清层定稿前合入 IR
 * @param {null|{status:string,patch?:object,ms?:number,cached?:boolean,cost?:number,model?:string,usage?:object,code?:string,reason?:string}} llm
 */
function runPipeline(rawText, opts, llm = null) {
  const startedAt = Date.now();
  const tier = opts.tier ?? 'fast';
  const ir = createIR(rawText, opts);
  const stage = (name, fn) => {
    const t = Date.now();
    const out = fn();
    ir.trace.push({ stage: name, ms: Date.now() - t });
    return out;
  };

  // 规则层永远先跑：它是 LLM 失败时的兜底，也是 LLM 结果的下界
  ir.intent = stage('S1_intent', () => detectIntent(ir.source.text));
  ir.slots = stage('S2_slots', () => extractSlots(ir.source.text, ir.intent, ir));

  let merged = null;
  if (llm) {
    ir.trace.push({ stage: 'S1b_llm_analyze', ms: llm.ms ?? 0 });
    if (llm.status === 'ok') merged = applyAnalysis(ir, llm.patch, { model: llm.model ?? null });
  }

  // S3 是澄清层的唯一定稿点：先把用户回答（opts.answers）合入 IR，再据此产出问题与假设。
  // 被回答的槽位 → source=explicit/confidence=1 → 缺口评分归零 → 不再追问、不再成为假设。
  const clar = stage('S3_clarify', () =>
    runClarificationRound(ir, { ask: opts.ask === true, answers: opts.answers ?? null }));
  ir.questions = clar.questions;
  ir.assumptions = clar.assumptions;
  stage('S4_rules', () => runRules(ir));
  ir.conflicts = stage('S5_conflict', () => detectConflicts(ir));
  ir.contract = stage('S6_contract', () => buildContract(ir));
  const prompt = stage('S7_render', () => renderPrompt(ir, opts.recipeId ?? 'fast/default'));
  const violations = stage('S8_validate', () => validateIR(ir, prompt));

  return {
    prompt,
    ir,
    intent: ir.intent,
    slots: ir.slots,
    contract: ir.contract,
    questions: ir.questions,
    assumptions: ir.assumptions,
    conflicts: ir.conflicts,
    violations,
    meta: {
      ok: violations.length === 0,
      tier,
      llmCalls: llm ? (llm.cached ? 0 : 1) : 0,
      llmBudgetCalls: TIERS[tier].llmCalls,
      latencyBudgetMs: TIERS[tier].latencyBudgetMs,
      // ms = 本地计算耗时；totalMs = 用户实际等待（含 LLM 往返）。延迟预算要按 totalMs 看
      ms: Date.now() - startedAt,
      totalMs: Date.now() - startedAt + (llm?.ms ?? 0),
      sourceHash: ir.source.hash,
      promptHash: hashObject(prompt),
      // 多轮澄清闭环的留痕：无 answers 时为 null（既有路径逐字节不变）
      clarify: ir.clarify ?? null,
      goal: ir.options.goal,
      language: ir.slots.language?.value ?? ir.options.locale,
      stages: ir.trace.map((t) => t.stage),
      llm: llm
        ? {
            status: llm.status,
            code: llm.code ?? null,
            reason: llm.reason ?? null,
            model: llm.model ?? null,
            cached: llm.cached === true,
            costYuan: llm.cost ?? 0,
            usage: llm.usage ?? null,
            ms: llm.ms ?? null,
            merged,
          }
        : null,
      degraded: llm ? llm.status !== 'ok' : false,
    },
  };
}

/**
 * Fast 档入口（同步，0 次 LLM 调用）。
 * 非 fast 档一律抛错——要跑模型请用 optimizeAsync，避免"以为跑了模型其实没跑"。
 * @param {string} rawText
 * @param {object} [opts] 含 answers：{ 问题 id（q_<slot>）或槽位 id → 回答字符串 }；
 *   回答在澄清层定稿前合入 IR（source=explicit），并重新渲染一次，不会因此多调一次 LLM。
 */
export function optimize(rawText, opts = {}) {
  const tier = opts.tier ?? 'fast';
  if (!TIERS[tier]) throw new Error(`未知档位：${tier}`);
  if (tier !== 'fast') {
    throw new Error(
      `${tier} 档要调用模型、是异步的：请用 await optimizeAsync(text, { tier: '${tier}' })；`
        + 'optimize() 只跑 fast 档，不做静默降级。',
    );
  }
  return runPipeline(rawText, opts, null);
}

/**
 * Standard 档入口（异步，1 次 LLM 调用；命中缓存则 0 次）。
 * 模型只负责「看懂」，渲染/契约/冲突消解仍由确定性代码产出，因此结果可回放、可 diff。
 * 模型失败不会静默退回规则层：meta.degraded=true 且带 code/reason。
 * @param {string} rawText
 * @param {{tier?:string,provider?:object,env?:object,maxTokens?:number,maxCostYuan?:number,
 *          cacheDir?:string,fetchImpl?:Function,targetModel?:string,ask?:boolean,locale?:string,
 *          answers?:object,goal?:string|Array<string>,stream?:boolean,onDelta?:Function}} opts
 *   answers 同 optimize()：答案来自用户，不会触发第二次 LLM 调用；
 *   goal：优化目标 id 列表（见 goals.js，如 'concise,format'），只影响渲染层；
 *   stream+onDelta：流式接收 LLM 分析增量（standard 档），结果与成本口径不变。
 */
export async function optimizeAsync(rawText, opts = {}) {
  const tier = opts.tier ?? 'standard';
  if (!TIERS[tier]) throw new Error(`未知档位：${tier}`);
  if (tier === 'fast') return runPipeline(rawText, { ...opts, tier }, null);
  if (tier === 'deep') {
    throw new Error('deep 档尚未实现（需要 3–5 次调用与多轮自检）：请用 fast 或 standard，不做静默降级。');
  }

  let provider = opts.provider ?? null;
  if (!provider) {
    const cfg = resolveConfig(opts.env ?? process.env);
    if (!cfg.ok) throw new Error(`LLM_CONFIG_MISSING：${cfg.reason}`);
    provider = createProvider(cfg, opts);
  }

  const started = Date.now();
  let llm;
  try {
    const { system, user } = buildAnalysisMessages(rawText);
    const res = await provider.chat({
      system,
      user,
      maxTokens: opts.maxTokens ?? 900,
      // 流式（opts.stream + opts.onDelta）：分析过程逐段推给宿主；结果与缓存/成本口径不变
      stream: opts.stream === true,
      onDelta: typeof opts.onDelta === 'function' ? opts.onDelta : null,
    });
    const patch = parseAnalysis(res.text);
    llm = {
      status: 'ok',
      patch,
      ms: Date.now() - started,
      cached: res.cached === true,
      cost: res.cost ?? 0,
      model: res.model ?? null,
      usage: res.usage ?? null,
    };
  } catch (e) {
    // 降级可以，静默不可以：错误码与原因一路带到 meta.llm
    llm = {
      status: 'failed',
      code: e?.code ?? 'LLM_ERROR',
      reason: e?.message ?? String(e),
      ms: Date.now() - started,
      cached: false,
      cost: 0,
      model: null,
      usage: null,
    };
  }
  return runPipeline(rawText, { ...opts, tier }, llm);
}
