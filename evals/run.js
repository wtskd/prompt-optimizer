// 评测器：意图/形态准确率 + 置信度分层 + 成本记账 + 基线快照/漂移比对/双档对照。
//
//   node evals/run.js                                    Fast 档跑 samples.jsonl（盲测集，0 次 LLM 调用）
//   node evals/run.js --file evals/dev.jsonl             跑指定集合
//   node evals/run.js --tier standard --estimate         Standard 档先看钱：只估算，一次请求都不发
//   node evals/run.js --tier standard                    Standard 档真实调用（需要 API key）
//   node evals/run.js --tier standard --mock mock.demo.jsonl --limit 6   离线验证链路（0 费用）
//   node evals/run.js --record [out.json]                记录快照（默认 baseline.<tier>.json）
//   node evals/run.js --diff baseline.fast.json          与快照比对漂移
//   node evals/run.js --compare a.json b.json            两份快照对照（如 fast → standard 的增益）
//   node evals/run.js --recompute baseline.standard.json 用快照里已记录的预测重算指标（0 次 LLM 调用）
//
// 样本行格式（expect 可省略：省略即「未标注」，只记快照、不参与准确率）：
//   {"id":"b01","text":"帮我把这段话回得客气点","expect":{"task_type":"transform","deliverable_format":"table"}}
//   task_type 写成数组表示「这些标签都算对」（边界样本多标签；第一个元素是主标签，严格口径按它算）：
//   {"id":"u08","text":"k8s pod 一直 pending 咋排查","expect":{"task_type":["plan","analyze"]}}
//
// 退出码：0 = 标注样本全对且无违规无降级；1 = 有判错/违规/降级；2 = 用法或配置错误。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { optimize, optimizeAsync } from '../src/pipeline.js';
import { VERSION } from '../src/schema.js';
import { resolveConfig, createProvider, estimateCost, llmError, PRICES } from '../src/llm/provider.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function optList(name, count) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  return argv.slice(i + 1, i + 1 + count).filter((v) => v && !v.startsWith('--'));
}

const has = (name) => argv.includes(name);

const fileArg = opt('--file', 'samples.jsonl');
let tier = String(opt('--tier', 'fast'));
const tierExplicit = has('--tier');
const recordArg = opt('--record');
const recomputeArg = opt('--recompute');
const diffArg = opt('--diff');
const compareArg = optList('--compare', 2);
const mockArg = opt('--mock');
const limitArg = opt('--limit');
const estimateArg = has('--estimate');
const maxCostArg = opt('--max-cost');

if (!['fast', 'standard', 'deep'].includes(tier)) {
  console.error(`✗ 未知档位：${tier}（可选 fast / standard / deep）`);
  process.exit(2);
}

/** 相对路径先按仓库根（cwd）解析，再退回 evals/ 目录，避免 evals/evals/x.jsonl 这种重复前缀 */
function resolveInput(p) {
  const fromCwd = resolve(process.cwd(), p);
  if (existsSync(fromCwd)) return fromCwd;
  const fromHere = resolve(here, p);
  if (existsSync(fromHere)) return fromHere;
  return fromCwd;
}

function loadJsonl(p, label = '样本') {
  const target = resolveInput(p);
  if (!existsSync(target)) {
    console.error(`找不到${label}文件：${p}`);
    console.error(`  已尝试：${target}`);
    console.error(`  当前目录：${process.cwd()}`);
    console.error('  修法一：先 cd 到仓库根再运行 ——  cd /d/project/deepseek');
    console.error('  修法二：把 evals/inputs.local.example.jsonl 复制成 evals/inputs.local.jsonl，再逐行填你的真实输入');
    process.exit(2);
  }
  return readFileSync(target, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('//'))
    .map((l, i) => {
      let rec;
      try {
        rec = JSON.parse(l);
      } catch (err) {
        throw new Error(`${p}:${i + 1} 不是合法 JSON：${err.message}`);
      }
      // 字段名兼容：新采集的集合用 `input`，历史集合用 `text`。
      // 缺字段时**必须报错**：曾经因为只认 text，整集被当成 undefined 跑完，
      // 报告看着完整、其实是 0 分假数据（2026-10-04 holdout4 事故）。
      if (rec.text === undefined && rec.input !== undefined) rec.text = rec.input;
      if (rec.text === undefined || rec.text === null || String(rec.text).trim() === '') {
        throw new Error(`${p}:${i + 1} 缺少输入文本（字段名需为 text 或 input）`);
      }
      return rec;
    });
}

