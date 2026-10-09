# DeepSeek Harness 适配 FAQ

DeepSeek Harness（`@deepseek-ai/dsh-sdk-client`）在**真实运行环境**里踩过的坑。每条四格：现象做小标题、日期、根因、解决方案；有外部资料就补第五格。

规矩：现象用**日志/界面里的原文**做标题（改写过的描述搜不到）；只写已证实的根因；同一现象只留一条最新的，与事实冲突时改旧条目不新开。

---

## `dsh：声明 streamingDelta=yes，但 plain-reply 场景里没有任何 delta 消息`

**日期**：2026-10-07

**现象**：新增智能体 SDK 一致性套件的「能力声明与产物互钉」组报出上面这句（红在 `providers/dsh/conformance.test.ts`）。同一条判据在 codex 与 claude 上都过。

**根因**：**这条通路上，厂商不把增量投送到我们能订阅的通道**。厂商侧确实有这个数据——LLM 层的流式协议里有 `text-delta`（`StreamChunk` 的一支），会话日志默认还会把连续同块增量压成 `text-chunks` 行——但**我们订阅到的通知流里没有它**：2026-10-07 真机探针（`probe/v2/dsh-chunk-shape.mjs` → 转储 `probe/dumps/v2/dsh-chunk-shape.jsonl`）跑完一次完整往返，共 **20 条通知**，正文只有**一条整块的 `assistant/message`**、增量类事件 **0 条**（事件类型全集：`permission/preset`、`sandbox/mode`、`approval/policy`、`agent/inbox/spliced`、`session.status`、`turn/start`、`step/start`、`system/message`、`user/message`、`request/header`、`request/context`、`session/title`、`session-log-deepseek/delivery-accepted`、`assistant/message`、`step/end`、`turn/end`）。适配器只认整块 `assistant/message`（`message.ts` 全文件 `delta` 零命中）本身没错；错的是**声明写着 `streamingDelta: 'yes'` + `source: 'wire'`**，即「说这条通道拿得到」。

**⚠️ 这条最值钱的教训：文档说的层 ≠ 我们能拿到的层**。我们最初照文档把它判成 `off-by-adapter`（厂商有、我们没接），实跑把它推翻了——文档描述的是 **LLM 层**与**会话日志层**，我们消费的是 **SDK 订阅到的通知层**，两者不是同一个通道。**凡「厂商有没有」的判定，落到「我们能不能拿到」上才算数**；只查文档最多得出「某层有」。

**解决方案**：`providers/dsh/index.ts` 的 `messageCapability` 改为 `streamingDelta: 'not-projected-by-vendor'`、`streamingDeltaSource: null`、`streamingDeltaReason: 'not-exposed'`——五态里这一格的语义正是「厂商侧有数据，但不投送到我们拿得到的通道」；并在 `notes` 第一条写上探针证据与「界面不得按有增量渲染」。
判据：套件第 7 组「能力声明与产物互钉（§2.7）」+ `providers/dsh/conformance.test.ts` **11/11** 全过；codex 侧的能力对齐守卫同步钉住这处差异（`codex/index.test.ts`，commit `2f3dd50`）。若换路由或 SDK 选项后能拿到增量，把这一格改回 `'yes'` 并补一个含 delta 的场景。

**相关资料**：
- [dsh 官方 `llm-streaming.md`：`StreamChunk` 的完整定义（含 `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end`）](https://github.com/deepseek-ai/deepseek-harness/blob/25d959aa085865f9d889e3a663ce018669258207/docs/core-data-structures/llm-streaming.md)
- [会话日志存储格式（中文手册）：`text-chunks` 等 packed row 展开成 `assistant/chunk` 的 `text-delta`](https://github.com/sandbaseai/deepseek-harness-handbook/blob/main/docs/zh-CN/reference/session-log-storage-format.md)
