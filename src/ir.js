// PromptIR：贯穿全流程的统一中间表示（设计文档 T2）。
// 约定：原文只读、产出物全部可序列化、时序信息不进入指纹。
import { VERSION } from './schema.js';
import { fnv1a, hashObject } from './util.js';
import { detectLanguage } from './lang.js';
import { resolveGoals } from './goals.js';

export const SLOT_SOURCES = ['explicit', 'inferred', 'assumed', 'default'];

export function createIR(rawText, opts = {}) {
  const text = String(rawText ?? '');
  // 语言一致性：用户没显式给 locale 时，跟随输入语言（英文输入不再默认按中文渲染）
  const detected = opts.locale ? null : detectLanguage(text);
  return {
    version: VERSION,
    source: { text, hash: fnv1a(text.trim()) },
    options: {
      tier: opts.tier ?? 'fast',
      targetModel: opts.targetModel ?? 'generic',
      locale: opts.locale ?? detected ?? 'zh-CN',
      languageDetected: detected,
      goal: resolveGoals(opts.goal),
      ask: opts.ask === true,
    },
    intent: null,
    slots: {},
    decisions: [],
    assumptions: [],
    questions: [],
    conflicts: [],
    blocks: [],
    notes: [],
    contract: null,
    trace: [],
  };
}

/** 剔除时序与调试字段后的规范形态，用于指纹与回放 */
export function canonicalIR(ir) {
  const { trace, decisions, ...rest } = ir;
  return rest;
}

export const irHash = (ir) => hashObject(canonicalIR(ir));

/** 硬不变量检查（INV-1…INV-5），返回违规清单；空数组代表通过 */
export function validateIR(ir, rendered = '') {
  const v = [];
  const raw = ir.source?.text ?? '';
  if (!raw.trim()) v.push({ code: 'INV-1', message: '空输入无法优化' });
  if (fnv1a(raw.trim()) !== ir.source?.hash) {
    v.push({ code: 'INV-1', message: 'source.hash 与原文不一致：原文被改写' });
  }
  for (const [id, s] of Object.entries(ir.slots)) {
    if (!SLOT_SOURCES.includes(s?.source)) {
      v.push({ code: 'INV-2', message: `槽位 ${id} 的 source=${s?.source} 非法：禁止无来源取值` });
    }
    if (s?.value === undefined) {
      v.push({ code: 'INV-2', message: `槽位 ${id} 有 source 但无 value` });
    }
  }
  for (const c of ir.conflicts) {
    if (!c.action || !c.reason) {
      v.push({ code: 'INV-3', message: `冲突 ${c.type} 缺少 reason/action：禁止静默消解` });
    }
  }
  if (ir.assumptions.length && rendered && !rendered.includes('假设')) {
    v.push({ code: 'INV-5', message: '存在假设但渲染结果未标注假设' });
  }
  if (rendered && raw.trim() && !rendered.includes(raw.trim())) {
    v.push({ code: 'INV-1b', message: '渲染结果未保留原始输入' });
  }
  return v;
}
