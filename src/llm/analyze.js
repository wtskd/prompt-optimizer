// LLM 分析层（设计文档 §7 S1b）：把口语化输入结构化成意图 + 槽位补丁。
// 分工是刻意的——模型只负责"看懂"，输出必须过本体校验；渲染与契约仍然 100% 确定性代码。
import { TASK_TYPES, DOMAINS, DELIVERABLES, SLOT_IDS, SLOT_DEFS } from '../schema.js';
import { llmError } from './provider.js';
import { asList } from '../util.js';

// task_type 的判定按 ANNOTATION.md v1 的顺序执行（先命中者胜）。
// 真实数据实测暴露的系统性偏差按轮次记在这里（每轮改完都必须换没跑过的集合验证）：
//   ① 第一留出集 h01-h20（35% / 45%）："报错 + 咋整/咋解决/怎么排" 被误判 analyze（应为 code）；
//      "一般…多少合适/要调哪个参数" 被误判 learn（应为 plan）。→ 已修，第二留出集 90%。
//   ② 第二留出集 v01-v20（90%）暴露的两条，都是 ① 修法的副作用或遗留：
//      v20 "单测启动报错…是哪里配置错了还是框架不支持"（问成因）被判 code ← ① 的触发条件过宽；
//      v15 "通用 agent 为什么比不过专用的"（问普遍差距的成因）被判 learn ← analyze 的射程写得太窄。
//      本次修法：code 加"求成因即让位"例外；analyze 从"具体现场"扩到"任何已观察到的现象/差距"；learn 收窄为求理解。
//   ③ 第三留出集 w01-w20（严格 70% / 宽松 90%）：v1.1 的成因例外被过度触发，code 召回明显下降（w05 配置类、
//      w16 "要个程序"都被判 plan）→ 触发 ANNOTATION §2.1 预登记的回滚条件。
//   ④ 第四留出集 x01-x20 的 A 臂（v1.1，严格 50% / 宽松 65%）给出两类可复现错误：
//      a) 配置/写法类（"如何配置/怎么设置/如何将同步包装成异步"）被判 plan 或 learn；
//      b) 判断类（"真的有那么好吗/还有必要吗/需不需要"）被判 learn（learn 只写了"不含成因追问"，漏了价值判断）。
//      本次 v1.2 修法：①把成因例外收窄为"只有问句本身是成因判断句时才让位"；②code 行补"要写法一律 code"的正例；
//      ③learn 行补"不含是否必要/真的好吗这类价值判断"。⚠️ v1.2 是在看过 A 臂在本集的错误后写的，
//      因此它在**同一集**上的数字属**样本内**，只能证明方向；干净的泛化数字必须来自 holdout5。
const TASK_GUIDE = [
  'converse=没有实质请求：只有寒暄、纯情绪、或只有陈述式观察（"我发现 system prompt 好长"），没有任何"要什么"的诉求',
  'decide=在用户**已点名的选项**里选一个（"A 和 B 选哪个"、"该不该用 X"、"有没有推荐的 Y"）',
  'code=交付物是代码/SQL/配置文本本身，或对已有代码/配置做生成、改写、优化、补全（"报错 XX 怎么改/咋整/咋解决/怎么排"、"改成…写法"、"写个脚本"）。**"如何配置 / 怎么设置 / 如何实现 / 怎么写 / 这种情况怎么处理"这类要写法的问句一律 code**，不要因为句首是"如何"就退成 plan 或 learn。**例外**：只有问句本身在问**成因判断**（"是…还是…导致的"、"为什么会这样"、"到底哪里的问题"、"是什么原因"）且不要求改法时，才让位给 analyze',
  'transform=交付物是**已有文本**的改写/压缩/润色/翻译/换语气/转格式',
  'extract=从给定材料里抠出信息条目（挑出来/提炼出来/整理成表）',
  'review=对给定材料挑错、找漏洞、核对（检查一遍/有没有问题）',
  'plan=交付物是**可执行的步骤、做法或取值**（"怎么排查"、"怎么办/咋办"、"有啥手段"、"从哪查起"、"要调哪个参数"、"一般咋做"、"一般设多少/设置多少合适/一般几个"）',
  'learn=求**理解**：概念/原理/机制/用法差异是什么（"是什么"、"啥意思"、"啥区别"、"怎么实现的"）。**不含**两类：①"某现象/某差距为什么会这样"的成因追问；②"是否必要 / 真的好吗 / 会不会被淘汰 / 该不该 / 需不需要"这类**价值或必要性判断**——两者都是 analyze，即使问的是普遍现象而不是某个现场',
  'analyze=对**已观察到的现象、现场或差距**做归因或判断：可以是具体这行代码/这次报错/线上挂了/接口突然变慢，也可以是普遍现象（"为什么国内公司宁愿改开源 JDK"、"通用 agent 为什么比不过专用的"）',
  'write=从零产出新文本（没有素材，也不是代码）',
].join('\n');

