// prompt-optimizer MV3 弹窗：直接复用 src/ 的确定性管线（构建脚本同步进 extension/src/）。
// fast 档纯本地零成本；standard/deep 档从浏览器直连 DeepSeek（host_permissions 已豁免 CORS）。
// key 存 chrome.storage.local，只留本机；历史存 chrome.storage.local（最近 50 条）。
import { optimize, optimizeAsync } from './src/pipeline.js';
import { diffLines } from './src/diff.js';

const $ = (id) => document.getElementById(id);
let lastPayload = null;
let lastDiffOn = true;
let history = []; // [{at, input, prompt, tier, taskType, costYuan, totalMs, degraded}]

const show = (el, on) => { el.style.display = on ? 'block' : 'none'; };
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const banner = (el, msg) => { el.textContent = msg || ''; show(el, Boolean(msg)); };

function totalCost(meta) {
  let c = meta.llm?.costYuan ?? 0;
  if (meta.llm?.deep) {
    c += meta.llm.deep.enrich?.costYuan ?? 0;
    c += meta.llm.deep.verify?.costYuan ?? 0;
  }
  return c;
}

function renderBadges(meta) {
  const parts = [`<span class="badge">${meta.tier}</span>`, `<span class="badge">${meta.totalMs ?? meta.ms}ms</span>`];
  const cost = totalCost(meta);
  if (cost > 0) parts.push(`<span class="badge ${meta.llm?.cached ? 'ok' : ''}">¥${cost.toFixed(4)}</span>`);
  if (meta.degraded) parts.push('<span class="badge err">降级</span>');
  if (meta.violations?.length) parts.push(`<span class="badge err">违规${meta.violations.length}</span>`);
  if (meta.llm?.deep?.verify?.revisionApplied) parts.push('<span class="badge ok">自检修订</span>');
  $('badges').innerHTML = parts.join('');
}

function renderResult() {
  if (!lastPayload) return;
  const el = $('result');
  if (lastDiffOn && lastPayload.diff?.length) {
    el.innerHTML = lastPayload.diff
      .map((c) => c.t === '+' ? `<span class="diff-add">+ ${escapeHtml(c.line)}</span>`
        : c.t === '-' ? `<span class="diff-del">- ${escapeHtml(c.line)}</span>`
        : escapeHtml(c.line))
      .join('');
  } else {
    el.textContent = lastPayload.prompt;
  }
}

function renderQuestions(questions) {
  const panel = $('qPanel');
  if (!questions?.length) { show(panel, false); return; }
  $('qList').innerHTML = questions.map((q) => `
    <div class="q-item" data-qid="${escapeHtml(q.id)}">
      <div>${q.blocking ? '【必答】' : '【可选】'}${escapeHtml(q.question)}</div>
      <input type="text" placeholder="留空 = 跳过该条">
    </div>`).join('');
  show(panel, true);
}

function handleDone(payload) {
  lastPayload = payload;
  lastDiffOn = $('wantDiff').checked;
  banner($('errBox'), '');
  banner($('warnBox'), payload.meta.degraded ? `⚠ 模型分析失败，输出来自规则层（${payload.meta.llm?.code ?? ''}）` : '');
  renderBadges(payload.meta);
  renderResult();
  renderQuestions(payload.questions);
  show($('resultPanel'), true);
  saveHistory(payload);
}

