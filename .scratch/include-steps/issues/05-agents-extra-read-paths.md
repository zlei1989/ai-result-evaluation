# 05 agents 扩展：AgentRunInput.extraReadPaths + claude additionalDirectories + codex 能力声明

Status: resolved
Blocked by: （无）

## 任务

1. `packages/server/agents/src/types.ts`：`AgentRunInput`（97-213 行）加可选字段 `extraReadPaths?: string[]`——语义：read-only 权限下额外放行的只读绝对路径（目录或文件）；同步更新 44-47 行权限表注释。纯可选字段，缺省不传时三家行为逐字不变。
2. `packages/server/agents/src/providers/claude-code/sdk.ts`：窄壳 `ClaudeQueryOptions`（25-156 行）加 `additionalDirectories?: readonly string[]`（SDK 官方字段，`@anthropic-ai/claude-agent-sdk@0.3.281` sdk.d.ts:1467，编译成 `--add-dir`，与 `dontAsk` 兼容——工作目录内读预授权、additionalDirectories 扩进权限范围）。
3. `packages/server/agents/src/providers/claude-code/index.ts`：options 构造处（405-478 行，约 428 行 disallowedTools 附近）加 `additionalDirectories: input.extraReadPaths ?? []`。
4. codex / dsh **不改映射**：两家 read-only 读已全盘放行（codex sandbox 官方语义全盘可读；dsh 读在所有模式直通）。在 `permission.ts` 三份 OPTIONS 附近注释写明「extraReadPaths 只被 claude 消费」的口径。
5. 能力声明：provider 注册表 metadata（`getProvider(kind).metadata`）加布尔能力（命名自定，建议 `needsMessagesForReasoningEvidence`）：codex 为 true（思考全文与工具结果正文结构性不进 events.jsonl，唯一落点是 messages.jsonl）、claude/dsh 为 false。放在 agents 包——厂商差异吸收在此，evaluator 不得硬编码厂商名。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；`packages/server/agents/src` 相关测试绿。
- `permission.test.ts` 加守卫：extraReadPaths 不进三份权限档表、不改变三档落点；claude `index.test.ts` 断言 additionalDirectories 转发且与 read-only 档共存；metadata 能力声明有用例钉住。
- 新守卫做变异验证（把转发条件改成只 read-only 才传/完全不传，看测试红，再还原）。

## Comments

先读 `docs/protocols/provider-run.md` 权限段与 `packages/server/agents/src/permission.ts`（唯一真源）。不改 contracts（AgentRunInput 不在 contracts 里）；registry 不需要动。docs/agents README 权限表回写留 08 票。