const SLOT_GUIDE = SLOT_DEFS.map((d) => `- ${d.id}（${d.label}）：${d.question}`).join('\n');

export const ANALYZE_SYSTEM = `你是提示词优化器的输入分析器。任务：把用户的口语化输入解析成结构化标签，供下游确定性地生成提示词。

你只做"理解"，不做"改写"：不得补充用户没说的事实，不得美化措辞，不得编造背景。

task_type 只能取以下之一（按定义判断，不要只看关键词）：
${TASK_GUIDE}

domain 只能取：${DOMAINS.join(' / ')}
deliverable_format 只能取：${DELIVERABLES.join(' / ')}，用户没要求形态就填 null
language 只能取："zh-CN" 或 "en"（用户没指定就省略，不要猜）

可填的槽位（只能填这些 id，其余一律不要出现）：
${SLOT_GUIDE}

判断纪律：
- 口语化表达按意图归类，不要被字面词带偏：出现"脚本"不一定是 code（可能是演示脚本=write），"bug"不一定是 code（可能是影响分析=analyze），"路径"不一定是 analyze（可能是学习路径=plan）。
- 带报错的问句先看**诉求**再定类，不要见到"报错"就判 code：要给出改法/改好 → code；问"哪里错了/是什么原因/是 A 还是 B 导致的" → analyze；要"怎么排查/从哪查起/有哪些手段" → plan。
- 配置/设置类问句的交付物就是**配置或代码文本本身** → code（"如何配置"、"怎么设置"、"如何实现"、"怎么写"）；只有"有没有办法 / 怎么办 / 怎么排查 / 有什么方案"才归 plan。
- 判断类问句是要求**判断**，不是求概念解释 → analyze（"是否必要"、"有必要吗"、"真的好吗"、"会不会被淘汰"）。
  但**当句子里同时给出两个已点名的选项、或问"该不该选 X / 选 A 还是 B"时归 decide**（decide 优先于 analyze，两者不冲突）。
- confidence 要真实校准：用户表述明确 → 0.85–0.95；需要推断 → 0.6–0.8；只能靠猜 → ≤0.45 或干脆省略该字段。
- 每个槽位必须给 evidence：从用户原话里抄一段片段，不得自己总结。
- 拿不准就省略该字段。省略是安全的，编造是有害的。

只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块：
{
  "task_type": "…",
  "confidence": 0.0,
  "domain": "…",
  "deliverable_format": null,
  "slots": {
    "goal": { "value": "…", "confidence": 0.0, "evidence": "原话片段" }
  }
}`;

export function buildAnalysisMessages(text) {
  return {
    system: ANALYZE_SYSTEM,
    user: `用户原始输入（逐字，含错别字与口语）：\n"""\n${String(text ?? '')}\n"""`,
  };
}

const stripFences = (s) => s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

const num = (v, fallback) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, Number(n.toFixed(3))));
};

/**
 * 严格校验模型输出。核心字段非法 → 整份补丁作废（抛错，由调用方显式降级并标注）；
 * 边缘字段非法 → 丢弃该字段并记入 skipped，不牵连其余结论。
 */
