// 澄清决策：缺口评分 = impact × (1 − confidence)（设计文档 §3.2 决策矩阵）
// ≥0.6 追问 / 0.3–0.6 假设+标注 / <0.3 静默默认。追问是"可中断分支"：宿主无交互容器时全部降级为假设。
//
// 本轮补齐"闭环"的另一半：answers 回收（runClarificationRound / applyAnswers）。
// 回答是**用户显式给出**（explicit，优先级 100），在澄清层定稿之前合入 IR：
// 缺口评分随之归零 → 该槽位既不追问、也不再进 assumptions（否则 INV-5 自相矛盾）。
import {
  SLOT_DEFS, SLOT_IDS, slotDef, CLARIFY,
  DELIVERABLES, TONES, DELIVERABLE_LABEL, TONE_LABEL,
} from './schema.js';
import { asList } from './util.js';

const band = (score) =>
  score >= CLARIFY.askThreshold ? 'ask' : score >= CLARIFY.assumeThreshold ? 'assume' : 'default';

const isEmpty = (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);

/**
 * @param {object} ir PromptIR（会就地写入缺失槽位的默认值）
 * @param {{ask?: boolean}} opts ask=true 表示宿主具备交互容器，可追问
 */
export function planClarification(ir, opts = {}) {
  const ask = opts.ask === true;
  const questions = [];
  const assumptions = [];
  const decisions = [];

  const rows = SLOT_DEFS.map((def) => {
    const slot = ir.slots[def.id];
    const confidence = slot ? slot.confidence : 0;
    const score = Number((def.impact * (1 - confidence)).toFixed(3));
    return { def, slot, score, decision: band(score) };
  });

  const askRows = rows.filter((r) => r.decision === 'ask').sort((a, b) => b.score - a.score);
  const blockingRows = askRows.filter((r) => r.def.blocking);
  const optionalRows = askRows.filter((r) => !r.def.blocking);

  if (ask) {
    for (const r of blockingRows.slice(0, CLARIFY.maxBlockingPerRound)) {
      questions.push(mkQuestion(r, true));
    }
    for (const r of optionalRows.slice(0, CLARIFY.maxOptionalPerRound)) {
      questions.push(mkQuestion(r, false));
    }
  }

  const queued = new Set(questions.map((q) => q.slot));

  for (const r of rows) {
    decisions.push({
      slot: r.def.id,
      impact: r.def.impact,
      confidence: r.slot ? r.slot.confidence : 0,
      score: r.score,
      decision: r.decision,
      queued: queued.has(r.def.id),
    });

    if (queued.has(r.def.id)) continue;

    if (r.decision === 'default') {
      if (!r.slot && !isEmpty(r.def.default)) {
        ir.slots[r.def.id] = { value: r.def.default, confidence: 1, evidence: '静默默认', source: 'default' };
      }
      continue;
    }

    // assume 区间，或 ask 区间但追问预算已用尽 → 转假设并标注
    // 取值优先级：已有槽位 > 本体暂定值（assumedDefault，可判定枚举）> 静默默认 > 人读描述串
    const value = !isEmpty(r.slot?.value)
      ? r.slot.value
      : !isEmpty(r.def.assumedDefault)
        ? r.def.assumedDefault
        : !isEmpty(r.def.default)
          ? r.def.default
          : r.def.blocking
            ? `未指定；暂按「${(r.def.options ?? ['按通用情况处理'])[0]}」处理`
            : undefined;

    if (isEmpty(value)) {
      ir.notes.push(`${r.def.id}: 缺失且无可用默认值，本次不写入（禁止静默取值）`);
      continue;
    }

    // 槽位值必须机器可判定；人读说明单独放 display。
    // 旧写法把整句「未指定；暂按「表格」处理」塞进槽位值，下游契约/规则拿不到可判定的形态。
    const display = r.def.assumedLabel ? `${r.def.assumedLabel}（用户未指定，暂定）` : undefined;

    assumptions.push({
      slot: r.def.id,
      label: r.def.label,
      value,
      display,
      confidence: r.slot ? r.slot.confidence : 0,
      reason:
        `缺口评分 ${r.score} = impact ${r.def.impact} × (1−置信度 ${r.slot ? r.slot.confidence : 0})，` +
        `落在假设区间 [${CLARIFY.assumeThreshold}, ${CLARIFY.askThreshold})` +
        (r.decision === 'ask' ? '；追问预算已满，转为假设' : ''),
    });
    if (!r.slot) {
      ir.slots[r.def.id] = { value, confidence: 0.2, evidence: '假设补全', source: 'assumed' };
    }
  }

  ir.decisions = decisions;
  return { questions, assumptions, decisions };
}

