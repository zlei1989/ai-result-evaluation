# Claude Code 适配 FAQ

Claude Code（`@anthropic-ai/claude-agent-sdk`）在**真实运行环境**里踩过的坑。每条四格：现象做小标题、日期、根因、解决方案；有外部资料就补第五格。

规矩：现象用**日志/界面里的原文**做标题（改写过的描述搜不到）；只写已证实的根因；同一现象只留一条最新的，与事实冲突时改旧条目不新开。

---

## `AGENT_FAILED：Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`

**日期**：2026-10-08

**根因**：SDK 0.3.281 在未提供 `pathToClaudeCodeExecutable` 时，从 `sdk.mjs` 自身位置 `createRequire` → `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude')` + 存在性检查（内部函数 BK）；解析落空即抛该错。本机落空的原因不是文案暗示的 `--omit=optional`：`node_modules/.modules.yaml` 里 `included.optionalDependencies: true`，且 `skipped` 名单记录了 7 个跨平台变体（darwin-x64 / linux×4 / win32×2）、**恰好不含 darwin-arm64**——pnpm 认为它该装且已装。真实事实是 `.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.281` 只剩空目录骨架（install 中断留下的残缺 slot），与 lockfile 的完整记录错位。**为什么重装修不好**：pnpm 11.18 headless 的 up-to-date 判定只信 `node_modules/.package-map.json` 与 lockfile 的记录、不探测 `.pnpm` 磁盘实况，实测 `pnpm install` / `pnpm install --force` / 移走 `.pnpm/lock.yaml` / 移走 `.modules.yaml` / 移走 SDK symlink 全部照样 "Already up to date"，只有移走 `.package-map.json` 才放弃快路径走完整重装。**测试环境 ≠ 运行环境**：全套 vitest 把 SDK mock 成假 fixture（`testing/agent-fixtures.ts`），二进制解析链根本不跑，`pnpm test` 全绿、真机 `provider.run` 才炸——缺陷因此静默存活到评测现场。

**解决方案**：修环境——移走 `node_modules/.package-map.json` 触发完整重装（实测半成品 node_modules 下会撞 `ERR_PNPM_ENOTEMPTY` 的 rename 竞态，故最省事的可靠解是全删 `node_modules` 再 `pnpm install`，warm store 下 4 分 18 秒完成；验证：`claude --version` → `2.1.281 (Claude Code)`）。守卫——新增 `packages/server/agents/src/providers/claude-code/native-cli.test.ts`：复刻 SDK BK 的解析链，断言本机平台二进制可解析且存在，把缺陷从真机运行期提前到 `pnpm test`。**变异验证**：把平台包内容挪空（还原空壳形态）→ 守卫红（1 failed）→ 还原并核对目录哈希与基线逐字一致（`c40269011cec3188e402d9179cd22028`）→ 复绿；另用 freebsd（SDK 根本不发布的平台）做跨平台稳定的负例，钉住判据「能红」。守卫覆盖边界如实登记：只拦「resolve 不到 / 文件不存在」，「文件在但损坏」与 SDK 自身的 exists 检查同边界，拦不住。

**相关资料**：

- [pnpm/pnpm#16642 — Global virtual store: an interrupted install leaves a slot without dependency links, and later installs trust it](https://github.com/pnpm/pnpm/issues/16642)（机制同源的上游 issue：安装分两半并发执行、中断留下部分 slot，而「current-lockfile 记录只由完成的安装写入」这一信任假设被打破，后续 install 不探测磁盘直接放行）
- [Claude Code 官方 troubleshooting：native binary 以 per-platform optional dependency 分发](https://code.claude.com/docs/en/troubleshoot-install.md)

---

## `[22:21:22] stdout {"type":"system","subtype":"thinking_tokens","estimated_tokens":1,"estimated_tokens_delta":1,"session_id":"8a23d018-0dec-4c5c-b67f-8d98ac31d970","uuid":"b51b18af-2b8c-4af6-a4d8-abbc51c011ac"}`（「原始输出」抽屉被思考进度帧刷满、页面卡死）

**日期**：2026-10-09

**根因**：机制层——claude 适配器的 `system` 分支只认子任务生命周期与 `init`，**其余 subtype 落到文件末尾那条「未识别厂商负载保留原始负载」的兜底** ⇒ 每个思考 token 一条的 `system/thinking_tokens` 被逐条写成 `log` 事件。它不是 `stream_event`，所以 2026-10-09 第一版只挡 `stream_event` 的修复**盖不到真机上真正刷屏的那一种帧**。

两层证据：

- **实测量级**（run `7f05c765-9c7b-48aa-ad2f-212787d52475` 的 claude 行 `057d00fb`）：该行 **12,509 条 `log`** 里 **11,629 条**是这一种帧（93%），评分智能体那条路（走同一个适配器、编排层给 `text` 加 `[评分智能体] ` 前缀）再叠 **670 条**；单行 `events.jsonl` 因此涨到 MB 级——「页面卡死」与「日志文件过大」是同一个成因的两面。
- **协议语义**（SDK 0.3.281 `sdk.d.ts` 的 `SDKThinkingTokensMessage` 注释原文）：*Live thinking-token estimate, digested from `thinking_delta.estimated_tokens` during the redacted-thinking phase … **Approximate progress for spinners/pills, not the authoritative billed `output_tokens`*** ⇒ 它是**进度帧**，权威值在收尾的 `result.usage.output_tokens_details.thinking_tokens`，丢它不损失任何事实。

**解决方案**：`packages/server/agents/src/providers/claude-code/events.ts` 新增常量 `THINKING_TOKENS_SUBTYPE = 'thinking_tokens'` 与一支 `emptyProjection()`（与 `stream_event` 并列），并在文件头「规则 2」写明这是**唯一一类例外**（其余未识别消息照旧保留原文）；同步登记进《消息规范》的「非渲染增量」表（四类→五类）。守卫三处：① `events.test.ts` 新增零事件产出用例，**带反向判据**——`system/status` 必须仍保留原始负载（防「凡 `system` 一律丢」的过度修复）；② 一致性套件 §2.12——claude 的 `plain-reply` 场景里真喂一条这种帧，事件条数仍声明 `2`；③ 跨家条数声明表。**变异验证**：删掉该排除分支 ⇒ 两处同时红（单元用例 + `claude-code/plain-reply：事件条数 3 ≠ 声明的 2`），还原后哈希 `6c7bec82cc08cfb492b27e53308af4cc3365762b941640fb77e6b4e6c4819950` 逐字一致、66 条用例复绿。

**已知残留**：已经写进 `events.jsonl` 的那 12,509 条**不会自动消失**（历史产物不回收、读侧不做过滤），要清掉只能重跑该行（`resetEvents` 清空当次产物）；另外运行中的评测进程持有模块，**重启 dev server 后**新帧才不再写入。

**相关资料**：

- SDK 类型注释（本地安装态）：`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.281_*/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 `SDKThinkingTokensMessage`（该 subtype 无公开文档页，故留本地路径）
- [《消息规范》](/protocols/message-spec) —— 「非渲染增量」五类处置表（登记点）
- [《Claude Code 接入》](/protocols/claude-code) —— 已知边界与取舍里同一条
