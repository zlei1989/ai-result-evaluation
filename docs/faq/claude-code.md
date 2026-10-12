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
