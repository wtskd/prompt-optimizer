// 通用工具：确定性序列化与哈希。同一输入必须产生同一输出（INV-4）。
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const uniq = (arr) => [...new Set(arr)];

/**
 * 列表型槽位的取值归一：数组原样返回，标量包成单元素数组，空值 → []。
 * 存在理由（真实事故，2026-10-04）：Standard 档模型对 constraints_include 返回了字符串
 * "需要给出修改后的代码"，渲染/契约层对字符串调 .forEach 直接 TypeError，整个管线崩掉。
 * 模型输出不可信 → 边界校验（parseAnalysis）+ 消费侧防御（本函数）双层兜底。
 */
export const asList = (v) => {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  return [String(v)];
};

/** 返回第一个命中的模式及其捕获组 */
export function firstMatch(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return { match: m[0], group: m[1], index: m.index };
  }
  return null;
}

/** 收集全部命中（自动补 /g，避免共享 lastIndex 的坑） */
export function allMatches(text, patterns, limit = 20) {
  const out = [];
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');
    let m;
    while ((m = re.exec(text)) !== null && out.length < limit) {
      out.push({ match: m[0], group: m[1], index: m.index });
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return out;
}

export function truncate(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, n) + '…';
}

/** 键序稳定的 JSON 序列化，用于指纹与回放 */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') +
    '}'
  );
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const hashObject = (o) => fnv1a(typeof o === 'string' ? o : stableStringify(o));