/** Standard 档费用估算的固定假设（写死在报告里，避免"估算口径不明"） */
const EST = { systemTokens: 900, completionTokens: 200 };
const estUsage = (text) => ({
  promptMiss: EST.systemTokens + String(text ?? '').length,
  promptHit: 0,
  completion: EST.completionTokens,
});

function printEstimate(samples, model, file) {
  const per = samples.map((s) => estimateCost(estUsage(s.text), model));
  const total = per.reduce((a, b) => a + b, 0);
  const price = PRICES[model];
  const avgChars = Math.round(samples.reduce((a, s) => a + String(s.text ?? '').length, 0) / samples.length);
  console.log(`=== Standard 档费用估算 · ${file}（只估算，不发请求） ===`);
  console.log(`样本数            : ${samples.length}`);
  console.log(`模型              : ${model}${price ? '' : '（不在价目表里，按 deepseek-chat 近似）'}`);
  console.log(`价目表（元/百万） : 输入未命中 ${price?.inMiss ?? 2} · 缓存命中 ${price?.inHit ?? 0.2} · 输出 ${price?.out ?? 3}`);
  console.log(`估算假设          : 输入 ≈ ${EST.systemTokens}（system）+ 输入字数；输出 ≈ ${EST.completionTokens} token`);
  console.log(`单条估算          : ¥${(total / samples.length).toFixed(4)}（平均输入 ${avgChars} 字）`);
  console.log(`合计估算          : ¥${total.toFixed(4)}`);
  console.log(`运行预算上限      : ¥${maxCostArg ? Number(maxCostArg) : 0.5}（--max-cost 可调；超限立即中止，不写快照）`);
  console.log(`缓存              : 同输入重复跑命中 .cache/llm，第二次起 ¥0`);
  console.log(`\n实际花费以账单为准；先 --limit 3 试跑最省：node evals/run.js --tier standard --file ${file} --limit 3`);
}

/** mock：把预置的模型输出喂给同一条 standard 管线（离线、0 费用、可复现） */
function makeMockProvider(map, state) {
  return {
    config: { baseUrl: 'mock://offline', model: 'mock', apiKey: 'mock' },
    async chat() {
      state.calls += 1;
      const entry = map.get(state.current);
      if (!entry) {
        throw llmError('LLM_MOCK_MISSING', `mock 覆盖里没有 id=${state.current} 的预置分析（用 --limit 截到覆盖范围内）`);
      }
      const usage = entry.usage ?? { promptMiss: 900, promptHit: 0, completion: 200, total: 1100 };
      const model = entry.model ?? 'deepseek-chat';
      const text = typeof entry.analysis === 'string' ? entry.analysis : JSON.stringify(entry.analysis);
      return {
        text,
        usage,
        // mock 复现真实计价口径：缓存命中 ¥0，free:true 表示不扣费；便于核对成本记账
        cost: entry.cached === true || entry.free === true ? 0 : estimateCost(usage, model),
        cached: entry.cached === true,
        model: `mock/${model}`,
      };
    },
    stats() {
      return { calls: state.calls, spentYuan: 0 };
    },
  };
}

