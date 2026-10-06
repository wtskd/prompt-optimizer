// 行级 LCS 对比（结果展示用）：输入都是短文本（一条原文 + 一条渲染结果），
// O(n*m) 的朴素 DP 足够，不值得为此引依赖。输出确定性，同输入同 diff。

/** @returns {[{t:'='|'-'|'+', line:string}]} */
export function diffLines(aText, bText) {
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: '=', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: '-', line: a[i++] });
    } else {
      out.push({ t: '+', line: b[j++] });
    }
  }
  while (i < n) out.push({ t: '-', line: a[i++] });
  while (j < m) out.push({ t: '+', line: b[j++] });
  return out;
}

/** 渲染成统一 diff 风格的文本块（前缀 空格/-/+） */
export function formatDiff(changes) {
  return changes.map((c) => `${c.t === '=' ? ' ' : c.t} ${c.line}`).join('\n');
}

/** 简要统计：两份文本的行数与字符数变化 */
export function diffStats(aText, bText) {
  const stat = (s) => ({ lines: String(s ?? '').split('\n').length, chars: String(s ?? '').length });
  return { a: stat(aText), b: stat(bText) };
}
