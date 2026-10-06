#!/usr/bin/env node
// CLI：node src/cli.js "原始输入" [--json] [--ask] [--answers '<json>' | --answers-file <path>]
//      [--tier fast|standard] [--model reasoning|fast|generic] [--trace out.jsonl] [--max-cost 0.5]
//      [--goal concise,specific,context,format] [--stream] [--copy] [--diff]
//      [--history [n]] [--history-show <id|序号>] [--history-file <path>] [--no-save]
import { readFileSync } from 'node:fs';
import { optimize, optimizeAsync } from './pipeline.js';
import { appendTrace, traceRecord } from './trace.js';
import { resolveGoals, GOAL_IDS } from './goals.js';
import { copyText } from './clipboard.js';
import { diffLines, formatDiff, diffStats } from './diff.js';
import {
  DEFAULT_HISTORY_FILE, makeRecord, appendHistory, readHistory, listHistory, showHistory, clearHistory,
} from './history.js';

const USAGE = `用法：
  node src/cli.js "你的原始输入" [选项]
  echo "你的原始输入" | node src/cli.js [选项]

选项：
  --json                    输出完整 JSON（含 contract / slots / decisions / conflicts / clarify / llm）
  --ask                     宿主有交互容器：返回追问清单（否则缺口一律转"假设+标注"）
  --answers <json>          回收上一轮追问的回答，如 '{"q_goal":"产出一份发布检查清单"}'
                            key 用问题 id（q_<槽位 id>）或槽位 id；空回答记 skipped 不报错
  --answers-file <path>     从 JSON 文件读取回答（与 --answers 互斥）
  --goal <列表>             优化目标，逗号分隔（可多选）：${GOAL_IDS.join(' | ')}
  --stream                  流式接收模型分析输出（standard 档；进度打到 stderr，不污染 stdout）
  --copy                    把优化结果复制到系统剪贴板
  --diff                    在 stderr 打印原文与优化结果的逐行对比及字数变化
  --trace <path>            追加一行轨迹到 JSONL 文件
  --model <name>            目标模型：generic | reasoning | fast
  --tier <name>             档位：fast（默认，0 次）| standard（1 次调用）| deep（3 次调用+自检，需 API key）
  --max-cost <元>           standard 档的单次会话花费上限（默认 0.5）
  --no-save                 本次结果不写入优化历史（默认写入）
  --history-file <path>     自定义历史文件（默认 .prompt-optimizer/history.jsonl）
  --history [n]             查看最近 n 条优化历史（默认 20），无需输入文本
  --history-show <id|序号>  查看单条完整记录（JSON）
  --history-clear           清空历史文件
  -h, --help                显示帮助

环境变量（standard 档）：
  DEEPSEEK_API_KEY 或 OPENAI_API_KEY 或 PROMPT_OPTIMIZER_API_KEY
  PROMPT_OPTIMIZER_MODEL / PROMPT_OPTIMIZER_BASE_URL  覆盖默认端点
  PROMPT_OPTIMIZER_NO_CACHE=1                          关闭磁盘缓存（默认开，缓存命中不花钱）
`;

const usageError = (msg) => {
  process.stderr.write(`错误：${msg}\n\n` + USAGE);
  process.exit(2);
};

const argv = process.argv.slice(2);
const flags = {
  json: false, ask: false, trace: null, model: 'generic', tier: 'fast',
  maxCost: null, answers: null, answersFile: null,
  goal: null, stream: false, copy: false, diff: false,
  save: true, historyFile: null, history: null, historyShow: null, historyClear: false,
};
const rest = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') flags.json = true;
  else if (a === '--ask') flags.ask = true;
  else if (a === '-h' || a === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (a === '--trace') flags.trace = argv[++i];
  else if (a === '--model') flags.model = argv[++i];
  else if (a === '--tier') flags.tier = argv[++i];
  else if (a === '--max-cost') flags.maxCost = Number(argv[++i]);
  else if (a === '--goal') flags.goal = argv[++i];
  else if (a === '--stream') flags.stream = true;
  else if (a === '--copy') flags.copy = true;
  else if (a === '--diff') flags.diff = true;
  else if (a === '--no-save') flags.save = false;
  else if (a === '--history-file') flags.historyFile = argv[++i];
  else if (a === '--history-clear') flags.historyClear = true;
  else if (a === '--history') {
    // n 是可选参数：后面紧跟纯数字才算（避免吞掉下一个旗标）
    flags.history = 20;
    const nxt = argv[i + 1];
    if (nxt !== undefined && /^\d+$/.test(nxt)) {
      flags.history = Number(nxt);
      i++;
    }
  } else if (a === '--history-show') {
    const v = argv[++i];
    if (v === undefined) usageError('--history-show 缺少 id 或序号参数');
    flags.historyShow = v;
  } else if (a === '--answers') {
    const v = argv[++i];
    if (v === undefined) usageError('--answers 缺少 JSON 参数');
    flags.answers = v;
  } else if (a === '--answers-file') {
    const v = argv[++i];
    if (v === undefined) usageError('--answers-file 缺少路径参数');
    flags.answersFile = v;
  } else rest.push(a);
}