function loadMockMap(p) {
  const map = new Map();
  for (const o of loadJsonl(p, 'mock')) {
    if (!o.id) throw new Error(`${p}: mock 行缺少 id`);
    map.set(o.id, o);
  }
  return map;
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

/** 标注可以是单标签字符串，也可以是「都算对」的数组（边界样本多标签；数组第一个元素是主标签） */
const acceptOf = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const primaryOf = (v) => (Array.isArray(v) ? v[0] : v);

/** 混淆矩阵：行 = 标注主标签，列 = 引擎/模型判定；* = 不在可接受集合内（真错） */
function printConfusion(taskRows) {
  const expects = [...new Set(taskRows.map((r) => primaryOf(r.expect.task_type)))];
  console.log('\n混淆矩阵（行 = 标注主标签，列 = 引擎判定；* = 真错，无 * = 命中可接受集合）:');
  for (const e of expects) {
    const group = taskRows.filter((r) => primaryOf(r.expect.task_type) === e);
    const tally = new Map();
    for (const r of group) {
      const cur = tally.get(r.task_type) ?? { ok: 0, bad: 0 };
      if (acceptOf(r.expect.task_type).includes(r.task_type)) cur.ok += 1;
      else cur.bad += 1;
      tally.set(r.task_type, cur);
    }
    const cells = [...tally.entries()]
      .sort((a, b) => b[1].ok + b[1].bad - (a[1].ok + a[1].bad) || String(a[0]).localeCompare(String(b[0])))
      .flatMap(([k, c]) => [
        ...(c.ok ? [`${k} ${c.ok}`] : []),
        ...(c.bad ? [`${k}* ${c.bad}`] : []),
      ]);
    console.log(`  ${String(e).padEnd(9)}(${group.length}) → ${cells.join(' · ')}`);
  }
}

async function main() {
  // 对照模式：只读两份快照，不跑评测、不建 provider、不发请求
  if (compareArg) {
    if (compareArg.length !== 2) {
      console.error('✗ --compare 需要两个快照路径：--compare baseline.fast.json baseline.standard.json');
      process.exit(2);
    }
    printCompare(resolveInput(compareArg[0]), resolveInput(compareArg[1]));
    return;
  }

  const samplesAll = loadJsonl(fileArg);

  // 示例占位文本绝不会出现在真实需求里：拦住它，否则会把"假基线"当成基线记下来
  const PLACEHOLDER_RE = /粘在这里|第二条真实需求|这条故意不写|最常出现的一句原始需求/;
  const placeholders = samplesAll.filter((s) => PLACEHOLDER_RE.test(s.text ?? ''));
  if (placeholders.length) {
    const ids = placeholders.map((s) => s.id ?? '?').join('、');
    console.error(`✗ 检测到 ${placeholders.length} 条示例占位输入（${ids}），它们不是你的真实需求。`);
    console.error('  → 这次的数字不构成基线，已跳过记录。');
    console.error(`  编辑 ${resolve(here, 'inputs.local.jsonl')}：把示例那几行删掉，换成你的真实原话，然后重跑。`);
    process.exit(2);
  }

  const limit = limitArg && limitArg !== true ? Number(limitArg) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    console.error(`✗ --limit 需要正整数，收到：${limitArg}`);
    process.exit(2);
  }
  const samples = limit ? samplesAll.slice(0, limit) : samplesAll;

  // 估费模式：不建 provider、不发请求
  if (estimateArg) {
    if (tier !== 'standard') {
      console.error('✗ --estimate 只对 --tier standard 有意义（fast 档 0 次 LLM 调用，费用恒为 0）');
      process.exit(2);
    }
    const cfg = resolveConfig(process.env);
    printEstimate(samples, cfg.ok ? cfg.model : 'deepseek-chat', fileArg);
    process.exit(0);
  }

  let rows = [];
  let isMock = Boolean(mockArg);
  let model = 'rules';
  let snapshotSource = null;
  const recomputePath = recomputeArg
    ? resolveInput(typeof recomputeArg === 'string' ? recomputeArg : 'samples.jsonl')
    : null;

  // 重算模式：只用快照里已记录的预测重算指标，0 次 LLM 调用（标注修订后不必再花钱重跑模型）
  if (recomputePath) {
    if (!existsSync(recomputePath)) {
      console.error(`✗ 找不到快照：${recomputePath}`);
      console.error('  → 先记录一份：node evals/run.js --tier standard --file inputs.local.jsonl --record baseline.standard.json');
      process.exit(2);
    }
    const snap = JSON.parse(readFileSync(recomputePath, 'utf8'));
    const byId = new Map(snap.samples.map((s) => [s.id, s]));
    const missing = samples.filter((s) => !byId.has(s.id));
    if (missing.length) {
      console.error(`✗ 快照里没有这些样本的预测：${missing.map((s) => s.id).join('、')}`);
      console.error('  → 重算必须用同一批样本：--file 要和当初 --record 时一致。');
      process.exit(2);
    }
    snapshotSource = snap;
    if (!tierExplicit && snap.tier) tier = snap.tier;
    model = snap.model ?? model;
    isMock = snap.mocked === true;
    rows = samples.map((s) => {
      const p = byId.get(s.id);
      return {
        id: s.id,
        text: s.text,
        expect: s.expect ?? {},
        task_type: p.task_type,
        confidence: p.confidence,
        fallback: p.fallback === true,
        sufficient: true,
        alternatives: null,
        deliverable_format: p.deliverable_format ?? null,
        language: p.language ?? null,
        assumptions: p.assumptions ?? 0,
        questions: p.questions ?? 0,
        conflicts: p.conflicts ?? 0,
        violations: 0,
        promptHash: p.promptHash ?? null,
        stable: null,
        ms: p.ms ?? 0,
        totalMs: p.totalMs ?? p.ms ?? 0,
        llmStatus: p.llmStatus ?? null,
        llmCached: false,
        costYuan: p.costYuan ?? 0,
        degraded: p.llmStatus === 'error',
        merged: null,
        llmCode: null,
      };
    });
  } else {
  const mockState = isMock ? { current: null, calls: 0 } : null;
  let provider = null;

  if (tier !== 'fast') {
    if (isMock) {
      provider = makeMockProvider(loadMockMap(mockArg), mockState);
      model = 'mock';
    } else {
      const cfg = resolveConfig(process.env);
      if (!cfg.ok) {
        console.error(`✗ LLM_CONFIG_MISSING：${cfg.reason}`);
        console.error(`  → 只想看费用不发请求：node evals/run.js --tier standard --file ${fileArg} --estimate`);
        console.error('  → 想离线验证链路：node evals/run.js --tier standard --file inputs.local.jsonl --limit 6 --mock mock.demo.jsonl');
        process.exit(2);
      }
      model = cfg.model;
      provider = createProvider(cfg, {
        cacheDir: resolve(here, '../.cache/llm'),
        ...(maxCostArg && maxCostArg !== true ? { maxCostYuan: Number(maxCostArg) } : {}),
      });
    }
  }

  const rowsOut = [];
  for (const s of samples) {
    const id = s.id ?? `#${rowsOut.length + 1}`;
    let r1;
    let r2 = null;

    if (tier === 'fast') {
      r1 = optimize(s.text, {});
      r2 = optimize(s.text, {}); // fast 档零成本，跑两遍验确定性
    } else {
      if (mockState) mockState.current = id;
      r1 = await optimizeAsync(s.text, { tier, provider });
      if (mockState) {
        mockState.current = id;
        r2 = await optimizeAsync(s.text, { tier, provider }); // mock 零成本，同样验确定性
      }
    }

    const llm = r1.meta.llm;
    rowsOut.push({
      id,
      text: s.text,
      expect: s.expect ?? {},
      task_type: r1.ir.intent.task_type,
      confidence: r1.ir.intent.confidence,
      fallback: r1.ir.intent.fallback === true,
      sufficient: r1.ir.intent.sufficient !== false,
      alternatives: r1.ir.intent.alternatives,
      deliverable_format: r1.ir.slots.deliverable_format?.value ?? null,
      language: r1.ir.slots.language?.value ?? null,
      assumptions: r1.assumptions.length,
      questions: r1.questions.length,
      conflicts: r1.conflicts.length,
      violations: r1.violations.length,
      promptHash: r1.meta.promptHash,
      stable: r2 ? r1.meta.promptHash === r2.meta.promptHash : null,
      ms: r1.meta.ms,
      totalMs: r1.meta.totalMs,
      llmStatus: llm ? llm.status : null,
      llmCached: llm ? llm.cached : false,
      costYuan: llm ? (llm.costYuan ?? 0) + (llm.deep?.enrich?.costYuan ?? 0) + (llm.deep?.verify?.costYuan ?? 0) : 0,
      degraded: r1.meta.degraded === true,
      merged: llm && llm.merged
        ? {
            applied: llm.merged.applied.length,
            agreed: llm.merged.agreed.length,
            blocked: llm.merged.blocked.length,
            skipped: llm.merged.skipped.length,
          }
        : null,
      llmCode: llm ? llm.code : null,
    });
  }
  rows = rowsOut;
  } // end：非重算分支

  const labeled = rows.filter((r) => r.expect.task_type || r.expect.deliverable_format);
  const taskRows = rows.filter((r) => acceptOf(r.expect.task_type).length);
  const delRows = rows.filter((r) => r.expect.deliverable_format);
  const taskOk = taskRows.filter((r) => r.task_type === primaryOf(r.expect.task_type));
  const taskOkAny = taskRows.filter((r) => acceptOf(r.expect.task_type).includes(r.task_type));
  const multiLabel = taskRows.filter((r) => acceptOf(r.expect.task_type).length > 1);
  const delOk = delRows.filter((r) => r.deliverable_format === r.expect.deliverable_format);

  const adoptable = taskOkAny.filter((r) => r.confidence >= 0.8);
  const annotate = rows.filter((r) => r.confidence >= 0.5 && r.confidence < 0.8);
  const lowish = rows.filter((r) => r.confidence < 0.5);
  const wrongConfident = taskRows.filter((r) => !acceptOf(r.expect.task_type).includes(r.task_type) && r.confidence >= 0.5);
  const fallbackRows = rows.filter((r) => r.fallback);
  const degradedRows = rows.filter((r) => r.degraded);
  const cachedRows = rows.filter((r) => r.llmCached);
  const costYuan = rows.reduce((s, r) => s + (r.costYuan ?? 0), 0);
  const avgMs = rows.reduce((s, r) => s + r.ms, 0) / rows.length;
  const avgTotalMs = rows.reduce((s, r) => s + (r.totalMs ?? r.ms), 0) / rows.length;
  const stableRows = rows.filter((r) => r.stable === true);
  const determinism = rows[0] && rows[0].stable === null ? null : pct(stableRows.length, rows.length);
  const merged = rows.reduce(
    (acc, r) => {
      if (!r.merged) return acc;
      acc.applied += r.merged.applied;
      acc.agreed += r.merged.agreed;
      acc.blocked += r.merged.blocked;
      acc.skipped += r.merged.skipped;
      return acc;
    },
    { applied: 0, agreed: 0, blocked: 0, skipped: 0 },
  );

  const tierLabel = `${snapshotSource ? '重算 · ' : ''}${tier === 'fast' ? 'Fast' : tier === 'deep' ? 'Deep' : isMock ? 'Standard（mock 离线）' : 'Standard'}`;
  const callsPer = snapshotSource
    ? '0 次 LLM 调用，用快照预测重算'
    : tier === 'fast' ? '0 次 LLM 调用' : '1 次 LLM 调用/条';
  console.log(`=== ${tierLabel} 档评测 · ${fileArg}（${callsPer}） ===`);
  if (snapshotSource) {
    console.log(`预测来源                  : ${recomputePath}（记录于 ${snapshotSource.recordedAt ?? '?'} · ${model}）`);
  }
  console.log(`样本数                    : ${rows.length}（已标注 ${labeled.length}${limit ? `，--limit ${limit}` : ''}）`);
  console.log(`意图准确率（严格）        : ${pct(taskOk.length, taskRows.length)} (${taskOk.length}/${taskRows.length})  ← 只认主标签`);
  if (multiLabel.length) {
    console.log(`意图准确率（含可接受替代）: ${pct(taskOkAny.length, taskRows.length)} (${taskOkAny.length}/${taskRows.length})  ← ${multiLabel.length} 条边界样本为多标签`);
  }
  console.log(`交付物形态准确率          : ${pct(delOk.length, delRows.length)} (${delOk.length}/${delRows.length})`);
  console.log(`可直接采用率（conf≥0.8）  : ${pct(adoptable.length, taskRows.length)}  ← 设计阈值 90% 应按此口径衡量`);
  console.log(`需标注区间（0.5–0.8）     : ${annotate.length}`);
  console.log(`低置信/无信号（<0.5）     : ${lowish.length}`);
  console.log(`  └ 规则层无信号回退      : ${fallbackRows.length}  ← intent.fallback=true，task_type 无信息量`);
  console.log(`错且自信（错且 conf≥0.5） : ${wrongConfident.length}  ← 最危险的一类`);
  if (tier === 'standard') {
    const s0 = snapshotSource?.summary ?? {};
    console.log(`模型补丁 采纳/一致/拦下/丢弃: ${snapshotSource ? '见原快照（本次重算未重新调用）' : `${merged.applied} / ${merged.agreed} / ${merged.blocked} / ${merged.skipped}`}`);
    console.log(`模型失败降级（走规则层）  : ${degradedRows.length}${degradedRows.length ? `  ← ${[...new Set(degradedRows.map((r) => r.llmCode))].join(', ')}` : ''}`);
    console.log(`LLM 调用 / 缓存命中       : ${snapshotSource ? `${s0.llmCalls ?? 0} / ${s0.cached ?? 0}（来自快照）` : `${rows.filter((r) => r.llmStatus === 'ok' && !r.llmCached).length} / ${cachedRows.length}`}`);
    console.log(`模型花费（按价目表估算）  : ¥${Number(snapshotSource ? s0.costYuan ?? 0 : costYuan).toFixed(4)}${snapshotSource ? '（来自快照，本次未花钱）' : isMock ? '（mock 模拟计价，未真实扣费）' : ''}`);
  }
  console.log(`确定性（两次一致）        : ${determinism ?? 'n/a（真实调用不重复跑，省费用）'}`);
  console.log(`平均单次耗时              : ${avgMs.toFixed(1)} ms（本地） / ${avgTotalMs.toFixed(1)} ms（含模型往返）`);
  console.log(`延迟预算                  : ${tier === 'fast' ? 300 : 3000} ms（按含往返口径看）`);
  console.log(`冲突 / 不变量违规         : ${rows.reduce((s, r) => s + r.conflicts, 0)} / ${rows.reduce((s, r) => s + r.violations, 0)}`);

  const taskBad = taskRows.filter((r) => !acceptOf(r.expect.task_type).includes(r.task_type));
  const delBad = delRows.filter((r) => r.deliverable_format !== r.expect.deliverable_format);
  if (taskBad.length || delBad.length) {
    console.log('\n未通过样本：');
    for (const r of rows) {
      const bad = [];
      const acc = acceptOf(r.expect.task_type);
      if (acc.length && !acc.includes(r.task_type)) {
        bad.push(`意图 期望 ${primaryOf(r.expect.task_type)}${acc.length > 1 ? `（可接受 ${acc.join(' / ')}）` : ''} → 实际 ${r.task_type} (conf ${r.confidence})`);
      }
      if (r.expect.deliverable_format && r.deliverable_format !== r.expect.deliverable_format) bad.push(`形态 期望 ${r.expect.deliverable_format} → 实际 ${r.deliverable_format}`);
      if (bad.length) console.log(` - ${r.id}｜${bad.join('；')}｜「${r.text}」`);
    }
  } else if (taskRows.length) {
    console.log('\n未通过样本：无（已标注样本全部命中）');
  }

  if (taskRows.length) printConfusion(taskRows);

  if (degradedRows.length) {
    console.log('\n降级样本（模型失败，输出仍可用但来自规则层）：');
    for (const r of degradedRows) console.log(` - ${r.id}｜${r.llmCode}｜「${r.text}」`);
  }

  console.log('\n低置信样本（需标注或需 LLM 兜底）：');
  for (const r of lowish) {
    console.log(` - ${r.id} conf ${r.confidence}${r.fallback ? ' (无信号回退)' : ''} → ${r.task_type}｜「${r.text}」`);
  }

  const summary = {
    samples: rows.length,
    labeled: labeled.length,
    taskAccuracy: taskRows.length ? Number((taskOk.length / taskRows.length).toFixed(4)) : null,
    taskAccuracyAny: taskRows.length ? Number((taskOkAny.length / taskRows.length).toFixed(4)) : null,
    multiLabel: multiLabel.length,
    deliverableAccuracy: delRows.length ? Number((delOk.length / delRows.length).toFixed(4)) : null,
    adoptable: Number((adoptable.length / rows.length).toFixed(4)),
    wrongConfident: wrongConfident.length,
    annotate: annotate.length,
    lowish: lowish.length,
    fallback: fallbackRows.length,
    degraded: degradedRows.length,
    conflicts: rows.reduce((s, r) => s + r.conflicts, 0),
    violations: rows.reduce((s, r) => s + r.violations, 0),
    avgMs: Number(avgMs.toFixed(2)),
    avgTotalMs: Number(avgTotalMs.toFixed(2)),
    determinism: determinism === null ? null : Number((stableRows.length / rows.length).toFixed(4)),
    llmCalls: snapshotSource ? (snapshotSource.summary?.llmCalls ?? 0) : rows.filter((r) => r.llmStatus === 'ok' && !r.llmCached).length,
    cached: snapshotSource ? (snapshotSource.summary?.cached ?? 0) : cachedRows.length,
    costYuan: snapshotSource ? Number((snapshotSource.summary?.costYuan ?? 0).toFixed(6)) : Number(costYuan.toFixed(6)),
    mocked: isMock,
    recomputed: Boolean(snapshotSource),
  };

  if (recordArg) {
    const defName = `baseline.${tier}${isMock ? '.mock' : ''}.json`;
    const out = typeof recordArg === 'string' ? resolve(here, recordArg) : resolve(here, defName);
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          version: VERSION,
          tier,
          mocked: isMock,
          model,
          file: fileArg,
          recordedAt: new Date().toISOString(),
          summary,
          samples: rows.map((r) => ({
            id: r.id,
            task_type: r.task_type,
            confidence: r.confidence,
            fallback: r.fallback,
            deliverable_format: r.deliverable_format,
            language: r.language,
            assumptions: r.assumptions,
            questions: r.questions,
            conflicts: r.conflicts,
            promptHash: r.promptHash,
            ms: r.ms,
            totalMs: r.totalMs,
            llmStatus: r.llmStatus,
            costYuan: r.costYuan,
          })),
        },
        null,
        1,
      )}\n`,
      'utf8',
    );
    console.log(`\n快照已写入：${out}`);
  }

  if (diffArg) {
    const base = JSON.parse(readFileSync(resolveInput(diffArg), 'utf8'));
    const before = new Map(base.samples.map((s) => [s.id, s]));
    const after = new Map(rows.map((r) => [r.id, r]));
    const added = [...after.keys()].filter((id) => !before.has(id));
    const removed = [...before.keys()].filter((id) => !after.has(id));
    const changed = [];
    for (const [id, cur] of after) {
      const prev = before.get(id);
      if (!prev) continue;
      const fields = ['task_type', 'confidence', 'fallback', 'deliverable_format', 'language', 'assumptions', 'promptHash']
        .filter((f) => prev[f] !== cur[f]);
      if (fields.length) changed.push({ id, fields, prev, cur });
    }
    console.log(`\n=== 与快照 ${diffArg} 比对（tier ${base.tier ?? '?'} → ${tier}） ===`);
    console.log(`新增样本 ${added.length}｜删除样本 ${removed.length}｜字段变化 ${changed.length}`);
    if (added.length) console.log(` 新增：${added.join(', ')}`);
    if (removed.length) console.log(` 删除：${removed.join(', ')}`);
    for (const c of changed.slice(0, 20)) {
      console.log(` - ${c.id}：${c.fields.map((f) => `${f} ${c.prev[f]} → ${c.cur[f]}`).join('；')}`);
    }
    const promptDrift = changed.filter((c) => c.fields.includes('promptHash')).length;
    console.log(`渲染输出变化（promptHash）: ${promptDrift}  ← 规则/模板改动的影响面`);
  }

  if (taskBad.length || delBad.length || rows.some((r) => r.violations > 0) || degradedRows.length > 0) {
    process.exitCode = 1;
  }
}

function printCompare(pathA, pathB) {
  for (const p of [pathA, pathB]) {
    if (!existsSync(p)) {
      console.error(`✗ 找不到快照：${p}`);
      console.error('  → 先记录一份：npm run eval:local（fast，用你的真实输入）'
        + ' / npm run eval:standard（standard，需要 API key）');
      console.error('  → 离线演示（现在就能跑）：npm run eval:compare:mock');
      process.exit(2);
    }
  }
  const a = JSON.parse(readFileSync(pathA, 'utf8'));
  const b = JSON.parse(readFileSync(pathB, 'utf8'));
  const fp = (v, digits = 1) => (v === null || v === undefined ? 'n/a' : v.toFixed(digits));
  const rows = [
    ['意图准确率', a.summary.taskAccuracy, b.summary.taskAccuracy, 'pct'],
    ['  含可接受替代', a.summary.taskAccuracyAny ?? null, b.summary.taskAccuracyAny ?? null, 'pct'],
    ['交付物形态准确率', a.summary.deliverableAccuracy, b.summary.deliverableAccuracy, 'pct'],
    ['可直接采用率', a.summary.adoptable, b.summary.adoptable, 'pct'],
    ['错且自信', a.summary.wrongConfident, b.summary.wrongConfident, 'int'],
    ['低置信/无信号', a.summary.lowish, b.summary.lowish, 'int'],
    ['  └ 无信号回退', a.summary.fallback, b.summary.fallback, 'int'],
    ['降级（模型失败）', a.summary.degraded, b.summary.degraded, 'int'],
    ['平均耗时（ms）', a.summary.avgTotalMs, b.summary.avgTotalMs, 'ms'],
    ['模型花费（元）', a.summary.costYuan, b.summary.costYuan, 'yuan'],
  ];
  const fmt = (v, kind) => {
    if (v === null || v === undefined) return 'n/a';
    if (kind === 'pct') return `${(v * 100).toFixed(1)}%`;
    if (kind === 'yuan') return `¥${v.toFixed(4)}`;
    if (kind === 'ms') return fp(v);
    return String(v);
  };
  const delta = (x, y, kind) => {
    if (x === null || y === null || x === undefined || y === undefined) return '';
    if (kind === 'pct') return `${y - x >= 0 ? '+' : ''}${((y - x) * 100).toFixed(1)}pp`;
    if (kind === 'int') return `${y - x >= 0 ? '+' : ''}${y - x}`;
    if (kind === 'ms') return `${y - x >= 0 ? '+' : ''}${(y - x).toFixed(1)}`;
    return `${y - x >= 0 ? '+' : ''}${(y - x).toFixed(4)}`;
  };
  console.log(`\n=== 快照对照：${a.tier}(${a.file}) → ${b.tier}(${b.file}) ===`);
  console.log(`${'指标'.padEnd(18)}${'A'.padStart(12)}${'B'.padStart(12)}${'Δ(B−A)'.padStart(12)}`);
  for (const [label, x, y, kind] of rows) {
    console.log(`${label.padEnd(18)}${fmt(x, kind).padStart(12)}${fmt(y, kind).padStart(12)}${delta(x, y, kind).padStart(12)}`);
  }
  const ids = new Set([...a.samples.map((s) => s.id), ...b.samples.map((s) => s.id)]);
  const changes = [];
  for (const id of ids) {
    const x = a.samples.find((s) => s.id === id);
    const y = b.samples.find((s) => s.id === id);
    if (!x || !y) continue;
    if (x.task_type !== y.task_type || x.confidence !== y.confidence || x.deliverable_format !== y.deliverable_format) {
      changes.push(` - ${id}：${x.task_type}/${x.confidence}${x.deliverable_format ? `/${x.deliverable_format}` : ''} → ${y.task_type}/${y.confidence}${y.deliverable_format ? `/${y.deliverable_format}` : ''}`);
    }
  }
  console.log(`\n逐样本意图/形态变化：${changes.length}`);
  for (const c of changes) console.log(c);
  console.log('\n说明：A 通常是 fast 档，B 是 standard 档；成本差即为"把语义交给模型"的价钱。');
}

await main();
