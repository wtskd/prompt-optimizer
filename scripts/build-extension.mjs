// 构建 MV3 插件：把浏览器兼容的核心模块从 src/ 同步到 extension/src/。
// 单一事实源是 src/——extension/src 是生成物（已提交，方便直接"加载已解压的扩展"），每次改核心后重跑本脚本。
// 跑法：npm run build:ext
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extSrc = join(root, 'extension', 'src');

// pipeline.js 的完整（且仅）导入闭包——全部是浏览器兼容的纯 ESM 模块
const CORE_FILES = [
  'src/pipeline.js',
  'src/schema.js',
  'src/ir.js',
  'src/intent.js',
  'src/slots.js',
  'src/clarify.js',
  'src/rules.js',
  'src/conflict.js',
  'src/contract.js',
  'src/templates.js',
  'src/render.js',
  'src/util.js',
  'src/lang.js',
  'src/goals.js',
  'src/diff.js',
  'src/llm/provider.js',
  'src/llm/analyze.js',
  'src/llm/deep.js',
];

rmSync(extSrc, { recursive: true, force: true });
for (const rel of CORE_FILES) {
  const dest = join(extSrc, rel.slice('src/'.length));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(root, rel), dest);
}
console.log(`✓ 已同步 ${CORE_FILES.length} 个核心模块 → extension/src/`);