export function parseAnalysis(raw) {
  const text = stripFences(String(raw ?? ''));
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw llmError('LLM_BAD_JSON', `模型返回的不是合法 JSON：${e.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw llmError('LLM_BAD_JSON', '模型返回的顶层不是 JSON 对象');
  }
  if (!TASK_TYPES.includes(obj.task_type)) {
    throw llmError('LLM_SCHEMA', `task_type 不在本体里：${JSON.stringify(obj.task_type)}`);
  }

  const skipped = [];
  let domain = 'other';
  if (DOMAINS.includes(obj.domain)) domain = obj.domain;
  else if (obj.domain != null) skipped.push(`domain=${obj.domain}`);

  let deliverable_format = null;
  if (obj.deliverable_format == null) deliverable_format = null;
  else if (DELIVERABLES.includes(obj.deliverable_format)) deliverable_format = obj.deliverable_format;
  else skipped.push(`deliverable_format=${obj.deliverable_format}`);

  const slots = {};
  const coerced = [];
  const rawSlots = obj.slots && typeof obj.slots === 'object' && !Array.isArray(obj.slots) ? obj.slots : {};
  for (const [id, entry] of Object.entries(rawSlots)) {
    if (!SLOT_IDS.includes(id)) {
      skipped.push(`未知槽位 ${id}`);
      continue;
    }
    const def = SLOT_DEFS.find((d) => d.id === id);
    let value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
    if (id === 'deliverable_format') {
      if (!DELIVERABLES.includes(value)) {
        skipped.push(`${id}=${JSON.stringify(value)}`);
        continue;
      }
    } else if (def?.type === 'list') {
      // 列表型槽位收到标量，是模型常见的"退让"写法（真实事故：constraints_include 返回字符串
      // 导致下游 .forEach TypeError、整条管线崩溃）→ 归一为单元素列表并留痕，绝不把标量送下去
      const list = asList(value).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
      if (!list.length) {
        skipped.push(`${id} 空列表`);
        continue;
      }
      if (!Array.isArray(value)) coerced.push(`${id}（标量 → 单元素列表）`);
      value = list;
    } else if (Array.isArray(value)) {
      skipped.push(`${id} 应为标量却收到数组`);
      continue;
    } else if (typeof value === 'string') {
      if (!value.trim()) {
        skipped.push(`${id} 为空`);
        continue;
      }
    } else {
      skipped.push(`${id} 类型不支持`);
      continue;
    }
    const evidence = entry && typeof entry === 'object' && typeof entry.evidence === 'string' ? entry.evidence : null;
    if (!evidence) skipped.push(`${id} 缺少 evidence（已保留结论）`);
    slots[id] = {
      value,
      confidence: num(entry?.confidence, 0.7),
      evidence,
    };
  }

  let language = null;
  if (obj.language === 'zh-CN' || obj.language === 'en') language = obj.language;
  else if (obj.language != null) skipped.push(`language=${obj.language}`);

  return {
    task_type: obj.task_type,
    confidence: num(obj.confidence, 0.7),
    domain,
    deliverable_format,
    language,
    slots,
    skipped,
    coerced,
  };
}

/**
 * 把补丁合并进 PromptIR。合并规则来自 §6 优先级分层，不是"模型说了算"：
 *   用户显式表达（优先级 100）> 模型推断 > 规则默认。
 * 模型不会覆盖 explicit 槽位，也不会用更低置信度覆盖规则层的高置信结论。
 */
export function applyAnalysis(ir, patch, { model = null } = {}) {
  const applied = [];
  const blocked = [];
  const agreed = []; // 模型结论与现有槽位一致：不算"被拦下"，避免污染审计口径

  // ① 意图
  ir.intent = {
    ...ir.intent,
    task_type: patch.task_type,
    confidence: patch.confidence,
    domain: patch.domain,
    by: 'llm',
    rules: { task_type: ir.intent.task_type, confidence: ir.intent.confidence },
  };
  if (patch.deliverable_format) ir.intent.deliverable_format = patch.deliverable_format;

  // ⓪ 语言：模型判出的语言只在用户没有显式指定时采纳（帮助纠偏启发式检测）；显式表达永远优先
  if (patch.language && ir.slots.language?.source !== 'explicit') {
    ir.options.llmLanguage = patch.language;
  }

  // ② 交付物形态：模型给出的是本体枚举，直接落成可判定的槽位值
  if (patch.deliverable_format) {
    const cur = ir.slots.deliverable_format;
    if (cur && cur.source === 'explicit') {
      // 用户显式说了形态（如"三点式清单"）→ 模型不得改写，且必须留痕（不得静默丢弃）
      if (cur.value === patch.deliverable_format) agreed.push('deliverable_format');
      else
        blocked.push({
          slot: 'deliverable_format',
          reason: '用户显式表达优先（优先级 100）',
          kept: cur.value,
          proposed: patch.deliverable_format,
        });
    } else {
      ir.slots.deliverable_format = {
        value: patch.deliverable_format,
        confidence: num(patch.confidence, 0.75),
        evidence: patch.slots?.deliverable_format?.evidence ?? 'llm:deliverable_format',
        source: 'inferred',
        via: 'standard.llm',
      };
      applied.push('deliverable_format');
    }
  }

  // ③ 其余槽位
  for (const [id, s] of Object.entries(patch.slots)) {
    if (id === 'deliverable_format') continue;
    const cur = ir.slots[id];
    // 结论一致（含数组顺序不同）→ 记 agreed，不进 blocked："被拦下"要真的改变了什么才有审计价值
    const same = cur && JSON.stringify(cur.value) === JSON.stringify(s.value);
    if (cur && cur.source === 'explicit') {
      if (same) agreed.push(id);
      else blocked.push({ slot: id, reason: '用户显式表达优先（优先级 100）', kept: cur.value, proposed: s.value });
      continue;
    }
    const hasValue = cur && cur.value !== undefined && cur.value !== null;
    if (hasValue && (s.confidence ?? 0) < (cur.confidence ?? 0)) {
      if (same) agreed.push(id);
      else
        blocked.push({
          slot: id,
          reason: `规则层置信度更高（${cur.confidence} > ${s.confidence}）`,
          kept: cur.value,
          proposed: s.value,
        });
      continue;
    }
    ir.slots[id] = {
      value: s.value,
      confidence: num(s.confidence, 0.7),
      evidence: s.evidence ?? `llm:${id}`,
      source: 'inferred',
      via: 'standard.llm',
    };
    applied.push(id);
  }

  // 注意：ir.decisions 是澄清层（S3）的"逐槽位决策账本"（{slot,impact,confidence,score,decision}），
  // 且会被明确重新赋值。模型合并记录不写进那里，统一由 meta.llm.merged 暴露，避免污染账本语义。
  return { applied, blocked, agreed, skipped: patch.skipped ?? [], coerced: patch.coerced ?? [] };
}
