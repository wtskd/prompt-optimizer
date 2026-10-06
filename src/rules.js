// 改写规则表 R-001…R-014（设计文档 §2.3）。
// 每条规则：id / name / priority(层级) / when(ir) / apply(ir) → 若干 block。
// 规则只产出"内容部件"，不做渲染；渲染交给 templates + render。
import { PRIORITY, TASK_LABEL, DOMAIN_LABEL, DELIVERABLE_LABEL } from './schema.js';
import { truncate, asList } from './util.js';

const block = (id, kind, priority, layer, text) => ({ id, kind, priority, layer, text });
const val = (ir, id, fallback) => ir.slots[id]?.value ?? fallback;
const listText = (v) => asList(v).join('；');

/**
 * 语言一致性（R-009 用）：显式指令 > 模型判断（llm 层合入）> 输入语言检测。
 * 返回 'en' | 'zh-CN' | null——null 表示没有任何语言信号，维持旧行为不发约束。
 */
function effectiveLanguage(ir) {
  if (ir.slots.language?.source === 'explicit') return ir.slots.language.value;
  if (ir.options.llmLanguage) return ir.options.llmLanguage;
  return ir.options.languageDetected ?? null;
}

const SHAPES = {
  table: '先给列标题，再给行；每行不超过 3 个要点，量级用数字而非形容词',
  json: '给出合法 JSON，字段名用英文小写下划线，不要注释、不要多余包裹文字',
  list: '分条编号，每条一句话，先结论后理由',
  checklist: '每条为可勾选动作，并给出完成判据',
  code: '给出可运行代码，含输入输出示例与关键注释',
  prose: '连贯段落，先结论后展开，避免流水账',
  plan: '按阶段/里程碑分节，每节给产出物与验收点',
  report: '摘要 → 证据 → 结论 → 建议，四段式',
};

