// 意图识别：三级漏斗的 L1/L2（显式任务信号 + 领域名词），Fast 档不使用 LLM（设计文档 §2.2）
//
// 证据充分性纪律（来自 evals/ 三集实测结论，见 evals/README.md）：
//   ① 只有「显式任务信号」（动词/句式，如 写个函数 / 分析一下 / 选哪个）才允许给出 ≥0.5 的置信度；
//   ② 单靠「领域名词」（代码/报错/list/sql/异常）命中，一律封顶在 0.45，落进低置信区间；
//   ③ 名词信号仍然参与排序（它确实指示话题），但永远赢不过任何一个有显式任务信号的候选。
// 为什么要这样：真实口语输入里名词命中常常是「用户提了领域名词、要的却是另一件事」——
// 「报错 → code」这种关键词劫持在评测里表现为"错且自信"（conf 0.55 且判错），
// 是全部失败模式里最危险的一类：它既错，又不肯说自己不确定。
// 把名词降级成弱证据，代价是"看不懂"时判错的数量不变，收益是把假自信清零。
import { TASK_TYPES, CONF } from './schema.js';
import { clamp, uniq } from './util.js';

/** 显式任务信号：命中即"用户明确说了他要做什么"，允许给出高置信度 */
const TASK_PATTERNS = {
  code: [
    /写[^，。；\n]{0,15}?(函数|脚本|代码|程序|类|模块|接口)/,
    /(实现|重构|调试|修复|排错|单元测试)/,
    /\b(implement|refactor|debug)\b/i,
  ],
  write: [
    /写[^，。；\n]{0,15}?(文章|文案|邮件|周报|报告|方案|总结|说明|故事|标题|介绍|模板|话术)/,
    /(起草|撰写|润色|扩写)/,
    /\b(draft|rewrite|copywriting)\b/i,
  ],
  analyze: [
    /(分析|诊断|归因|解读|评估|复盘)/,
    /\b(analy[sz]e|diagnose|root cause)\b/i,
    /(找出|定位|排查)[^，。；\n]{0,10}(原因|问题|瓶颈)/,
  ],
  plan: [
    /(计划|排期|路线图|里程碑|拆解|规划|安排)/,
    /\b(plan|roadmap|milestone|breakdown)\b/i,
  ],
  extract: [
    /(抽取|提取|解析出|归纳出|整理成|结构化)/,
    /\b(extract|parse|structur)\w*/i,
  ],
  transform: [
    /(翻译|译成|转成|转换成|格式化为|改写成)/,
    /\b(translate|convert|format)\b/i,
  ],
  decide: [
    /(选哪个|如何选择|对比|取舍|哪个更|值得吗)/,
    /\b(compare|trade-?off|which one)\b/i,
  ],
  review: [
    /(评审|审查|挑错|找问题|指出[^，。；\n]{0,6}(漏洞|问题))/,
    /\bcode review\b|\breview\b/i,
  ],
  learn: [
    // 口语省略是常态："解释下" 与 "解释一下" 是同一个信号（不区分只说明词表写窄了）
    /(怎么学|如何学|入门|讲解|解释(一下|下)?|教我|原理)/,
    // \bexplain\b 单独出现会把 SQL 的 EXPLAIN 当成"求讲解"，必须要求它带宾语（explain me / explain this）
    /\b(explain\s+(?:me|this|that|how|why|it)|tutorial)\b/i,
  ],
  converse: [/^(你好|hi|hello|在吗)/i, /(聊聊|随便说|陪我说)/],
};

/**
 * 领域名词：指示话题，不指示任务。
 * 只做弱证据——参与排序、封顶置信度，不能单独支撑一个"确定的意图判断"。
 */
const TASK_NOUNS = {
  code: [
    /(bug|报错|异常|堆栈|性能瓶颈)/i,
    /(代码|函数|脚本|接口|数据库|SQL|部署)/i,
  ],
  // 故障线索：用户在描述"出了什么问题"，通常指向诊断（analyze），但单靠它不能确定
  analyze: [
    /(报错|异常|故障|崩溃|超时|timeout|挂了|失败|没生效|不生效|回滚|丢失|不一致|泄漏|瓶颈|很慢|太慢|慢了)/i,
  ],
};

// 交付物形态：顺序即优先级，先到先得
const DELIVERABLE_PATTERNS = [
  ['json', /\bjson\b/i],
  ['checklist', /(检查清单|待办清单|勾选|checkbox|checklist|todo)/i],
  ['table', /(表格|表格式|对比表|矩阵)/],
  ['list', /(清单|列表|条目|分条|bullet|三点式|要点式)/],
  ['markdown', /\bmarkdown\b|\bmd\b/i],
  ['code', /(代码|函数|脚本|伪代码|可运行)/],
  ['email', /(邮件|email)/i],
  ['report', /(分析报告|报告)/],
  ['slides', /(ppt|幻灯片|slide)/i],
  ['sql', /\bsql\b/i],
  ['plan', /(计划书|排期表|路线图)/],
  ['prose', /(散文|自然段|连贯段落)/],
];

