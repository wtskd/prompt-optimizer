// 渲染：把 PromptIR 的 blocks 与澄清/冲突结果拼成最终提示词（确定性输出，INV-4）
import { SECTIONS, RECIPES } from './templates.js';
import { GOALS } from './goals.js';
import { stableStringify } from './util.js';

export const fmtValue = (v) => {
  if (Array.isArray(v)) return v.join('、');
  if (v && typeof v === 'object') return String(v.text ?? stableStringify(v));
  return String(v ?? '');
};

export function renderPrompt(ir, recipeId = 'fast/default') {
  const recipe = RECIPES[recipeId];
  if (!recipe) throw new Error(`未知 recipe：${recipeId}`);

  const parts = [];
  for (const sid of recipe.sections) {
    const sec = SECTIONS.find((s) => s.id === sid);
    let lines = [];

    if (sid === 'assumptions') {
      lines = ir.assumptions.map((a) => `- ${a.label}：${fmtValue(a.display ?? a.value)}（依据：${a.reason}）`);
    } else if (sid === 'questions') {
      lines = ir.questions.map(
        (q) => `- [${q.blocking ? '必答' : '可选'}] ${q.question} 选项：${q.options.join(' / ')}`,
      );
    } else if (sid === 'conflicts') {
      lines = ir.conflicts.map(
        (c) =>
          `- ⚠️ ${c.type} 冲突：「${c.a}」与「${c.b}」——${c.reason}；处理：` +
          `${c.action === 'flag' ? '未自动取舍，需你确认' : `按优先级保留「${c.winner}」`}`,
      );
    } else {
      lines = ir.blocks
        .filter((b) => sec.kinds.includes(b.kind))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((b) => `- ${b.text}`);
    }

    if (!lines.length) continue;
    parts.push(`${sec.title}\n${lines.join('\n')}`);
  }

  // 用户指定的优化目标（--goal）：插在「输出要求」之后、「质量与风格」之前，优先级高于风格类约束
  const goalLines = (Array.isArray(ir.options.goal) ? ir.options.goal : [])
    .filter((id) => GOALS[id])
    .map((id) => `- 【${GOALS[id].label}】${GOALS[id].constraint}`);
  if (goalLines.length) {
    const qualityIdx = parts.findIndex((p) => p.startsWith('# 质量与风格'));
    const goalPart = `# 优化目标（用户指定，优先满足）\n${goalLines.join('\n')}`;
    parts.splice(qualityIdx >= 0 ? qualityIdx : parts.length, 0, goalPart);
  }

  parts.push(`# 用户原始输入（保真，不得改写其事实）\n${ir.source.text}`);
  return parts.join('\n\n') + '\n';
}
