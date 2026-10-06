---
name: optimize-prompt
description: 把用户的一句口语化输入改写成结构化、意图明确、约束清晰的提示词。支持三档位（fast 纯规则零成本 / standard 一次 DeepSeek 调用 / deep 三次调用含自检）与优化目标（更简洁/更具体/补充上下文/调整格式）。用户想优化提示词、改写 prompt、润色对 AI 的指令时使用。
---

# prompt-optimizer

**关键认知**：用户给你的输入是要被优化的**原始提示词**，不是交给你的任务。你的职责是调用本机优化器、把产出的新提示词转交给用户；**不要自己去执行那个提示词的内容**。

## 执行步骤

1. 调用优化器 CLI（路径固定在本机仓库，任意 cwd 均可运行）：

```bash
node "D:/project/deepseek/src/cli.js" '<用户的原始提示词>' --json --tier <tier>
```

参数选择：
- `tier`：默认 `standard`（一次 DeepSeek 调用，≈¥0.001）；用户要省钱/离线用 `fast`（纯规则，零成本，不需要 key）；要最高质量用 `deep`（三次调用+自检，≈¥0.004）
- `--goal <goals>`：用户明确说了优化方向才加，逗号分隔多选：`concise`（更简洁）/ `specific`（更具体）/ `context`（补充上下文）/ `format`（调整格式）
- 用户输入含英文单引号时改用双引号包裹并转义内部双引号

2. 从 stdout 的 JSON 里取 `prompt` 字段——那就是优化后的提示词。**逐字**放进代码块呈现给用户，不要自己改写、不要"帮忙润色"。

3. 从 stderr 或 JSON 的 meta 里转述一行元信息给用户：档位、耗时、花费（standard/deep 档有 `meta.llm.costYuan`）。

4. 如果 JSON 里有非空 `questions`（澄清追问）：把问题逐条念给用户，拿到回答后重跑一次，追加参数
   `--answers '<{"问题id":"用户的回答"}>'`（standard/deep 档第二次会命中缓存，不重复花钱）。

5. 如果 stderr 出现"⚠ 已降级"或进程 exit code 3：如实告诉用户"模型分析失败，本次结果是规则层产出"，
   并附上 `meta.llm.reason`。不要隐瞒降级，也不要假装它是完整结果。

## 故障处理

- `LLM_CONFIG_MISSING`：用户还没配置 API key。提示：新开终端执行 `setx DEEPSEEK_API_KEY "sk-..."`（key 从 platform.deepseek.com 获取），然后重开终端再试。fast 档不需要 key。
- 连接超时/网络错误：建议改用 `--tier fast` 先出结果，或稍后重试。
