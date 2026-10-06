// Output Contract：契约双写中的"结构化"一半（设计文档 §4.1 / T6）。
// hard = 违反即不合格；soft = 期望满足，可协商；pref = 风格偏好。
import { PRIORITY, DELIVERABLE_LABEL, TONE_LABEL } from './schema.js';
import { asList } from './util.js';

export function buildContract(ir) {
  const hard = [];
  const soft = [];
  const pref = [];

  const langSlot = ir.slots.language;
  hard.push({
    id: 'C-01',
    text: `输出语言：${langSlot?.value === 'en' ? 'English' : '简体中文'}，不得混用`,
    source: langSlot?.source ?? 'default',
    priority: PRIORITY.userExplicit,
  });

  if (ir.slots.deliverable_format) {
    hard.push({
      id: 'C-02',
      text: `交付物形态：${DELIVERABLE_LABEL[ir.slots.deliverable_format.value] ?? ir.slots.deliverable_format.value}`,
      source: 'explicit',
      priority: PRIORITY.userExplicit,
    });
  }

  asList(ir.slots.constraints_exclude?.value).forEach((x, i) =>
    hard.push({ id: `C-1${i}`, text: `不得：${x}`, source: 'explicit', priority: PRIORITY.userExplicit }));
  asList(ir.slots.constraints_include?.value).forEach((x, i) =>
    hard.push({ id: `C-2${i}`, text: `必须：${x}`, source: 'explicit', priority: PRIORITY.userExplicit }));

  asList(ir.slots.success_criteria?.value).forEach((x, i) =>
    soft.push({ id: `C-3${i}`, text: `合格标准：${x}`, source: 'explicit', priority: PRIORITY.systemTemplate }));

  const sl = ir.slots.scope_length?.value;
  if (sl) {
    // slot 可能是结构化的 {kind,n,unit}，也可能是"中等篇幅，先结论后展开"这类描述串（含假设补全）
    const text =
      sl && typeof sl === 'object' ? (sl.kind === 'max' ? `不超过 ${sl.n} ${sl.unit}` : String(sl.text ?? '')) : String(sl);
    if (text) soft.push({ id: 'C-40', text: `篇幅：${text}`, source: 'explicit', priority: PRIORITY.userExplicit });
  }
  const tone = ir.slots.tone_style?.value;
  if (tone) {
    soft.push({
      id: 'C-41',
      text: `语气：${(Array.isArray(tone) ? tone : [tone]).map((t) => TONE_LABEL[t] ?? t).join('、')}`,
      source: 'explicit',
      priority: PRIORITY.userTemplate,
    });
  }
  if (ir.slots.audience) {
    soft.push({ id: 'C-42', text: `受众：${ir.slots.audience.value}`, source: ir.slots.audience.source, priority: PRIORITY.userTemplate });
  }
  if (ir.slots.deadline) {
    soft.push({ id: 'C-43', text: `时效：${ir.slots.deadline.value}`, source: 'explicit', priority: PRIORITY.userExplicit });
  }

  pref.push({ id: 'C-50', text: '先结论后展开；使用中文标点；避免套话与空洞过渡句', source: 'default', priority: PRIORITY.styleDefault });
  pref.push({ id: 'C-51', text: `表达方式适配目标模型：${ir.options.targetModel}`, source: 'default', priority: PRIORITY.modelAdapt });

  return { hard, soft, pref, counts: { hard: hard.length, soft: soft.length, pref: pref.length } };
}
