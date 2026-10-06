// 槽位抽取：只做"字面可验证"的抽取，不做语义猜测；抽不到就留空交给澄清层
import { allMatches, firstMatch, truncate, uniq } from './util.js';

const TONE_MAP = [
  [/(正式|严谨|官方)/, 'formal'],
  [/(专业|技术|硬核)/, 'technical'],
  [/(简洁|精炼|直接|干脆)/, 'concise'],
  [/(亲切|友好|口语|轻松|易懂)/, 'friendly'],
  [/(有说服力|打动|种草|营销|销售感)/, 'persuasive'],
  [/(幽默|俏皮|有趣)/, 'playful'],
];

const AUDIENCE_PATTERNS = [
  { re: /(?:面向|针对)([^，。；\n]{1,12})/, pick: (m) => m[1] },
  { re: /给([^，。；\n]{1,10}?)(?:看|用|阅读|参考)/, pick: (m) => m[1] },
  { re: /(?:受众|读者|用户)(?:是|为)([^，。；\n]{1,12})/, pick: (m) => m[1] },
];

const mk = (value, confidence, evidence, source) => ({
  value,
  confidence: Number(confidence.toFixed(3)),
  evidence: evidence ?? null,
  source,
});

/** value 是否为空（空数组视为未提供） */
const isEmpty = (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);

/**
 * @param {string} text 原始输入
 * @param {object} intent detectIntent 的结果
 * @param {object} ir PromptIR（读取 locale 等选项）
 * @returns {Record<string, {value:any, confidence:number, evidence:any, source:string}>}
 */
export function extractSlots(text, intent, ir) {
  const src = String(text ?? '');
  const locale = ir?.options?.locale ?? 'zh-CN';
  const slots = {};

  // 语言：显式优先（"翻译成英文" 也算显式），否则沿用 locale 默认
  const en = firstMatch(src, [
    /(翻译成|译成|转成|输出|写成|改用|用)\s*(英文|英语|English)/i,
    /\bEnglish\b/i,
  ]);
  const zh = firstMatch(src, [/(翻译成|译成|输出|写成|用)\s*(中文|汉语)/, /中文(回答|输出|呈现)/]);
  if (en) slots.language = mk('en', 0.92, en.match, 'explicit');
  else if (zh) slots.language = mk('zh-CN', 0.92, zh.match, 'explicit');
  else slots.language = mk(locale, 1, `locale 默认 ${locale}`, 'default');

  // 交付物形态：来自意图层的字面命中
  if (intent.deliverable_format) {
    slots.deliverable_format = mk(
      intent.deliverable_format,
      intent.deliverable_confidence,
      intent.deliverable_evidence,
      'explicit',
    );
  }

  // 目标：有显式引导词则截取其后文本，否则由原始输入推断（低置信度，留待假设/追问）
  const goalHit = firstMatch(src, [/(目标是|目的是|我想让你|希望你|帮我做到)/]);
  if (goalHit) {
    slots.goal = mk(truncate(src.slice(goalHit.index).trim(), 80), 0.7, goalHit.match, 'explicit');
  } else {
    const len = src.trim().length;
    const conf = len >= 15 ? 0.5 : len >= 6 ? 0.35 : 0.15;
    slots.goal = mk(truncate(src.trim(), 80), conf, '由原始输入推断', 'inferred');
  }

  // 受众
  for (const { re, pick } of AUDIENCE_PATTERNS) {
    const m = src.match(re);
    if (m) {
      slots.audience = mk(pick(m).trim(), 0.7, m[0], 'explicit');
      break;
    }
  }

  // 篇幅：数字上限优先于形容词
  const maxLen = firstMatch(src, [
    /(?:不超过|控制在|最多|不多于|少于)\s*(\d+)\s*(字|词|token)/,
    /(\d+)\s*(字|词|token)\s*(?:以内|以下|之内)/,
  ]);
  const lenWord = firstMatch(src, [/(一句话|简短|简洁|精炼|要点式|简略)/, /(详尽|详细|全面|深入|完整)/]);
  if (maxLen) {
    const n = Number((maxLen.match.match(/(\d+)/) ?? [])[1]);
    const unit = maxLen.match.includes('token') ? 'token' : maxLen.match.includes('词') ? '词' : '字';
    slots.scope_length = mk({ kind: 'max', n, unit, text: maxLen.match }, 0.9, maxLen.match, 'explicit');
  } else if (lenWord) {
    slots.scope_length = mk({ kind: 'descriptor', text: lenWord.match }, 0.6, lenWord.match, 'explicit');
  }

  // 语气
  const tones = [];
  for (const [re, label] of TONE_MAP) {
    if (re.test(src)) tones.push(label);
  }
  if (tones.length) slots.tone_style = mk(uniq(tones), 0.75, tones.join('/'), 'explicit');

  // 必须项 / 禁止项（字面抽取，供冲突检测比对）
  const inc = uniq(
    allMatches(src, [/(?:必须|一定要|务必|需要包含|要包含)([^，。；\n]{1,40})/])
      .map((x) => (x.group ?? '').trim())
      .filter(Boolean),
  );
  if (inc.length) slots.constraints_include = mk(inc, 0.8, inc.join(' / '), 'explicit');

  const exc = uniq(
    allMatches(src, [/(?:不要|不用|禁止|别|避免|不能)([^，。；\n]{1,40})/])
      .map((x) => (x.group ?? '').trim())
      .filter(Boolean),
  );
  if (exc.length) slots.constraints_exclude = mk(exc, 0.8, exc.join(' / '), 'explicit');

  // 示例
  const ex = uniq(
    allMatches(src, [/(?:例如|比如|参考|类似)/])
      .map((x) => x.match)
      .filter(Boolean),
  );
  if (ex.length) {
    const ctx = allMatches(src, [/(?:例如|比如|参考|类似)([^。\n]{1,60})/]).map((x) => (x.group ?? '').trim());
    slots.examples = mk(uniq(ctx.filter(Boolean)), 0.6, ex.join(' / '), 'explicit');
  }

  // 成功标准
  const sc = uniq(
    allMatches(src, [/(?:验收标准|成功标准|判断标准|才算|要求是)([^。\n]{1,60})/])
      .map((x) => (x.group ?? '').trim())
      .filter(Boolean),
  );
  if (sc.length) slots.success_criteria = mk(sc, 0.7, sc.join(' / '), 'explicit');

  // 背景：显式引导词，或长输入整体作为背景
  const bg = firstMatch(src, [/(?:背景|上下文|目前|现状|情况是|我们正在)([^。\n]{1,80})/]);
  if (bg) {
    slots.background = mk(truncate(bg.match, 80), 0.6, bg.match, 'explicit');
  } else if (src.trim().length >= 120) {
    slots.background = mk(truncate(src.trim(), 120), 0.5, '输入较长，整体作为背景', 'inferred');
  }

  // 时效
  const dl = firstMatch(src, [
    /(今天|明天|后天|本周|下周|本月|下月|截止[^。\n]{0,12}|\d{1,4}[年/-]\d{1,2}[月/-]\d{1,2}日?)/,
  ]);
  if (dl) slots.deadline = mk(dl.match, 0.65, dl.match, 'explicit');

  return Object.fromEntries(Object.entries(slots).filter(([, s]) => !isEmpty(s.value)));
}