function mkQuestion(r, blocking) {
  return {
    id: questionId(r.def.id), // 回收答案时的稳定 key（q_<槽位 id>），槽位 id 本身也是合法 key
    slot: r.def.id,
    blocking,
    question: r.def.question ?? `请补充：${r.def.label}`,
    options: (r.def.options ?? []).slice(0, CLARIFY.optionMax),
    reason:
      `缺口评分 ${r.score} = impact ${r.def.impact} × (1−置信度 ${r.slot ? r.slot.confidence : 0})` +
      ` ≥ ${CLARIFY.askThreshold}`,
    timeoutMs: CLARIFY.timeoutMs,
    round: 1,
  };
}

// ---------------------------------------------------------------------------
// 答案回收：多轮澄清闭环
// ---------------------------------------------------------------------------

export const CLARIFY_ANSWER_UNKNOWN = 'CLARIFY_ANSWER_UNKNOWN';
export const CLARIFY_ANSWER_INVALID = 'CLARIFY_ANSWER_INVALID';

/** 问题 id 约定：q_<槽位 id>。answers 的 key 用问题 id 或槽位 id 都行 */
export const questionId = (slot) => `q_${slot}`;

const SLOT_IDSET = new Set(SLOT_IDS);

/** 合法 key 全清单（槽位 id + 问题 id），用于报错时"列出可用 key" */
export const answerKeySlots = () => SLOT_IDS.flatMap((id) => [id, questionId(id)]);

// 枚举型槽位：取值必须落在本体枚举内。中文标签（追问选项里给用户看的那种）按 label 表反查归一后再校验，
// 属于"校验后归一"，不是放行任意文本。
const ENUM_VALUES = {
  deliverable_format: DELIVERABLES,
  language: ['zh-CN', 'en'],
  tone_style: TONES,
};
const invert = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
const ENUM_LABELS = {
  deliverable_format: invert(DELIVERABLE_LABEL), // 表格 → table
  tone_style: invert(TONE_LABEL), // 简洁直接 → concise
  language: { 简体中文: 'zh-CN', 中文: 'zh-CN', 汉语: 'zh-CN', English: 'en', 英文: 'en', 英语: 'en' },
};

const isEnumSlot = (def) => Boolean(def && ENUM_VALUES[def.id]);
const allowedValues = (def) => ENUM_VALUES[def.id] ?? [];

const resolveEnumValue = (def, raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (allowedValues(def).includes(s)) return s;
  return ENUM_LABELS[def.id]?.[s] ?? null;
};

function answerError(code, message, details = {}) {
  const e = new Error(message);
  e.code = code;
  e.details = details;
  return e;
}

function enumError(slot, def, raw) {
  return answerError(
    CLARIFY_ANSWER_INVALID,
    `槽位 ${slot} 的回答 ${JSON.stringify(String(raw))} 不是合法枚举取值；`
      + `允许：${allowedValues(def).join('、')}（其中文标签同样接受：${Object.keys(ENUM_LABELS[def.id] ?? {}).join('、')}）`,
    { slot, answer: raw, allowed: allowedValues(def) },
  );
}

/**
 * 归一一条回答：返回 { empty:true, reason } 或 { value, evidence }。
 * 非法形态 / 非法枚举直接抛带 code 的错误（不静默改写用户的意思）。
 */
function normalizeAnswer(slot, def, raw) {
  if (raw === undefined || raw === null) return { empty: true, reason: '空回答（null/undefined）' };

  const isList = def?.type === 'list';
  if (Array.isArray(raw) && !isList) {
    throw answerError(
      CLARIFY_ANSWER_INVALID,
      `槽位 ${slot} 是标量槽位，回答必须是字符串（收到数组 ${JSON.stringify(raw)}）`,
      { slot, answer: raw },
    );
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    throw answerError(
      CLARIFY_ANSWER_INVALID,
      `槽位 ${slot} 的回答必须是字符串${isList ? '或字符串数组' : ''}（收到对象）`,
      { slot, answer: raw },
    );
  }

  if (isList) {
    // 列表型槽位统一走 asList()：标量 → 单元素列表（与 llm/analyze.js 的消费侧归一同一把尺子）
    const items = asList(raw).map((x) => String(x ?? '').trim()).filter(Boolean);
    if (!items.length) return { empty: true, reason: '空回答（纯空白/空列表）' };
    const value = isEnumSlot(def)
      ? items.map((x) => {
          const v = resolveEnumValue(def, x);
          if (v === null) throw enumError(slot, def, x);
          return v;
        })
      : items;
    return { value, evidence: items.join('、') };
  }

  const text = (typeof raw === 'string' ? raw : String(raw)).trim();
  if (!text) return { empty: true, reason: '空回答（纯空白）' };
  if (isEnumSlot(def)) {
    const v = resolveEnumValue(def, text);
    if (v === null) throw enumError(slot, def, text);
    return { value: v, evidence: text };
  }
  return { value: text, evidence: text };
}

