// 输入语言检测：只做可验证的字面统计（CJK 字符 vs 拉丁字母），不做语义猜测。
// 用途：语言一致性——让"输出语言"槽位的默认值跟随输入语言，而不是永远默认中文。
// 显式指令（"翻译成英文"）仍由 slots.js 的规则优先，本检测只兜"没说"的情形。

export function detectLanguage(text) {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
  const latin = (s.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0 && latin === 0) return null;
  return cjk >= latin ? 'zh-CN' : 'en';
}
