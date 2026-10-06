// 阶段编排 S1…S8（设计文档 §7）。三档位分工是刻意的：
//   fast     —— 0 次 LLM 调用，纯规则 + 模板（同步 optimize）
//   standard —— 1 次 LLM 调用做「意图 + 槽位」分析，之后 S3–S8 仍是确定性代码（异步 optimizeAsync）
//   deep     —— 3 次 LLM 调用：基础分析 + 槽位补全 + 对抗性自检；每一跳独立缓存/计费/降级留痕
//               （llmCalls 预算 4，留一跳余量），渲染与契约仍 100% 确定性代码
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
import { resolveConfig, createProvider, safeEnv } from './llm/provider.js';
import { buildAnalysisMessages, parseAnalysis, applyAnalysis } from './llm/analyze.js';
import { buildEnrichMessages, parseEnrichment, buildStateSnapshot, buildVerifyMessages, parseVerdict, gateRevision } from './llm/deep.js';

export const STAGES = ['S1_intent', 'S2_slots', 'S3_clarify', 'S4_rules', 'S5_conflict', 'S6_contract', 'S7_render', 'S8_validate'];

/** standard 档真正跑的阶段（比 fast 多一步 LLM 分析） */
export const STAGES_STANDARD = ['S1_intent', 'S2_slots', 'S1b_llm_analyze', ...STAGES.slice(2)];

