// 优化历史：JSONL 追加写入，一次优化一行。损坏行按铁律 4 计数暴露，绝不静默吞掉。
import { appendFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fnv1a } from './util.js';

export const DEFAULT_HISTORY_FILE = () => resolve(process.cwd(), '.prompt-optimizer', 'history.jsonl');

export function makeRecord({ input, prompt, tier, taskType, confidence, costYuan, totalMs, degraded }) {
  const at = new Date().toISOString();
  return {
    id: fnv1a(`${at}|${input}`),
    at,
    input: String(input ?? ''),
    prompt: String(prompt ?? ''),
    tier,
    taskType: taskType ?? null,
    confidence: confidence ?? null,
    costYuan: Number(costYuan ?? 0),
    totalMs: totalMs ?? null,
    degraded: degraded === true,
  };
}

/** 追加一条记录；返回写入了多少条（0 = 目录不可写，主流程不受影响） */
export function appendHistory(file, record) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return 1;
  } catch {
    return 0;
  }
}

/** 读全部记录；返回 { records, skipped }——skipped 是损坏行计数（带行号，可审计） */
export function readHistory(file) {
  if (!existsSync(file)) return { records: [], skipped: [] };
  const lines = readFileSync(file, 'utf8').split('\n');
  const records = [];
  const skipped = [];
  lines.forEach((line, idx) => {
    const t = line.trim();
    if (!t) return;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object' && typeof obj.id === 'string') records.push(obj);
      else skipped.push({ line: idx + 1, reason: '不是对象或缺 id 字段' });
    } catch {
      skipped.push({ line: idx + 1, reason: 'JSON 解析失败' });
    }
  });
  return { records, skipped };
}

/** 最近 n 条（时间正序编号，返回 [{no, record}]） */
export function listHistory(file, n = 20) {
  const { records } = readHistory(file);
  return records.slice(-n).map((record, i) => ({ no: records.length - Math.min(records.length, n) + i + 1, record }));
}

/** 按序号（1 起）或 id 前缀取单条；取不到返回 null */
export function showHistory(file, key) {
  const { records } = readHistory(file);
  const k = String(key ?? '').trim();
  if (/^\d+$/.test(k)) {
    const no = Number(k);
    return no >= 1 && no <= records.length ? records[no - 1] : null;
  }
  return records.find((r) => r.id.startsWith(k)) ?? null;
}

/** 清空历史（删除文件）；返回是否真的删了 */
export function clearHistory(file) {
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}