const historyFile = flags.historyFile ?? DEFAULT_HISTORY_FILE();

// —— 历史模式：只读写历史文件，不需要输入文本 ——
if (flags.historyClear) {
  const removed = clearHistory(historyFile);
  process.stdout.write(`${removed ? '已清空' : '历史文件不存在'}：${historyFile}\n`);
  process.exit(0);
}
if (flags.historyShow !== null) {
  const rec = showHistory(historyFile, flags.historyShow);
  if (!rec) {
    process.stderr.write(`错误：历史里找不到 ${flags.historyShow}（可用 --history 先看序号/id）。\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
  process.exit(0);
}
if (flags.history !== null) {
  const { skipped } = readHistory(historyFile);
  const items = listHistory(historyFile, flags.history);
  if (skipped.length) process.stderr.write(`⚠ 历史文件有 ${skipped.length} 行损坏已跳过：${JSON.stringify(skipped)}\n`);
  if (!items.length) process.stdout.write('（暂无历史记录）\n');
  for (const { no, record } of items) {
    const flag = record.degraded ? ' [降级]' : '';
    process.stdout.write(
      `#${no} ${record.at} ${record.tier}${flag} ${record.taskType ?? '?'} `
        + `¥${Number(record.costYuan ?? 0).toFixed(4)} ${record.totalMs ?? '?'}ms\n`
        + `    ${record.input.replace(/\s+/g, ' ').slice(0, 60)}\n    id=${record.id}\n`,
    );
  }
  process.exit(0);
}

// 回答来源：两个入口互斥——同时给是用法错误，不做"后者覆盖前者"的静默取舍
if (flags.answers !== null && flags.answersFile !== null) {
  usageError('--answers 与 --answers-file 不能同时使用，请只给一个。');
}