/**
 * 把 answers 合入 IR（只改 ir.slots 与 ir.clarify，不碰 questions/assumptions——那是 planClarification 的账）。
 * @param {object} ir PromptIR
 * @param {object|null|undefined} answers key = 问题 id（q_<slot>）或槽位 id，value = 回答
 * @param {{availableKeys?:string[]}} [opts]
 * @returns {null|{round:object,answered:object,skipped:Array,appliedAnswers:object}}
 *          无 answers / 空对象 → null（不触碰 IR，保证既有路径逐字节不变）
 */
export function applyAnswers(ir, answers, opts = {}) {
  if (answers === undefined || answers === null) return null;
  if (typeof answers !== 'object' || Array.isArray(answers)) {
    throw answerError(
      CLARIFY_ANSWER_INVALID,
      'answers 必须是「key → 回答」的 JSON 对象',
      { got: Array.isArray(answers) ? 'array' : typeof answers },
    );
  }
  const keys = Object.keys(answers);
  if (!keys.length) return null; // 空对象 = 没有回答

  const available = opts.availableKeys ?? answerKeySlots();
  const resolved = [];
  const unknown = [];
  for (const key of keys) {
    const slot = SLOT_IDSET.has(key) ? key : key.startsWith('q_') && SLOT_IDSET.has(key.slice(2)) ? key.slice(2) : null;
    if (!slot) {
      unknown.push(key);
      continue;
    }
    resolved.push({ key, slot, def: slotDef(slot), raw: answers[key] });
  }

  // 未知 key：抛错，但把"未知清单 + 可用清单"一并放进 message 与 error 字段——绝不静默丢弃
  if (unknown.length) {
    const err = answerError(
      CLARIFY_ANSWER_UNKNOWN,
      `未知的澄清答案 key：${unknown.map((k) => JSON.stringify(k)).join('、')}；`
        + `可用 key（槽位 id 或问题 id）：${available.join('、')}`,
      { unknown, available },
    );
    err.unknown = unknown;
    err.available = available;
    throw err;
  }

  const appliedAnswers = {};
  const answered = {};
  const skipped = [];

  for (const { key, slot, def, raw } of resolved) {
    const norm = normalizeAnswer(slot, def, raw);
    if (norm.empty) {
      // 空回答：记为 skipped，不报错、不写槽位（该槽位照旧走假设/追问）
      skipped.push({ key, slot, reason: norm.reason });
      continue;
    }
    const prev = ir.slots[slot] ?? null;
    ir.slots[slot] = {
      value: norm.value,
      confidence: 1, // 用户显式给出 → 缺口评分 impact×(1−1)=0，不会再被追问
      evidence: norm.evidence,
      source: 'explicit', // 优先级 100，覆盖 inferred / assumed / default
      via: 'user.answer',
    };
    appliedAnswers[slot] = {
      key,
      answer: raw,
      value: norm.value,
      source: 'explicit',
      previous: prev ? { value: prev.value, source: prev.source ?? null } : null,
    };
    answered[slot] = norm.evidence;
  }

  const round = {
    round: 1,
    asked: [], // 本轮实际问出去的问题 id（由 runClarificationRound 在定稿前算出后回填）
    answered,
    skipped,
    unknown: [], // 成功路径恒为空：未知 key 在合并前就抛 CLARIFY_ANSWER_UNKNOWN，错误对象里带完整清单
    applied: Object.keys(appliedAnswers),
    remaining: [], // 合并后仍需追问的问题 id（由 runClarificationRound 回填）
  };

  ir.clarify = { rounds: [round], appliedAnswers };
  return { round, answered, skipped, appliedAnswers };
}

/** 影子视图：用来算"合入回答之前本轮会问哪些问题"，不污染真实 IR */
const shadow = (ir) => ({ ...ir, slots: { ...ir.slots }, notes: [...ir.notes], decisions: [] });

/**
 * S3 澄清层入口：先合入用户回答，再定稿问题与假设（answers 为空的路径与 planClarification 完全一致）。
 * @param {object} ir PromptIR
 * @param {{ask?:boolean, answers?:object}} [opts]
 */
export function runClarificationRound(ir, opts = {}) {
  const ask = opts.ask === true;
  const answers = opts.answers ?? null;
  const noAnswers =
    answers === null
    || answers === undefined
    || (typeof answers === 'object' && !Array.isArray(answers) && Object.keys(answers).length === 0);
  if (noAnswers) return planClarification(ir, { ask });

  const asked = planClarification(shadow(ir), { ask }).questions.map((q) => q.id);
  const recycled = applyAnswers(ir, answers);
  const planned = planClarification(ir, { ask });
  if (recycled) {
    recycled.round.asked = asked;
    recycled.round.remaining = planned.questions.map((q) => q.id);
  }
  return planned;
}
