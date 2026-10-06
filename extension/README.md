# prompt-optimizer 浏览器插件（MV3）

复用与 CLI / Web 宿主**同一份确定性管线**（`extension/src/` 由 `npm run build:ext` 从 `src/` 同步生成）。

## 安装（加载已解压的扩展程序）

1. 打开 Chrome / Edge → `chrome://extensions`（Edge: `edge://extensions`）
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本仓库的 `extension/` 目录

## 使用

1. 点扩展栏图标 → 右上角「设置」→ 填入 DeepSeek API key（只存本机 `chrome.storage.local`，不经过任何第三方服务器）
2. 输入一句口语化的提示词，选档位与优化目标 → 「优化」
   - `fast`：纯规则层，零成本毫秒级，**不需要 key**
   - `standard`：1 次 DeepSeek 调用（≈¥0.001），流式显示分析过程
   - `deep`：3 次调用（分析 + 槽位补全 + 对抗性自检，≈¥0.004）
3. 结果可复制、可看原文对比；追问（澄清面板）回答后重新优化——standard/deep 第二次命中缓存，不重复花钱
4. 最近 50 条历史保存在本地，点击可回放

## 开发

改了 `src/` 下的核心代码后执行 `npm run build:ext` 同步进插件，再在扩展管理页点「重新加载」。
