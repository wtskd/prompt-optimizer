// 优化目标（用户自定义）：确定性渲染层约束，不碰 LLM 提示词。
// 刻意不进 analyze.js 的 TASK_GUIDE——那套判据是用留出集量过数字的（ANNOTATION.md §6.5），
// 对着它加话术就是铁律 1 禁止的样本内调参；目标约束只影响 S7 渲染，fast/standard 两档同效。

export const GOALS = {
  concise: {
    id: 'concise',
    label: '更简洁',
    constraint:
      '输出保持精炼：删除与任务无关的修饰、铺垫和重复说明，正文尽量短；但不得为省字牺牲下方任何硬性约束。',
  },
  specific: {
    id: 'specific',
    label: '更具体',
    constraint:
      '把模糊表述改写为可判定的具体要求：明确范围、数量、边界与验收标准；凡能量化的一律量化，禁止"尽量""适当"这类不可判定的词。',
  },
  context: {
    id: 'context',
    label: '补充上下文',
    constraint:
      '主动补齐上下文骨架：使用场景、目标读者/系统、已知前提与限制条件；材料缺失处一律走「假设」标注（与事实不符请纠正），不得编造事实。',
  },
  format: {
    id: 'format',
    label: '调整输出格式',
    constraint:
      '明确交付物形态与结构：段落/编号列表/表格/代码块的选择要有依据，并规定字段、顺序与长度上限；结构化内容优先于散文式叙述。',
  },
};

export const GOAL_IDS = Object.keys(GOALS);

/**
 * 解析 --goal 参数：'concise,format' 或 ['concise'] → 去重后的 id 列表；空 → []。
 * 未知目标直接抛错（带可选项提示），不做静默丢弃。
 */
export function resolveGoals(spec) {
  if (spec == null || spec === '') return [];
  const raw = Array.isArray(spec) ? spec : String(spec).split(',');
  const ids = raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const unknown = ids.filter((id) => !GOALS[id]);
  if (unknown.length) {
    throw new Error(`未知优化目标：${unknown.join(', ')}（可选：${GOAL_IDS.join(' / ')}）`);
  }
  return [...new Set(ids)];
}
