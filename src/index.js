// 公共 API
export { optimize, optimizeAsync, STAGES, STAGES_STANDARD, STAGES_DEEP } from './pipeline.js';
export { resolveConfig, createProvider, estimateCost, LlmError, PRICES } from './llm/provider.js';
export { buildAnalysisMessages, parseAnalysis, applyAnalysis, ANALYZE_SYSTEM } from './llm/analyze.js';
export { createIR, validateIR, canonicalIR, irHash, SLOT_SOURCES } from './ir.js';
export { detectIntent } from './intent.js';
export { extractSlots } from './slots.js';
export { planClarification } from './clarify.js';
export { RULES, runRules } from './rules.js';
export { detectConflicts, pickWinner, blockRank } from './conflict.js';
export { buildContract } from './contract.js';
export { renderPrompt, fmtValue } from './render.js';
export { SECTIONS, RECIPES, lintRecipe, lintTemplate, renderTemplate } from './templates.js';
export { appendTrace, traceRecord } from './trace.js';
export { GOALS, GOAL_IDS, resolveGoals } from './goals.js';
export { detectLanguage } from './lang.js';
export { diffLines, formatDiff, diffStats } from './diff.js';
export { copyText } from './clipboard.js';
export {
  DEFAULT_HISTORY_FILE, makeRecord, appendHistory, readHistory, listHistory, showHistory, clearHistory,
} from './history.js';
export * from './schema.js';
