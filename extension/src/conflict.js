// 冲突检测与消解（设计文档 §6.2 / T8 / T9）。
// 铁律：冲突永不静默。要么按确定性排序键裁决并记录，要么升级为"需用户确认"。
import { PRIORITY } from './schema.js';
import { fnv1a, asList } from './util.js';

// 文本层互斥信号对
const PAIRS = [
  {
    type: 'length',
    a: /(不超过|最多|控制在|不多于)\s*\d+\s*(字|词|token)|一句话|简短|简洁|精炼/,
    b: /详尽|详细|全面|深入|完整|所有细节/,
    reason: '篇幅硬上限与"全面详尽"不可同时满足',
  },
  {
    type: 'tone',
    a: /正式|严谨|专业/,
    b: /口语|轻松|幽默|俏皮|别太死板/,
    reason: '正式严谨与轻松口语的语气互斥',
  },
  {
    type: 'language',
    a: /英文|English/i,
    b: /中文|汉语/,
    reason: '同时要求中英两种输出语言',
    // 翻译类指令天然同时出现两种语言（源语言与目标语言），不是"要求两种输出语言"。
    // 例：「把这段中文翻译成英文」是单一目标语言，不能报冲突（false positive 实测于 dev 集 s02）。
    unless: /翻译|翻成|译成|译为|translate/i,
  },
  {
    type: 'scope',
    a: /只讲|只说|仅讲|仅限于|限定在|只覆盖/,
    b: /全面|所有|全部|完整覆盖/,
    reason: '限定范围与全面覆盖互斥',
  },
  {
    type: 'format',
    a: /表格|表格式/,
    b: /散文|连贯段落|大段叙述/,
    reason: '表格与连贯段落两种形态互斥',
  },
];

/** 排序键（降序比较）：priority → specificity → scope_depth → version → hash(升序) */
export function blockRank(b) {
  return {
    priority: b.priority ?? 0,
    specificity: b.specificity ?? 1,
    scope_depth: b.scope_depth ?? 1,
    version: b.version ?? 1,
    hash: b.hash ?? fnv1a(String(b.id ?? b.text ?? '')),
  };
}

export function pickWinner(a, b) {
  const x = blockRank(a);
  const y = blockRank(b);
  if (x.priority !== y.priority) return x.priority > y.priority ? a : b;
  if (x.specificity !== y.specificity) return x.specificity > y.specificity ? a : b;
  if (x.scope_depth !== y.scope_depth) return x.scope_depth > y.scope_depth ? a : b;
  if (x.version !== y.version) return x.version > y.version ? a : b;
  return x.hash <= y.hash ? a : b;
}

const normPair = (s) => String(s ?? '').replace(/^(必须包含|包含|不要|禁止)/, '').trim();
function overlap(x, y) {
  const a = normPair(x);
  const b = normPair(y);
  if (a.length < 2 || b.length < 2) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function detectConflicts(ir) {
  const text = ir.source.text;
  const out = [];

  for (const p of PAIRS) {
    if (p.unless && p.unless.test(text)) continue;
    const ma = text.match(p.a);
    const mb = text.match(p.b);
    if (ma && mb) {
      out.push({
        type: p.type,
        a: ma[0],
        b: mb[0],
        reason: p.reason,
        action: 'flag',
        requires_confirmation: true,
        resolution: `两项均为用户显式要求且同层级（priority ${PRIORITY.userExplicit}），不做静默取舍 → 需用户确认`,
      });
    }
  }

  const inc = asList(ir.slots.constraints_include?.value);
  const exc = asList(ir.slots.constraints_exclude?.value);
  for (const i of inc) {
    for (const e of exc) {
      if (overlap(i, e)) {
        out.push({
          type: 'include_exclude',
          a: i,
          b: e,
          reason: `同一项既被要求包含又被要求排除：${i}`,
          action: 'flag',
          requires_confirmation: true,
          resolution: '同一项不可同时"必须"与"禁止" → 需用户确认',
        });
      }
    }
  }

  // 同 id 多版本 → 按排序键裁决（非静默，保留裁决记录）
  const byId = new Map();
  for (const b of ir.blocks) {
    if (!byId.has(b.id)) byId.set(b.id, []);
    byId.get(b.id).push(b);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    if (new Set(list.map((b) => b.text)).size < 2) continue;
    let winner = list[0];
    for (const b of list.slice(1)) winner = pickWinner(winner, b);
    out.push({
      type: 'precedence',
      a: list[0].rule ?? id,
      b: winner.rule ?? id,
      reason: `同一区块 ${id} 出现多个版本`,
      action: 'keep_winner',
      winner: winner.text,
      requires_confirmation: false,
      resolution: `按排序键 (priority, specificity, scope_depth, version, hash) 保留 priority=${winner.priority} 的版本，其余丢弃并记录`,
    });
  }

  return out;
}