async function run(answers) {
  const text = $('input').value.trim();
  if (!text) { banner($('errBox'), '请先输入要优化的内容。'); return; }
  const tier = $('tier').value;
  const { po_api_key: key } = await chrome.storage.local.get(['po_api_key']);
  if (tier !== 'fast' && !key) { banner($('errBox'), 'standard/deep 档需要 API key：点右上角「设置」填入。'); return; }
  $('run').disabled = true;
  $('run').textContent = '…';
  banner($('errBox'), '');
  const progress = $('progress');
  progress.textContent = '';
  show(progress, tier !== 'fast');
  const goal = [...document.querySelectorAll('label.opt input:checked')].map((c) => c.value);
  const env = tier !== 'fast' ? { DEEPSEEK_API_KEY: key } : undefined;
  try {
    let payload;
    if (tier === 'fast') {
      const r = optimize(text, { goal, ask: true, ...(answers ? { answers } : {}) });
      payload = {
        prompt: r.prompt, questions: r.questions, meta: r.meta,
        diff: $('wantDiff').checked ? diffLines(text, r.prompt) : null,
      };
    } else {
      const r = await optimizeAsync(text, {
        tier, goal, ask: true, env,
        stream: true,
        onDelta: (d) => { progress.textContent += d; progress.scrollTop = progress.scrollHeight; },
        ...(answers ? { answers } : {}),
      });
      payload = {
        prompt: r.prompt, questions: r.questions, meta: r.meta,
        diff: $('wantDiff').checked ? diffLines(text, r.prompt) : null,
      };
    }
    show(progress, false);
    handleDone(payload);
  } catch (e) {
    show(progress, false);
    banner($('errBox'), `错误${e?.code ? `（${e.code}）` : ''}：${e?.message ?? e}`);
  } finally {
    $('run').disabled = false;
    $('run').textContent = '优化';
  }
}

async function loadHistory() {
  ({ po_history: history } = await chrome.storage.local.get(['po_history']));
  history = history ?? [];
  const el = $('hist');
  if (!history.length) { el.textContent = '暂无记录'; return; }
  el.innerHTML = history.map((h, i) => `
    <div class="hist-item" data-i="${i}">
      <div class="t">${escapeHtml(h.at.slice(5, 16).replace('T', ' '))} ${escapeHtml(h.tier)}${h.degraded ? ' [降级]' : ''} ¥${Number(h.costYuan ?? 0).toFixed(4)}</div>
      <div class="x">${escapeHtml(h.input)}</div>
    </div>`).join('');
  el.querySelectorAll('.hist-item').forEach((item) => {
    item.addEventListener('click', () => {
      const h = history[Number(item.dataset.i)];
      $('input').value = h.input;
      lastPayload = { prompt: h.prompt, meta: { tier: h.tier, ms: h.totalMs, llm: { costYuan: h.costYuan, cached: false }, degraded: h.degraded, questions: [], violations: [] }, diff: null, questions: [] };
      lastDiffOn = false;
      renderBadges(lastPayload.meta);
      renderResult();
      renderQuestions([]);
      show($('resultPanel'), true);
    });
  });
}

async function saveHistory(payload) {
  const meta = payload.meta;
  history.unshift({
    at: new Date().toISOString(),
    input: $('input').value.trim(),
    prompt: payload.prompt,
    tier: meta.tier,
    taskType: meta.llm?.merged ? undefined : undefined,
    costYuan: totalCost(meta),
    totalMs: meta.totalMs ?? meta.ms,
    degraded: meta.degraded === true,
  });
  history = history.slice(0, 50);
  await chrome.storage.local.set({ po_history: history });
  loadHistory();
}

document.addEventListener('DOMContentLoaded', () => {
  $('run').addEventListener('click', () => run(null));
  $('answerBtn').addEventListener('click', () => {
    const answers = {};
    $('qList').querySelectorAll('.q-item').forEach((item) => {
      const v = item.querySelector('input').value.trim();
      if (v) answers[item.dataset.qid] = v;
    });
    run(Object.keys(answers).length ? answers : null);
  });
  $('skipBtn').addEventListener('click', () => run(null));
  $('copyBtn').addEventListener('click', async () => {
    if (!lastPayload) return;
    try { await navigator.clipboard.writeText(lastPayload.prompt); $('copyBtn').textContent = '已复制 ✓'; }
    catch { $('copyBtn').textContent = '失败'; }
    setTimeout(() => { $('copyBtn').textContent = '复制'; }, 1500);
  });
  $('diffToggle').addEventListener('click', () => { lastDiffOn = !lastDiffOn; renderResult(); });
  $('histClear').addEventListener('click', async () => {
    history = [];
    await chrome.storage.local.set({ po_history: [] });
    loadHistory();
  });
  loadHistory();
});