/** deep 档：在 standard 的基础上多两跳——槽位补全（S1c）与对抗性自检（S1d） */
export const STAGES_DEEP = ['S1_intent', 'S2_slots', 'S1b_llm_analyze', 'S1c_llm_enrich', 'S1d_llm_verify', ...STAGES.slice(2)];

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
  // Deep 档追加两跳（补丁在 optimizeAsync 里已取回，这里只是确定性合并）。
  // 留痕口径：只要该跳真正执行过（无论成败）就进阶段轨迹；合并只在补丁合法时发生。
  const deep = llm?.deep ?? null;
  let mergedEnrich = null;
  if (deep?.enrich) {
    ir.trace.push({ stage: 'S1c_llm_enrich', ms: deep.enrich.ms ?? 0 });
    if (deep.enrich.status === 'ok') {
      mergedEnrich = applyAnalysis(ir, deep.enrich.patch, { updateIntent: false, model: deep.enrich.model ?? null });
    }
  }
  let mergedVerify = null;
  if (deep?.verify) {
    ir.trace.push({ stage: 'S1d_llm_verify', ms: deep.verify.ms ?? 0 });
    if (deep.verify.revision) {
      mergedVerify = applyAnalysis(ir, deep.verify.revision, { updateIntent: true, model: deep.verify.model ?? null });
    }
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

  // deep 档实际发生的非缓存调用数（含三跳）；standard 保持旧口径（0 或 1）
  const deepCallCount = deep
    ? [llm, deep.enrich, deep.verify].filter((p) => p && p.status === 'ok' && !p.cached).length
    : 0;

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
      llmCalls: llm ? (deep ? deepCallCount : (llm.cached ? 0 : 1)) : 0,
      llmBudgetCalls: TIERS[tier].llmCalls,
      latencyBudgetMs: TIERS[tier].latencyBudgetMs,
      // ms = 本地计算耗时；totalMs = 用户实际等待（含全部 LLM 往返：deep 档 = 三跳之和）。延迟预算按 totalMs 看
      ms: Date.now() - startedAt,
      totalMs:
        Date.now() - startedAt +
        (llm?.ms ?? 0) +
        (llm?.deep ? (llm.deep.enrich?.ms ?? 0) + (llm.deep.verify?.ms ?? 0) : 0),
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
            deep: deep
              ? {
                  skipped: deep.skipped === true,
                  enrich: deep.enrich
                    ? {
                        status: deep.enrich.status,
                        code: deep.enrich.code ?? null,
                        reason: deep.enrich.reason ?? null,
                        ms: deep.enrich.ms ?? null,
                        costYuan: deep.enrich.cost ?? 0,
                        cached: deep.enrich.cached === true,
                        model: deep.enrich.model ?? null,
                        skippedEvents: deep.enrich.skippedEvents ?? 0,
                        merged: mergedEnrich,
                      }
                    : null,
                  verify: deep.verify
                    ? {
                        status: deep.verify.status,
                        code: deep.verify.code ?? null,
                        reason: deep.verify.reason ?? null,
                        ms: deep.verify.ms ?? null,
                        costYuan: deep.verify.cost ?? 0,
                        cached: deep.verify.cached === true,
                        model: deep.verify.model ?? null,
                        verdict: deep.verify.verdict ?? null,
                        issues: deep.verify.issues ?? [],
                        revisionApplied: !!deep.verify.revision,
                        revisionRejected: deep.verify.revisionRejected ?? null,
                        merged: mergedVerify,
                      }
                    : null,
                }
              : null,
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

  let provider = opts.provider ?? null;
  if (!provider) {
    const cfg = resolveConfig(opts.env ?? safeEnv());
    if (!cfg.ok) throw new Error(`LLM_CONFIG_MISSING：${cfg.reason}`);
    provider = createProvider(cfg, opts);
  }

  // —— 第 1 跳：基础分析（与 standard 完全同源：同一提示词、同一缓存、同一校验器）——
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

  if (tier !== 'deep') return runPipeline(rawText, { ...opts, tier }, llm);

  // —— Deep 档：第 2 跳补全 + 第 3 跳自检。任何一跳失败都留痕继续，不做静默吞错；
  //     只有基础分析失败才算整体降级（deep.skipped，后续跳不再花钱）。
  const deep = { skipped: llm.status !== 'ok', enrich: null, verify: null };

  if (!deep.skipped) {
    const t2 = Date.now();
    try {
      const m = buildEnrichMessages(rawText, llm.patch.task_type, llm.patch);
      const res = await provider.chat({ system: m.system, user: m.user, maxTokens: 700 });
      const patch = parseEnrichment(res.text, llm.patch.task_type);
      deep.enrich = {
        status: 'ok', patch, ms: Date.now() - t2, cost: res.cost ?? 0,
        cached: res.cached === true, model: res.model ?? null, skippedEvents: res.skippedEvents ?? 0,
      };
    } catch (e) {
      deep.enrich = {
        status: 'failed', code: e?.code ?? 'LLM_ERROR', reason: e?.message ?? String(e),
        ms: Date.now() - t2, cost: 0, cached: false, model: null,
      };
    }

    // 自检跳看的是模型层的两跳合并视图（显式/规则层槽位由合并层守门，不进提示词）
    const t3 = Date.now();
    try {
      const snapshot = buildStateSnapshot(rawText, llm.patch, deep.enrich?.status === 'ok' ? deep.enrich.patch : null);
      const m = buildVerifyMessages(rawText, snapshot);
      const res = await provider.chat({ system: m.system, user: m.user, maxTokens: 500 });
      const verdict = parseVerdict(res.text);
      const { revision: _rawRevision, ...verdictClean } = verdict; // 原始 revision 不能直接进 meta：由下方门槛决定去留
      deep.verify = {
        status: 'ok', ...verdictClean, ms: Date.now() - t3, cost: res.cost ?? 0,
        cached: res.cached === true, model: res.model ?? null, skippedEvents: res.skippedEvents ?? 0,
      };
      const gate = gateRevision(verdict.revision, llm.patch.task_type);
      if (gate?.revision) {
        deep.verify.revision = {
          task_type: gate.revision.task_type,
          confidence: gate.revision.confidence,
          domain: llm.patch.domain,
          deliverable_format: null,
          slots: {},
          skipped: [],
          coerced: [],
        };
      } else if (gate?.rejected) {
        deep.verify.revisionRejected = gate.rejected;
      }
    } catch (e) {
      deep.verify = {
        status: 'failed', code: e?.code ?? 'LLM_ERROR', reason: e?.message ?? String(e),
        ms: Date.now() - t3, cost: 0, cached: false, model: null,
      };
    }
  }

  return runPipeline(rawText, { ...opts, tier }, { ...llm, deep });
}
