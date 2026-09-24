# ai-result-evaluation —— AI 生成代码评测工具

固定「同一道题 + 同一起点」，让每个候选（`模型 × 智能体`）在**隔离的工作区**里各自独立完成一遍，
再用**同一把尺子**打分，最后并排比较。

解决的问题：比较不同模型与智能体写代码的能力，目前只能靠零散的对话记录和主观印象，
缺少可复现、可横向对比的依据。

## 评测口径

| 项 | 值 |
|----|----|
| 起点 | 用例固定「本地仓库 + commit」；每个候选行独立克隆该 commit 并建自己的 `test/{rowId}` 分支 |
| 考题 | 用例里的考题提示词，交给智能体在工作目录里自行完成 |
| 评分 | **纯文本 API**：评分提示词 + 代码改动 + 维度定义交给评分模型，不入仓库、不跑 agent |
| 得分 | 固定 5 维度各 1–5 分（等权）+ 总分（0–100）+ 每维理由 + 一句话总评 |
| 可比性 | 候选行的工作区、分支全部隔离；评分的输入（diff 上限）与尺子（评分模型）可追溯到每一行 |

评分维度（本期固定，不可自定义）：功能正确性 / 需求完成度 / 代码质量 / 健壮性与边界 / 可维护性。
评分走纯文本 API 而非 agent 会话：成本低、快、完全可复现；代价是看不到测试运行结果，只能凭代码本身判断。

## 快速开始

前置：Node.js ≥ 20、[pnpm](https://pnpm.io)（corepack）、系统 git CLI。

```bash
pnpm install      # 仅允许 pnpm（preinstall 强制）
pnpm dev          # 开发服务器 http://localhost:3083
pnpm test         # vitest 全量测试
pnpm typecheck    # 全链类型检查
pnpm lint         # ESLint 全量检查
pnpm build        # 生产构建
```

单包开发：`pnpm --filter @aieval/<包名> <脚本>`。
起服务后到 `/settings` 配一个模型供应商（名称 / 协议类型 / API 地址 / API 密钥）与默认评分模型；
配置落在 `~/.aieval/config.json`（可用 `AIEVAL_CONFIG_DIR` 覆盖）。

## 代码在哪

```text
ai-result-evaluation/
├── apps/web-next/     # 唯一应用：Next.js（页面壳 + 路由转调服务层）
├── packages/server/   # core（工作区引擎，零外部依赖）/ agents（智能体适配）
│                      # / evaluator（编排评分）/ api（一个功能一个文件）/ contracts（zod 契约）
├── packages/client/   # ui（纯展示组件）/ client（SWR hooks + HTTP 原语）
└── docs/superpowers/  # specs（设计）+ plans（实施计划）+ notes
```

服务端各包**零框架依赖**：厂商 SDK 只允许出现在 `agents`。依赖方向单向，
由 `withBoundary()` 的 eslint 规则硬约束而非口头约定，边界含动态 `import()`、`require()`
与跨包相对引用。持久化走磁盘文件（JSON + JSONL 事件日志），不引入数据库。

## 当前状态

脚手架已落地：8 包分层 + 边界约束 + Next.js 应用壳 + 设置接口 + 界面原语
（`PageShell`、`ListDetailLayout`、`SplitPane`、`ResizableColumns`、双主题与紧凑密度、顶栏）。
`agents` 与 `evaluator` 仍是空壳。

测试：**181 个用例**，`pnpm test` / `pnpm typecheck` / `pnpm lint` 全绿。
下一步见 [`docs/superpowers/specs/2026-09-22-features-design.md`](docs/superpowers/specs/2026-09-22-features-design.md)
（三个功能域：用例 / 评测 / 设置）。

## 更多

- 改代码前先读 [`AGENT.md`](AGENT.md)：分层边界、主题与紧凑密度的硬口径，以及一批工具链坑。
- 设计与取舍（含被否决的替代及理由）：[`docs/superpowers/`](docs/superpowers/)。
- 本仓库为个人项目，尚未选定许可。
