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

---

## `AGENT_FAILED：Claude Code returned an error result: There's an issue with the selected model (test-model). It may not exist or you may not have access to it.`

**日期**：2026-10-10

**现象原文**（真机探针那一行的失败文案，行级归因码 `AGENT_FAILED`；模型名 `test-model` 是夹具默认值，见根因）：
```
AGENT_FAILED：Claude Code returned an error result: There's an issue with the selected model (test-model). It may not exist or you may not have access to it.
```

**根因**：机制层——行的模型名来自**行快照**（`EvalRow.modelId`，创建时写死的那一格），适配器把它原样交给 CLI（`modelForClaudeCode` 只可能在它后面追加 `[1m]`）。夹具工厂 `makeRowFixture` 的默认值是假适配器专用的 `test-model`，而真机路由里这个名字在网关的模型清单里**不存在** ⇒ CLI 自己的模型校验当场拒掉整轮，行落 `failed` / `AGENT_FAILED`。

**测试环境 ≠ 运行环境**：单测里适配器被整个换成 `fakeAgents`，模型名从不发出去，于是这个默认值一路绿；只有在「真适配器 + 真网关」的探针里才会暴露（本仓的 live 探针就是这条差异的靶子）。

**解决方案**：真机探针显式覆盖模型名——`packages/server/evaluator/src/live-row-mcp.test.ts` 用 `makeRowFixture({ modelId: live.modelId })`（`live` 从宿主 `~/.aieval/config.json` 的 anthropic 供应商里取第一条模型的 id）。**同一处另一条口径**：真机探针把 `ROW_RETRY.maxRetries` 临时置 0——瞬时失败自动重试在真机上是「再起一遍 CLI、再花一次配额」，而探针要的是「跑通一次」的证据，重试只把失败信息拉长。

---

## 技能面确证 `[{"name":"tang-poem-meal","source":"userSettings"},…]` 在，但 `工具调用名：[]`、哨兵 `AIEVAL-SKILL-OK-7f3a` 未命中

**日期**：2026-10-11

**根因**：缺口在**这条网关路由下的模型不发出 `Skill` 工具调用**这一层，不在装入链。判据链两半都对得上，唯独行为面是空的：

- **装入链没问题**（L1 + 厂商确证）：`<行配置目录>/skills/tang-poem-meal/SKILL.md` 与源目录逐字相同，`SKILL.md` 在 `query()` 之前落盘；厂商自己报的技能面里**有它**——`getContextUsage().skills.skillFrontmatter` = `[{"name":"tang-poem-meal","source":"userSettings"},…]`（同一条里另有 12 条 `built-in`；另造一条仓库自带 skill，来源原值 `projectSettings`，说明这条通道真的在按来源分档）。`source: userSettings` 就是「本机启用项那一份进了系统提示的技能面」的厂商原话。
- **行为面是空的**：该行 `工具调用名：[]`——一个工具都没调；答复是一首唐诗，**末行没有哨兵串**。`Skill` 是 CLI 侧的工具，模型要在 wire 上回一个 `tool_use(name='Skill', input.skill='…')` 才会触发；这条路由下的模型只回文本。**换 `GLM-5.3` 同样一次都不调** ⇒ 不是某一个模型的怪癖，是**这条网关路由下的模型行为**。

**测试环境 ≠ 运行环境**：单测里适配器整个换成 `fakeAgents`，模型答复是夹具造的，行为面在 `pnpm test` 里**永远是绿的**；这个缺口只有「真适配器 + 真 CLI + 真网关」的一行才看得见。另一半更隐蔽——**技能面那一格是厂商自己报的，与模型会不会照做是两层**，把「技能面里有它」当成「模型会用它」就是把 L1 的结论当 L3 用。

**解决方案**：判据改成**技能面确证**——`getContextUsage().skills.skillFrontmatter` 里出现该条且来源为 `userSettings`（行级观测格仍记 `installed · 判据 厂商清单`，但**不把「模型会用它」写成已兑现**；已经装上多少条 ≠ 模型用了哪条）。要复验行为面：换**真 Claude 模型**（`modelId` 匹配 `/claude/i`）或另一条网关重跑同一行，三条判据同时看——真发 `tool_use(name='Skill')`、答复**末行逐字**命中哨兵串（只出现唐诗不算，唐诗是模型本来就会的东西）、`SKILL.md` 在行配置目录里。守卫：`packages/server/agents/src/providers/claude-code/live-skills-context.test.ts`（`AIEVAL_LIVE_SKILL_CONTEXT=1`，真 CLI + 真网关）把这条判据链钉住；配置前提那一半由离线的 `packages/server/agents/src/skills-config-prereq.test.ts` 钉。

