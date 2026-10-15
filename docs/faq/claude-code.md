# Claude Code 适配 FAQ

Claude Code（`@anthropic-ai/claude-agent-sdk`）在**真实运行环境**里踩过的坑。每条四格：现象做小标题、日期、根因、解决方案；有外部资料就补第五格。

规矩：现象用**日志/界面里的原文**做标题（改写过的描述搜不到）；只写已证实的根因；同一现象只留一条最新的，与事实冲突时改旧条目不新开。

---

## `AGENT_FAILED：Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`

**日期**：2026-10-08

**根因**：SDK 0.3.281 在未提供 `pathToClaudeCodeExecutable` 时，从 `sdk.mjs` 自身位置 `createRequire` → `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude')` + 存在性检查（内部函数 BK）；解析落空即抛该错。本机落空的原因不是文案暗示的 `--omit=optional`：`node_modules/.modules.yaml` 里 `included.optionalDependencies: true`，且 `skipped` 名单记录了 7 个跨平台变体（darwin-x64 / linux×4 / win32×2）、**恰好不含 darwin-arm64**——pnpm 认为它该装且已装。真实事实是 `.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.281` 只剩空目录骨架（install 中断留下的残缺 slot），与 lockfile 的完整记录错位。**为什么重装修不好**：pnpm 11.18 headless 的 up-to-date 判定只信 `node_modules/.package-map.json` 与 lockfile 的记录、不探测 `.pnpm` 磁盘实况，实测 `pnpm install` / `pnpm install --force` / 移走 `.pnpm/lock.yaml` / 移走 `.modules.yaml` / 移走 SDK symlink 全部照样 "Already up to date"，只有移走 `.package-map.json` 才放弃快路径走完整重装。**测试环境 ≠ 运行环境**：全套 vitest 把 SDK mock 成假 fixture（`testing/agent-fixtures.ts`），二进制解析链根本不跑，`pnpm test` 全绿、真机 `provider.run` 才炸——缺陷因此静默存活到评测现场。

**解决方案**：修环境——移走 `node_modules/.package-map.json` 触发完整重装（实测半成品 node_modules 下会撞 `ERR_PNPM_ENOTEMPTY` 的 rename 竞态，故最省事的可靠解是全删 `node_modules` 再 `pnpm install`，warm store 下 4 分 18 秒完成；验证：`claude --version` → `2.1.281 (Claude Code)`）。守卫——新增 `packages/server/agents/src/providers/cc/native-cli.test.ts`：复刻 SDK BK 的解析链，断言本机平台二进制可解析且存在，把缺陷从真机运行期提前到 `pnpm test`。**变异验证**：把平台包内容挪空（还原空壳形态）→ 守卫红（1 failed）→ 还原并核对目录哈希与基线逐字一致（`c40269011cec3188e402d9179cd22028`）→ 复绿；另用 freebsd（SDK 根本不发布的平台）做跨平台稳定的负例，钉住判据「能红」。守卫覆盖边界如实登记：只拦「resolve 不到 / 文件不存在」，「文件在但损坏」与 SDK 自身的 exists 检查同边界，拦不住。

**相关资料**：