let answers = null;
if (flags.answers !== null || flags.answersFile !== null) {
  let raw;
  const from = flags.answersFile !== null ? `--answers-file ${flags.answersFile}` : '--answers';
  if (flags.answersFile !== null) {
    try {
      raw = readFileSync(flags.answersFile, 'utf8');
    } catch (e) {
      process.stderr.write(`错误：读取 --answers-file 失败（${flags.answersFile}）：${e.message}\n`);
      process.exit(2);
    }
  } else {
    raw = flags.answers;
  }
  // 记事本 / PowerShell(Set-Content -Encoding utf8) 写出的 UTF-8 文件常带 BOM，JSON.parse 会因此报错 → 容忍并剥掉
  raw = String(raw).replace(/^\uFEFF/, '');
  try {
    answers = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`错误：${from} 的 JSON 解析失败：${e.message}\n  原文：${String(raw).slice(0, 200)}\n`);
    process.exit(2);
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    process.stderr.write('错误：--answers 必须是 JSON 对象，形如 \'{"q_goal":"产出一份发布检查清单"}\'。\n');
    process.exit(2);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

// --goal 在进管线前先校验（未知目标直接用法错误，不做静默丢弃）
let goalIds = [];
try {
  goalIds = resolveGoals(flags.goal);
} catch (e) {
  usageError(e.message);
}

const text = (rest.join(' ').trim() || (await readStdin())).trim();
if (!text) {
  process.stderr.write('错误：没有输入。\n\n' + USAGE);
  process.exit(2);
}

const opts = { tier: flags.tier, targetModel: flags.model, ask: flags.ask, goal: goalIds };
if (Number.isFinite(flags.maxCost)) opts.maxCostYuan = flags.maxCost;
if (answers !== null) opts.answers = answers;
if (flags.stream && flags.tier === 'standard') {
  opts.stream = true;
  opts.onDelta = (d) => process.stderr.write(d);
}

if (flags.stream) process.stderr.write('[模型分析中]\n');

let result;
try {
  result = flags.tier === 'fast' ? optimize(text, opts) : await optimizeAsync(text, opts);
} catch (e) {
  // CLARIFY_ANSWER_UNKNOWN / CLARIFY_ANSWER_INVALID 等带 code 的错误：中文说明 + exit 2
  process.stderr.write(`错误：${e.message}${e.code ? `（${e.code}）` : ''}\n`);
  process.exit(2);
}
if (flags.stream) process.stderr.write('\n[分析完成]\n');

if (flags.trace) appendTrace(flags.trace, traceRecord(result, { input: text }));

// 优化历史：默认写入；写入失败只提醒，不阻塞主流程（appendHistory 内部已兜底）
let historyId = null;
if (flags.save) {
  const record = makeRecord({
    input: text,
    prompt: result.prompt,
    tier: result.meta.tier,
    taskType: result.intent?.task_type ?? null,
    confidence: result.intent?.confidence ?? null,
    costYuan: result.meta.llm?.costYuan ?? 0,
    totalMs: result.meta.totalMs ?? result.meta.ms,
    degraded: result.meta.degraded === true,
  });
  if (appendHistory(historyFile, record) === 1) historyId = record.id;
  else process.stderr.write(`⚠ 优化历史写入失败（${historyFile}），本次结果未存档。\n`);
}

if (flags.json) {
  process.stdout.write(
    JSON.stringify(
      {
        prompt: result.prompt,
        intent: result.intent,
        slots: result.slots,
        contract: result.contract,
        questions: result.questions,
        assumptions: result.assumptions,
        conflicts: result.conflicts,
        decisions: result.ir.decisions,
        clarify: result.meta.clarify,
        violations: result.violations,
        llm: result.meta.llm,
        meta: { ...result.meta, historyId },
      },
      null,
      2,
    ) + '\n',
  );
} else {
  process.stdout.write(result.prompt);
  const llm = result.meta.llm;
  const cost = llm ? ` · ¥${Number(llm.costYuan ?? 0).toFixed(4)}${llm.cached ? '（缓存命中）' : ''}` : '';
  process.stderr.write(
    `[${result.meta.tier}] ${result.meta.totalMs ?? result.meta.ms}ms · ${result.meta.llmCalls} 次 LLM 调用${cost} · `
      + `假设 ${result.assumptions.length} · 追问 ${result.questions.length} · 冲突 ${result.conflicts.length} · 不变量违规 ${result.violations.length}`
      + `${goalIds.length ? ` · 目标 ${goalIds.join('/')}` : ''}\n`,
  );

  if (flags.diff) {
    const st = diffStats(text, result.prompt);
    process.stderr.write(
      `\n—— 与原文对比（原文 ${st.a.chars} 字 ${st.a.lines} 行 → 结果 ${st.b.chars} 字 ${st.b.lines} 行）——\n`
        + formatDiff(diffLines(text, result.prompt)) + '\n',
    );
  }

  if (flags.copy) {
    const cp = copyText(result.prompt);
    process.stderr.write(cp.ok ? `已复制到剪贴板（${cp.tool}）\n` : `复制失败：${cp.error}\n`);
  }

  if (historyId) process.stderr.write(`已存历史 id=${historyId}（${historyFile}）\n`);

  const noAnswersGiven = answers === null || Object.keys(answers).length === 0;
  if (flags.ask && noAnswersGiven && result.questions.length > 0) {
    const q0 = result.questions[0];
    process.stderr.write(
      `提示：回答后用 --answers 回收，例如 --answers '{"${q0.id}":"${q0.options[0] ?? ''}"}'`
        + '（回答较多时可写进 JSON 文件用 --answers-file answers.json）。\n',
    );
  }
}

if (result.meta.degraded) {
  const llm = result.meta.llm ?? {};
  process.stderr.write(
    `⚠ 已降级：模型分析失败（${llm.code ?? 'LLM_ERROR'}：${llm.reason ?? ''}），本次输出来自规则层 fast 路径。\n`,
  );
  process.exitCode = 3;
}
if (result.violations.length > 0) process.exitCode = 1;
