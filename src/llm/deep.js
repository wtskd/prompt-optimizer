// Deep 档的第 2/3 跳：槽位补全（enrich）与对抗性自检（verify）。
// 铁律：这三跳都只是"看懂"——第 1 跳复用 analyze.js 量过数字的 TASK_GUIDE（一字不改），
// 本文件的提示词是全新战场，效果数字必须来自从未跑过的干净留出集（ANNOTATION.md 口径）。
import { TASK_TYPES, SLOT_DEFS, DELIVERABLES, DOMAINS } from '../schema.js';
import { llmError } from './provider.js';
import { TASK_GUIDE, parseAnalysis } from './analyze.js';

const num = (v, fallback) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, Number(n.toFixed(3))));
};

const SLOT_ID_LIST = SLOT_DEFS.map((d) => d.id).join(' / ');

// —— 第 2 跳：槽位补全 ——

/** @param {string} text 原话 @param {string} taskType 已定稿的意图 @param {object} basePatch 基础分析补丁（用于列出已知槽位） */
export function buildEnrichMessages(text, taskType, basePatch) {
  const known = Object.keys(basePatch?.slots ?? {});
  const system = `你是提示词优化器的槽位补全器。基础分析已经完成，task_type 已定稿为「${taskType}」，你不得更改它（输出里照抄这个值即可）。

任务：只做一件事——对照下面已知的槽位清单，从用户原话里挖出基础分析**漏掉**的槽位；没有可补的就输出空 slots。

可填的槽位 id（只能填这些）：${SLOT_ID_LIST}

判断纪律：
- evidence 必须从用户原话里**逐字抄**一段片段，不得总结、不得改写、不得编造；
- 拿不准就不填，宁缺勿滥；填错槽位比漏掉更有害；
- deliverable_format 只能取：${DELIVERABLES.join(' / ')}，用户没要求形态就填 null；
- domain 只能取：${DOMAINS.join(' / ')}。

只输出一个 JSON 对象（结构与分析器完全相同），不要解释、不要 Markdown 代码块：
{"task_type":"${taskType}","confidence":0.0,"domain":"…","deliverable_format":null,"slots":{"槽位id":{"value":"…","confidence":0.0,"evidence":"原话片段"}}}`;
  const knownLine = known.length ? `已知的槽位：${known.join('、')}（不要重复给这些，除非你能给出明显更准的值）` : '基础分析没有给出任何槽位。';
  const user = `用户原始输入（逐字，含错别字与口语）：\n"""\n${String(text ?? '')}\n"""\n\n${knownLine}`;
  return { system, user };
}

/** 校验补全跳输出：结构走 parseAnalysis，意图必须与定稿一致（intent 合并层还有第二道闸） */
export function parseEnrichment(raw, expectedTaskType) {
  const patch = parseAnalysis(raw);
  if (patch.task_type !== expectedTaskType) {
    throw llmError('LLM_SCHEMA', `补全器输出 task_type=${patch.task_type}，与定稿 ${expectedTaskType} 不一致：补丁作废`);
  }
  return patch;
}

// —— 第 3 跳：对抗性自检 ——

/** 合并基础与补全两跳的模型层视图（verify 只需要看模型看到了什么；显式/规则层槽位由合并层守门） */
export function buildStateSnapshot(text, basePatch, enrichPatch) {
  const slots = {};
  for (const [id, s] of Object.entries(basePatch?.slots ?? {})) {
    slots[id] = { value: s.value, confidence: s.confidence, evidence: String(s.evidence ?? '').slice(0, 80) };
  }
  for (const [id, s] of Object.entries(enrichPatch?.slots ?? {})) {
    slots[id] = { value: s.value, confidence: s.confidence, evidence: String(s.evidence ?? '').slice(0, 80) };
  }
  return {
    task_type: enrichPatch?.task_type ?? basePatch?.task_type,
    confidence: basePatch?.confidence,
    domain: enrichPatch?.domain && enrichPatch.domain !== 'other' ? enrichPatch.domain : basePatch?.domain,
    deliverable_format: enrichPatch?.deliverable_format ?? basePatch?.deliverable_format ?? null,
    slots,
  };
}