const DOMAIN_PATTERNS = {
  software: [
    /(代码|函数|脚本|接口|数据库|部署|bug|报错|重构|单元测试|架构)/,
    /\b(api|sdk|sql|redis|mysql|docker|k8s|rust|python|java|golang|go|typescript|javascript)\b/i,
  ],
  data: [/(数据|指标|报表|埋点|统计|同比|环比)/, /\b(csv|etl|dashboard)\b/i],
  business: [/(商业|运营|增长|定价|客户|收入|成本|市场|竞品)/],
  content: [/(文案|标题|选题|公众号|视频|脚本创作)/],
  education: [/(课程|教学|学习|入门|考试|知识点)/],
  research: [/(论文|文献|实验|假设检验|综述|课题)/],
  ops: [/(运维|监控|告警|发布流程|扩容|故障|回滚)/],
  design: [/\b(ui|ux)\b/i, /(交互|视觉|原型|设计稿|配色)/],
  life: [/(健身|旅行|饮食|睡眠|运动|生活|减肥)/],
};

function bucketScore(text, patterns) {
  const hits = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) hits.push(m[0]);
  }
  return { count: hits.length, hits: uniq(hits) };
}

/** 名词信号封顶：低于 CONF.annotate，保证"只有名词证据"不会自称确定 */
export const NOUN_ONLY_CONFIDENCE_CAP = CONF.annotate - 0.05;

/**
 * @param {string} text 用户原始输入
 * @returns 意图与置信度。
 *   - fallback=true：没有任何信号，task_type 是无信息量的兜底（write），调用方应视为"未识别"
 *   - sufficient=false：只有领域名词，没有显式任务信号，置信度已封顶
 *   - ambiguous=true：第一、二名证据强度相同
 */
export function detectIntent(text) {
  const src = String(text ?? '');

  const ranked = TASK_TYPES.map((task) => {
    const direct = bucketScore(src, TASK_PATTERNS[task]);
    const noun = bucketScore(src, TASK_NOUNS[task] ?? []);
    return {
      task,
      direct: direct.count,
      noun: noun.count,
      count: direct.count + noun.count,
      hits: uniq([...direct.hits, ...noun.hits]),
    };
  })
    .filter((r) => r.count > 0)
    // 排序：先看有没有显式任务信号，再看证据条数，最后按本体顺序稳定兜底
    .sort(
      (a, b) =>
        Number(b.direct > 0) - Number(a.direct > 0)
        || b.direct - a.direct
        || b.noun - a.noun
        || TASK_TYPES.indexOf(a.task) - TASK_TYPES.indexOf(b.task),
    );

  const top = ranked[0] ?? null;
  const second = ranked[1] ?? null;
  const ambiguous = Boolean(top && second && second.direct === top.direct && second.count === top.count);

  const task_type = top ? top.task : 'write'; // 无信号时回退到最通用的写作意图（并标 fallback）
  const sufficient = Boolean(top && top.direct > 0);
  let confidence;
  if (!top) confidence = 0.2;
  else if (!sufficient) confidence = Math.min(0.3 + 0.1 * top.count, NOUN_ONLY_CONFIDENCE_CAP);
  else confidence = clamp(0.35 + 0.2 * top.count, 0, 0.95);
  if (ambiguous) confidence = Math.min(confidence, CONF.annotate + 0.1);

  let deliverable_format = null;
  let deliverable_confidence = 0;
  let deliverable_evidence = null;
  for (const [fmt, re] of DELIVERABLE_PATTERNS) {
    const m = src.match(re);
    if (m) {
      deliverable_format = fmt;
      deliverable_confidence = 0.85;
      deliverable_evidence = m[0];
      break;
    }
  }

  let domain = 'other';
  for (const [name, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    if (patterns.some((p) => p.test(src))) {
      domain = name;
      break;
    }
  }

  return {
    task_type,
    confidence: Number(confidence.toFixed(3)),
    ambiguous,
    fallback: !top,
    sufficient,
    signals: top ? { direct: top.direct, noun: top.noun } : { direct: 0, noun: 0 },
    alternatives: ranked.slice(0, 3).map((r) => ({ task_type: r.task, count: r.count, direct: r.direct })),
    evidence: top ? top.hits : [],
    domain,
    deliverable_format,
    deliverable_confidence,
    deliverable_evidence,
  };
}