export const RULES = [
  {
    id: 'R-001', name: '角色与受众锚定', priority: PRIORITY.systemTemplate, when: () => true,
    apply: (ir) => [
      block('b-role', 'role', PRIORITY.systemTemplate, 'systemTemplate',
        `你是${DOMAIN_LABEL[ir.intent.domain] ?? '通用'}领域经验丰富的助手；受众是${val(ir, 'audience', '普通读者')}。`),
    ],
  },
  {
    id: 'R-002', name: '任务显式化', priority: PRIORITY.userExplicit, when: () => true,
    apply: (ir) => [
      block('b-task', 'task', PRIORITY.userExplicit, 'userExplicit',
        `任务类型：${TASK_LABEL[ir.intent.task_type] ?? ir.intent.task_type}` +
        `${ir.intent.ambiguous ? '（输入含多个意图，建议拆分为多次请求）' : ''}。` +
        `目标：${truncate(val(ir, 'goal', '按原始输入执行'), 120)}`),
    ],
  },
  {
    id: 'R-003', name: '交付物形态锁定', priority: PRIORITY.userExplicit,
    when: (ir) => Boolean(ir.slots.deliverable_format),
    apply: (ir) => [
      block('b-deliverable', 'deliverable', PRIORITY.userExplicit, 'userExplicit',
        `交付物形态：${DELIVERABLE_LABEL[ir.slots.deliverable_format.value] ?? ir.slots.deliverable_format.value}` +
        '（严格遵守，不得改用其他形态）。'),
    ],
  },
  {
    id: 'R-004', name: '负面约束前置', priority: PRIORITY.userExplicit,
    when: (ir) => Boolean(ir.slots.constraints_exclude?.value?.length),
    apply: (ir) => [
      block('b-exclude', 'constraint_hard', PRIORITY.userExplicit, 'userExplicit',
        `禁止事项（违反即视为不合格）：${listText(ir.slots.constraints_exclude.value)}`),
    ],
  },
  {
    id: 'R-005', name: '成功标准显式化', priority: PRIORITY.systemTemplate,
    when: (ir) => Boolean(ir.slots.success_criteria),
    apply: (ir) => [
      block('b-success', 'quality', PRIORITY.systemTemplate, 'systemTemplate',
        `合格标准：${listText(ir.slots.success_criteria.value)}`),
    ],
  },
  {
    id: 'R-006', name: '输出结构建议', priority: PRIORITY.systemTemplate,
    when: (ir) => Boolean(ir.slots.deliverable_format),
    apply: (ir) => {
      const shape = SHAPES[ir.slots.deliverable_format.value];
      return shape ? [block('b-shape', 'deliverable', PRIORITY.systemTemplate, 'systemTemplate', `结构要求：${shape}`)] : [];
    },
  },
  {
    id: 'R-007', name: '术语与标点归一', priority: PRIORITY.styleDefault, when: () => true,
    apply: (ir) => {
      ir.notes.push('R-007：全角/半角与连续空白已归一；专有名词保持原意，不做同义改写');
      return [];
    },
  },
  {
    id: 'R-008', name: '时效标注', priority: PRIORITY.userExplicit,
    when: (ir) => Boolean(ir.slots.deadline),
    apply: (ir) => [
      block('b-deadline', 'context', PRIORITY.userExplicit, 'userExplicit',
        `时效要求：${ir.slots.deadline.value}（按此时限组织内容详略）。`),
    ],
  },
  {
    id: 'R-009', name: '语言与风格约束', priority: PRIORITY.userTemplate,
    when: (ir) => Boolean(ir.slots.tone_style) || effectiveLanguage(ir) != null,
    apply: (ir) => {
      const out = [];
      const lang = effectiveLanguage(ir);
      if (lang === 'en') {
        out.push(block('b-lang', 'constraint_soft', PRIORITY.userExplicit, 'userExplicit',
          '输出语言：English（整篇英文，不得夹杂中文解释）'));
      } else if (lang === 'zh-CN' && ir.slots.language?.source === 'explicit') {
        // 中文输入的模板本身就是中文，只在用户显式点名"用中文"时才发约束（保持旧行为）
        out.push(block('b-lang', 'constraint_soft', PRIORITY.userExplicit, 'userExplicit',
          '输出语言：简体中文'));
      }
      const t = ir.slots.tone_style?.value;
      if (t) {
        out.push(block('b-tone', 'constraint_soft', PRIORITY.userTemplate, 'userTemplate',
          `语气风格：${Array.isArray(t) ? t.join('、') : t}`));
      }
      return out;
    },
  },
  {
    id: 'R-010', name: '示例锚定', priority: PRIORITY.userTemplate,
    when: (ir) => Boolean(ir.slots.examples?.value?.length),
    apply: (ir) => [
      block('b-example', 'example', PRIORITY.userTemplate, 'userTemplate', `参考示例：${listText(ir.slots.examples.value)}`),
    ],
  },
  {
    id: 'R-011', name: '假设可撤销声明', priority: PRIORITY.styleDefault,
    when: (ir) => ir.assumptions.length > 0,
    apply: () => [
      block('b-assume-policy', 'constraint_pref', PRIORITY.styleDefault, 'styleDefault',
        '若下方假设与你的真实情况不符，直接在下一轮纠正该条即可，无需重述全部背景。'),
    ],
  },
  {
    id: 'R-012', name: '多意图拆分提示', priority: PRIORITY.systemTemplate,
    when: (ir) => ir.intent.ambiguous,
    apply: () => [
      block('b-split', 'task', PRIORITY.systemTemplate, 'systemTemplate',
        '输入可能包含多个意图：请只完成最主要的一项，其余列为「待确认」，不要自行合并输出。'),
    ],
  },
  {
    id: 'R-013', name: '敏感信息防护', priority: PRIORITY.safety,
    when: (ir) => /(密码|密钥|私钥|token|api[ _-]?key|身份证|银行卡|手机号)/i.test(ir.source.text),
    apply: () => [
      block('b-safety', 'constraint_hard', PRIORITY.safety, 'safety',
        '不得复述、补全或推断任何真实凭据与个人敏感信息；示例场景请使用占位符。'),
    ],
  },
  {
    id: 'R-014', name: '目标模型自适应', priority: PRIORITY.modelAdapt, when: () => true,
    apply: (ir) => {
      const m = ir.options.targetModel;
      const text =
        m === 'reasoning' ? '先给推理要点，再给结论；不要省略关键推理链。'
          : m === 'fast' ? '直接给结论与可执行动作，省略推导过程。'
            : '先给结论，再给必要的支撑理由。';
      return [block('b-model', 'constraint_pref', PRIORITY.modelAdapt, 'modelAdapt', `表达方式：${text}`)];
    },
  },
  {
    // 真实事故补的：constraints_include（必须项）原来只写进结构化契约与冲突检测，
    // 从未进入渲染出的提示词——用户说"必须包含 X"，下游模型根本看不到。禁止项有 R-004，必含项却漏了。
    id: 'R-015', name: '必含项前置', priority: PRIORITY.userExplicit,
    when: (ir) => asList(ir.slots.constraints_include?.value).length > 0,
    apply: (ir) => [
      block('b-include', 'constraint_hard', PRIORITY.userExplicit, 'userExplicit',
        `必须包含（缺一即不合格）：${listText(ir.slots.constraints_include.value)}`),
    ],
  },
];

/** 按规则 id 稳定顺序执行，返回本次生效的 block 列表 */
export function runRules(ir) {
  for (const rule of [...RULES].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!rule.when(ir)) continue;
    for (const b of rule.apply(ir) ?? []) ir.blocks.push({ ...b, rule: rule.id });
  }
  return ir.blocks;
}
