# AI 产物评测

同一道题、同一个起点，让每个候选（**模型 × 智能体**）在各自隔离的工作区里独立完成一遍，
再用同一把尺子打分，最后横向对比。

解决的问题：评估不同模型与智能体的编码能力时，目前只能依赖零散的对话记录与主观印象，
缺少可复现、可横向对比的依据。

## 评测方式

- **用例**定义一道题：一个 git 仓库 + 一个 commit 作为起点，加一段考题提示词，以及一张评分表（组 → 评分项：ID / 目标 / 权重）。
- **候选行**是一个「智能体 + 模型」组合。一轮评测可包含多行，串行或并行执行；每行都从同一个 commit 独立克隆、
  切自己的 `test/{rowId}` 分支，在各自的工作目录里完成考题，行与行互不干扰。
- **打分**按评分表逐项判定「达成 / 未达成」，每项附一句理由。总分 = 达成项权重之和，
  满分 = 全部项权重之和（不固定为 100 分）。
- **比较**：出分后按总分降序排列，同分依次比较耗时与 token 用量，前三名带排名徽标。

评分有两条通路，一轮只用一条：

- **纯文本 API**：评分表与代码改动一次性提交给评分模型，不访问仓库、不运行智能体——成本低、速度快、结果可复现；
  代价是看不到测试执行结果，只能依据代码本身判断。
- **智能体评分**：由 Claude Code / Codex / DeepSeek Harness 之一在该行工作区内
  自行查阅文件，适合大到一次请求容纳不下的改动。

模型协议适配：**Claude Code** 只兼容 Anthropic 协议，**Codex** 只兼容 OpenAI 协议，**DeepSeek Harness** 两者皆可。

## 快速开始

前置：Node.js ≥ 20.9、[pnpm](https://pnpm.io)（corepack）、系统 git CLI。

```bash
pnpm install      # 仅允许用 pnpm 安装依赖（preinstall 拦截）
pnpm dev          # 开发服务器 http://localhost:3083
pnpm test         # vitest 全量测试
pnpm typecheck    # 全链类型检查
pnpm lint         # ESLint 全量检查
pnpm build        # 生产构建
```

单包开发：`pnpm --filter @aieval/<包名> <脚本>`。

上手三步：在 `/settings` 配置模型供应商（名称 / 协议类型 / API 地址 / API 密钥）与默认评分模型
→ 在 `/cases` 建用例 → 在 `/runs` 建评测。**创建后不会自动开跑，需另点「开始」**。

配置存放于 `~/.aieval/config.json`（可用 `AIEVAL_CONFIG_DIR` 更改位置）；
评测产物位于工作区根目录（默认 `~/.aieval-runs`，可在 `/settings` 修改）的 `{runId}/` 下。

## 代码结构

```text
ai-result-evaluation/
├── apps/web-next/     # 唯一应用：Next.js（页面壳 + 路由转调服务层）
├── packages/server/   # core（工作区引擎，零外部依赖）/ agents（智能体适配）
│                      # / evaluator（编排评分）/ api（一个功能一个文件）/ contracts（zod 契约）
├── packages/client/   # ui（纯展示组件）/ client（SWR hooks + HTTP 原语）
└── docs/ 知识库  # 五域知识文章 + 厂商 FAQ 活文档（历史 spec/plans/notes 已按 ADR 0001 熔炼）
```

服务端各包不依赖框架，厂商 SDK 只在 `agents` 包内引用；依赖方向单向，由 ESLint 规则强制约束，而非口头约定。
存储使用磁盘文件（JSON + JSONL 事件日志），不引入数据库。