- [pnpm/pnpm#16642 — Global virtual store: an interrupted install leaves a slot without dependency links, and later installs trust it](https://github.com/pnpm/pnpm/issues/16642)（机制同源的上游 issue：安装分两半并发执行、中断留下部分 slot，而「current-lockfile 记录只由完成的安装写入」这一信任假设被打破，后续 install 不探测磁盘直接放行）
- [Claude Code 官方 troubleshooting：native binary 以 per-platform optional dependency 分发](https://code.claude.com/docs/en/troubleshoot-install.md)

---

## `[22:21:22] stdout {"type":"system","subtype":"thinking_tokens","estimated_tokens":1,"estimated_tokens_delta":1,"session_id":"8a23d018-0dec-4c5c-b67f-8d98ac31d970","uuid":"b51b18af-2b8c-4af6-a4d8-abbc51c011ac"}`（「原始输出」抽屉被思考进度帧刷满、页面卡死）

**日期**：2026-10-09

**根因**：机制层——claude 适配器的 `system` 分支只认子任务生命周期与 `init`，**其余 subtype 落到文件末尾那条「未识别厂商负载保留原始负载」的兜底** ⇒ 每个思考 token 一条的 `system/thinking_tokens` 被逐条写成 `log` 事件。它不是 `stream_event`，所以 2026-10-09 第一版只挡 `stream_event` 的修复**盖不到真机上真正刷屏的那一种帧**。

两层证据：

- **实测量级**（run `7f05c765-9c7b-48aa-ad2f-212787d52475` 的 claude 行 `057d00fb`）：该行 **12,509 条 `log`** 里 **11,629 条**是这一种帧（93%），评分智能体那条路（走同一个适配器）再叠 **670 条**；单行 `events.jsonl` 因此涨到 MB 级——「页面卡死」与「日志文件过大」是同一个成因的两面。
- **协议语义**（SDK 0.3.281 `sdk.d.ts` 的 `SDKThinkingTokensMessage` 注释原文）：*Live thinking-token estimate, digested from `thinking_delta.estimated_tokens` during the redacted-thinking phase … **Approximate progress for spinners/pills, not the authoritative billed `output_tokens`*** ⇒ 它是**进度帧**，权威值在收尾的 `result.usage.output_tokens_details.thinking_tokens`，丢它不损失任何事实。

**解决方案**：`packages/server/agents/src/providers/cc/events.ts` 新增常量 `THINKING_TOKENS_SUBTYPE = 'thinking_tokens'` 与一支 `emptyProjection()`（与 `stream_event` 并列），并在文件头「规则 2」写明这是**唯一一类例外**（其余未识别消息照旧保留原文）；同步登记进《消息规范》的「非渲染增量」表（四类→五类）。守卫三处：① `events.test.ts` 新增零事件产出用例，**带反向判据**——`system/status` 必须仍保留原始负载（防「凡 `system` 一律丢」的过度修复）；② 一致性套件 §2.12——claude 的 `plain-reply` 场景里真喂一条这种帧，事件条数仍声明 `2`；③ 跨家条数声明表。**变异验证**：删掉该排除分支 ⇒ 两处同时红（单元用例 + `cc/plain-reply：事件条数 3 ≠ 声明的 2`），还原后哈希 `6c7bec82cc08cfb492b27e53308af4cc3365762b941640fb77e6b4e6c4819950` 逐字一致、66 条用例复绿。

**已知残留**：已经写进 `events.jsonl` 的那 12,509 条**不会自动消失**（历史产物不回收、读侧不做过滤），要清掉只能重跑该行（`resetEvents` 清空当次产物）；另外运行中的评测进程持有模块，**重启 dev server 后**新帧才不再写入。

**相关资料**：

- SDK 类型注释（本地安装态）：`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.281_*/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 `SDKThinkingTokensMessage`（该 subtype 无公开文档页，故留本地路径）
- [《消息规范》](/protocols/message-spec) —— 「非渲染增量」五类处置表（登记点）
- [《Claude Code 接入》](/protocols/cc) —— 已知边界与取舍里同一条

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

**现象原文**（模型自己的话，两条指向同一件事）：

```
关于技能：本次会话里我**没有**收到任何可用技能（skill）的清单，因此没有可逐行列出的名字。
关于令牌：没看到。
```

**根因**：**技能清单压根没到模型** —— 不是模型不肯调 `Skill`，也不是装入链有缺陷。机制一层：

**丢弃点已定位（不再是「某处翻译层」）：`proxyGateway` 的 `lib/convert/anthropic.js` 的 `anthropicToOpenAI` 里那一行显式丢弃** —— `if (role === "system") continue;`。抓包原文：主请求体 `messages[0].role='user'` 是题面（587 字符）、`messages[1].role='system'` 是那坨 reminder（7694 字符，技能清单在里面），`tools[]` 里 `Skill` 在；Anthropic 的 Messages API 只定义 `user` / `assistant`，而这一行不认它，整条 `continue` 掉 ⇒ 模型上下文里从来没有这份清单。清单里没有名字、`Skill` 的入参无处可来，「不主动读 skill」是**信息缺失**的必然结果，不是模型偏好。

三个细节决定了它为什么能长期静默（**三处都以为别人管着**）：

- **丢弃处零留痕**：`lib/convert/anthropic.js` 一条 `addDiagnostic` 都没有，而该模块自己的规约（`lib/diagnostics.js:3-4`、`lib/protocol/steps.js:92`）要求「每一次丢弃/降级都必须在丢弃的那一行发诊断，绝不静默」；
- **本该兜底的门禁主动豁免了它**：`lib/fidelity.js` 的「类 3 会话中途系统指令 → 400」对 `from = anthropic` **明写放行**（原文：「anthropic 入站是这里的第一道放行」），而 `chat_completions` 又不在它那份「承载不了中途 system」的目标集合里；
- **旧行为有专门的守卫测试**：`test/system-prefix.test.js`（文件头写明这份守卫是为**prompt cache 命中率**立的）断言「中途 system 不进上游报文」，注释给的理由是「避免被 `mergeSystemMessages` 前移到头部、改变上游缓存前缀」。

⚠️ 同一个现象在网关里有**两种处置**：`anthropic → anthropic` 直连路由走 `convertSystemToUser`（**就地转 user**，注解说它修掉了 joybuilder 的 400），只有非直连目标（chat / responses / gemini）走那条丢弃。**要防的是「前移」而不是「存在」**——转成 `user` 后 `mergeSystemMessages` 根本不看它，内容与位置都能保住，前缀缓存性质与旧实现相同。

**判据一：同一请求体、只改一个字段**（`packages/server/agents/probe/v9/replay-role-differential.mjs`，请求体由同目录的 `claude-skill-mount-capture.mjs` 现场抓取），`DeepSeek-V4.1-Flash-a` 与 `GLM-5.3` 各 3 轮：

| 臂 | 请求体差异 | `Skill` 调用 | 模型自述 |
|---|---|---|---|
| 原样 | `role: "system"` | **0 / 3** | 「系统并没有向我提供任何技能（skill）清单」 |
| 只改 role | `role: "user"`，其余逐字节相同 | **3 / 3**，入参 `{"skill":"tang-poem-meal"}` | — |
| 删掉该条 | 无清单（对照） | 0 / 3 | — |
| 原样 + 条末拼令牌再追问 | `role: "system"` | 0 / 3 | 「关于令牌：没看到」 |

**判据二：量化判别——该内容根本没进上游上下文**。该条为 `role:"system"` 时上游 usage 与「整条删掉」**逐字相同**（`input_tokens` 158 / `cache_read_input_tokens` 11392，多次运行同值）；改成 `user` 后总上下文抬升（`input_tokens` 216～1880 / `cache_read_input_tokens` 11520～13184，随提示缓存浮动，两次测量的抬升量约 1850 token，与 7694 字符的 reminder 同量级）。模型自述与 token 账两头对上，排除「内容进去了但模型不理」。

**判据三：同时排除「挂载方式 / `settingSources` 传错」**——这正是本条目最初被误判的方向。同一抓包探针按四档 A/B 数主请求体里的清单条数：`['user','project','local']` **14 条**（含我们物化的 `tang-poem-meal` 与仓库自带的 `repo-owned-probe`）/ `[]` **12 条**（两条都没有）/ `['user']` **13 条**（只有我们那条）/ `['project','local']` **13 条**（只有仓库那条——**剔掉 `'user'`，我们物化的 skill 就从请求体里消失**）⇒ `settingSources` 传对了、且正是它在起作用，缺陷不在这里；离线守卫 `packages/server/agents/src/skills-config-prereq.test.ts` 钉的也是这一格。

**测试环境 ≠ 运行环境**：单测里适配器整个换成 `fakeAgents`，行为面在 `pnpm test` 里永远是绿的；而**这一层连真机行也看不出来**——`getContextUsage().skills.skillFrontmatter` 是 CLI **自己报的装配读数**（「我装上了」），与「模型收到了」隔着网关那一跳，把前者当后者用就会得出「模型不肯读」这个错判——那就是**把 L1 的装配结论当 L3 的行为证据**用。装配链那两半的事实如下（仍成立，是上面三条判据的前提）：

- **装入链没问题**（L1 + 厂商确证）：`<行配置目录>/skills/tang-poem-meal/SKILL.md` 与源目录逐字相同，`SKILL.md` 在 `query()` 之前落盘；厂商自己报的技能面里**有它**——`getContextUsage().skills.skillFrontmatter` = `[{"name":"tang-poem-meal","source":"userSettings"},…]`（同一条里另有 12 条 `built-in`；另造一条仓库自带 skill，来源原值 `projectSettings`，说明这条通道真的在按来源分档）。`source: userSettings` 就是「本机启用项那一份进了系统提示的技能面」的厂商原话。
- **行为面是空的**：该行 `工具调用名：[]`——一个工具都没调；答复是一首唐诗，**末行没有哨兵串**。`Skill` 是 CLI 侧的工具，模型要在 wire 上回一个 `tool_use(name='Skill', input.skill='…')` 才会触发；这条路由下的模型只回文本。**换 `GLM-5.3` 同样一次都不调** ⇒ 不是某一个模型的怪癖，而是**两个模型都拿不到那份清单**：只把那条消息的 `role` 改成 `user`，两个模型都会调（见上表）。

**解决方案**：**网关侧已修，待部署**——丢弃点不在本仓，修的是 `proxyGateway`（同一台机器上的 `~/Coding/proxyGateway`）。四件事：

- **改法**：`lib/convert/anthropic.js` 的 `anthropicToOpenAI` 把「中途 system 整条丢弃」改为**就地降级为 `user`**（内容与位置都保留，只改指令角色），并发一条 `semantic` 诊断 `mid_sequence_system_downgraded_to_user`（`path` = `messages[i].role`，登记在 spec §19.2 表第四处）。**前导连续段不改写、不发诊断**（与 `lib/convert/responses.js` 的 S3 同口径）。
- **守卫**：`test/system-prefix.test.js` 的三处断言随之改写（原断言钉的正是旧行为）；`test/diagnostic-sites.test.js` 新增 S4（正例 + 两条「位置未变则零诊断」反例 + 三条目标各保 reminder 原文的复验）与一条真实 HTTP 往返的端到端用例。**变异验证**：把 `continue` 放回去 ⇒ 6 条守卫同时变红（3 条反例仍绿），还原后 `lib/convert/anthropic.js` 哈希 `1bd66503d7e208bfa7001bfa0ad42547bc8609c581de7904b13ec2ea27bcb756` 逐字一致。
- **本机端到端**：真启动改后的网关 + 假上游，把本轮抓到的**真实请求体**POST 进 `/v1/messages` ⇒ 上游报文的 `messages` = `[system 62, user 647, **user 7694**]`，技能清单标题、`Primary working directory`、reminder 原文全部逐字到达，控制台出现 `转换诊断 1 条(semantic=1) codes=mid_sequence_system_downgraded_to_user`。
- **生效条件**：远端 `likecode-llm-proxy.jd.com` 仍跑旧代码 ⇒ **部署前本仓现象照旧**。
- **行级判据维持「技能面确证」不变**：`getContextUsage().skills.skillFrontmatter` 里出现该条且来源为 `userSettings`（观测格记 `installed · 判据 厂商清单`），**但绝不把「模型会用它」写成已兑现**；它报的是装配读数，与模型是否收到隔着网关那一跳。**换真 Claude 模型或另一条网关是唯一的替代复验路径**：三条判据同时看——真发 `tool_use(name='Skill')`、答复**末行逐字**命中哨兵串（只出现唐诗不算，唐诗是模型本来就会的东西）、`SKILL.md` 在行配置目录里。
- **兜底（未实施，网关修好后不再是必需）**：候选执行的任务提示里显式注入技能清单。它只补技能一项，补不了环境块 / agent 类型表 / 日期 / token 预算——那些随网关这一修一起回来。
- **复验判据**：跑 `packages/server/agents/probe/v9/replay-role-differential.mjs`，`A1-原样(system)` 臂的 `Skill调用` 由 0 变正即说明这一跳被修好（**部署后**才可能变正）；请求体由 `claude-skill-mount-capture.mjs` 现场抓取，不依赖上游会答题。真机那一半仍由 `packages/server/agents/src/providers/cc/live-skills-context.test.ts`（`AIEVAL_LIVE_SKILL_CONTEXT=1`）与离线的 `packages/server/agents/src/skills-config-prereq.test.ts` 钉。

**相关资料**：

- [《技能配置》](/features/skills-config) —— 已知边界里同一条登记（「厂商确证技能面里有它」这一档的上限）
- [《Claude Code 接入》](/protocols/cc) —— skills 落地口径（落点、`options.skills` 的三档、判据通道）与已知边界表
- SDK 类型（本地安装态）：`getContextUsage()` 的 `skills.skillFrontmatter[].source` 取值域 `userSettings` / `projectSettings` / `built-in`（`sdk.d.ts`）
- 探针与判定原文：`packages/server/agents/probe/v9/REPORT.md`（两个脚本的跑法与四张判定表）；抓包落 `probe/dumps/v9/`（已 gitignore）

---

## Write 落点缺一级 workspace：`"file_path":"…/rows/54fbe2bf-…/poetry.md"` 应为 `…/workspace/poetry.md`（评分「工作区无任何改动、无未跟踪文件」→ 0 分）

**日期**：2026-10-11

**根因**：机制层三层，前两层是绿的事实、缺口在第三层：

- **平台三层全绿**：① `system/init` 帧 `cwd` = `…/rows/<rowId>/workspace`（给 CLI 的 cwd 正确）；② 厂商确证技能面里有该条——`getContextUsage().skills.skillFrontmatter` 含 `{"name":"tang-poem-meal","source":"userSettings"}`；③ **CC 2.1.281 在主请求的 `<system-reminder>` 里确实注入了技能清单**（原文 `The following skills are available for use with the Skill tool: - tang-poem-meal: …`）——本地假网关捕获真实请求体逐项对齐真机 options（模型名 `glm-5.3` / `GLM-5.3[1m]` / `claude-sonnet-4-5`、`CLAUDE_CODE_ENABLE_TODO_TOOLS`、禁用名单、`forwardSubagentText`、`includePartialMessages`、`settings.env`）全部带清单；第一轮请求构造先于任何网关响应，故「CLI 没把清单注入请求体」这一半被排除——**至于它到不到模型，是网关那一跳的事，见上一条**。
- **模型没见过清单（不是「没利用」），改翻文件系统**：该行模型（GLM-5.3 走 likecode anthropic 协议网关）的 thinking 自述 `I don't see a system-reminder listing skills in this conversation`，于是用 Bash `find $HOME/skills` 找技能——命中平台物化目录，**输出把 `<行目录>/.agenthome/skills/<名>/SKILL.md` 的绝对路径送进上下文**。那句自述是**字面事实**：整份 `<system-reminder>` 随 `role:"system"` 那条消息一起被网关丢掉（判据见上一条），模型确实没收到过它。
- **落点**：模型随后 Write 时复用该绝对路径前缀，`poetry.md` 落在 `.agenthome` 的**父目录**（行目录）——比正确工作区少一级 `workspace`。diff 采集只扫 `workspace/`（口径：工作区外的产物对评分不可见），于是 `diff = 0 改动` → 评分判「未达成」→ 0 分。

与同日「技能面确证在但 `工具调用名：[]`」条目同源（模型不调 `Skill` 工具），本条目是它的下游一环：**文件系统翻找把平台私有目录（`.agenthome`）的绝对路径送进模型上下文，模型复用它拼产物路径**。「经常」的机制：skills 冒烟场景每次重跑都可能触发同一条模型行为链。

**解决方案**：**未闭合**（用户裁定不动平台代码，接受为已知模型行为）。代价：第三方模型走 CC 时，技能可见性押在模型对 `<system-reminder>` 的服从上；模型翻文件系统并复用绝对路径时，产物落到 `workspace/` 之外，`diff=0`、评分失真。复验判据：真机重跑该行，看 `messages.jsonl` 里 `Write` 的 `file_path` 是否带 `.agenthome` 前缀（或缺一级 `workspace`）。可选兜底（未实施）：候选执行的任务提示里**显式注入技能清单**（名字 + description + 使用条件）与「所有产物写入当前工作目录」锚点，三家统一——不再依赖厂商 system-reminder。

**相关资料**：

- [Claude Code skills 官方文档](https://code.claude.com/docs/en/skills.md)：*"Every skill in the skill listing adds to your context on every turn"*（清单每轮进上下文）与 *"a skill's body loads only when it's used"*（正文只在被调用时注入）

---

## 执行日志里没有思考、原始输出里有（`messages.jsonl` 折叠后只剩 `text`；原文 `[{"type":"thinking","thinking":"…","signature":""}]`）

**现象原文**（「原始输出」抽屉里看得到这一串，「执行日志」抽屉里同一条消息只剩正文块）：

```
[{"type":"thinking","thinking":"The skill instructions are clear:\n1. Pick a poem from 唐诗三百首 …","signature":""}]
```

**日期**：2026-10-11

**根因**：机制层——**适配器给同一条厂商消息的多次投递各自重新起块序号**，后一块把前一块从槽里盖掉。三层：

- **厂商形状**（真机转录 `[22]` / `[23]`，同一个 `assistant.message.id`）：CLI 对一条 assistant 消息**分多次投递、每次只带一个内容块**——先 `thinking`、再 `text`。
- **契约口径**：文本 / 思考块的块标识就是「**该载体内第几个块**」（`i:<index>`），`MessageAssembler.applyBlock` 对「已有键 + 快照」的处置是**覆盖**——这正是「增量片段与它后面的块结束快照落进同一个槽」所要求的。
- **缺陷**：`providers/cc/message.ts` 的 `assistant()` 每条投递都走 `takeStreaming(id) ?? createBlockIndexAllocator()`，而 `takeStreaming` **取一次就清空** ⇒ 第二次投递拿到一本新账、`forSource(0)` 又算出 `i:0`，把第一次的 `thinking` 覆盖成 `text`。账本必须**按 `message.id` 跨投递存活**（即分配器文档里那句「每个载体一个实例」）。
- **为什么第 1 轮（`thinking` + `tool_use`）看不出**：工具调用按 `c:<callId>` 分槽，撞不上 `i:0` ⇒ 这个缺陷只在「两次投递都是文本 / 思考块」时暴露。

**判据**（真机产物 `96e5f6e2…/rows/ceec6cb1…`）：`messages.jsonl` 里同一个 `mergeKey`（`main|2|assistant|-`）有两条记录，一条只有 `[thinking]`、一条只有 `[text]`；读侧按 `mergeKey` 留最后一条 ⇒ 最终视图只剩 `text`，而原始输出里思考原文俱在。把那一行的转录逐帧复放（归一器 + 装配器）修复前打印 `main|2|assistant|- → ["text"]`、修复后 `["thinking","text"]`。

**解决方案**：`packages/server/agents/src/providers/cc/message.ts` 把「每条投递一本新账」改为**按 `message.id` 一本账**（`ordinalBooks`：`{ allocator, delivered }` 随消息存活；`assistant()` 用 `delivered + position` 续号并按厂商 `content` 数组长度推进 `delivered`；`message_start` 重开一本；增量那一侧不推进 `delivered`）。守卫：`providers/cc/message.test.ts` 新增三条（先 thinking 后 text / 反向顺序 / `tool_use` 对照）。**变异验证**：把 `assistant()` 那本账改回「每帧新建」（`ordinalBookOf(key, true)`）⇒ 两条红 + 真机复放打印回 `["text"]`，`tool_use` 对照仍绿；还原后 `message.ts` 哈希 `20229089889a8728e5ac25be9abf016f5c1a66dd01a5366218d17f80c5616945` 逐字一致。**残留**：已经写进 `messages.jsonl` 的历史行**不会自愈**（读侧不做重算）——要让某一行的执行日志补上思考，得**重跑那一行**。

**相邻未修（另一处，本次未动）**：主会话**增量**的轮次号取的是 `state.turns` 的当前值（不 +1），而推进它的是**完整** assistant 消息 ⇒ 第 2 轮起增量的 `roundTrip` 比快照**小 1**（实测 `增量 roundTrip=1 快照 roundTrip=2`），实时打字那一段因此归到上一轮的载体里。它在代码里被注为「既有口径、本次不动」。

**相关资料**：

- [《消息规范》](/protocols/message-spec) —— 「帧是累积值，不是本片」与「合并键分两层」（块标识不进 `mergeKey`）
- [《Claude Code 接入》](/protocols/cc) —— 「覆盖合并（关键）」那一节

---

## `AGENT_FAILED：Claude Code returned an error result: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)`（这一行在 `running` 上挂了 6 分钟才失败）

**现象原文**（`attempts.jsonl` 的 `phase: "end"` 那一行，逐字）：

```
{"attempt":1,"phase":"end","outcome":"failed","code":"AGENT_FAILED","message":"Claude Code returned an error result: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)","retrying":true}
```

同一行在界面上表现为：`选手` 格长期停在 `执行中`、`耗时` 一直涨（实测 **6 分 14 秒**才落到终态），「执行日志」抽屉里是清一色的重试帧：

```
{"type":"system","subtype":"api_retry","attempt":8,"max_retries":10,"retry_delay_ms":36089,"error_status":null,"error":"unknown","session_id":"…"}
```

**日期**：2026-10-12

**根因**：**这一行的供应商端点没有进程在监听**——不是防火墙、不是平台。三层：

- **我们的配置**：这一行的 `providerId` 指向 `local` 供应商，`baseUrl = http://127.0.0.1:7999`（`~/.aieval/config.json` 的 `providers[]` 里可逐字核到）。该端点上没有任何服务在跑：同机 `curl http://127.0.0.1:7999/v1/models` 得到的是连接层失败（退出码非零、无 HTTP 状态），即 TCP `ECONNREFUSED`。
- **厂商那一层**：CC 的 CLI 拿到连接被拒后不会立刻放弃，而是**带指数退避重试同一请求**（`api_retry` 帧：`attempt` 1→10、`retry_delay_ms` 逐次翻倍到 36 秒量级），重试耗尽才把整轮判失败；我们的编排层再把整个 attempt 重来一遍（`attempts.jsonl` 里 `attempt: 1` 与 `2` 都是同样的 `ECONNREFUSED`，间隔约 3 分钟）。
- **那句「a firewall or proxy may be blocking it」是 CLI 自己加的猜测**，不是诊断结论：真实原因就是「本机那个端口没人监听」。这一格会把人往网络策略上引，而实际上只要把本地网关起起来（或换一个在线的供应商）就好。

**解决方案**：**未闭合**（不需要改代码：本仓没有任何一处该做而未做的事）。判据链按顺序核三格即可定位同类问题：① `run.json` 里该行 `providerId` → ② 配置里它的 `baseUrl` → ③ 在**同一台机器**上 `curl` 那个 `baseUrl`。第三格失败即根因落定。**代价**：这一格从现象到终态要 **6 分钟以上**（CLI 的 10 次退避 + 我们的一次 attempt 重试），期间行状态是 `running`、名次表里那一列显示「执行中」——看的人容易以为它在正常干活。要更快失败只能改厂商侧的退避策略（不在本仓控制内）。

**相关资料**：

- [《Claude Code 接入》](/protocols/cc) —— 供应商端点与凭据的解析口径（`providerId` → `baseUrl` / `apiKey`）

---

## `No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.`（没有批准面时，提问工具根本不提供给模型）

**现象原文**（探针 `probe/v11/cc-ask-channel.mjs` 的 `none` 臂，脚本式上游主动回一帧
`AskUserQuestion` 的 `tool_use`，工具结果逐字）：

```
<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.</tool_use_error>
```

同一现象在**子智能体**里换一句话（`cc-ask-subagent.mjs` 的 `subagent` 臂，父会话挂着批准面、
让子会话提问）：

```
<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is not available inside subagents. Complete the task with the tools provided and return findings to the orchestrator.</tool_use_error>
```

同桌读数（同一次运行的入站请求体 `tools[]`，也是原文）：

| 装配 | 模型工具表 | 提问工具在不在 |
|---|---|---|
| 挂了 `canUseTool`（`bypassPermissions` 或 `default` 都一样） | 30 项 | **在** |
| 一个回调都不挂（或 `permissionPrompts: 'none'`） | 27 项 | **不在** |
| 子智能体的会话（父会话挂着回调） | 25 项 | **不在** |

**日期**：2026-10-13

**根因**：提问工具的启用闸门是 `isEnabled()`，它把「headless」与「有没有批准面」两件事**与**起来：

- CLI 侧原文（`@anthropic-ai/claude-agent-sdk@0.3.281` 自带二进制 2.1.281）：
  `function k5(){ if (ph().length > 0 && Ae()) return !1; if (Ae() && !ORn(wF())) return !1; return !0 }`，
  其中 `Ae()` = `!isInteractive()`（`--print` / SDK 都是 headless）、
  `wF()` = `permissionPromptToolName()`、`ORn(e)` = `e !== undefined && e !== "none"`；
  另有 `g5t({permissionPromptTool, sdkUrl}) { return sdkUrl ? "stdio" : permissionPromptTool }`
  ⇒ SDK 走 stdio 时那一格解析成 `stdio`，**所以「挂一个回调」等于给这个会话装上批准面**。
- 于是：**不挂批准面 ⇒ 工具不提供给模型**（模型永远问不出来），不是「问了被拒」，也不是「问了挂住」；
  挂上批准面之后，提问才会以 `can_use_tool` 下发给宿主（同一份探针的 `both` 臂，`requires_user_interaction: true`）。
- 子智能体那句是**另一道独立的闸门**：父会话挂着批准面时子会话仍拿不到这个工具，
  提示语也是分开写的（`not available inside subagents`）——即「子智能体不能向用户提问」在 cc 侧是
  **厂商原生**行为，不需要宿主自己按子智能体身份去拒。

**解决方案**：**本仓无需改代码**（这是厂商设计，不是缺陷）；要判的是「我们这一轮到底挂没挂应答面」：
判据链 = ① 这一轮是否传了 `canUseTool`（不传就是本条现象，模型看不见工具，收场是「这家没开应答面」而**不是**「无人应答」）；
② 传了就一定能在入站请求体的 `tools[]` 里看到 `AskUserQuestion`（本仓 `probe/v11/cc-ask-channel.mjs`
的 `inboundFirstMain.hasAskUserQuestion` 就是这一格）。复跑：
`node packages/server/agents/probe/v11/cc-ask-channel.mjs --arm=none --mode=default`。
**代价**：这一格今天在界面上看不出来——模型只是「不会问」，什么都不报，所以容易把
「我们没开应答面」误判成「模型不需要问」。

**相关资料**：

- [《Claude Code 接入》](/protocols/cc) —— 权限档与 `canUseTool` 的装配口径

---

## `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted.`（全权档并没有遮蔽提问工具）

**现象原文**（SDK 打到进程 stderr 的 node 警告，逐字）：

```
(node:85537) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted. To gate every tool call, use a PreToolUse hook instead.
```

同一次运行（`probe/v11/cc-ask-channel.mjs --arm=shadow-ab --mode=bypass`）里，同一个回调记录器
收到的**命中列表**只有提问工具：普通工具 `Read` 正常执行（工具结果就是文件内容）却**没有**过回调，
而 `AskUserQuestion` **过了**回调，线级帧逐字：

```
{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{…},"tool_use_id":"toolu_probe_ask_1","requires_user_interaction":true}}
```

**日期**：2026-10-13

**根因**：那句警告是**写给普通工具的**，它把结论说过头了。`bypassPermissions` 的自动批准短路
（`except explicit deny rules`）只覆盖「策略层可以自己决定 allow」的工具；而提问工具的接口里
`requiresUserInteraction()` 恒为 `true`（同一份 CLI 原文：`requiresUserInteraction(){return !0}`），
这一类工具的批准卡**本身就是交互面**，所以策略层不替它做决定，仍把 `ask` 交给宿主 ⇒
控制帧带 `requires_user_interaction: true`。同一条原则在 hook 那一侧也能看到：
`if (!C.updatedInput && e.requiresUserInteraction?.()) return null;`（规则/hook 的 allow
不带改写入参时不短路这类工具）。

**解决方案**：**不要照那句警告设计权限档**。判据（可复跑）：

```
node packages/server/agents/probe/v11/cc-ask-channel.mjs --arm=shadow-ab --mode=bypass
```

看 `shadow-ab @ bypassPermissions：通道=回调命中过的工具 = ["AskUserQuestion"]；普通工具（Read）是否也过回调 = false`。
实测结论：**接应答面不需要放弃全权档**——`permissionMode: 'bypassPermissions'` 一字不用改，
只要在传 `canUseTool` 的同时照旧给 `allowDangerouslySkipPermissions: true`；
普通工具照旧走自动批准、到不了回调，等于免费得到「只对提问工具走问答，其它工具一律放行」。
（要「每个工具都过宿主」才需要换 `PreToolUse` hook——本仓不需要。）

**相关资料**：

- [《Claude Code 接入》](/protocols/cc) —— 权限档表与 `allowDangerouslySkipPermissions` 的成对口径

---

## `updatedInput.response` 一给就把选项答案整条盖掉：`The user responded: …`（自由输入该走选项值那一格）

**现象原文**（探针 `probe/v11/cc-ask-answer.mjs --arm=response`，脚本式上游只回一帧
`AskUserQuestion` 的 `tool_use`，我们返回 `allow` + `updatedInput` 里**同时**给 `answers` 与 `response`；
模型最终看到的工具结果逐字）：

```
The user responded: 探针自由输入：先按 Alpha 走。
```

对照：同样两条工具结果来源（后续入站请求体的 `tool_result` 与 SDK 消息流）在 `--arm=answers` 下逐字是

```
Your questions have been answered: "Which approach should the probe take?"="Alpha", "Which paths may I touch?"="workspace".
```

**日期**：2026-10-13

**根因**：提问工具的**结果渲染**按 `response` 优先分档——`response` 一有值，整条工具结果换成
「用户这么说」那一种渲染，`answers` 里那些选项标签**一条都不再出现**（这一家的工具结果里没有第三格
能同时装下两者；`annotations[<题面>].notes` 装得下补充说明，但它只在 `answers` 那一支里追加
`notes: …`）。于是「多选 + 自由输入」这种**两者都要保留**的答案用 `response` 递出去必然丢一半：
用户选中的标签模型再也看不到。

**解决方案**：**不用 `response`**。本仓把用户写的那句话当成**选项值的另一种**递回去——值取 `custom`
（单选）或与选项标签**并在同一个数组**里（多选），键仍是题面文本（`providers/cc/ask-user.ts` 的
`ccAnswersOf` / `ccAnswerValueOf`）。判据（可复跑，探针的 `answer-custom` 臂就是按这份算出来的值发的）：

```
node packages/server/agents/probe/v11/cc-ask-answer.mjs --arm=answer-custom
```

实测工具结果逐字：

```
The user answered: "Which approach should the probe take?"="探针自由输入：先按 Alpha 走。", "Which paths may I touch?"="workspace,探针自由输入：再多带一个 system。".
```

即：单选与多选的自由输入**都到得了模型**，多选那一半的选项标签也没丢。套餐内的守卫是
`providers/cc/ask-user.test.ts` 的「弹层的单选那一档」「多选那一档」两条
（真路径那一侧由 `providers/cc/conformance.test.ts` 钉「答复真的回到了厂商」）。
**另一处容易踩的**：这一家的提问入参 schema 里**没有**「允不允许自由输入」这一格，而它自己的
schema 描述逐字写着「不要给 'Other' 选项，那个界面上自动提供」⇒ 题面的 `allowOther` 在这一家
**恒 `true`**，判据读的是答案面而不是提问形状（`tool-payload.ts`）。

**相关资料**：

- [《Claude Code 接入》](/protocols/cc) —— 《提问与应答面》一节的递答案形状
- [《提问与应答》](/features/ask-user-answer) —— 四家自由输入的落点对照

---

## 执行日志里任务工具没有「计划清单」卡片：一行一个「计划清单」标签 + 参数原文（`{"taskId":"1","status":"in_progress"}`），而 codex 同题是一整张表

**现象原文**（run `f4e3f5c1-9a43-49ce-9a3a-75a74ed4ace0` 的 claude 行 `9e2b9cc0`，「执行日志」抽屉里
`TaskCreate` / `TaskUpdate` 的五行工具行；同 run 的 codex 行 `1a1e1a09` 那一处是带 `0/2 完成` 与
状态列的卡片）：

```
工具调用 × 2  TaskCreate
  计划清单  使用 AskUserQuestion 工具询问用户的工作岗位，作为后续 AI 场景分析的基础信息。
  计划清单  基于采集到的工作岗位信息，分析该岗位/行业中能够与 AI 契合、可被 AI 增强或自动化的具体场景。
工具调用 × 1  TaskUpdate
  计划清单  {"taskId":"1","status":"in_progress"}
```

（`messages.jsonl` 里对应的六条 `tool-call` 块逐字是 `"payload": null`：`TaskCreate` × 3 与
`TaskUpdate` × 5 全都拿不到族载荷。）

**日期**：2026-10-14

**根因**：机制层——**这一家的任务工具是工作项注册表，整表只能由多次调用累积出来，而我们的族载荷只从单次入参算**。

- **厂商形状**：自 SDK 0.3.142 / CC 2.1.142 起任务工具从 `TodoWrite` 换成 `Task*`。`TaskCreateInput` = `{subject, description, activeForm?}`、`TaskUpdateInput` = `{taskId, status? | subject? | owner? | addBlockedBy? …}`；输出 `TaskCreateOutput` = `{task: {id, subject}}`、`TaskUpdateOutput` = `{success, taskId, updatedFields, statusChange}`——**入参与结果两头都没有整表**；整表只有 `TaskListOutput.tasks` 有（真机那一行一次都没调 `TaskList`）。id 也**只有结果才有**（工具自己发号）。
- **我们的缺陷**：`tool-payload.ts` 的 `toolPayloadOf` 是**单次入参**的函数，`task` 族只认 `todos` / `plan` / `steps` 三个键 ⇒ `Task*` 恒 `payload: null`，界面按契约走通用工具行（`familyPayloadOf` 只在 `payload.kind === 'plan'` 时出「计划清单」卡片）。
- **空摘要那一半是同一个成因**：`TaskUpdate` 的入参只有 `{taskId, status}`，`activity.ts` 的 `detailOf` 三级（计划类键 → `description` → 族提示）都没有落脚点 ⇒ 摘要为空串，界面回落成参数原文首行那一串 JSON。
- **为什么另两家没有这个问题**：codex 的 `update_plan`（`{plan: [{step, status}]}`）与 dsh 的 `todo_write`（`{todos: […]}`）**入参本来就是整表**，一次调用就能算出「本次调用之后的整张清单」。

**解决方案**：把「整表」这一层从单次入参挪到**适配器内的 run 级台账**。

- `packages/server/agents/src/providers/cc/task-registry.ts`（新增）：`TaskCreate` / `TaskUpdate` 的入参入账（建项、改状态、`owner` / `addBlockedBy` 读到的就投），两者的**结果**补它权威的那一半（创建结果回填 id / subject；更新结果的 `statusChange.to` 落状态）。三条口径写在该文件头：「刚建、还没更新过」记 `pending`（依据是真机 `statusChange.from` 逐字 `"pending"`；`TaskCreateOutput` 本身没有状态格）、`deleted` 按**移除**处置（面板画的是清单当前状态）、没见过的 id 只记补丁账**不凭空造行**。
- `packages/server/agents/src/message.ts`：`toolCallBlockDraft` 加一个**可选**载荷入参（只给逐条 patch 的族用；不给就照旧按族归一算），仍是工具块的唯一构造点。
- `packages/server/agents/src/providers/cc/message.ts`：`assistant()` 把台账算出的载荷挂上块；`user()` 在结果入账后**用同载体重投一份快照**（`taskRefreshDraft`：轮次 / 派生调用 / 会话逐格沿用那次调用的）把刷新后的整表挂回同一个块——走的正是 `message.ts` 已登记的「已 seal 的槽位被新快照更新」，界面按 `mergeKey` last-wins 折叠即得，**不需要新通道、界面一个字节都不用改**。id 必须这样学：轮 2 的 `TaskUpdate{taskId:'1'}` 要能对上轮 1 那两条创建结果里发下来的号。
- `packages/server/agents/src/tool-payload.ts`：状态映射抽成 `taskStepStatusOf` 一处（整表形状与这套注册表共用，避免同一个状态串在两处读成两档）。
- 守卫：`providers/cc/task-registry.test.ts` 九条——真机那七条帧走「归一器 → 合并器 → 按 `mergeKey` 折叠」的端到端四条（每个 `Task*` 块都有整表载荷、id 由结果回填、轮 2/轮 5 的状态、刷新不新增合并键），台账边界五条。**变异验证**：把载荷接线摘掉 ⇒ 3 红；结果不刷新 ⇒ 2 红；`in_progress` 读成 `pending` ⇒ 2 红；新建立项 `pending` 改成 `unknown` ⇒ 3 红；四次还原后 `message.ts` / `task-registry.ts` / `tool-payload.ts` 哈希逐字一致。
- **残留**：已写进 `messages.jsonl` 的历史行**不会自愈**（读侧不重算）——要让某一行补上「计划清单」卡片，得**重跑那一行**。
- **未投的两维**：`owner` / 依赖在真机入参里一次都没出现，故入参没给过的行拿契约的「有这个概念、当前无人认领 / 没有依赖」（`''` / `[]`），不拿 `null` 冒充「这家没有这个概念」；`addBlocks`（反向边）本期不投。`TaskList` / `TaskGet` 的结果形状真机未观测，不入账。

**相关资料**：

- [《消息规范》](/protocols/message-spec) —— `tool-call` 的 `payload` 与「帧是累积值」
- [《Claude Code 接入》](/protocols/cc) —— 《数据与契约》一节的任务台账

---

## 回了 tool_use 却没跑工具、SDK 时间线里直接 `result/success`（CLI 在真正的第一轮之前还会打 `messages: []` 的探路请求与 `<session>…</session>` 包裹的辅助请求）

**日期**：2026-10-14

**根因**：机制层——用**脚本式假上游**驱动 SDK 时，把 `tool_use` 帧回给了**辅助请求**，于是它被静默丢弃。CLI 在真正的第一轮之前会打若干条辅助入站请求，实测见到两种形状：① `path` 是 **`/api/hello` 的握手请求**——`messages: []`、`system` 为空、不带工具表，它根本不是 `/v1/messages` 上的模型请求；② **会话标题生成**那条——`path` 是 `/v1/messages?beta=true`、`messages` 只有一条、`tools: []`（不带工具表），user 文本是把原话包进 `<session>…</session>` 再缀一句 `Write the title in the predominant language of the session …`，**每条用户消息各触发一条**。辅助请求一件工具都不带，把工具帧回给它必然是丢弃。**主轮请求的判据取硬的：`tools.length > 0`**（主轮带整套工具表，实测 27 件）；`<system-reminder>` 那一组块（环境、模型名、代理类型、技能清单、日期、署名）是被 CLI 拼进同一个 user 消息里的，可作旁证但不能当判据。按**序号**（`record.index === 0`，或"第一条被 decide 的请求"）去判"该给工具帧的那一轮"必然打偏——序号里混着 `count_tokens` 与这些辅助请求——症状是**静默的**：不报错、不执行，时间线里直接 `result/success`，看起来像"工具没被调用 / 模型不愿用工具"。

同批观测到的第二条相关事实：长命令（`sleep 4`）不是一次阻塞的工具调用，而是以 **`system/task_started` → `system/task_notification` → `user`(tool_result)** 的**后台 task** 形态跑完的——判"工具在途"的窗口要看这两条，不是看 `assistant` 里有没有 `tool_use`。

**解决方案**：探针 `packages/server/agents/probe/v11/cc-stream-input.mjs` 的 `decide` 改成**按内容**判主轮（该请求的 `messages` 里带首句、且序列化后不含 `<session>` 包裹，更稳的是直接看 `tools.length > 0`），不再按序号。判据：慢工具真的跑起来——时间线里出现 `system/task_started` → `system/task_notification` → `user`，且那一轮的 `result` 比注入时刻晚一个 `sleep` 的量级。产物（`probe/dumps/v11/cc-stream-input-*.json`）的 `readings[].preview` 会把每条入站请求的 `messages[]` 逐条打出，辅助请求与主轮一眼可分。

---

## 探针读数 `insertedSeenInRequests: []`：「注入的那句话没进任何模型请求」

**日期**：2026-10-14

**根因**：机制层——**观测口径漏了一类落点**，不是注入没到。cc 在**工具在途**时收到的用户消息，缺省档（不写 `priority`）会把它折进**下一条工具结果的正文**：后续那条带 `tool_result` 的主轮请求里，`tool_result` 块的 `content` 变成

```text
probe-tool-done

<system-reminder>
The user sent a new message while you were working:
PROBE-INJECTED-next-…

This is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.
</system-reminder>
```

只扫 `text` 块（`block.text`）的读数读不到 `tool_result` 的正文（`block.content`，字符串或块数组两种形状都出现过）⇒ 读成"这句话没进主轮"，进而误判成"注入被那条 `<session>…</session>` 辅助请求吃掉了"。同一段原文也把这一档的语义写明了：**折进正在跑的这一轮、通常伴随下一条工具结果**，而不是另起一轮；机制层的车道名就在 CLI 原生二进制里——折进那一段取的是 `getCommandsByMaxPriority("next")` 并用 `registerFoldInFlight` / `unregisterFoldInFlight` 括住，队列头分派处写成 `ee.priority === "later" ? "later" : "next"`（**不写 `priority` 的缺省档就是 `"next"` 这条 mid-turn fold 车道**，`"later"` 是另一条）。辅助请求并不消费用户消息——同一次运行的 9 条臂里，凡是标题生成请求带上这句话的，主轮请求**随后照样带上它**；"只有辅助看到、主轮没看到"的一格**一条都没有**。

**解决方案**：判据改成**三类落点全扫**（`text` / `thinking` / `tool_result.content`，后者含字符串与块数组），再用整份请求体做一次 `JSON.stringify(body).includes(needle)` 的**口径自检**——「结构命中为空而请求体里有这句话」的条数必须为 0；命中项的 `where` 直接写出落点形状。判据落在 `packages/server/agents/probe/v11/cc-stream-input.mjs` 的 `blockTexts()` / `findInserted()` 与 `readings[].insertedRawInBody` 上（全臂跑完自检漏=0、误报=0）。**消费方同样要读 `tool_result` 的 `content`**：工具结果本体（命令输出、文件内容）就在那一格，只认 `text` 块会把工具结果读成空。

⚠️ **本条只说明「折入那条车道存在、落点在 `tool_result.content`」**：那条探针是**工具在途**时 push 的，折入窗口只在那一刻开。生产路径的两个取件点都比它晚 ⇒ 从适配器推出去的消息**读不到这个落点**，症状见下一节。

---

## `result` 已经到了、这一行却永远不收场：`query({ prompt: AsyncIterable })` 下输入流不 `end()`，查询不会自己结束

**日期**：2026-10-15

**根因**：机制层——**`prompt` 的两种形状在厂商侧不是同一件事**。传字符串时 CLI 判定 `isSingleUserTurn`：那一轮的首条 `result` 一到就 `endInput()` 关掉自己的 stdin，`query` 的迭代器随之结束（既有行为）。换成 `AsyncIterable<SDKUserMessage>`（streaming input，运行中注入要的那一支）之后 stdin **一直留着**：`result` 变成**每一轮一条**的整轮收尾，迭代器要等到输入流 `end()`（或 `interrupt()` / `abortController`）才结束。于是「首条 `result` = 运行结束」这条旧口径在**读侧**仍然成立（`result` 照样到、事件照样投影），但**这一行不会收场**——界面上的样子是「一直停在 running」，没有任何报错、也没有任何一帧说不收场。判据：`packages/server/agents/probe/v11/cc-stream-input.mjs` 各臂跑完必须显式 `stream.end()`，不 `end()` 时那一刻的读数就是「迭代器挂着」。

**解决方案**：**收场由适配器驱动**（`providers/cc/index.ts`）：`'idle'` 档一条都没取到就 `inputStream.end()`，流循环的 `finally` 里再收一次（正常收尾、消费者提前退出、abort / 终止四档都走得到）。判据是 `providers/cc/inject.test.ts` 的两条：①「队列里没有待投递的消息 ⇒ 本轮收场就收流」——夹具那条假流在收到 `end()` 之前一直挂着，适配器不收流时用例红在「运行未在预算内落定」那句人话上（而不是把整个文件挂到超时）；②边界序列（工具结果取 `round`、`result` 收场取 `idle`）。

---

## 执行日志「只有全部完成才显示」：第 2 轮起没有打字机效果（正文等到该轮跑完才整段出现，`messages.jsonl` 与快照齐全、无任何报错）

**日期**：2026-10-15

**根因**：机制层——**流式增量的轮次号在计数点落后一轮**。cc 主会话的增量（`stream_event` 的 `content_block_delta`）取号走 `roundTripOf(state)`，那读的是 `state.turns`＝events 侧 `countModelRoundTrip` 数到的**完整 assistant 消息**条数；而完整消息是该轮**结束时**才到的 ⇒ 增量到达时它还是上一轮的数。合并键是 `subagentId|roundTrip|role|parentCallId`，轮次号一错，增量就落进**上一轮的载体**；那个载体的文本槽已被它自己的快照 `sealed` ⇒ 按 `MessageAssembler` 的「已 seal + 增量 ⇒ 丢弃」被**静默吃掉**（无日志、无报错）。第二档后果：上一轮只产出工具调用时（文本槽没被占，走的是 `c:<callId>` 槽），增量会写进去看着在长，却**挂在前一轮的轮次位置上**。第 1 轮恰好正确（`state.turns` 为 0 时兜底给 1），所以只在**多轮**任务上现形。

真机读数（cc 行 5 轮，`run 5051403b`）的 delta 落键：`main|1:9 / main|2:1 / main|3:1 / main|4:69 / main|5:0`——每轮都堆在前一轮，最后那 69 条其实是第 5 轮的（第 5 轮是最后的长回复）。另外三家不适用：它们的计数点在**该轮开始时**（pi 的 `turn_start`、codex 的「先计入再取号」、dsh 直接带厂商 `step` 号）。

**测试环境 ≠ 运行环境**：夹具只跑单轮、或只在第一轮观察时，增量与快照恰好同键，`pnpm test` 全绿。既有的 `message-session-rounds.test.ts` ④ 甚至把这个错值写成了「既成事实的前提钉」（断言主会话增量拿「已数到的 2」），**守卫反过来固化了缺陷**——这不是环境差异，是**用例只覆盖了恰好正确的那一轮**。

**解决方案**：`packages/server/agents/src/providers/cc/message.ts` 新增 `mainRoundTrip(state, messageId)`，主会话的号改按 `message.id` 在 `state.turnKeys`（events 侧按到达顺序记的完整 assistant 消息 id）里的**位次**取：id 已在账里（完整消息已到）⇒ 位次 +1；id 还没进账（**增量先到**）⇒ 占「账里条数 +1」，正是它稍后进账时会占的那个号。`roundTripOfSession` 的主会话分支改调它（侧链与「拿不到 id」两档不动）。守卫：新增 `providers/cc/stream-alignment.test.ts` 4 条（第 1 轮对齐 / 第 2 轮不落上一轮且增量当场写进载体 / 多轮不串联 / 同一条消息分块多次投递号稳定），并把 `message-session-rounds.test.ts` ④ 的错值断言翻成新口径 + 补「与快照同键」。**变异验证**：主会话分支改回 `roundTripOf(state)` ⇒ 新守卫红 3 条（第 1 轮那条仍绿属预期）⇒ 还原后 `message.ts` 哈希 `4c64c9e1…` 逐字一致、复绿。真机复核（同一用例）：delta 落键变成 `main|1`（14 条，末条 96 = 该轮快照 96）与 `main|2`（49 条，末条 164 = 快照 164），页面采样第 2 轮正文 126→321 分 10 步增长。

---

## 运行中投出去的那句话**另起了一轮**：多一次模型往返，而 `tool_result.content` 里没有 `<system-reminder>The user sent a new message while you were working: …</system-reminder>`

**现象原文**（真机探针：两条只差**上游响应延迟**的臂，判据是出站请求体的逐字内容）：

```text
臂 round-response-immediate ：注入的那句话落在**第 5 条请求的独立 user 消息**里
臂 round-response-delayed-4s：同上（上游把带 tool_result 的那条请求拖了 4 秒也照样）
两臂的 drains 都是 ['round','idle',…] ⇒ 取件**真的**发生在 'round' 边界
含厂商折入文案的请求 = 0 条
注入之后 CLI 另起一轮：上游多收到一条引擎请求，finalText 换成新那轮的答复
```

**日期**：2026-10-16

**根因**：机制层——**折入窗口开在「厂商构造那条请求」之前，而契约两档的取件点都在构造之后**。厂商的折入发生在它把「用户中途发来的消息」并进某次请求体那一刻（取 `getCommandsByMaxPriority("next")` 那条 mid-turn fold 车道），而适配器的两个取件点读的都是**已经到达我们这一侧**的事件：`'round'` 读「工具结果帧到达」、`'idle'` 读「`result` 帧到达」。工具结果帧到达意味着厂商**已经拿到工具结果、正在构造下一条请求** ⇒ 此刻推出去的那条只能作为一条新的用户消息入队，厂商据此开新的一轮。上游快慢不影响这一点（拖 4 秒的臂同样没折入）——差异不在时间窗口，在**取件点晚于构造点**这个次序。取证要点：可复核的判据是「折入文案在请求体里出现 0 次」与「`drains` 里有 `round`」这对读数同时成立（后者证明取件真的发生过，否则读数只是「没取件」）。

**解决方案**：**未闭合**（不修代码：契约 `InjectionBoundary` 只有 `round` / `idle` 两档，两档的语义都是「我们已经看得见某个事件」——要真折入必须多一条**早于工具结果**的边界，那属契约变更）。当下已做的两件事：① **声明与文档改说真话**——能力面两档仍记 `unverified`（它指的是「折进本轮」那句口径，不是「投不投得出去」；「消息被厂商收下并另起一轮」这一半已真机证到），`docs/protocols/cc.md` 的《注入与续接》把两档写成「落点实测一致：都另起一轮」并删掉「缺省车道的落点在 `tool_result.content`」那句；② 契约词表（`contracts/src/inject-vocab.ts`）补一句「这两档说的是我们什么时候交出去，不是厂商一定怎么处置」。**代价**：每次注入多一轮模型往返（真实计费与墙钟都增加），两档在效果上**同值**——界面若按「立即发送会折进本轮」写动效就是假的。判据留档：探针两条臂 + 阴性对照（不挂端口时暗号一次都不出现）。

**相关资料**：

- [《Claude Code 接入》](/protocols/cc) —— 《注入与续接》两条边界的现时口径
- [《Provider 抽象与 run 入口》](/protocols/provider-run) —— 注入面的两档边界与端口契约

---

## 为 `claude-sonnet-4-5` 选 `high` 档，出站请求体里整格没有 `output_config`（同一档换 `opus-4-5` / 非 Claude 名就有）

**现象**：思考档位选 `high`，看出站 `/v1/messages` 请求体——`claude-sonnet-4-5` 那条**整格没有** `output_config`；同样的档位换 `opus-4-5` 或非 Claude 模型名（`deepseek-flash`）就是 `{"effort":"high"}`。产物、日志、事件流里**一个字都没提**，界面看起来像「这行选的档位没生效」——因为它确实没生效，而且没有任何提示。

**日期**：2026-10-17

**根因**：CLI 侧有一份**模型目录**。适配器传的 `options.effort` 一定被 SDK 拼成 `--effort <值>` 交给 CLI（`sdk.mjs` 的 argv 拼装：`if(this.options.effort) G.push(Be("--effort", …))`），但**是否写进请求体由 CLI 按模型条目决定**——目录里没有该模型的 effort 条目时**静默忽略**。两版 CLI（2.1.281 / 2.1.301）逐字同形 ⇒ 既有行为，不是升级回归。

`system/init` 的 `per_turn_effort_active` **不能**当判据：四条臂（含明确落地了 `output_config.effort` 的 opus 与非 Claude 臂）里它**恒为 `false`**，无反例。适配器与 SDK 两层都没有观测点——body 在 CLI 里，初始化帧那个布尔位又不反映它。

**解决方案**：**代码不修**（改了也验不了：没有观测点，写了就是猜）。口径写进[《Claude Code 接入》](/protocols/cc)的《effort 的落地由 CLI 的模型目录决定》：`reasoningEfforts` 声明的是**值域**，支持面按模型名而变。判据是**出站请求体的差分**（对照臂不传 `effort`，另跑 `claude-sonnet-4-5` / `opus-4-5` / 非 Claude 名三条，逐条读 `output_config` 在不在）。要证「网关真的按它算」只能抓**真网关**请求体 —— 本机假上游只能证明我们发出去的是什么。

**相关资料**：

- [《Claude Code 接入》](/protocols/cc) —— 《effort 的落地由 CLI 的模型目录决定》（登记点）

---

## `num_turns` 与本轮数出的轮次对不上（并行工具档 `3` vs `2`、结构化输出档 `2` vs `1`）

**现象**：`[WARN] cc 自报的 num_turns=3 与本轮按 assistant 消息数出的轮次=2 不一致；界面与本行快照以数出来的为准（一次模型 API 往返算一次）`——纯文本与单工具两档不亮，**并行工具**与**结构化输出**两档必亮。

**日期**：2026-10-17

**根因**：两把尺子不同刻度。我们数的是**去重后的 `assistant.message.id` 数**（一次模型往返一个 id，多次投递按同一个 id 去重）；厂商的 `num_turns` 至少混了两种成分。真机三档把四个量并排（CLI 2.1.301）：

| 臂 | assistant 帧数 | 去重 `message.id` | `message_start` 数 | `num_turns` |
|---|---|---|---|---|
| 纯文本 | 1 | 1 | 1 | 1 |
| 并行两工具 | **3** | 2 | 2 | **3** |
| 结构化输出 | 1 | 1 | 1 | **2** |

⇒ 并行档 `num_turns` **正好等于投递次数**（同一条 id 被投递两次也各算一次）；结构化输出档多出的那一次**仍未归因**（该档 `message_start` 只有 1 次，第二次模型往返根本没发生，厂商仍报 2）。

**多报那一档还有第二种成因**（真机臂：上游真收到 2 次请求、两条 `assistant` 帧的 `message.id` **相同**，产品侧 `turns = 1`）：本层按 `message.id` 去重计数，**两条不同往返撞同一个 id 时只算一轮**——网关 / 代理复用 id 属真实可能，而本层的去重键没有兜底。两种成因（厂商刻度 / 我们少算）从读数上分不开。

**解决方案**：判据取 **`reported !== state.turns`**（**两个方向都喊**，且只在第一条 `result` 上核对——`result` 在流式输入下是每一轮一条，从第 2 轮起两种刻度不可比）。多报那一档的文案点名第二种成因（「也可能是我们少算，请查上游是否复用 `message.id`」），少报那一档只管读数口径。读数仍以数出来的为准（两边同源）。守卫：`events.test.ts` 两条（少报 / 多报各一条，多报那条断言文案点名去重），变异验证把判据改成恒假即见红。

**相关资料**：

- [《Claude Code 接入》](/protocols/cc) —— 《数据与契约》的「轮次归属」那条

---

## `Permission to use Read has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools …`（评分阶段读 cwd 之外的执行过程记录时一次都没成功过）

**现象**：`read-only` 档（= `dontAsk` + `permissionPrompts: 'none'`）下，评审者按提示词去读「候选的执行过程」那两份绝对路径（`events.jsonl` / `messages.jsonl`，都落在行工作区之外），工具结果是**拒绝**：
```
Permission to use Read has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. …
```
`Bash{cat <同一个路径>}` 同样被拒。链路全绿（行照跑、照出分、零报错、零 WARN），丢的是**证据**：提示词要求「结合这些记录判定」，而记录一份都读不到。

**日期**：2026-10-17

**根因**：`Options.additionalDirectories`（CLI 的 `--add-dir`）**只接受目录**，而调用方（`judge-agent.ts`）把**文件路径**透传进 `extraReadPaths` ⇒ 适配器原样放进这一格，CLI 侧不产生任何可读范围。六臂差分（真 CLI 2.1.301 + 真 `provider.run`，同一份 cwd 之外的文件）：

| `extraReadPaths` 里放什么 | `Read <那份文件>` | `Bash{cat <那份文件>}` |
|---|---|---|
| （不给） | 拒绝 | 拒绝 |
| 文件路径 | **拒绝** | **拒绝** |
| 文件路径的 `realpath` | **拒绝** | — |
| **该文件的父目录** | **读到内容** | **读到内容** |
| 父目录的 `realpath` | 读到内容 | — |
| cwd 之内的文件（阳性对照） | 读到内容 | — |

⇒ 差异只在「目录 vs 文件」，与符号链接形态（macOS 的 `/var → /private/var`）无关。`sdk.d.ts` 的 JSDoc 逐字也是 *"Additional directories Claude can access beyond the current working directory"*。
**测试环境 ≠ 运行环境**：`index.test.ts` 原先钉的判据是「`extraReadPaths` 原样转发成 `additionalDirectories`」——转发这一半是真的，**生效**那一半只有真 CLI 会回答；假 SDK 只记录入参，于是这一格从未生效这件事在单测里完全看不见。

**解决方案**：`packages/server/agents/src/providers/cc/index.ts` 新增 `additionalDirectoriesFor(paths)`（目录项原样、文件项取 `dirname`、去重保序；`statSync` 取不到按文件项处置），`additionalDirectories` 那一格改用它，换算发生过就落一条 DEBUG（放行面比调用方写的宽一个目录，这件事不该只活在注释里）。守卫：`index.test.ts` 三条原判据改成父目录断言 + 新增换算单测（去重 / 目录原样 / 路径不存在）；**真机复采**：同一个探针（`.scratch/cc-audit3/probe/p5-extra-read-paths.test.ts`）修前那三条读不到（不给放行 + 两条文件项）、修后全部读到哨兵（这就是变异验证的另一半——探针在修前见过红）。精确到单个文件的另一条通道也已真机验过（`settings.permissions.allow: ["Read(//<绝对路径>)"]`，双斜杠前缀才认），但那档只覆盖 `Read` 工具、`Bash{cat}` 仍被拒，故本仓取换算父目录这条。

**相关资料**：

- [Configure permissions — Claude Code Docs](https://code.claude.com/docs/en/permissions)（权限规则与「额外目录」的官方口径）
- `sdk.d.ts` 的 `Options.additionalDirectories` JSDoc（安装态：`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.301_*/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）
- [《评分》](/features/judging) —— 智能体通路的「候选的执行过程」那一段
