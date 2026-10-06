// 模板层：Block → Template/Recipe（设计文档 §5）。
// Recipe 决定"章节顺序与装哪些 kind"；lint 作为上线门禁，拦住空洞模板与缺失变量。

export const SECTIONS = [
  { id: 'role', title: '# 角色', kinds: ['role'] },
  { id: 'task', title: '# 任务', kinds: ['task'] },
  { id: 'context', title: '# 背景与上下文', kinds: ['context'] },
  { id: 'output', title: '# 输出要求（必须满足）', kinds: ['deliverable', 'constraint_hard'] },
  { id: 'quality', title: '# 质量与风格', kinds: ['quality', 'constraint_soft', 'constraint_pref'] },
  { id: 'examples', title: '# 参考示例', kinds: ['example'] },
  { id: 'conflicts', title: '# 冲突提示（未静默取舍，请确认）', kinds: ['conflict'] },
  { id: 'assumptions', title: '# 假设（与事实不符请直接纠正）', kinds: ['assumption'] },
  { id: 'questions', title: '# 待澄清问题（不影响本次输出）', kinds: ['question'] },
];

export const RECIPES = {
  'fast/default': {
    id: 'fast/default',
    tier: 'fast',
    llmCalls: 0,
    sections: SECTIONS.map((s) => s.id),
  },
};

/** 模板 lint：章节必须存在且绑定至少一个 kind */
export function lintRecipe(recipe, sections = SECTIONS) {
  const errs = [];
  if (!recipe || !Array.isArray(recipe.sections) || recipe.sections.length === 0) {
    errs.push('recipe 未定义 sections');
    return errs;
  }
  const seen = new Set();
  for (const sid of recipe.sections) {
    if (seen.has(sid)) errs.push(`章节 ${sid} 重复`);
    seen.add(sid);
    const s = sections.find((x) => x.id === sid);
    if (!s) {
      errs.push(`章节 ${sid} 不存在于 SECTIONS`);
      continue;
    }
    if (!s.kinds || s.kinds.length === 0) errs.push(`章节 ${sid} 未绑定 block kind（空洞模板）`);
  }
  return errs;
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** 变量替换；变量缺失直接抛错，不允许静默留空 */
export function renderTemplate(tpl, vars = {}) {
  const missing = [];
  const out = String(tpl).replace(VAR_RE, (_, key) => {
    const v = key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), vars);
    if (v === undefined || v === null) {
      missing.push(key);
      return '';
    }
    return String(v);
  });
  if (missing.length) throw new Error(`模板变量缺失：${missing.join(', ')}`);
  return out;
}

export function lintTemplate(tpl) {
  const errs = [];
  const declared = [...String(tpl).matchAll(VAR_RE)].map((m) => m[1]);
  if (declared.length === 0) errs.push('模板未声明任何变量（至少需要一个 {{var}}）');
  if (new Set(declared).size !== declared.length) errs.push('模板存在重复变量声明');
  return errs;
}
