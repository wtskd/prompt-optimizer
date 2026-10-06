// 轨迹落盘：一行一条 JSON，用于回放与归因（设计文档 §9 评测流水线的前置条件）
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendTrace(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

/** 从一次 optimize 结果中抽出可落盘的轨迹记录（不含全量 blocks，保持精简） */
export function traceRecord(result, extra = {}) {
  return {
    at: new Date().toISOString(),
    sourceHash: result.meta.sourceHash,
    promptHash: result.meta.promptHash,
    tier: result.meta.tier,
    ms: result.meta.ms,
    ok: result.meta.ok,
    intent: result.intent,
    decisions: result.ir.decisions,
    assumptions: result.assumptions,
    questions: result.questions,
    conflicts: result.conflicts,
    violations: result.violations,
    ...extra,
  };
}