export function buildVerifyMessages(text, snapshot) {
  const system = `你是提示词优化器的自检员，职责是对抗性校验——你的对手是前面所有分析跳的错误与编造。

当前结构化结果会以 JSON 给你，用户原话附后。你要做三件事：
1) 复核 task_type：按下方定义逐条判断，先命中者胜；
2) 找出槽位里的编造与矛盾：evidence 是否真的逐字来自原话、value 与 evidence 是否相符、槽位之间是否冲突；
3) 只在**确凿**时提出修订：revision 的 confidence 必须 ≥0.8，evidence 必须逐字来自原话。

task_type 定义（按顺序判断，先命中者胜）：
${TASK_GUIDE}

输出纪律：
- 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块：
{"verdict":"ok 或 revise","issues":[{"slot":"槽位id（可省略）","note":"问题说明，≤200字"}],"revision":{"task_type":"…","confidence":0.0,"evidence":"原话片段"}}
- verdict=ok 时省略 revision；issues 没有问题就是空数组；
- 不得编造原话里没有的事实；发现不了问题就说 ok，硬凑 issue 比漏报更有害。`;
  const user = `当前结构化结果：\n${JSON.stringify(snapshot, null, 2)}\n\n用户原始输入（逐字，含错别字与口语）：\n"""\n${String(text ?? '')}\n"""`;
  return { system, user };
}

/** 校验自检输出：verdict 必须是 ok|revise；revision 只有结构完整才采纳，残缺部分进 skipped */
export function parseVerdict(raw) {
  const text = String(raw ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw llmError('LLM_BAD_JSON', `自检员返回的不是合法 JSON：${e.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw llmError('LLM_BAD_JSON', '自检员返回的顶层不是 JSON 对象');
  }
  const skipped = [];
  if (obj.verdict !== 'ok' && obj.verdict !== 'revise') {
    throw llmError('LLM_SCHEMA', `自检员 verdict 非法：${JSON.stringify(obj.verdict)}（只允许 ok | revise）`);
  }

  const issues = [];
  if (Array.isArray(obj.issues)) {
    for (const it of obj.issues.slice(0, 10)) {
      if (it && typeof it === 'object' && typeof it.note === 'string' && it.note.trim()) {
        issues.push({
          slot: typeof it.slot === 'string' ? it.slot : null,
          note: it.note.trim().slice(0, 200),
        });
      } else if (it != null) {
        skipped.push(`issue=${JSON.stringify(it).slice(0, 60)}`);
      }
    }
    if (obj.issues.length > 10) skipped.push(`issues 超出 10 条，已截断`);
  } else if (obj.issues != null) {
    skipped.push('issues 应为数组');
  }

  let revision = null;
  if (obj.revision && typeof obj.revision === 'object' && !Array.isArray(obj.revision)) {
    const r = obj.revision;
    if (r.task_type != null || r.confidence != null) {
      if (!TASK_TYPES.includes(r.task_type)) {
        skipped.push(`revision.task_type=${JSON.stringify(r.task_type)}`);
      } else if (typeof r.evidence !== 'string' || !r.evidence.trim()) {
        skipped.push('revision 缺少逐字 evidence');
      } else {
        revision = {
          task_type: r.task_type,
          confidence: num(r.confidence, 0),
          evidence: r.evidence.trim(),
        };
      }
    }
  } else if (obj.verdict === 'revise' && obj.revision != null) {
    skipped.push('revision 应为对象');
  }
  return { verdict: obj.verdict, issues, revision, skipped };
}

/** 修订门槛：confidence ≥0.8 且与当前意图不同才值得应用（同值 = 共识，记录即可） */
export function gateRevision(revision, currentTaskType) {
  if (!revision) return null;
  if (revision.task_type === currentTaskType) {
    return { rejected: `自检修订与基础分析一致（${revision.task_type}），视为共识，无需改写` };
  }
  if ((revision.confidence ?? 0) < 0.8) {
    return { rejected: `自检修订置信度 ${revision.confidence} < 0.8 门槛，不应用` };
  }
  return { revision };
}
