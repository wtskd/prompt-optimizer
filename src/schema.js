// 本体与槽位定义（对应设计文档 §2.1 意图本体、§3.1 槽位模型、§6 优先级分层）
export const VERSION = '0.1.0';

/** 三档位：Fast 档是本次实现，0 次 LLM 调用 */
export const TIERS = {
  fast: { id: 'fast', llmCalls: 0, latencyBudgetMs: 300 },
  standard: { id: 'standard', llmCalls: 2, latencyBudgetMs: 3000 },
  deep: { id: 'deep', llmCalls: 4, latencyBudgetMs: 15000 },
};

export const TASK_TYPES = [
  'write', 'code', 'analyze', 'plan', 'extract',
  'transform', 'decide', 'review', 'learn', 'converse',
];

export const DOMAINS = [
  'software', 'data', 'business', 'content', 'education',
  'research', 'ops', 'design', 'life', 'other',
];

export const DELIVERABLES = [
  'prose', 'list', 'table', 'json', 'markdown',
  'code', 'email', 'report', 'checklist', 'plan', 'slides', 'sql',
];

export const TONES = ['neutral', 'formal', 'concise', 'friendly', 'persuasive', 'technical', 'playful'];

export const TASK_LABEL = {
  write: '文本写作', code: '编码实现', analyze: '分析诊断', plan: '方案规划', extract: '信息抽取',
  transform: '格式/语言转换', decide: '方案比选', review: '评审与挑错', learn: '讲解与学习', converse: '日常对话',
};

export const DOMAIN_LABEL = {
  software: '软件工程', data: '数据分析', business: '商业与运营', content: '内容创作', education: '教学与学习',
  research: '研究与实验', ops: '运维与发布', design: '产品与设计', life: '个人生活', other: '通用',
};

export const DELIVERABLE_LABEL = {
  prose: '连贯段落', list: '分条清单', table: '表格', json: '结构化 JSON', markdown: 'Markdown',
  code: '可运行代码', email: '邮件', report: '报告', checklist: '可勾选清单', plan: '计划/排期', slides: '幻灯片', sql: 'SQL 语句',
};

export const TONE_LABEL = {
  neutral: '中性', formal: '正式严谨', concise: '简洁直接', friendly: '亲切口语',
  persuasive: '有说服力', technical: '专业技术', playful: '轻松幽默',
};

/** 意图置信度阈值（§2.2） */
export const CONF = { adopt: 0.8, annotate: 0.5 };

/** 澄清策略预算（§3.2） */
export const CLARIFY = {
  askThreshold: 0.6,
  assumeThreshold: 0.3,
  maxBlockingPerRound: 2,
  maxOptionalPerRound: 3,
  maxRounds: 1,
  optionMin: 2,
  optionMax: 5,
  timeoutMs: 8000,
};

/** 优先级分层（§6.1），数值越大越优先 */
export const PRIORITY = {
  userExplicit: 100,
  safety: 90,
  userTemplate: 80,
  scenarioPack: 60,
  systemTemplate: 40,
  modelAdapt: 20,
  styleDefault: 10,
};

/**
 * 槽位定义。
 * impact：缺失该槽位对下游结果的影响（0–1）
 * blocking：缺失时是否必须由用户回答
 * default：静默默认值（undefined 表示没有可静默取用的值）
 * assume：是否允许以"假设 + 标注"方式补全
 */
export const SLOT_DEFS = [
  {
    id: 'goal', label: '核心目标', impact: 0.95, blocking: true, askable: true, assume: true, default: null,
    question: '这次输出的核心目标是什么？',
    options: ['产出可执行方案', '产出结论与判断', '产出可交付文本', '产出代码实现', '产出结构化数据'],
  },
  {
    id: 'deliverable_format', label: '交付物形态', impact: 0.9, blocking: true, askable: true, assume: true, default: null,
    // 缺失时的暂定值：必须是本体枚举（契约与规则要按枚举判定），人读的说明放 assumedLabel
    assumedDefault: 'prose',
    assumedLabel: DELIVERABLE_LABEL.prose,
    question: '你希望输出成什么形态？',
    options: ['表格', '分条清单', '结构化 JSON', '连贯段落', '可运行代码'],
  },
  {
    id: 'constraints_exclude', label: '禁止项', impact: 0.75, askable: true, assume: false, type: 'list', default: [],
    question: '有哪些必须避免的内容或做法？',
    options: ['不要套话与客套', '不要编造数据', '不要展开背景', '不要给代码'],
  },
  {
    id: 'language', label: '输出语言', impact: 0.7, askable: false, assume: false, default: null,
    question: '输出用哪种语言？',
    options: ['简体中文', 'English'],
  },
  {
    id: 'constraints_include', label: '必须项', impact: 0.7, askable: true, assume: false, type: 'list', default: [],
    question: '有哪些必须包含的内容？',
    options: ['包含具体步骤', '包含风险与代价', '包含示例', '包含验收标准'],
  },
  {
    id: 'success_criteria', label: '成功标准', impact: 0.65, askable: true, assume: true, type: 'list', default: ['结论明确、可直接执行'],
    question: '怎样算这次输出合格？',
    options: ['可直接执行，无需再问', '结论有依据，可追溯', '覆盖所有列举点', '符合字数与格式硬约束'],
  },
  {
    id: 'audience', label: '受众', impact: 0.6, askable: true, assume: true, default: '具备基本背景知识的普通读者',
    question: '这份输出主要给谁看？',
    options: ['领域专家', '非技术决策者', '一线执行者', '公开读者'],
  },
  {
    id: 'background', label: '背景信息', impact: 0.55, askable: true, assume: true, default: '未提供，按通用场景处理',
    question: '有什么背景需要我知道？',
    options: ['稍后补充', '按通用场景处理', '见对话上文'],
  },
  {
    id: 'scope_length', label: '篇幅与范围', impact: 0.5, askable: true, assume: true, default: '中等篇幅，先结论后展开',
    question: '篇幅和覆盖范围要多大？',
    options: ['一句话结论', '要点式短答', '中等篇幅', '详尽长文'],
  },
  {
    id: 'tone_style', label: '语气风格', impact: 0.45, askable: true, assume: true, type: 'list', default: ['neutral', 'concise'],
    question: '语气上有什么偏好？',
    options: ['专业严谨', '简洁直接', '口语轻松', '有说服力'],
  },
  {
    id: 'examples', label: '参考示例', impact: 0.4, askable: false, assume: false, type: 'list', default: [],
    question: '有没有可参考的示例？',
    options: ['有，稍后提供', '没有，按通用风格'],
  },
  {
    id: 'deadline', label: '时效', impact: 0.25, askable: false, assume: false, default: null,
    question: '什么时候要？',
    options: ['今天', '本周内', '不急'],
  },
];

export const SLOT_IDS = SLOT_DEFS.map((d) => d.id);
export const slotDef = (id) => SLOT_DEFS.find((d) => d.id === id);