**相关资料**：

- [《技能配置》](/features/skills-config) —— 已知边界里同一条登记（「厂商确证技能面里有它」这一档的上限）
- [《Claude Code 接入》](/protocols/claude-code) —— skills 落地口径（落点、`options.skills` 的三档、判据通道）与已知边界表
- SDK 类型（本地安装态）：`getContextUsage()` 的 `skills.skillFrontmatter[].source` 取值域 `userSettings` / `projectSettings` / `built-in`（`sdk.d.ts`）

---

## Write 落点缺一级 workspace：`"file_path":"…/rows/54fbe2bf-…/poetry.md"` 应为 `…/workspace/poetry.md`（评分「工作区无任何改动、无未跟踪文件」→ 0 分）

**日期**：2026-10-11

**根因**：机制层三层，前两层是绿的事实、缺口在第三层：

- **平台三层全绿**：① `system/init` 帧 `cwd` = `…/rows/<rowId>/workspace`（给 CLI 的 cwd 正确）；② 厂商确证技能面里有该条——`getContextUsage().skills.skillFrontmatter` 含 `{"name":"tang-poem-meal","source":"userSettings"}`；③ **CC 2.1.281 在主请求的 `<system-reminder>` 里确实注入了技能清单**（原文 `The following skills are available for use with the Skill tool: - tang-poem-meal: …`）——本地假网关捕获真实请求体逐项对齐真机 options（模型名 `glm-5.3` / `GLM-5.3[1m]` / `claude-sonnet-4-5`、`CLAUDE_CODE_ENABLE_TODO_TOOLS`、禁用名单、`forwardSubagentText`、`includePartialMessages`、`settings.env`）全部带清单；第一轮请求构造先于任何网关响应，故「清单没注入」这一半被排除。
- **模型未利用清单，改翻文件系统**：该行模型（GLM-5.3 走 likecode anthropic 协议网关）的 thinking 自述 `I don't see a system-reminder listing skills in this conversation`，于是用 Bash `find $HOME/skills` 找技能——命中平台物化目录，**输出把 `<行目录>/.agenthome/skills/<名>/SKILL.md` 的绝对路径送进上下文**。
- **落点**：模型随后 Write 时复用该绝对路径前缀，`poetry.md` 落在 `.agenthome` 的**父目录**（行目录）——比正确工作区少一级 `workspace`。diff 采集只扫 `workspace/`（口径：工作区外的产物对评分不可见），于是 `diff = 0 改动` → 评分判「未达成」→ 0 分。

与同日「技能面确证在但 `工具调用名：[]`」条目同源（模型不调 `Skill` 工具），本条目是它的下游一环：**文件系统翻找把平台私有目录（`.agenthome`）的绝对路径送进模型上下文，模型复用它拼产物路径**。「经常」的机制：skills 冒烟场景每次重跑都可能触发同一条模型行为链。

**解决方案**：**未闭合**（用户裁定不动平台代码，接受为已知模型行为）。代价：第三方模型走 CC 时，技能可见性押在模型对 `<system-reminder>` 的服从上；模型翻文件系统并复用绝对路径时，产物落到 `workspace/` 之外，`diff=0`、评分失真。复验判据：真机重跑该行，看 `messages.jsonl` 里 `Write` 的 `file_path` 是否带 `.agenthome` 前缀（或缺一级 `workspace`）。可选兜底（未实施）：候选执行的任务提示里**显式注入技能清单**（名字 + description + 使用条件）与「所有产物写入当前工作目录」锚点，三家统一——不再依赖厂商 system-reminder。

**相关资料**：

- [Claude Code skills 官方文档](https://code.claude.com/docs/en/skills.md)：*"Every skill in the skill listing adds to your context on every turn"*（清单每轮进上下文）与 *"a skill's body loads only when it's used"*（正文只在被调用时注入）
