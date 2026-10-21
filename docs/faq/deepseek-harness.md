# DeepSeek Harness 适配 FAQ

DeepSeek Harness（`@deepseek-ai/dsh-sdk-client`）在**真实运行环境**里踩过的坑。每条四格：现象做小标题、日期、根因、解决方案；有外部资料就补第五格。

规矩：现象用**日志/界面里的原文**做标题（改写过的描述搜不到）；只写已证实的根因；同一现象只留一条最新的，与事实冲突时改旧条目不新开。

---

## 追问 / 续接段的权限档被抹成「未暴露」，而实际档位没变（厂商把权限档当**会话属性**）

**日期**：2026-10-17

**现象**：同一进程里跑完首段再追问一段，环境信息抽屉上的「权限档」从 `danger-full-access` 变成「未暴露」（`vendor-system.permissionMode = null`）。原始通知直方图：首段有 `permission/preset` / `sandbox/mode` / `approval/policy` / `request/context` 各 1 条，**追问段一条都没有**——厂商只在会话首次启动投这些。而读侧（环境抽屉）取的是**最后一条** `vendor-system`，于是后到的那条 `null` 把首段采到的档位抹掉了。

**根因**：两层叠在一起。厂商把权限档当**会话属性**（`sandbox-policy.resolve()` = 请求里的 mode ?? 会话日志里最后一条 `sandbox/mode` ?? 进程默认），`permission/preset` 只在会话起手投一条，续接 / 追问段既不重投也不改；而适配器的 `runState.permissionPreset` 是**每 run 一份**（`events.ts` 的两条 `vendor-system` 出口都取 `?? null`）⇒ 续接段必然交 `null`。

⚠️ 同一机制还有一个**安全面**的推论（真机证实）：`read-only` + 续接同一条 `full` 会话，写文件**照样成功**（对照臂新会话被拒）——权限档由会话决定，env 里的 `DSH_PERMISSION_MODE` 对已存在会话无效。适配器为此落一条点名 WARN（续接 + 非 full + 观测不到档位），但**根治在编排层**（对「会话起手档 vs 本次 permission」加断言，不一致就别续接）。

**解决方案**：会话级记一份权限档（`noteDshSessionPermission`，与往返号那类按会话关联表同处），两条 `vendor-system` 出口在 `runState.permissionPreset` 缺席时用它兜底（跨进程拿不到就是 `null`，不猜）。

判据：`providers/dsh/events.test.ts` 的「续接段观测不到 permission/preset ⇒ 用同一会话早先那段记下的档位兜底（不是 null）」，变异验证：去掉会话级兜底 ⇒ 见红。真机复核（同进程两段追问）：首段 `["danger-full-access","danger-full-access"]`、续接段 `["danger-full-access"]`（修复前是 `[null]`）。

---

## 续接 / 追问段误报「装了技能却整轮没观测到目录」（厂商在同会话技能集没变时**故意不重发**）

**日期**：2026-10-17

**现象**：首段正常，追问段的运行日志里多一条 `[WARN] 本次运行装了 N 条技能，但整轮都没观测到厂商的技能目录…`，环境抽屉的「已下发的技能」跟着变成「未能核验」。

**根因**：厂商的 `agent/pre-step` 钩子先扫会话历史里那条 `skill-catalog`，摘要没变就直接 return（不重发）——技能目录在**同一会话的第二段**里本来就不会再来一条。那条 WARN 的判据只看「本段有没有看到目录」，于是把设计当成了异常。另一条加重因素：子会话自己的 `<available_skills>` 也会进同一条通知流，认了它会让「候选技能格」显示子会话的清单（同一形状时有时无）。

**解决方案**：WARN 的判据收窄到**会话起手那一段**（`resume === null`），并让技能目录只认**主会话**的消息（`dshSubagentIdOf(sessionId) === null`）。

判据：`providers/dsh/index.test.ts` 的「装了技能却整轮没观测到技能目录 ⇒ 一条点名 WARN；装了没观测到不是这一档就不出声」新增续接段一档（续接 + 装了技能 + 没目录 ⇒ **0 条**）。真机复核（同进程两段追问，装了 1 条技能）：首段与续接段的技能 WARN 都是 **0**（修复前续接段是 1）。

---

## 子智能体干到一半被连根拔掉：`subagent.finished` 一条都不来，子任务行永远停在「running」

**日期**：2026-10-17

**现象**：一次派了后台子智能体的运行里，父会话正常收工、行也 `ok:true`，但：

- 子会话的厂商日志最后是 `turn/end {"kind":"aborted","reason":{"kind":"parent"}}`（被父进程连带终止）；
- `subagent.finished` **一条都不来** ⇒ 子任务行永远停在 `status: "running"`、终态与 `stopReason` 缺失、子智能体那一份用量与轮次只到一半。

真机时间线（同一轮两个观测点）：

```text
 4946ms  run() 落定（父会话已收工）        ← 厂商门面只等**根会话** idle（SDK lib/index.js）
13607ms notify:session.event:turn/end  子会话
13624ms notify:subagent.finished
35836ms session/wait 返回 {"blockedMs":30890}   ← 等的是**整棵树**
```

⇒ 根会话 idle 与整棵树收工之间差了 8.6 秒，而适配器把「释放运行时」挂在 `run()` 的落定上。

**根因**：厂商的 `run()` 只等**根会话** idle；适配器据此释放运行时（`runtime.close()`），后台子智能体随之被终止。厂商其实提供了「等整棵子树」的原语 `session/wait`（服务端 `wait()` = `agent.whenIdle()` + `subagents.waitForChildren()` 循环到干净为止），但它**没有 SDK 门面**（只能 `client.request('session/wait', {sessionId})`），适配器此前一次都没用。

**解决方案**：**收流之前**（根会话落定、`break` 之前）补一次 `client.request('session/wait', { sessionId })`——位置很关键：分量与子任务终态是**收流之后 `finalize` 现算**的，等在释放那一步就改不了任何结果。四条口径：**只在这一轮确实还有子会话没收场时调**（`childSessions − finishedSessions` 非空）；上限 `DSH_SUBAGENT_DRAIN_MS = 60_000`；**已终止（`signal.aborted`）不等**（停机不能被一分钟的等待拖住）；等不到（到点 / 请求失败）⇒ **那些子会话按「事实缺失」交 `null` 并点名 WARN**，不按 0 计（运行一释放它们就被掐死，「还在跑、以后会报」是假话）。

判据：`providers/dsh/index.test.ts` 的「释放前等子智能体收场（session/wait）」三档（还有子会话在跑 ⇒ 恰好一次且带候选 `sessionId`；全部收场 ⇒ 一次都不调；已终止 ⇒ 不等；请求失败 ⇒ 分量 `null` + 点名 WARN + 结论不变），变异验证：把收流前那次等待去掉 ⇒ 三条都见红。真机复核（同一支 `fork` 场景）：修复前 `subagent.finished` **0 条** + 子任务行停在 `running` + 分量只有部分读数；修复后 **1 条** `subagent.finished`、`subagentTurns=3`、分量读全（等不到那一档的读数见上一条口径）。

**代价（口径已定）**：运行时长由最慢的后代决定——今天可能提前收工，补上就必须等；上限 60 s 与「终止不等」是这条口径的两道闸。

---

## 日志说「人工消息投递失败」而真相是**撤回失败**，撤回还白等满 5 秒预算

**日期**：2026-10-17

**现象**：插件的失败收据原来只有 `{phase:'failed', key, reason}` —— 投递失败（`agent.steer` 找不到 Agent）与撤回失败（`inbox.remove` 抛错）**同形**。于是：

- 两条 `failed/agent-not-found` 都打出「dsh 人工消息投递失败：这一条不会进模型的上下文」——撤回失败时这句话是**反话**（那一条可能已经进了上下文，只是撤不回来），排障被引到相反结论；
- 父进程拿到失败收据**不结算在飞的撤回** ⇒ 界面上「撤回中」白转满预算（真机口径 5000 ms）才按「未知」收场。

**根因**：收据缺一格「这一条在干什么」。插件在 `agent-not-found` 与 catch 两条失败出口上都知道当前是 `steer` 还是 `remove`，只是没写进收据；父进程的 `failed` 分支因此只能给一套笼统措辞，也没有可按动作结算撤回的判据。

**解决方案**：收据加 `action: 'steer' | 'remove' | null`（`inject.ts` 的插件源码三处失败出口）；父进程的 `failed` 分支按动作分岔——`remove` ⇒ **当场**把在飞的撤回结算成 `'unknown'` 并打「可能已经进了模型上下文」的 ERROR，`steer` / 认不出 ⇒ 照旧「不会进上下文」（认不出时取两条里更保守的一套措辞）。

判据：`providers/dsh/inject.test.ts` 的两条（「撤回失败的收据 ⇒ 在飞的撤回当场收场（未知），不是等到预算到点」用 300 ms 预算、判据是 <150 ms；「投递失败的收据不影响撤回，账本也不假装收到」），变异验证：把按动作结算那一支停掉 ⇒ 第一条回到 300 ms 并见红。真机复核：篡改场景（半行 / 伪 sessionId）产出的两条失败收据现在逐字带 `"action":"steer"`。

---

## 插件没被厂商加载：人工消息投不进模型 / 模型的问题到不了提问端口，而**适配器这一侧一个字都没有**

**日期**：2026-10-17

**现象**：`aieval-inject.mjs`（人工消息面）或 `aieval-ask-answerer.mjs`（提问应答面）因为自身抛错 / 语法错 / `ctx` 形状不符而没被厂商加载时：

- 人工消息面：投递流水写了**没人读**（`steered` / `removed` 收据永远不来）⇒ 人工消息永远不投，最坏一直等到编排层的超时（十分钟级）；
- 提问应答面：提问流水永远是空的 ⇒ 模型的问题落回厂商自己的等待档，人的答复交不回模型。

而**两边都没有任何信号**：适配器不读厂商的 stderr，正常收场时 SDK 的 `stderrTail` 也是 0 行；厂商那边只有 runtime stderr 里一行 `dsh: warning: N entries did not activate` 加一条详情。于是「功能没了」与「这一轮没人发消息」在界面上长得一模一样（受控真机：让插件在加载期抛错 ⇒ 进程照旧存活、运行照旧成功、只有那两座桥哑掉）。

**根因**：两座桥的「加载事实」只活在**插件自己写的第一行收据**里（`phase: 'plugin-loaded'`），而 inject 侧的 `pluginLoaded()` **生产代码里没有任何消费方**（`grep` 只有测试），ask 侧连这个读数都没有 ⇒ 收尾不检查，静默失效就没人说。

**解决方案**：给 ask 桥补 `pluginLoaded()`（读流水里那一行，不靠内存标志），收尾新增 `pluginWarns`——**配了哪个面就只报哪个面**、没有加载收据就落一条点名 WARN（说清「投不进模型 / 到不了提问端口」与厂商侧只有 `did not activate` 可查）。口径与其余几条同尺：**只说话、不改结论、不改观测格**。

判据：`providers/dsh/index.test.ts` 的「配了插件却整轮没有加载收据 ⇒ 一条点名 WARN；有收据则一条都不落」（两档：假 SDK 不加载插件 ⇒ 1 条 / 主动写一行真形状的收据 ⇒ 0 条），变异验证：停掉这条 WARN ⇒ 见红；真路径反向断言在 `injection-real-path.test.ts`（真厂商运行时加载正常 ⇒ 0 条）。真机正向复核（受控变异，**两座桥各做一遍**）：① 人工消息面——临时让 inject 插件在加载期抛错 ⇒ 真运行时 `pluginLoaded = null` + 恰好 1 条点名 WARN；② 应答面——临时让应答插件在加载期抛错 ⇒ 那一问**一次都没到提问端口**（答复批次 0）+ 恰好 1 条点名 WARN；两次的运行本身都照旧成功，还原后两份源码哈希逐字一致（`cddda474e86f3f10` / `8fb1798d04a96f63`）。

---

## 装了技能却整轮观测不到厂商的技能目录：界面显示「未能核验」而**行照跑照出分**（技能面的假绿）

**日期**：2026-10-17

**现象**：一行挂了技能，磁盘上 `<DSH_HOME>/skills/<名>/SKILL.md` 物化正确（sha256 与源逐条相等），但整轮的 `vendor-system.skills` 一格是 `null`（采不到）。界面上技能那一格读成「未能核验」，而**运行照常、评分照出**。真机读数（10 条臂）：7 条一次 `[]` 都没读到，其中 3 条磁盘上确实有技能、厂商一条都没认领。

**根因**：两层叠在一起。

1. 厂商**首次发布且这次会话里零条技能**时根本不投 `skill-catalog` 那条消息（`dsh-tool-skill`：`if (!history.published && skills.length === 0) …`）⇒「我们装进去的技能被厂商**全丢了**」与「厂商就是没投」在 wire 上是**同一格 `null`**；
2. 厂商对技能文件的 frontmatter 用**严格 YAML** 解析（`dsh-skill-filesystem`），解析不了的文件它**静默丢弃**——自己的那句 `skill file … ignored` 没有任何出口（cordis 的 `LoggerService.exporters` 是空 Map、SDK 的 `stderrTail` 正常收场时 0 行）⇒ 丢了也没人说。本仓的扫描器判据比它宽（候选级切分 + 只看 name/description），于是「界面显示合格 → 文件装上了 → 厂商一条不认 → 行照跑」这条链没有任何一处报警。

**解决方案**：`providers/dsh/index.ts` 收尾补一条**点名 WARN**（`skillCatalogWarns`）：这一轮装了 N 条技能（N>0）且整轮没观测到技能目录时落一条，说清「装了几条」「无法区分被丢与没投」「观测格因此是未能核验、这个候选不会因此失败」「要收口去看落点与 frontmatter」。

三条口径：**装了 0 条不出声**（那种情况下厂商不投是设计）；**只说话、不改观测格**（把 `null` 补成 `[]` 会把另两种厂商不投的情况——发现不完整、`skill` 工具没挂——误判成失败）；**点名到条数**。

判据：`providers/dsh/index.test.ts` 的「装了技能却整轮没观测到技能目录 ⇒ 一条点名 WARN；装了没观测到不是这一档就不出声」（三档：装了没目录 ⇒ 1 条 / 装了有目录 ⇒ 0 条 / 没装 ⇒ 0 条）。变异验证：把这条 WARN 停掉 ⇒ 见红。真机复核：坏 frontmatter（`description: [unclosed`，厂商严格 YAML 解析失败）⇒ 厂商日志 0 行 `<available_skills>`、适配器**恰好 1 条**点名 WARN；对照臂（合法技能）⇒ 厂商日志 1 行、**0 条** WARN。

**测试环境 ≠ 运行环境**：夹具里的技能场景永远只有「好技能」这一档（厂商会认领），所以「装了却被丢弃」这条通路在单测里没有数据流过。

---

## 模型自己传 `timeout: 5` 的那一档不生效：工具调用到结果拖了 8031 ms，交回的还是答案而不是 `{"pending":true}`

**日期**：2026-10-17

**现象**：提示词强制模型显式传 `timeout: 5`（厂商工具描述里那一档是「到点先继续干别的，用户稍后答复会作为 user message 回来」），人 8 秒后才答。真机三条读数：

```text
提问流水：{"phase":"request","key":"call_53f4…","wait":{"callId":"call_53f4…","timed":true},"hasSignal":true}
时间线  ：tool/call @2841ms → tool/result @10872ms（8031 ms > 模型要求的 5000 ms）
出站请求：tool_result = {"answers":[{"id":"q1","selected":["甲"],…}]}   ← 应该是 {"pending":true,…}
```

**根因**：厂商的到点收场是**协作式**的——`dsh-user-questions` 的 `TimedQuestionWait` 只 `abort` 一个 `AbortController`（随 `request.signal` 一起进 waterfall），真正让那一问收场的是应答者**对 signal 的检查**。本仓的应答者插件（`ask-user.ts` 的 `DSH_ASK_ANSWERER_PLUGIN_SOURCE`）同步认领、同步阻塞、**只等自己的 `DSH_ASK_ANSWERER_WAIT_MS`**，从不读 `request.signal` ⇒ 信号发出后没人读它，`await this.ask(...)` 一直挂在插件的返回上，厂商的 `ASK_TIMED_OUT` / `pending` 那一支永远走不到。缺省档（`mode: timed` + `timeout: -1`）因此看不出差别，只有**模型自己传正数**时才现形。

**解决方案**：插件在轮询里每拍检查一次 `request.signal.aborted`，到点立刻 `return next()`（委派）——厂商随即走它自己的定时收场。判据（真机 `R2-D`/`R2-B` 那支探针的 `askTimed` 场景，连跑三次取 `wait.timed:true` 的那次）：

```text
提问流水：{"phase":"delegate","key":"call_56d2…","reason":"vendor-signal-aborted"}
出站请求：tool_result = {"pending":true,"callId":"call_56d2…","message":"No answer batch arrived before the timeout. …"}
```

修复前同场景是 `phase:"answer"` + 答案批次（10872 ms）；修复后是 `phase:"delegate"` + 厂商的 `{pending:true}`（9357 ms，与模型要求的 5 s 同量级）。注释与文档同步（`ask-user.ts` 文件头的「本模块不设到点收场」改成「不自己设到点收场，但认厂商的 signal」；`docs/protocols/dsh.md`《等待预算》那一行）。

**测试环境 ≠ 运行环境**：这一格在单测里造不出来（要有厂商真的 abort 一个真 signal），只有真机把模型逼到显式传 `timeout` 才现形——而且**模型不是每次都传**（同一支探针三次里只有两次 `timed:true`，另一次 `wait` 里没有 `timed`，走的仍是阻塞档）。

---

## sidecar 流水落成 `0644`（人工消息正文 / 提问 / 人的答复对同机其他用户可读）

**日期**：2026-10-17

**现象**：`ls -l <configHome>` 里 `aieval-inject-queue.jsonl`、`aieval-inject-receipts.jsonl`、`aieval-stream-tap.jsonl` 都是 `-rw-r--r--`（0644 / umask 022），而代码里写着 `appendFileSync(..., { mode: 0o600 })`。

**根因**：`mode` **只在创建文件时生效**。而这些流水是父进程（`index.ts` 的三处 `writeFileSync(path, '', …)`）在 boot 之前先建好的空文件——插件那边的 `appendFileSync` 只是追加，权限早就定死在 0644 上了。于是「人工消息正文、模型提问、人的答复、模型输出的逐字转录」对同机其他用户可读，而那句 `mode: 0o600` 会让人以为已经收紧。

**解决方案**：三处 `writeFileSync` 各加 `mode: 0o600`（旁路文件、提问/答复流水、投递队列/收据）。判据：`providers/dsh/index.test.ts` 的两条权限断言（`statSync(...).mode & 0o777 === 0o600`）。变异验证：去掉 `mode` ⇒ 两条见红。真机复核：`ls -l` 五份文件全是 `-rw-------`（插件本体与四份流水）。

---

## 子智能体失败把整行判成失败（`ok:false / exitReason:'error'`，而父会话已正常答完、`finalText` 完好）

**日期**：2026-10-17

**现象**：只把**子会话**打挂（哨兵代理只对子会话的首个请求注入 HTTP 400）、父会话一切正常时，整个候选的结论是失败：

```text
result: { ok: false, exitReason: 'error',
          finalText: "The subagent I dispatched failed before finishing (it left no reply)…"  ← 父会话答完了
          error: { code: 'AGENT_FAILED',
                   message: '请求被上游拒绝（HTTP 400，…）：…[INVALID_REQUEST] 400 {…R2D 注入的 400（哨兵命中）}' } }
stack: at classifyAgentMessage (agents/src/errors.ts) ← at projectDshNotification (providers/dsh/events.ts 的 turn/end 失败那一支)
```

一次**成功**的运行因此不评分、还可能被自动重试（`AGENT_FAILED` 在重试表里），而界面上看到的错误与父会话的产出毫无关系。触发条件很常见：子智能体限流 / 超窗 / 鉴权失败。

**根因**：`finalText` 与 `failure` 两条出口的**会话闸不一致**。`assistant/message` 那一支有 `dshSubagentIdOf(sessionId) === null` 的闸（防的正是这类跨会话外溢，注释里写着「少了这道过滤，子智能体的话会顶掉候选答复」），而同一支的 `turn/end` 失败分支**没有**——子会话的 `turn/end(kind:'error')` 与主会话走同一条通知流、同样带 `reason.error`，于是它的失败被当成整行的失败。

**解决方案**：`providers/dsh/events.ts` 的 `turn/end` 失败分支补上同一道闸——`failure: dshSubagentIdOf(sessionId) === null ? classifyAgentMessage(...) : null`。子会话那一笔**照旧留证据**（`error` 草稿进事件日志，带厂商原文；子任务行的终态由 `subagent.finished{status,stopReason}` 那条通道给，不靠这一格）。

判据：`providers/dsh/events.test.ts` 的「子会话的 `turn/end(kind:error)` 只留证据、不判整候选失败；主会话的同样失败照旧判失败」（两个方向都钉）。变异验证：把那道闸去掉 ⇒ 见红；还原后逐字一致。真机复核：同一支哨兵代理（只打挂子会话首个请求，代理日志里 `inject=true` 只出现一次）修复前 `ok:false / exitReason:'error'`，修复后 **`ok:true / exitReason:'completed'`**、`finalText` 是父会话那句「子智能体出错没能回话」。

**测试环境 ≠ 运行环境**：夹具里的子会话从来只成功收场（`subagent` 场景的剧本），所以「子会话失败」这条通路在单测里没有任何数据流过——它是真机上子智能体被限流/超窗时才现形的。

---

## `[WARN] 用量负载读不动（缺 inputTokens / outputTokens）…：undefined`（厂商本来就没报用量）

**日期**：2026-10-17

**现象**：被 `interrupt_agent` 打断在模型流中间的那条 `assistant/message`（真机形状：`{turn, step, message, interrupted: true}`，**没有 `usage` 键**）会让适配器落一条

```text
[WARN] 用量负载读不动（缺 inputTokens / outputTokens），这一条按未采到处置、不计入合计：undefined
```

读起来像我们的解析崩了（文案里还带着字面量 `undefined`），而真相是**厂商没报这一格**。

**根因**：`events.ts` 的 `assistant/message` 分支无条件 `readTokens(data.usage, drafts)`，而 `usage` 键**允许缺席**（厂商类型面与真机都如此）；同一支的 `assistant/attempt` 分支本来就有 `!== null` 的闸，这一处漏了。

**解决方案**：改成 `const rawUsage = asRecord(data)?.usage; const tokens = rawUsage === undefined ? null : readTokens(rawUsage, drafts);`——**键缺席不读、也不落 WARN**；键在而形状不对（缺 `inputTokens` / `outputTokens`）才是真问题，那一条照旧 WARN。

判据：`providers/dsh/events.test.ts` 的「`assistant/message` 缺 usage 键 ⇒ 不落 WARN；键在而形状不对 ⇒ 照旧 WARN」。变异验证：改回无条件读 ⇒ 见红。真机证据：R2-D 的 `assistant/message.interrupted:true` 那条（`usage` 键缺席）。**连带**：一致性套件 `dsh` 的 `expectedEventCounts` 因此下调（`plain-reply` 4→3、`thinking-full` 7→5、`subagent` 10→9）——旧数里各含一条这样的误报 WARN。

---

## 失败的命令在界面上被画成成功（`job/settled.detail = "exit code: 7"` 而结果块 `isError=false`）

**日期**：2026-10-17

**现象**：真机跑一条必然失败的命令（`node -e "process.exit(7)"`），四处读数对不上：

```text
厂商 job/settled : {"callId":"call_d3a939…","detail":"exit code: 7"}
厂商 tool/result : {"callId":"call_d3a939…","isError":false,"tail":"(no output)\n[exit code: 7]"}
适配器结果块     : {callId:"call_d3a939…", isError:false}      ← 界面因此画成 status:'ok'
活动行           : 只有 `调用工具 bash：…`，没有任何「命令失败」
```

四家横向对照（同一句提示词、同一份供应商记录）：cc `is_error=true` + 「工具报错：Exit code 7」、codex `{"status":"failed","exitCode":7}` + 「工具报错：命令失败」、pi `isError=true` + `exit_code:7`——**只有 dsh 既不置 `isError` 也不播报**。

**根因**：厂商对 shell 类工具写的是 `message.isError: false` + 正文尾部的 `[exit code: N]`（`dsh-tool-bash` 的注释逐字：「Non-zero exits are reported, not errored」），而**结构化**的失败判据在同一次运行的 `job/settled` 上（`data.toolCall.callId` 与该次工具结果的 `message.toolCallId` **同值**）。厂商的 `processOutcome` 有**两种**收场，两种都要认：

```text
status: completed → detail: "exit code: N"          （失败当且仅当 N ≠ 0）
status: killed    → detail: "signal: SIGTERM"       （被信号杀掉，含超时 / job_kill / 运行时收工）
                  → detail: "killed before exit"    （连信号都没报出来）
```

适配器把 `job/*` 整类当成「未识别」落原始 JSON（这一条本身是有意的），于是那个数**读到了却没被用**；`tool/result` 的 `meta` 只投影 `{cwd}`（bash / pwsh 都如此），所以失败判据不在结构化结果里。

**解决方案**：`providers/dsh/events.ts` 新增 `job/settled` 分支——**只登记**（`jobFailures: Map<callId, boolean>`，两种收场都折算成「失败与否」），投影照旧走未识别兜底（口径不变）；`tool/result` 那条把登记的判据交给 `dshToolResultDraft`，结果块的 `isError = 厂商的 isError || 登记的失败`。

⚠️ **顺序不总是一样**：正常收场那条 `job/settled` 在 `tool/result` **之前**到（`job/registered → job/settled → tool/result`），而**被杀掉**的那一档在**之后**到（真机：`detail: "signal: SIGTERM; Test abort per instruction"`）。后者按登记值改判已经改不到交出去的那条 ⇒ 适配器把**已投影的那条结果重投一次**并改判成败（身份与块键都没变 ⇒ 合并是覆盖，不是新增载体）。
**播报口径与 codex 同尺**：只置块级 `isError`、**不给活动行加摘要**（真机 33 条命令里 6 条非零，多是 `grep` / 探测类命令的正常返回，播成「工具报错」是误导）。

判据：`providers/dsh/events.test.ts` 的六条守卫（`exit code: 7` ⇒ `isError=true` 且活动行无摘要 / `exit code: 0` ⇒ 不置 / **`signal: …` 与 `killed before exit` ⇒ 置** / **`job/settled` 晚到 ⇒ 重投并改判** / 没有 `job/settled` 的工具以厂商 `isError` 为准 / 判据按 `callId` 配对不牵连别的调用）。变异验证：把登记的判据改成恒 `null`、或只认 `exit code`、或去掉晚到重投 ⇒ 对应那几条各自见红。真机复核（探针 `ctrl-exitcode.mts` 与 `ctrl-killed.mts`）：`node -e "process.exit(7)"` 给出 `{isError: true}`；模型起长跑作业再 `job_kill` 的那条也给出 `isError: true`（修复前是 `false`）。

**测试环境 ≠ 运行环境**：夹具里 `tool/result` 的 `isError` 一直按厂商原值写（真机多数情形也对），而 `job/settled` 从来没进过任何用例 ⇒ 「退出码在另一条通知上」这条通路在单测里完全隐形。

**相关资料**：
- [《DeepSeek Harness 接入》](/protocols/dsh)——「工具非零退出」那一行边界
- 厂商工具描述（本地安装态）：`@deepseek-ai/dsh-tool-bash` 的 `lib/index.js`（「Non-zero exits are reported, not errored」）

---

## 候选快照上出现「合计 60 / 子分量 2010」（子智能体分量跨 run 累积）

**日期**：2026-10-17

**现象**：同一个 Node 进程里跑第二个 run（追问 / 续接同一个父会话，模型又让**同一个**子会话说话）时，「子智能体那一份」把**前一个 run** 的用量一起算了进来。确定性探针（假 SDK + 真适配器 + 真 `message.ts`，`R2-F-crossrun.mts`）：

```text
run1: subagentTokens={"input":2000,…} subagentTurns=2
run2（resume 同一会话、本轮子用量只有 10/1）: subagentTokens={"input":2010,…} subagentTurns=3
```

合计（`tokens` / `turns`）不受影响（`events.ts` 每 run 现算）⇒ 界面上会出现「合计 60 / 子分量 2010」这种自相矛盾的拆分。

**根因**：`message.ts` 的 `sessionUsage`（按会话的累计用量）与 `sessionRounds`（按会话的往返计数）都是**模块级、跨 run 不清**的（同一个进程里并行跑着好几行，模块级是刻意的；注释只登记了内存代价），而 `dshSubagentUsage` / `dshSubagentTurns` 按**本 run 的子会话白名单**求和 ⇒ 同一个子会话 id 在第二个 run 里被重新登记时，求和读到的是「历史 + 本轮」。

**解决方案**：给分量加**run 基线**——`index.ts` 的 `noteChildSession` 在**首次登记**某个子会话时记下它当时的累计用量与往返数（`childUsageBaseline` / `childTurnsBaseline`，只记一次），`dshSubagentUsage` / `dshSubagentTurns` 求和时减掉基线；「已收场却没报用量」的判据（`dshSilentChildSessions`）同步改成「**本 run 内**有没有新增」，否则上一轮的用量会让这一轮看起来「报过了」。

判据：`providers/dsh/index.test.ts` 的「同一个子会话 id 在第二个 run 里再登记 ⇒ 分量只算本 run 那一段」（跑两个 run，第二个 run 必须给 10/1 而不是 2010/3）。变异验证：把基线登记停用 ⇒ 该条见红（`expected 2010 to be 10`，正是真机症状）；还原后逐字一致。

**未闭合**：真机触发条件是「同一父会话的第二个 run 里，模型让**同一个** continuable 子会话再说话」（`resume` + `send_message` 那条路）——本轮没把模型逼到那一步，判据暂时只有确定性探针；验证方案：同一父会话跑第二个 run（`resume`）并让模型对**同一个** continuable 子会话再发一条消息，看第二个 run 的分量是不是只有本轮那一段。

---

## 对话视图里同一段答复出现两次、而第一段那条被顶掉（`roundTrip` 撞号：厂商的 `step` 是**每个 turn 内从 1 数**）

**日期**：2026-10-17

**现象**：一次「首轮 + 追问（或续接 / 结构化输出修正轮）」的运行，用产品自己的 `buildAgentLogModel` 折出来的对话视图里，**同一个逻辑消息出现两条、内容逐字相同**（修正后的 JSON 在第 1 轮与第 2 轮各一条），而第一轮那句被拒的答复在对话视图里**消失**（只剩执行日志里一条 `[stdout]`）。同一轮的用量行也会落到「与它同号的轮次之外」。

**根因**：`dshTurnAttribution` 原来直接拿厂商的 `data.step` 当往返号，而厂商的 `step` 是**每个 turn 内从 1 数**的。真机读数（会话日志与原始通知两处都是这个形状）：

```text
turn=1 step=1 → turn=1 step=2 → turn/end(turn=1)
turn=2 step=1 → turn=2 step=2 → turn/end(turn=2)
```

于是第二段的 `assistant/message`（带 `step`=1、2）被算成往返 **1、2**，与第一段**撞号**；而**不带 `step` 的出口**（stream-tap 增量、`turn/end`）走的是「该会话已观察到的 `step/start` 次数」⇒ **3、4**。同一条逻辑消息的增量与快照因此落进**两个载体**（合并键 `subagentId|roundTrip|role|parentCallId` 不同），界面上就画成两条，先到的那条随后被覆盖。

**解决方案**：`providers/dsh/message.ts` 的 `dshTurnAttribution` 改成「**按 `(turn, step)` 首次见到的顺序发号**」：

- 每个会话记一张 `"<turn>:<step>" → 往返号` 的表与一个 `highWater`（已分配出去的最大号）；
- 带 `(turn, step)` 的读数（`step/start` / `assistant/message` / `assistant/attempt`）拿**自己那个组合**的号：
  首次见到就发一个新号、再见到同一个组合就**返回原号**（重复投送、迟到、快照与增量各投影一遍都落回同一载体）；
- 新的组合只会拿到**更大**的号 ⇒ 跨 turn 不撞号，也不受「某几步的 `step/start` 厂商根本不投」影响；
- 不带 `(turn, step)` 的出口（`turn/end`、tap 增量）取 `highWater`（= 最后一次分配的号）。
- `count`（`step/start` 次数）是另一把尺子，只给轮次分量用（与 `turns` 合计数同一条驱动）。

判据：`providers/dsh/events.test.ts` 的三条守卫（「跨 turn 不撞号：两段各两步 ⇒ 1/2/3/4，且不带 `step` 的出口与最后一步同号」「漏了一条 `step/start` 也不撞号」「乱序/重复/迟到：同一个 `(turn, step)` 拿回同一个号，不同组合不撞号」）。变异验证：把发号改回按算式推（`round: step` 或 `count - 本turn步数 + step`）⇒ 见红；还原后逐字一致。真机复核（探针 `ctrl-turn-step.mts`，同一会话跑两段、每段两步）：修复前第二段的号是 `[3,1,1,4,4,…,2,4,4,3,4]`，修复后是 `[3,3,3,3,4,4,…]`（第一段 1、2 不再出现），四条消息各自只有一个载体。

**为什么不用「按算式推号」**：厂商的 `step` 是「每个 turn 内从 1 数」，任何把它折进一个单调号的算式都隐含「按 step 递增到达、且补出来的缺口永不再来」这两个前提；真机上乱序/重复投送一旦出现，号就会回退或撞号（同一条逻辑消息的增量与快照因此分进两个载体）。按「首次见到的组合」发号只保证唯一、单调、幂等——那正是合并键需要的三件事。

**测试环境 ≠ 运行环境**：既有用例全是**单个 turn** 的形状（每段只有 1~2 步且不跨 turn），撞号在那种形状下看不出来——只有真机上「一段跑完再跑一段」才会把两段的号并排放到同一个会话里。

**相关资料**：
- [《DeepSeek Harness 接入》](/protocols/dsh)——「通知外形」那一节写着 `step` 的口径
- [《消息规范》](/protocols/message-spec)——`roundTrip` 的定义（模型往返序号）与合并键

---

## `[MISSING_CREDENTIAL] llm-pi-ai: no credential for provider route "aieval-route"` / `[CONTEXT_WINDOW_EXCEEDED] pi-ai detected context overflow for model "…"` 被归成 `AGENT_FAILED`（可重试码 ⇒ 确定性失败白跑两遍）

**日期**：2026-10-17

**现象**：三种**配置类**失败在适配器侧拿到的都是 `errorCode: "AGENT_FAILED"`，而 `AGENT_FAILED` 在编排层的 `TRANSIENT_CANDIDATE_RETRY_CODES` 里（`ROW_RETRY.maxRetries = 2`、间隔 3 s、候选段失败整行重跑）：

```text
[cred:blank]          errorCode=AGENT_FAILED  [MISSING_CREDENTIAL] llm-pi-ai: no credential for provider route "aieval-route"…
[cred:newline]        errorCode=AGENT_FAILED  [INVALID_CREDENTIAL] llm-pi-ai: the API key resolved from AIEVAL_ROUTE_API_KEY contains characters no HTTP header can carry…
[cred:context-window] errorCode=AGENT_FAILED  [CONTEXT_WINDOW_EXCEEDED] pi-ai detected context overflow for model "jd/deepseek-v4-flash-0731"
```

三条都是**确定性**失败（同一份配置 / 同一份提示词再发一次结果逐字相同），重试只会白跑两遍（每次 3 s + 一整轮模型时间），而界面上的原因被说成「CLI 起不来 / 进程非零退出」。真机读数由本仓探针 `ctrl-cred-classify.mts` 给出：空 key 与「key 里带换行」都在 0.8 s 内失败（厂商一次内部重试都没做），超窗那条 5–6 s（`contextWindow` 给小 + 长提示词即可稳定复现）。

**根因**：厂商把失败原因放在**结构化的 `LlmFailure.code`** 上（`MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED` …），适配器把它以 `[CODE] 原文` 的前缀带进了归因文案，但归因那一层（`packages/server/agents/src/errors.ts` 的 `classifyAgentFailure`）**只认 HTTP 状态码**（401/403/429/400/404）与几句英文特征串 ⇒ 这三个码一路落到缺省的 `AGENT_FAILED`。对照：同样是「密钥不对」，另三家在 wire 上拿到的是 HTTP 401 ⇒ `AUTH_FAILED`（**不在**重试表里）——同一件事在 dsh 上换了码。

**解决方案**：`classifyAgentFailure` 在状态码分支之前认厂商的结构化码（只认我们自己加的那个方括号前缀 + 两句厂商特征串，别家的文案不会撞上）：

- `[MISSING_CREDENTIAL]` / `[INVALID_CREDENTIAL]`（或 `no credential for provider route` / `contains characters no HTTP header can carry`）⇒ `AUTH_FAILED`，文案沿用「密钥无效或无权访问（host）：请核对该供应商的密钥后重试」，编排层会再补一句「去哪儿改」；
- `[CONTEXT_WINDOW_EXCEEDED]`（或 `detected context overflow`）⇒ 新增的 `AGENT_CONTEXT_OVERFLOW`（`packages/server/agents/src/types.ts` 的 `AgentErrorCode`，**刻意不进** `TRANSIENT_CANDIDATE_RETRY_CODES`，与 `AGENT_SKILLS_UNAVAILABLE` 同一条理由）：文案点名 host 与补救动作「缩短提示词 / 减少随附内容 / 换窗口更大的模型；重试同一份请求不会成功」。

判据：`packages/server/agents/src/errors.test.ts` 的三条守卫（凭证码 ×2 档、超窗码、以及「没带厂商码时不误判」——普通 401 文案仍走状态码那一支）。变异验证：把两条新分支各停用一次 ⇒ 对应守卫见红；还原后逐字一致。真机复核（同一支探针）：三档分别拿到 `AUTH_FAILED` / `AUTH_FAILED` / `AGENT_CONTEXT_OVERFLOW`。

**测试环境 ≠ 运行环境**：单测里的失败文案都是我们**自己写的中文模板**，而这三个码只出现在**厂商原文**里 ⇒ 归因表在单测里从来没有机会见到它们；只有真网关配错 key / 超窗时才会现形。

**相关资料**：
- 厂商码来源（本地安装态）：`@deepseek-ai/dsh-llm` 的 `lib/index.js`（`MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED` 等常量）
- [《DeepSeek Harness 接入》](/protocols/dsh)——失败通道与归因那一节

---

## 适配器上报 `tokens={"input":640,"cached":18432,"output":165,"total":19237}`，而厂商自己的 token meter 是 `{"uncachedInputTokens":1014,"outputTokens":267,"cacheReadTokens":24320}`（被重试掉的那次尝试整条没算，且零 WARN）

**日期**：2026-10-17

**现象**：一次「先跑工具、再被上游 401 / 连接中断打断」的运行里，四个 LLM 请求、三个 `step/start`、三条 `assistant/message`，另有一条 `assistant/attempt` 与一对 `llm/retry` / `llm/retry-started`。适配器上报 `{"input":640,"cached":18432,"output":165,"total":19237}`（= 三条 `assistant/message` 的和），而**厂商自己**的 token meter（`<configHome>/storages/session_projcache/sessions/<id>.json` 的 `totals`）是 `{"uncachedInputTokens":1014,"outputTokens":267,"cacheReadTokens":24320}`——逐格差 `374 / 5888 / 102`，正好等于那条 `assistant/attempt` 的 `stream[]` 末条 usage chunk `{"inputTokens":374,"outputTokens":102,"totalTokens":6364,"cacheReadTokens":5888}`。界面上没有任何提示：`tokens` 有值、`WARN` 一条都没有。

**根因**：厂商对**一次尝试**只写两者之一（`@deepseek-ai/dsh-agent-loop` 的 `finish.kind === 'error' | 'aborted'` 走 `assistant/attempt`，正常收尾与「abort 但已有内容」走 `assistant/message`），而用量在 `assistant/attempt` 上**不在 `data.usage`**，在 `data.stream[]` 的最后一条 `{type:'chunk',chunk:{type:'usage',usage}}` 上（厂商 `dsh-token-meter` 的 `streamUsage` 正是这么读的，`deriveTurnTokenUsage` 两条都算）。适配器把 `assistant/attempt` 列进「已识别但零草稿」⇒ 那次尝试的用量一个字都没读。同一族的第二处：`llm/retry` 整条落进「未识别厂商负载」兜底（一条原始 JSON），于是「这一步为什么慢」在界面上没有解释。

**解决方案**：`providers/dsh/protocol.ts` 新增 `readAttemptUsage`（照抄厂商的取值顺序：从 `data.stream[]` 尾部往前找第一条 usage chunk）+ `DSH_ASSISTANT_ATTEMPT_TYPE` / `DSH_LLM_RETRY_TYPE`；`events.ts` 新增两支——`assistant/attempt` 按与 `assistant/message` **同一段**累计口径把用量记进行的（并交一次 `usage` 快照），`llm/retry` 落一条人话 `[WARN] 厂商重试（第 N/M 次，[CODE] 原因，X ms 后重发）`；`llm/retry-started` 进零草稿名单（信息全在配对上）。
判据：`providers/dsh/events.test.ts` 的「assistant/attempt 的用量进行的累计」「读不到 usage chunk ⇒ 什么都不记」「llm/retry 落一条人话 WARN」三条守卫（变异验证：两支各停用一次 ⇒ 见红）。真机复核（本机反代在首条请求上「等 `message_delta` 到齐 → 冲刷 → 断连接」造出真重试）：适配器 `{"input":6898,"cached":18432,"output":250,"total":25580}` 与厂商 meter `{"uncachedInputTokens":6898,"outputTokens":250,"cacheReadTokens":18432}` **逐格相等**，`WARN` 里出现那条重试原文。

**测试环境 ≠ 运行环境**：一致性夹具的剧本里没有「失败尝试」这一档（每次尝试都正常收尾），所以这条路径在单测里从来没有数据流过——它只在真网关真的重试过之后才现形。

**相关资料**：
- 取值来源（本地安装态）：`@deepseek-ai/dsh-token-meter` 的 `lib/types/turn-usage.js`（`streamUsage` / `deriveTurnTokenUsage`）、`@deepseek-ai/dsh-agent-loop` 的 `lib/index.js`（`assistant/attempt` 与 `assistant/message` 的互斥写入）
- [《DeepSeek Harness 接入》](/protocols/dsh)——「数据与契约」一节的逐消息用量那一条

---

## `assistant/message` 的 `content[]` 里工具调用块的键是 `["type","id","name","arguments"]`，而适配器读 `block.callId`（同一段文本在实时视图里渲染两次）

**日期**：2026-10-17

**现象**：真机一轮带工具的任务里，`assistant/message` 的 `content[]` 是 `["text","tool-call","text"]`，中间那块逐字是 `{"type":"tool-call","id":"call_ba1f832657b14e85ade228d3","name":"bash","arguments":"{…}"}`。适配器投影出来的快照只有**两个**块（`tool-call` 整块消失），其中第二段的块序号是 `1`；而同一轮的 stream-tap 旁路里，那段文本的增量带的是 `index: 2` ⇒ 同一段文字落在两个不同的载体里，实时视图把它渲染两遍（真机现场：重复的是空白块，表现为多一个空行）。

**根因**：**两条通道的字段名不同**——`assistant/message` 的内容块用 `id`（`@deepseek-ai/dsh-llm` 的 `ToolCallBlock{type,id,name,arguments}`），只有 `tool/call` 那条**事件**的 `data` 里才叫 `callId`。`message.ts` 的 `dshAssistantMessageDraft` 只读 `callId` ⇒ 读不到就 `continue`，块被丢掉。而块序号是按 `blocks.length` 分配的（含工具调用块），旁路的 `positionOf` 按「该次尝试里块的首见顺序」发号 ⇒ 被丢的块让两个位次空间整体错开一格。

**解决方案**：`providers/dsh/message.ts` 改成 `readString(block, 'callId') ?? readString(block, 'id')`（两条通道都认，`tool/call` 那条事件仍走 `callId`）。
判据：`providers/dsh/events.test.ts` 的「工具调用块按 `id` 读出来，且它占住内容位次」+「`tool/call` 事件那条通道仍读 `callId`」两条守卫（变异验证：改回只读 `callId` ⇒ 见红）。真机复核：新跑一轮带工具的任务，把厂商会话日志里那条 `content[]` 喂进真投影 ⇒ 三个块 `index 0 / call:call_… / index 2`，与旁路位次对齐。

**测试环境 ≠ 运行环境**：夹具里的 `assistant/message` 只有文本块（工具调用由 `tool/call` 事件单独喂），所以「内容里同时有文本与工具调用」这一形状在单测里从来没出现过——两个位次空间的错位因此一直不可见。

**相关资料**：
- 类型来源（本地安装态）：`@deepseek-ai/dsh-llm` 的 `lib/types/types.d.ts` 的 `ToolCallBlock`
- [《DeepSeek Harness 接入》](/protocols/dsh)——「流式增量旁路」一节的块位次换算

---

## `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：{"inputTokens":5949,"outputTokens":2,"totalTokens":5951}`（同一份探针两跑两样：一次 `tokens: null`、一次有值）

**日期**：2026-10-16

**现象**：同一条命令两次运行，dsh 的 anthropic 臂一次拿到 `tokens: null`、另一次 `{input:5438,cached:512,output:2,total:5952}`；openai 臂两次都有值。行上于是出现「这一轮一个 token 都没花」的读数，而同一行的执行日志里明明跑了一整轮。

**根因**：**厂商的用量字段是条件写入的，而适配器把它当成「缺项即未采到」**。

1. 厂商侧那一份读数在 `@deepseek-ai/dsh-llm-pi-ai` 的 `mapUsage()` 里生成：
   `inputTokens: usage.input` / `outputTokens: usage.output` 无条件写，
   而 `...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}`、`cacheWriteTokens` 同款
   ⇒ **字段缺席在语义上就是 0**（冷缓存的首条请求恰好是这个形状：`{"inputTokens":12601,"outputTokens":434,"totalTokens":13035}`，恒等式 `13035 = 12601 + 434` 也说明漏的是 0）。
2. 适配器原来要求三项齐备（`inputTokens` / `cacheReadTokens` / `outputTokens`），缺一即返回 `null` ⇒
   **同一条里的 input / output 一起作废**。真机产物上单条能差 65% 的非缓存输入
   （厂商侧真值 `{input:19234,cached:145920,output:3201}` vs 产品上报 `{input:6633,…}`）。
3. 更坏的是那句 WARN 的措辞：它说「**本次运行**按未采集计量处理」，而同一行照旧上报着另两格——
   排障会先怀疑「这一家不报用量」，而真相是「我们丢弃了同一条里能读到的两格」。

**解决方案**：读数规则改为「**两格必在、两格可缺**」（`providers/dsh/protocol.ts` 的 `readUsageTokens`）：
`inputTokens` / `outputTokens` 读不到才整条按未采到处置（WARN 措辞改成「缺 inputTokens / outputTokens，**这一条**按未采到处置」）；
`cacheReadTokens` 缺席按 **0** 计；`reasoningTokens` / `totalTokens` 仍是可选证据格（读不到就是 `null`）。
同一条读数被**候选级合计**（`events.ts`）与**消息级/子会话分量**（`message.ts` 的 `noteDshSessionUsage`）共用一份实现。
另修同一族的第二处：`totalTokens` 是**这一条自己**的合计（不是累计快照）⇒ 与三格一样**逐条相加**，
并按 `total = input + cached + cacheWrite + output` 校验，不成立就把 `total` 置 `null` + WARN
（宁可说不出总量，不给一个自己都解释不了的数）。
判据：`providers/dsh/events.test.ts` 的「缓存两格缺席 ⇒ 按 0 计」「usage.total 逐条相加（真机四条读数）」「恒等式不成立 ⇒ null」
三条守卫（变异验证：把 `cached` 缺席改回 `return null` ⇒ 见红；把求和改回覆盖 ⇒ 见红；去掉校验 ⇒ 见红）；
真机复核两条协议臂都拿到 `tokens ≠ null` 且 `input + cached + output === total`。

**测试环境 ≠ 运行环境**：一致性夹具里的 usage 三项永远齐全（它照真机**有缓存**那一条写），
所以「缺一项就整条作废」这条路径在单测里从来没有脸红过——只有在真网关的冷缓存首条请求上才现形。

**相关资料**：
- 读数来源（本地安装态）：`node_modules/.pnpm/@deepseek-ai+dsh-llm-pi-ai@0.2.1-alpha.3_*/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 的 `mapUsage`
- [《DeepSeek Harness 接入》](/protocols/dsh)——「数据与契约」一节记着这条字段语义

---

## `dsh：声明 streamingDelta=yes，但 plain-reply 场景里没有任何 delta 消息`

**日期**：2026-10-07

**现象**：新增智能体 SDK 一致性套件的「能力声明与产物互钉」组报出上面这句（红在 `providers/dsh/conformance.test.ts`）。同一条判据在 codex 与 claude 上都过。

**根因**：**这条通路上，厂商不把增量投送到我们能订阅的通道**。厂商侧确实有这个数据——LLM 层的流式协议里有 `text-delta`（`StreamChunk` 的一支），会话日志默认还会把连续同块增量压成 `text-chunks` 行——但**我们订阅到的通知流里没有它**：2026-10-07 真机探针（`probe/v2/dsh-chunk-shape.mjs` → 转储 `probe/dumps/v2/dsh-chunk-shape.jsonl`）跑完一次完整往返，共 **20 条通知**，正文只有**一条整块的 `assistant/message`**、增量类事件 **0 条**（事件类型全集：`permission/preset`、`sandbox/mode`、`approval/policy`、`agent/inbox/spliced`、`session.status`、`turn/start`、`step/start`、`system/message`、`user/message`、`request/header`、`request/context`、`session/title`、`session-log-deepseek/delivery-accepted`、`assistant/message`、`step/end`、`turn/end`）。适配器只认整块 `assistant/message`（`message.ts` 全文件 `delta` 零命中）本身没错；错的是**声明写着 `streamingDelta: 'yes'` + `source: 'wire'`**，即「说这条通道拿得到」。

**⚠️ 这条最值钱的教训：文档说的层 ≠ 我们能拿到的层**。我们最初照文档把它判成 `off-by-adapter`（厂商有、我们没接），实跑把它推翻了——文档描述的是 **LLM 层**与**会话日志层**，我们消费的是 **SDK 订阅到的通知层**，两者不是同一个通道。**凡「厂商有没有」的判定，落到「我们能不能拿到」上才算数**；只查文档最多得出「某层有」。

**解决方案**：结论分两层。
**通知层**：这条通道（stdio 的 `session.event`）确实**永远不投送增量**——上游 jsonrpc-server 只订阅 `session/event` / `agent/status` / `session/created` / `subagent/end` / `agent/error` 五个进程内事件，`agent/assistant-stream` 不在其中（任何版本都不在）。
**能力层**：适配器**换了一层拿**——`stream-tap` 把一个零依赖插件写进每个候选配置目录（overlay `insert`，相对名按 `dshHome` 解析），插件订阅厂商**进程内**的 `agent/assistant-stream`，把四类 chunk 追加写到 `<configHome>/aieval-stream-tap.jsonl`，父进程 tail 后包成 `aieval/delta` 伪通知 ⇒ `messageCapability` 现在是 `streamingDelta: 'yes'` + `streamingDeltaSource: 'hook'`（`providers/dsh/index.ts` 的 `messageCapability`，机制与边界见 [《DeepSeek Harness 接入》](/protocols/dsh) 的「流式增量旁路」）。
判据：真机旁路文件里有 `text-delta` 帧、界面上打字机动（探针 `probe/v3/dsh-tap-truncation.mjs` 的落点对照：写在 `profiles/sdk/` 里插件**从来没被加载过**，会打 `dsh: warning: 1 entry did not activate`）；能力声明与产物互钉在 `providers/dsh/conformance.test.ts`。
⚠️ 这一格是 `'hook'` 而**不是** `'wire'`：谁把 `streamingDeltaSource` 改回 `wire`，就等于说「通知流里能拿到」——那是这条 FAQ 已经推翻过一次的结论。

**相关资料**：
- [dsh 官方 `llm-streaming.md`：`StreamChunk` 的完整定义（含 `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end`）](https://github.com/deepseek-ai/deepseek-harness/blob/25d959aa085865f9d889e3a663ce018669258207/docs/core-data-structures/llm-streaming.md)
- [会话日志存储格式（中文手册）：`text-chunks` 等 packed row 展开成 `assistant/chunk` 的 `text-delta`](https://github.com/sandbaseai/deepseek-harness-handbook/blob/main/docs/zh-CN/reference/session-log-storage-format.md)

---

## `AssertionError: expected false to be true // Object.is equality`（`providers/dsh/index.test.ts` 的 overlay 绝对路径那条）＋仓库根长出 `D:\runs\run-1\rows\r-1\workspace`

**日期**：2026-10-09

**现象**：macOS 上跑测试，两件事同时发生：

1. `FAIL  |@aieval/agents| src/providers/dsh/index.test.ts > dshProvider > 注入落点：路由键 + 绝对路径的 overlay + **自定义变量名**带凭据；DSH_HOME/HOME 都指向该候选目录`，报
   `AssertionError: expected false to be true // Object.is equality`（`expect(isAbsolute(patches?.[0] ?? '')).toBe(true)` 那一行）；
2. 仓库根（进程 cwd）冒出 Windows 名字的目录：`D:\runs\run-1\rows\r-1\workspace`（api 夹具 `makeRow().workspacePath` 的原值）、`D:\runs/run-1/candidates/r-1`（`rowWorkspaceDir('D:\runs', …)` 拼出的混合分隔符树），以及 `D:/tmp/candidates/row-1/.agenthome/aieval-route.patch.yml`。

**根因**：**夹具把「磁盘地址」写成了盘符字面量，而盘符路径在 POSIX 上不是绝对路径**（`isAbsolute('D:/tmp/x') === false`），于是它按**相对 cwd** 解析，产物落进进程 cwd。

- `packages/server/agents/src/testing/agent-fixtures.ts` 的 `createRunInput` 默认 `cwd: 'D:/tmp/candidates/row-1/workspace'`、`configHome: 'D:/tmp/candidates/row-1/.agenthome'`；dsh 适配器**真的**会 `mkdirSync(input.configHome)` 并在其下写 overlay（`providers/dsh/index.ts`）⇒ `D:/tmp/…/.agenthome/aieval-route.patch.yml` 落在仓库根。
- 同一条路径还撞上 dsh 的既有不变量：`patches` 必须是绝对路径（SDK 用 `resolve(callerCwd, path)` 解析，callerCwd 是宿主进程的 cwd），故 `isAbsolute` 那行红。
- 同一类缺陷在 api 侧：`packages/server/api/src/testing/run-fixtures.ts` 的 `makeRow().workspacePath` / `makeRun().workspaceBase` 是 `D:\runs…`，而 `run-artifacts.test.ts`（`seedRun(..., { createWorkspace: true })`）与 `messages-stream.test.ts`（`resetRecords(...)`）拿它们直接 `mkdirSync` —— `D:\runs` 那棵树就是这么来的。

**这是测试环境差异，不是厂商行为**：同一份夹具在 Windows 上既绿又不脏（盘符路径确实是绝对路径），只在 POSIX 上既红又脏。凡是「夹具里的路径字段会被产品代码拼进真实文件路径」的地方，都必须按当前平台拼。

**解决方案**：两个夹具各取一棵**当前平台的真临时树**（`mkdtempSync(join(tmpdir(), …))`；vitest 按文件隔离模块图 ⇒ 每个测试文件一棵，互不串台），并在夹具模块里用 `afterAll` 回收（模块级钩子在**收集期**注册到当前测试文件的根套件，已实测有效，避免让十几个消费文件各写一遍清理）：

- `agent-fixtures.ts` 导出 `FIXTURE_CWD` / `FIXTURE_CONFIG_HOME`，`createRunInput` 的默认值改引它们；三家适配器用例里断言默认地址的 10 处（claude 3、codex 1、dsh 6）改为引用常量。
- `run-fixtures.ts` 导出 `fixtureWorkspaceRoot()`，`makeRow().workspacePath = rowWorkspaceDir(FIXTURE_WORKSPACE_ROOT, 'run-1', 'r-1')`、`makeRun().workspaceBase = FIXTURE_WORKSPACE_ROOT`。
- 夹具里的 `repoPath`（`D:\projects\gateway`）**刻意保留盘符形状**：用例的 git 操作要么被 mock、要么指向自建的临时仓库，它只走运输链，不碰盘。

判据（守卫 + 变异验证）：新增 `agent-fixtures.test.ts` 与 `run-fixtures.test.ts` 的「夹具里的磁盘地址按当前平台拼」两条，断言 `isAbsolute()` + 落在 `tmpdir()` 下 + 不在 `process.cwd()` 下（刻意不问「等于某个常量」——常量本身就是缺陷现场）。三个变异体都见过红：① `makeRun().workspaceBase` 改回 `'D:\\runs'` → api 守卫红；② 夹具根改成相对路径 `'aieval-run-fixtures'` → api 守卫红在 `isAbsolute` 那条；③ `configHome` 改回 `'D:/tmp/candidates/row-1/.agenthome'` → agents 守卫红 **且** dsh 那条 overlay 不变量同时红，仓库根重新长出 `D:/tmp/…/aieval-route.patch.yml`（缺陷可复现）。还原后两份夹具的 sha256 与变异前逐字一致。

**相关资料**：
- [Node.js `path.isAbsolute()`：POSIX 与 Windows 的「绝对路径」判定不同（盘符路径在 POSIX 上是普通相对路径）](https://nodejs.org/api/path.html#pathisabsolutepath)
- [Node.js `fs.mkdtempSync()`：推荐的临时目录 API（本仓口径：能用现成 API 就别手写递归删除）](https://nodejs.org/api/fs.html#fsmkdtempsyncprefix-options)

## 同一条脚本两次运行的事件条数差一条（`24 / 24 / 25 / 25`：收尾那条 `usage` 与 run 落定抢跑）

**日期**：2026-10-13

**现象**：dsh 的真路径一致性场景（真运行时 + 本机假 `/v1/messages` 上游 + 应答者插件）连跑四次，**同一臂**产出的事件条数是 `24 / 24 / 25 / 25`，多出来的那一条是**收尾处**的计量事件，载荷与上一条逐字相同（`seq` 与时刻除外）：

```json
{"type":"usage","turns":2,"tokensBasis":"reported","tokens":null,"subagentTokens":{"input":0,"cached":0,"output":0,"reasoningOutput":null,"total":null},"subagentTurns":0,"turn":{"round":2,"subagentId":null}}
```

上行文里还有一条 `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：{"inputTokens":12,"outputTokens":4,"totalTokens":16}` —— 它与这条竞态**无关**（把上游 SSE 的用量字段补全，警告照旧、条数照旧抖）。

同一次非确定性打的是**两处判据**，不止条数那一格。第二个面在套件的《交互面（提问）声明与产物互钉》：那一格按**两臂指纹**逐字比（`providers/conformance/ask-user.ts` 的 `checkDigestsUnchanged`），而「带回调 / 不传回调」两臂是**两次独立运行**——各自多不多那条重复的 `usage` 是掷骰子 ⇒ 两串指纹不同，红在这句原文上：

```text
dsh/ask-user：不传回调的对照运行产物与带回调那次不同——「不问就不动」不成立（两臂各自把 ask_user_question 归一到同一形态之后再比）
带回调：<指纹>
没传回调：<指纹>
```

两处红都**不是**「适配器少交付了东西」：那一问本身两条判据都过（端口真被问过、答复真回到厂商），差的只是收尾那条**重复读数**在不在。

**根因**：`packages/server/agents/src/providers/dsh/index.ts` 的通知投送循环「先排空再判结束」在 `run` 落定与**在飞的** `next()` 之间没有屏障。

1. `harness.run(...)` 的 promise 落定时把 `settled` 置真；而收尾那条通知可能是在那之后才被读循环 `push()` 进订阅的。
2. 循环那一拍的顺序可能是「`subscription.tryNext()` 拿到 `undefined` ⇒ `settled` 已真 ⇒ `break`」，于是**最后一条通知永远读不到**。它常常是厂商在 `turn/end` 上再交一次的那份累计计量（`events.ts` 的 `DSH_TURN_END_TYPE` 一支刻意「把最新的一份带上」，最后一版的用量与轮次都靠它）。
3. 谁先谁后由进程调度决定 ⇒ 同一份脚本两次运行的事件条数会抖。

**补两格更硬的事实**（都是后来量到的，改这条的修法之前先读）：

- **丢的机制是「值已经取到手、却没人读」**，不只是「还没到」。SDK 的 `next()` 是**先 `queue.shift()` 再交给等待者**，而循环把它与 `runPromise` / tap 拍竞速：竞速输掉的那一轮**没人读这个值**，那条通知就此消失（`pendingNext ??=` 只防住「孤儿等待者吃掉后续通知」，防不住这一格）。失败通道**只有** `turn/end` 一条 ⇒ 丢掉的那条若是 `kind:'error'`，一个失败轮会被判成 `completed`：**真机命中过一次**（`deliveredNotifications: 25, receivedNotifications: 24, sawTurnEnd: false`，同一轮 `exitReason: 'completed'`），假件把它做成确定性形状（批头换成 `turn/end(kind:'error')` ⇒ `ok:true` / `exitReason:'completed'`）。
- **「两臂投送条数不同」的机制已查明：不是厂商重复投送，是同一条通知按订阅各投一份**。给 SDK 的订阅实现打一层计数补丁（`NotificationSubscriptionImpl.push`）后真机读数：一次运行**恰好两个订阅、各 19 条**（`run()` 自己那条先建、拿第一份；适配器那条拿第二份），同一逻辑事件两份之间的间隔是 **1–38 µs**。`dispatchNotification` 对每个订阅各 `push` 一次，而每个订阅的队列/等待者互不相干 ⇒ **适配器不会双计**（真机两轮 `turns=1`、分量和 = `total`、与厂商逐条之和逐字段相等）。
  两个推论：① 「投送侧丢帧」与「两臂条数天生不同」这两个解释都可以划掉——差异来自**有几条订阅**，而 `session.status: idle` 那条会让 `run()` 的循环先退出、适配器那一条可能还剩几条尾随通知在队列里（实测 `tryNext` 排空得到 20 条，其中 1 条是 `run` 落定之后到的）；② 收尾那条被竞速丢掉的可达性**仍未观测**（两次真机都没出现，`stalled` WARN 一次没打）。

**测试环境 ≠ 运行环境**：夹具的假订阅是**同步投递**（`run` 落定之前所有通知都已入队）⇒ 这条竞态在单测里造不出来。与《原始输出 38164 行，但执行日志是空的》那条孤儿 promise 的教训同源：替身比真实实现「更整齐」，守卫就没有区分力。

**解决方案**（两层都已在适配器与夹具里闭合）：

- **适配器层**：`providers/dsh/index.ts` 的通知投送循环把等待者交出来的那条值**留存**下来（`inHand`），每次迭代先消费它；`settled` 之后再加一道**零墙钟**的收尾栅栏——等一个 `setTimeout(…, 0)` 宏任务拍子，让已经 settle 的等待者把值写进 `inHand`，取到就继续投影、取不到才 `break`。
  两条一起才盖住全部形状：队列里还有别的通知时靠「迭代开头消费 `inHand`」；队列已空、值还在微任务链上时靠那道栅栏。
  与更早那两条尝试的区别（它们各自被放弃的原因）：**不等任何墙钟、也不按到达序消费尾随通知**——只有「在 break 之前已经被交到等待者手里」的那一条会被投影，`run()` 落定之后才入队的尾随通知照旧丢掉，因此两臂指纹不因此变抖。
  守卫：`providers/dsh/index.test.ts` 的「dsh 收尾竞速」三条（批头是 `turn/end(kind:'error')` ⇒ 必须 `ok:false`、退出原因是 `error`；批头是普通通知 ⇒ 用量与轮次照常；`run()` 拒绝收场 ⇒ 先排空队列再抛真因）。夹具侧为此加了 `settleBatch`（最后 N 条通知与 `idle`、`run()` 落定同拍投送），因为默认的同步吐完永远踩不到这条竞速。变异验证：把「迭代开头消费 `inHand`」与收尾栅栏一起停用 ⇒ 三条守卫见红。
  真机复核：`S3-errloop` 形状的 30 次「第 2 步 401」运行，0 次误判成功、0 次错码。
- **夹具层**：真路径驱动器在收口产物时把「与上一条逐字相同（`seq` 与时刻除外）」的 `usage` 事件折成一条（`packages/server/agents/src/testing/dsh-real-path-fixture.ts` 的 `foldRepeatedUsage`），于是那一格判据拿到的是确定条数（套件里以 `expectedEventCounts` 钉住），两臂指纹才有可比性。
- **同一族的另一半（已落地）**：终止 / 看门狗收尾时不再误报「通知流中断…执行日志因此不完整」（`diagnoseStreamEnd` 的 `closed` 一档）——那条假诊断本身就在给同一批指纹添噪声。

**残留边界**：`run()` 落定之后才入队的尾随通知仍然不投影（那一段没有「已交付给谁」的判据，拉长等待就是上面被否掉的第二条尝试）。它只影响收尾后是否多一条重复读数，不影响任何结论。

**判红的处置口径**：条数那一格与两臂指纹那一格红都先**孤立重跑该文件**（`pnpm vitest run packages/server/agents/src/providers/dsh/conformance.test.ts`）——孤立重跑那一组即 `24 / 24` 绿 ⇒ 那一次红是这条竞态；孤立**仍红**才算回归（才去查适配器或夹具）。整目录并发跑（`pnpm vitest run packages/server/agents/src/providers/dsh`）会显著放大它：机器带负载时这条竞态的红**不算回归**，先看 `tests` 累积项与孤立重跑。

---

## `原始输出 38164 行，但执行日志是空的`（dsh 行：厂商会话日志 201 条事件，我们只收到前 13 条）

**日期**：2026-10-10（首次观测 2026-10-09）

**根因**：**适配器自己把 `subscription.next()` 的 promise 遗弃成了孤儿**，于是 SDK 把后续每一条通知都交给了没人等的等待者。

1. 消费循环每 `DSH_STREAM_TAP_POLL_MS`（100 ms）被 `tapWake` 唤醒一次，并把它与 `subscription.next()` **竞速**（`Promise.race`）。每一轮都**新建**一个 `next()`，竞速输给 `tapWake` 之后那份 promise 没人再 await，**但它仍挂在 SDK 的等待者队列里**。
2. SDK 的 `NotificationSubscriptionImpl.push()` 是 `const waiter = this.state.waiters.shift(); … waiter.resolve(notification)` —— **先到先得**（最老的等待者拿这一条）。于是此后每条通知都落到那个**孤儿**上（resolve 后丢弃），真正在等的那一个永远拿不到。孤儿数随静默时长线性增长 ⇒「握手之后彻底静默」是必然，不是偶发。
3. 结果：`messages.jsonl` 为 0、执行日志整段空白、`streamingDelta` 为 `{0,0}`，而**行照旧判成功**（diff 与评分都是真的）。真机运行 `7f05c765` 的 dsh 行连续三次都是这个形状。

**量级与判据**（真机一次 + 本机复现一次，数字逐字相同）：客户端**投递并接受 181 条**（含 18 条 `assistant/message`、tool call/result 各 52 条），我们的生成器只 `yield` **15 条**（全在前 50 ms 内——那批是先入队、被 `tryNext()` 取走的），之后 137 秒一条不剩且**零报错**。

- 探针 `probe/v3/dsh-tap-truncation.mjs`：同一 SDK / 运行时 / overlay / 权限 / **真题面 + 真工作区副本**，变体 A–E **全部收齐内容** ⇒ 上游与数据格式无罪。
- 回放：厂商会话日志的 191 条事件喂真实投影 ⇒ **127 条消息、185 条草稿、零抛错** ⇒ 投影层无罪。
- 本机复现（真网关 + 真题面 + 真工作区副本直接跑 `dshProvider.run`）：修前 `事件 16 / 消息 0`，修后 **`事件 175 / 消息 78`**；埋点从 `delivered 181 / yield 15` 变成 **`delivered 136 / yield 136`（1:1）+ `sawTurnEnd: true`**。

**为什么此前所有守卫都绿**：① 夹具的假订阅**只留一个 `waiter`**（新的 `next()` 直接覆盖旧的），真实实现是**等待者数组 + `shift()`** ⇒ 孤儿这条路径在夹具层根本不存在；② 夹具默认同步 / 2 ms 投递，永远抢在 100 ms 轮询拍之前，连「竞速输一次」都造不出来。**测试环境 ≠ 运行环境**在这里就是这两点：替身比真实实现弱，守卫就没有区分力。

**解决方案**：`packages/server/agents/src/providers/dsh/index.ts` 把在飞的 promise **记忆化复用**（`pendingNext ??= …`，settle 后才允许再建一个）。夹具补两处保真度：`waiters` 改数组 + `shift()`（与真实同序）、新增 `emitIntervalMs` 旋钮。回归守卫：`dsh/index.test.ts` 的「投递间隔 150ms > tap 轮询拍 100ms：三条通知一条都不许丢」，判据取**最后一条** `assistant/message` 带出的 `tokens`。**变异验证**：把记忆化改回「每轮新建」⇒ 守卫红（`expected null to deeply equal { input: 218, … }`），还原后哈希 `326a644fff9a0499861f7b0cc7452555a4b2d4af5096c602ef5425c1d0786f3b` 逐字一致、129 条复绿。

**顺带定位并修掉的第二个缺陷**：tap 插件落点错了——overlay 里 `name: "./aieval-stream-tap.mjs"` 由运行时按 **`dshHome`** 解析，而适配器写在 `profiles/sdk/` ⇒ 每次运行 stderr 只有 `dsh: warning: 1 entry did not activate` + `aieval-stream-tap (file:///<dshHome>/aieval-stream-tap.mjs): failed to import`，**插件从未加载**、旁路文件恒 0 字节、能力位声称 `streamingDelta: yes` 而界面一条增量都没有。改 `DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH` 为 `'aieval-stream-tap.mjs'` 后探针实证：stderr 干净、**旁路文件 0 → 720 字节**。

**方法论留档**：这一条最初被误判为「订阅在中途静默失败」（并据此加了 `aieval/stream-failure` 伪事件与「静默停滞」判据）。那些改动无害（只在真断流时出现），但当时的原因文案把矛头指向了厂商——**判据必须能分开「客户端投递了几条」与「我们消费了几条」**，这一格是最后才补上的，也是本次排障耗时最久的地方。`diagnoseStreamEnd` 现在同时报告两个数并直接指出断点在哪一侧。

**相关资料**：

- SDK 源码（本地安装态）：`node_modules/.pnpm/@deepseek-ai+dsh-sdk-client@0.2.1-alpha.3_*/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js` 的 `NotificationSubscriptionImpl.push/next`
- 探针（可复跑）：`packages/server/agents/probe/v3/dsh-tap-truncation.mjs`
- [《DeepSeek Harness 接入》](/protocols/dsh) —— 已知边界与取舍里同一条

---

## `TransportClosedError dsh profile "sdk": JSON-RPC input closed`（真因被外层错误吞掉：`overlay …/profiles/sdk/cordis.patch.yml must be a top-level YAML array of loader patch entries`）

**日期**：2026-10-14

**根因**：机制层——`DSH_HOME` 下的 `profiles/sdk/cordis.patch.yml` 被 dsh 的 boot 当**overlay** 读，而它要求**顶层是 YAML 数组**。写这份 patch 的辅助函数在"这次一个插件行都不挂"时会产出一个**只剩一行注释**的文件：注释解析出 `null`，`!Array.isArray(null)` 成立 ⇒ boot 在 `dsh-app-boot/lib/index.js` 的 `parsePatchList` 当场抛。**真正难查的不是这条错，而是它被外层吞了**：SDK 只把 `TransportClosedError … JSON-RPC input closed` 抛给调用方，`stderr tail` 才带着那句 `Error: dsh: overlay … must be a top-level YAML array of loader patch entries`——不看 `stderr tail` 就会往"运行时没起来/凭据不对/网络不通"的方向查。

**解决方案**：**不挂插件时干脆不写这份文件**（文件不存在就不产生 overlay）。落点：`packages/server/agents/probe/v11/dsh-session-resume.mjs`（它不需要任何插件行，故整段跳过 `writeProfilePatch`）；需要挂插件的探针照旧走 `probe/v2/lib/dsh.mjs` 的 `writeProfilePatch`（那条路径永远至少有一行 `insert:`，所以不会踩）。判据：改前 boot 立即失败、两半都报同一条 `TransportClosedError`；改后 `write` 半边的通知条数由 0 变 20、`finalResponse` 拿到 `记住了`。

---

## `session "probe-resume-…" already exists`（换一个新进程、用同一个 `sessionId` 与同一个 `DSH_HOME` 续接；`run` / `session().run` / `client.prompt` 三条形状全抛它）

**日期**：2026-10-14

**根因**：机制层，**两层，第二层是版本门**：

1. dsh 的会话**是持久化的**（`@deepseek-ai/dsh-session-persistence` 的 `SessionPersistence` 抽象类同时有 `create` / **`open(id, access)`** / `stat` / `list`，`open` 还带 `read` 非所有权与 `write` 单写者租约），所以"恢复一条已存在的会话"在架构上是设计过的；**但 wire 上的 `session/prompt` 那条路永远走 `create`**（`dsh-sdk-jsonrpc-server` 的 `getOrCreateSession` 只查实例私有的 `sessions = new Map()`，miss 就无条件 `agents.create`），不先 `stat` 再决定 create 还是 open ⇒ 同一个 id 再用一次必然撞 `SessionAlreadyExistsError`（该错误类的注释逐字：*"**`create` targeted a Session identity that already exists in this backend.**"*）。`DeepSeekHarness.run` 就是 `this.session(sessionId).run(...)`，而 `session(id)` 本身**一个字节的 wire 流量都没有**（`api.d.ts` 逐字 *"Open a session handle (**no wire traffic**; the runtime creates the session on its first prompt)"*）⇒ 所谓"三条形状"其实只有两条独立路径，都落在 `session/prompt` 上。
2. **这条 wire 上有没有"认领"入口，是版本差**：`session/resume` 自 **`@deepseek-ai/dsh-sdk-jsonrpc-server@0.2.1-alpha.3`** 起才是官方 wire 方法（协议类型 `'session/resume': { params: SessionResumeParams; result: Record<string, never> }`，注释逐字 *"Restore a persisted session without enqueueing a prompt."*）。`0.2.0-rc.2` 与 `0.2.1-alpha.1` / `-alpha.2` **根本没有这个名字** ⇒ 在那三版上这个候选名的读数是 `-32603 unknown DeepSeek Harness SDK runtime method: session/resume`（那三版的派发只有一个字面量 `switch`，能发的名字一共三个：`initialize` / `session/prompt` / `shutdown`）。**所以正确说法是"装到哪一版"的问题，不是"SDK 这条 wire 一律不支持 resume"。** ⚠️ 顺带一条事实更正：`0.2.1-alpha.3` 上 **`latest` 并不是 `0.2.0-rc.2`**——`@deepseek-ai/dsh-sdk-client` / `-sdk-jsonrpc-server` / `-sdk-protocol` 三个包的 `latest` 指的是远古的 `0.0.1-rc.*`，`0.2.0-rc.2` 是它们的 **`next`**（只有 `@deepseek-ai/dsh` 本体的 `latest` 才是 `0.2.0-rc.2`）；`0.2.1-alpha.3` 是四个包的 `alpha`。

**这是上游已知问题，不是我们的用法错**：`deepseek-ai/deepseek-harness` 的 Discussion #4954 标题逐字写着 *"session/prompt always creates and hits "id collision""*（Python SDK 侧同一症状，见 #4591）；上游最终选的是**加一条显式方法**（`session/resume`），而**不是**把 `session/prompt` 改成 create-or-adopt —— 判据：`0.2.1-alpha.3` 上"同一个已存 id 直接 `session/prompt`"**仍然**回 `session "…" already exists`（真机读数）。CLI 侧的 `--resume <id>` / `--continue` 至今还是一张 feature request（#167）。

**解决方案**：三条路按代价排；**路线 A 是本仓的落地做法**（探针 `packages/server/agents/probe/v11/dsh-session-resume-alpha3.mjs`，读数 `probe/dumps/v11/dsh-session-resume-alpha3-reading.json`）：

1. **路线 A（零自研，推荐）：把客户端升到 `@deepseek-ai/dsh-sdk-client@0.2.1-alpha.3`，用官方 `session/resume`。** 真机跑通的最小调用序：
   ```text
   initialize                                  （HarnessClient.start() 里的握手）
   session/resume  { sessionId }               （返回 {}，失败会抛）
   session/prompt  { sessionId, contentBlocks }（照旧走 rec.handle.agent.followup(...) ⇒ 运行中注入那一格不受影响）
   ```
   高层门面就是 `DeepSeekHarness.resumeSession(id)` → `HarnessSession.run(...)`（前两条都在 `resumeSession` 里）。三条围栏的真机读数：未知 id ⇒ `-32603 session "<id>" not found`（**不是**静默新建一个空会话）；同一进程重复 resume ⇒ `-32603 SDK session is already open or opening: <id>`（⇒ **adopt 必须在该 id 的第一条 `prompt` 之前**）；换一个空的 `DSH_HOME` ⇒ 同一个 `not found`（⇒ resume 读的确实是那个 home 下的持久化记录）。**两处与 headless 那条路不同**：① 这条 wire 上**没有 cwd 比对闸**（换 cwd 不报错，`getWorkingDirectory()` 回的是**记录里的** cwd）；② resume 之后通知流**不回放**历史（见下面两条新条目）。
2. **路线 B（不回退 pin 时的备选，未实测）**：在 `--patch` overlay 里 `- id: sdk-jsonrpc-server` + `disabled: true`，再 `insert` 自己的 server 插件（`HarnessSdkJsonRpcServer` 是被导出的，只覆写 `createSession`：先 `ctx.agents.resume`，仅在 `SessionPersistenceNotFoundError` 时回落 `super.createSession`）。代价是把厂商那约 300 行接过来维护。
3. **路线 C（已真机证过的备选）**：`dsh --profile headless --session-id <id> "<task>"`（`sessionQuery.observeSession(id)` → `agents.resume({ resumeSessionId })`，带 cwd 比对等围栏）。代价是**丢中途注入**——`--json` 只在 step 提交时给 `text`（没有逐 token 增量）且一次调用只接一条 task。
4. **另一条同名 wire 不归我们发**：`@deepseek-ai/dsh-api-session-controller#session/create` 文档逐字 *"Explicit-id `session.create` **adopts a live Session or resumes a persisted Session** while retaining its writer lock"*（`dsh-api-session-controller/README.md:38`），但它挂在 web / GUI 那条 Typert remote 上（HTTP + WebSocket `/api/remote.mux`，见 `dsh-api-gateway/README.md`），本机 `dsh-sdk-client` 打不到。

**判据**：路线 A 的判据是上面那支探针——判据一（机制）：`--role=wire` 的 14 个候选名里 `session/resume` **不再**回 `unknown … method`，原文变成 `session/resume requires a non-empty sessionId string`（判据是"派发器认不认得这个名字"，不是"成功/失败"）；判据二（端到端）：新进程 + 同 `DSH_HOME` + 同 cwd 的 `resume` 答出随机暗号（连问两次都答出），阴性对照（不 resume）答「不知道」，四条围栏全部按预期被拒。路线 C 的判据是 `packages/server/agents/probe/v11/dsh-headless-resume.mjs`（读数 `probe/dumps/v11/dsh-headless-resume-reading.json`）。

**升版本这一格已闭合**：两处 pin（`packages/server/agents/package.json` 与 `apps/web-next/package.json`）都在 `0.2.1-alpha.3`，lockfile 是 `@deepseek-ai/*` 版本族的整体上移（cordis 也从 `4.0.4` 走到 `4.0.5-alpha.2`，见《连带影响》）。

**它不能靠一次全量重解析完成**：改 `@aieval/agents` 的 dsh specifier 会让 pnpm 把该 importer 的**全部**依赖重新解析，于是与 dsh 无关的 peer 也被换掉（`@anthropic-ai/claude-agent-sdk` 的 peer `@anthropic-ai/sdk@0.124.0`→`0.129.0`、`undici` `8.10.2`→`8.11.2`、vitest 的 vite peer 多出 `esbuild`）——那正是仓规点名禁止的漂移。做法是**以旧 lockfile 为基、只把 dsh 族换成新版键**：

- **dsh 族** = 名字以 `@deepseek-ai/` 开头的键 ∪ 从 `@deepseek-ai/dsh-sdk-client@*` 在 snapshots 图上**正向可达**的键。⚠️ 图的边要含**键自身的 peer 后缀**（`pkg@1.0.0(zod@4.4.3)`）——这一家的包之间大量靠 peer 连接，只走 `dependencies:` 会把它们判成「族外」并在合并时丢掉（`zod` / `node-addon-*` / `@deepseek-ai/cosmokit` 都这样被漏过）。
- **同时被非 dsh 引用到的 dsh 键保留旧版**（`@anthropic-ai/sdk@0.124.0` 之于 claude-agent-sdk 的 peer 就是），并且要把它在**旧图里的依赖闭包**一起保留（保留集不闭包化会留下悬空引用：`zod-to-json-schema@…(zod@4.6.5)` 即此例）。
- 判据三条：**无新增悬空引用**、**非 dsh 族的 packages / snapshots 块与旧 lockfile 逐字相同**、**importers 段里 dsh 那两格之外的每个候选逐字不变**；最后由 `pnpm install --frozen-lockfile` 判定 lockfile 自洽。

**相关资料**：

- [deepseek-ai/deepseek-harness Discussion #4954 — Python SDK cannot resume a persisted session after restart（`session/prompt` always creates and hits "id collision"）](https://github.com/deepseek-ai/deepseek-harness/discussions/4954)
- [Discussion #4591 — [BUG] Python SDK 当 session ID 存在时无法 resume 对话](https://github.com/deepseek-ai/deepseek-harness/discussions/4591)
- [Discussion #167 — [Feature Request] `--resume <id>` / `--continue` 延续会话上下文](https://github.com/deepseek-ai/deepseek-harness/discussions/167)

---

## `JsonRpcResponseError [-32603]` 同时是「方法不认识」与「业务失败」（`unknown DeepSeek Harness SDK runtime method: session/open` 与 `session "…" already exists` 的 code 逐字相同）

**日期**：2026-10-14

**现象**：同一档 wire 探针里，五种互不相干的失败拿到的 `code` **逐字相同**，只有 `message` 不同：

```text
JsonRpcResponseError [-32603] unknown DeepSeek Harness SDK runtime method: session/open
JsonRpcResponseError [-32603] session/resume requires a non-empty sessionId string
JsonRpcResponseError [-32603] session "session-…" already exists
JsonRpcResponseError [-32603] session "probe-unknown-…" not found
JsonRpcResponseError [-32603] SDK session is already open or opening: session-…
```

**根因**：机制层，落点在**协议层不在业务层**。`@deepseek-ai/dsh-sdk-protocol/lib/index.js:31` 逐字 *"failures return `-32603`. Notifications without a handler are dropped."*，同一文件 `:210` 是 `this.writeError(id, -32603, error instanceof Error ? error.message : String(error))` ⇒ **runtime 侧任何被抛出的错误都折成同一个 `-32603`**，JSON-RPC 的保留码（`-32601 method not found` / `-32602 invalid params`）一个都不用；`JsonRpcResponseError` 再把 `code` 与 `message` 原样透给调用方。于是"派发器根本不认识这个名字"与"这条会话已经存在"在 `code` 上长得一模一样。

**解决方案**：判据一律落在 **`message` 原文**（或它的原文标记）上，不落在 `code` 上。两处落点：

- 探针 `packages/server/agents/probe/v11/dsh-session-resume-alpha3.mjs` 的 `--role=wire` 档：`recognized` 一格判的是 `message.includes('unknown DeepSeek Harness SDK runtime method')`，不是 `code !== -32603`。判据（把这一格改回按 `code` 判）：14 个候选名会被**全判成"认得"**（含 `session/open` 这种真不存在的），这一格立刻失效。
- 适配器侧的错误映射同理：`already exists`（该走 adopt）/ `not found`（该走 create）/ `already open or opening`（adopt 发得太晚）三支只能按 `message` 分派。

**这一族版本的形状（接线与后续升级要知道的五条）**：

1. **是版本族整体上移，不是"新增一个依赖"**。`@deepseek-ai/dsh-sdk-client@0.2.1-alpha.3` 的闭包里，`@deepseek-ai/*` 有 **278 个包同名不同版**（全部 `0.2.0-rc.2 → 0.2.1-alpha.3`），`cordis` 一条线整体从 `4.0.4` 走到 `4.0.5-alpha.2`（`cordis` / `cordis-plugin-group` / `-include` / `-loader` / `-timer`，外加 `cosmokit` / `schemastery`），另有 **22 个包是 alpha.3 才有的**（`dsh-api-remote-access`、`dsh-client-ui-secret-mask`、一批 `dsh-experimental-*`、`dsh-tool-schedule` / `-session-query` / `-terminal` / `-working-directory`、`dsh-working-directory`、`dsh-harness-dev-context` …）、**8 个是 rc.2 才有而 alpha.3 没有的**（`dsh-invariants`、`dsh-hook-protocol`、`dsh-hooks-claude-code` / `-codex`、`dsh-subagent-in-process-driver`、`dsh-webhook` / `-github`、`dsh-experimental-schedule-bundle`）。⇒ 仓规那条"手改清单 + 只把**新增的**条目并进旧 lockfile（判据：`git diff --stat pnpm-lock.yaml` 是 0 deletions）"**是为"加一个新依赖"写的，在升这一族版本时不成立**：既有 snapshot 的版本后缀必须逐条换掉。两处 pin 要一起改（`packages/server/agents/package.json` 与 `apps/web-next/package.json`，后者也直接钉着这个包）。
2. **客户端 API 只加不改**：`rc.2 → alpha.3` 的 `lib/types/*.d.ts` 逐文件 diff 只有**新增**——`DeepSeekHarness.resumeSession(sessionId)`、`HarnessSession.getWorkingDirectory()` / `setWorkingDirectory(path)`、`HarnessClient.resumeSession` / `getWorkingDirectory` / `setWorkingDirectory`、新导出 `validatedSessionEvent`；`types.d.ts`（构造选项与 `RunResult`）与 `launch.d.ts` **零 diff**，默认值也逐字未变（provider `deepseek-official`、model `deepseek-v4-flash`、`initializeTimeoutMs` 10000）。⇒ 本仓那份窄壳（`packages/server/agents/src/providers/dsh/sdk.ts`）在升这一族版本时**一个字都不用改**，新能力从窄壳里"长出来"即可（`resumeSession` 是新增格，不声明就够不到）。
3. **`latest` 这个 tag 会把人带偏**：`@deepseek-ai/dsh-sdk-client` / `-sdk-jsonrpc-server` / `-sdk-protocol` 的 `latest` 指的是远古的 `0.0.1-rc.1` / `0.0.1-rc.5` / `0.0.1-rc.1`，`0.2.0-rc.2` 是它们的 **`next`**，`0.2.1-alpha.3` 是它们的 **`alpha`**；只有 `@deepseek-ai/dsh` 本体的 `latest` 才是 `0.2.0-rc.2`。照 `latest` 去核"有没有新版本"会得出相反结论，要按 `next` 与 `alpha` 两个 tag 分别看。
4. **`allowBuilds` 不为这一族加条目**：alpha.3 相对 rc.2 新增的那 22 个包**一个 install / postinstall 脚本都没有**，而 `pnpm-workspace.yaml` 的 `allowBuilds` 已经放行了 `@deepseek-ai/dsh-subprocess-local`（`postinstall: node scripts/ensure-spawn-helper.mjs`，给 node-pty 的预编译 helper 补可执行位）与 `koffi` / `node-pty` / `protobufjs` / `sharp` / `unrs-resolver` / `esbuild`。旁证：仓库外那个临时目录走 `npm i` 时这 5 个脚本被 `allow-scripts` 拦下没跑，真机工具调用**照样正常**（`tool/call` + `tool/result` 都到，`echo` 的 stdout 原文回传）。
5. **本仓那两处装配面都在**（真机各跑一轮）：① **适配器形状的 overlay** —— 照 `buildDshRoutePatch` 写 `- id: llm-pi-ai` 定向覆盖（`config.providers.<route>.{api,baseURL,apiKeyEnv,models[].{contextWindow,maxTokens,reasoningEfforts}}`）+ `insert` 厂商提问工具（`config: { mode: "timed", timeout: 1 }`）与一个本地 `./*.mjs` 插件行，boot 通过、跑完一轮（20 条通知、`finalResponse` 是模型答复）——alpha.3 的 `dsh-base` 里那一行的 id 仍是 `llm-pi-ai`、`dsh-llm-pi-ai` 的 `Config` 仍是 `providers` 那一格；② **跨版本续接** —— 用 rc.2 建的会话（盘上 `session.v4.jsonl.zstd`）可以用 alpha.3 的 `session/resume` 接上且答出暗号 ⇒ **盘上用 rc.2 建的旧行会话不会作废**（会话格式仍是 v4），升级不需要迁移会话。

---

## `session/resume` 之后订阅到的通知流里没有上一轮的事实（`nonceInNotifications=true` 只因为模型在 `assistant/message` 里把暗号复述了一遍）

**日期**：2026-10-14

**现象**：新进程 `resumeSession(id)` → `session.run(...)` 落定后，投影那一栏**12 条全是本轮事件**——`agent/inbox/spliced` / `session.status` / `turn/start` / `step/start` / `user/message` / `request/header` / `session-log-deepseek/delivery-accepted` / `assistant/message` / `step/end` / `turn/end` / `session.status`——上一轮的 `user/message` **一条都没有**；而"通知流里含暗号 = true"只因为 `assistant/message` 里是模型答出的暗号。

**根因**：机制层——`session/resume` 做的是"**按 id 把持久化记录开成这个进程的写者**"（`dsh-sdk-jsonrpc-server` 的 `resume` → `openSession(id, true)` → `ctx.agents.resume({ resumeSessionId })` → `persistence.open(id, 'write')`），它**不重放事件**；SDK 的 `subscribeSessionTree(sessionId)` 只推**本进程从订阅那一刻起**新产生的事件。上一轮的事实落在两处磁盘产物上：`$DSH_HOME/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd`（厂商转录）与 `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`（投影缓存；里面 `identity.cwd` 是那条会话的 cwd、`titleInput.first.text` 是首个提示词、`rows.inbox` 是两档待投队列）。⇒ **"通知流里没有上一轮的话"不是恢复失败的证据**（会假红）；反过来"通知流里有话"也可能只是模型自己复述的（会假绿）。

**解决方案**：恢复判据取**两条独立**的，与探针的两格一一对应：

- **模型答复**：随机暗号回读，**且必须配阴性对照**（同 `DSH_HOME`、同 cwd、但不 resume 的那一次必须答不出）——否则"答对了"可能只是工作区或别处泄漏。单次回读不作唯一判据（模型会抖）：正面档在同一会话里**连问两次**。
- **磁盘转录**：`packages/server/agents/probe/v11/lib/dsh-session-log.mjs` 读那份 `session.v4.jsonl.zstd`。同一次两进程真机读数：`write` 之后 **19 条记录 / 3 条 `user/message`**，`resume` 里连问两次之后 **39 条 / 5 条**，而 header 的 `id` / `createdAt` / `cwd` 逐字未变 ⇒ resume 接着**同一份转录**往下写。

落点：`probe/v11/dsh-session-resume-alpha3.mjs` 把 `projection`（通知流）与 `nonceInAnswer`（答复）分成两格记，文件头写明第一格**不构成**恢复证据。

---

## `session/resume` 换一个 cwd 不报错：`getWorkingDirectory()` 回的是**记录里的**那个 cwd（headless 那支的 cwd 围栏在这条 wire 上不存在）

**日期**：2026-10-14

**现象**：同 id、同 `DSH_HOME`，用 `new DeepSeekHarness({ cwd: cwd2, processCwd: cwd2 })` 起进程后 `resumeSession(id)` **成功**（无错误、无 WARN），`session.getWorkingDirectory()` 返回的是**第一次创建会话时的 cwd**，不是启动参数给的 `cwd2`。

**根因**：机制层——`dsh-sdk-jsonrpc-server` 的 `createSession(sessionId, resume)` 里，`resume` 那一支是 `ctx.agents.resume({ resumeSessionId, agentOptions })`，**不带 `meta: { cwd }`**（只有 `create` 那一支带 `meta: { cwd: this.cwd }`）⇒ 会话的 cwd 只来自持久化 header 里的记录（投影缓存里 `identity.cwd` 逐字就是它），启动参数里的 `cwd` / `processCwd` 在这条路上**不参与**。对照 headless 那条路：`dsh --profile headless --session-id` 会显式比对记录的 cwd 并拒绝不符的——**那边是真闸，SDK wire 上没有那道闸**。

**解决方案**：接续接线时不要指望"resume 会按新 cwd 拒绝"：① 要拿会话的有效工作目录就调 `getWorkingDirectory()`（它在目录已被删时按 Session origin 恢复）；② 要钉"这个候选的会话没串行"就用候选快照里的 `sessionId` + `agentKind` 校验，**不要拿 cwd 当判据**（它在 resume 这条路上不构成隔离面）。落点：`probe/v11/dsh-session-resume-alpha3.mjs` 的 `--role=fence-cwd-mismatch` 档（读数：拒绝原文为空、`WORKDIR` 是记录里的那个）。

---

## 读 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd` 只解出 1 行（Node 的 `zstdDecompressSync` 只解**第一帧**，而日志是**拼接的多帧**）

**日期**：2026-10-14

**根因**：机制层——dsh 的会话日志不是"一个 zstd 流"，而是**每批 append 一个独立 zstd 帧、首尾相接**。真实样本（一个只有一轮问答的会话）：11 KB 的文件里有 **7 个**帧魔数 `28 b5 2f fd`（偏移 0 / 187 / 334 / 700 / 10072 / 10246 / 10395），逐帧解得 32378 字节 / 19 行；而 `zlib.zstdDecompressSync(buffer)` 只返回**第一帧**的 213 字节（就是那条 session header）⇒ **不报错、不抛异常**，症状只是"这份日志只有 1 行"，看起来像"这个会话什么都没记"。同一目录下的 0 字节 `session.lock` 是写者租约文件，不是日志。路径形状也容易猜错：不是 `<root>/<id>.jsonl`，而是 `<root>/<projectKey>/<encodeSegment(id)>/session.v4.jsonl.zstd`（`projectKey` 把分隔符折叠成 `-` 并包 `--…--`，见 `dsh-session-persistence-jsonl/lib/index.js:875`；`encodeSegment` 在 `:853`）。

**解决方案**：按魔数切帧、逐帧解。落点 `packages/server/agents/probe/v11/lib/dsh-session-log.mjs`（导出 `readSessionLog(path)` 与 `sessionLogPath({home,cwd,sessionId})`，也可直接 `node …/dsh-session-log.mjs <日志路径>` 打直方图）。判据：同一份真实日志，`zstdDecompressSync(整份)` 得 1 行 / 213 字节；`readSessionLog` 得 `frames: 7 / bytes: 32378 / records: 19`，`records[0]` 是 `{type:"session",version:4,id,createdAt,cwd,isSeeded,delegationDepth}`（无 `seq`），其余是 `{type,seq,time,data,surfaceOp?}`；`sessionLogPath` 算出的路径与磁盘上真实存在的路径逐字相同。**未闭合**：切帧靠扫魔数，理论上会在压缩载荷里误命中一个 `28 b5 2f fd`；更稳的做法是走厂商自己的 zstd 解码模块（`dsh-session-persistence-jsonl` 的私有面，我们没引）。

## 进程内插件在加载那一刻拿不到 `ctx.agents`（`ctx.get('agents')` 与 `ctx.agents` 都是空，几步之后同一个取法就有值）

**日期**：2026-10-15

**现象**：写一支插件（overlay `insert` 一行、落 `<DSH_HOME>` 根）想从 runtime 进程内 `agent.steer` / `agent.inbox.remove` 接出人工消息面。插件的加载收据里如实写着 `serviceAtLoad: false`：`ctx.get('agents')` 返回 undefined、`ctx.agents` 也取不到 ⇒ 投递那一步回 `agent-not-found`，**插件本身加载成功、一句报错都没有**，而同一份代码在动作那一刻（收到投递流水之后）用同一个取法就拿到了服务。

**根因**：**加载顺序**——`agents` 服务由另一行插件（`@deepseek-ai/dsh-agent` 的 `AgentRegistry`，`super(ctx, "agents")`）provide，而 profile 的装配清单里那一行**不保证排在我们这个候选之前**；Cordis 的服务表在插件 `apply()` 跑起来的那一刻可能还没有它。**在加载那一刻把服务缓存进闭包**（一个很自然的写法）等于把"这个候选排在哪"变成功能能不能用的前提——症状是"插件在、功能全废、零报错"。

**解决方案**：**每次用时现取**，别在加载时缓存。落点 `providers/dsh/inject.ts` 的 `agentService()`：先试 `ctx.get('agents')`（服务表通用入口），再退到 `ctx.agents` 属性式访问，两条都包在 try 里；`plugin-loaded` 收据里的读数改名 `serviceAtLoad`（**它是事实、不是判据**），判据取每条动作收据（`steered` / `removed`）里的 `hasAgents`。判据：真路径驱动器 `providers/dsh/injection-real-path.test.ts`（真运行时 + 本机假上游 + 产品的插件）三条全过——`'round'` 档的哨兵进**下一次 step** 的入站请求体、`'idle'` 档进**下一轮**、撤回那一条一次都没进；把缓存写回加载那一刻，这一组当场红（`hasAgents: false`）。

**相关资料**：`@deepseek-ai/cordis` 的 `Context.get(name, strict)`（`lib/types/reflect.d.ts`：「Read a service from the store **without the inject requirement**」）与 `Plugin.Base.inject`（「Services the plugin requires; it only loads while all are available」）——插件若声明 `inject`，服务不齐时**整支插件都不激活**，那会把"服务晚到"变成"插件不存在"，比现取更难查。


---

## 「dsh subagent 启动以后还是没有展示查看 subagent 执行日志的入口」（子智能体在跑，界面上没有卡片、也没有入口）

**日期**：2026-10-15

**现象**：dsh 行派发子智能体后，执行日志时间轴上**没有**子任务卡片、也没有「进入 ▸」入口；子智能体其实已经在跑（它的消息在界面上一条都没有落点）。产物一侧的形状（真机 `messages.jsonl` 逐行序）：派发工具的 `tool/call`（`call_e5a30b14cfb942759bac5121`）→ 第一条 `subagent` 记录 `{"subagentId":"eb24414b-…","name":null,"kind":null,"source":"wire","status":"running","parentCallId":null}` → 第二条（目录项到达后）`{"…","name":"检查 Vue 3 hello world 页面","kind":"one-shot","parentCallId":"call_e5a30b14cfb942759bac5121"}`。**第一条是修之前的全部**——它既没有名字也指不出派发点。

**根因**：**派发行在派发那一刻是「无名无主」的，而界面靠「名字」或「派发调用 id」二选一才能把它挂到某一轮上**。这一家两条都不给：厂商的 `subagent.started` 载荷只有 `{parentSessionId, childSessionId}`（真机；SDK 的 `recordSessionRelationship` 也只读这两个 sessionId），任务名（`label`）在**另一条**消息 `subagent/catalog` 里，`subagent` 工具调用的 `callId` 是另一种形状。**补记（2026-10-18，同一个入口的第二个名字）**：厂商把同一个派发插件（`@deepseek-ai/dsh-tool-subagent`）按 `dsh-base/cordis.patch.yml` 挂**两次**——`{provider: 'spawn', toolName: 'subagent'}` 与 `{provider: 'fork', toolName: 'subagent_fork'}`——两者都派子智能体、都投 `subagent.started` / `subagent/catalog`。而适配器记「这次派发在飞」时只认 `subagent` 一个名字 ⇒ **`subagent_fork` 那条路**的派发行永远拿不到 `parentCallId`。真机两臂对照（剧本只差工具名）：`subagent` 臂第一条之后就带 `parentCallId`，`subagent_fork` 臂**三条**——含目录项到达后的那条补投——全是 `null`，于是它只能靠「任务名逐字相同」那一条判据挂到某一轮上，撞名即落空。于是 `build-model` 的三条判据全落空：① `parentCallId` 为 `null`、② 身份（UUID）不等于调用 id、③ 名字是 `null` ⇒ `spawnedBy` 保持 `null`，那条行**落不进任何一轮**（`render-blocks` 的 `nodeForBlock` 只认 `spawnedBy`）。收尾那条因为目录项已到、名字非空，才靠判据 ③ 挂上去——外观就是「卡片要等子智能体跑完才出现」。**测试环境 ≠ 运行环境**：单测此前只喂「started → catalog → finished」并只看 finish 那条的形状，没有任何判据问过「派发行可不可达」。

**解决方案**：投影补两条（`providers/dsh/events.ts`）——`noteDshDispatchStart` 在父会话的 `tool/call` 上留一笔「这次派发在飞」（记 `{callId, description}`，子会话自己的嵌套派发不记），**工具名是枚举的两个**：`subagent` 与 `subagent_fork`（厂商同一个插件的两次挂载，见上面那条补记）；`workflow` 刻意不在名单里——它派出的子智能体走的仍是 `subagent.*` 那两条通知（2026-10-18 真机核实：一轮 workflow 里子任务行 3 条、带 `subagentId` 的消息 2 条、`subagent/catalog` 的 `label` 也到了），而一次 `workflow` 调用对应**多个**子智能体、按 `description` 认领必然零命中或多命中；`subagent/catalog` 到达时 `claimDshDispatch` 按「目录项 `label` ↔ 在飞派发的 `description` **逐字相同且唯一**」认领派发调用 id，`redeliverStartedSubagent` 再投一条**带名字与 `parentCallId` 的运行行**（同一身份覆盖累积；判据是内容签名，逐字相同不重发）。认领结果记在 `claimedDispatches` 上，**收尾那条也带上同一格**（否则覆盖会把派发点抹掉）。认不出（零条或多条命中）就**不认领、不猜**：名字照给，界面退回「任务名逐字相同」那条判据，与修之前同形。判据：`providers/dsh/events.test.ts` 的「派发行的派发点」五条（补投一条更完整的 / 收尾带同一格 / 目录项先到不重发 / 名字撞车不认领 / 嵌套派发不记账）。两条变异见过红：① 去掉补投 ⇒ 2 条红；② 认领放宽成「先到先得」⇒ 撞名那条红（还原后 `events.ts` 的 sha256 与变异前逐字一致）。真机复核：`tool/call` 在 `09:36:53.141Z`，界面上 0.5 s 后（`09:36:53.644Z`）卡片已带「运行中」+「进入 ▸」，点进去就是子会话自己的逐步骤内容（这一家的子会话事件在同一条通知流里，正文是真的）。

---

## 续接段的往返号又从 1 起（与上一段撞号），而厂商会话日志里明明有 `step/start`

**日期**：2026-10-18

**现象**：跨进程续接同一条 dsh 会话时，第二段的 `roundTrip` **从 1 重新开始**——与第一段的号逐个撞车，于是同一段答复在对话视图里出现两条、先到的那条被覆盖（症状与上面「对话视图里同一段答复出现两次…」那条**同形**，成因不同）。**没有任何报错**：`countSessionSteps` 静默返回 `null`（= 不播种），运行照旧 `ok`、执行日志干干净净。

真机读数（同一轮两次运行、中间清空模块级发号表模拟新进程）：

```text
纯 ASCII 路径    phase1 = [1,2]   phase2 = [3]     ← 播种生效
含空格 / 中文    phase1 = [1,2]   phase2 = [1]     ← 不播种，与第一段撞号
```

同一轮里把「厂商落盘的目录名」与「我们推出来的目录名」并排放，差异一目了然：

```text
厂商落盘    --…-dsh-probe-key-VL0bsB-~5DE5~4F5C~0020~533A~0020~9879~76EE--
我们的推导  --…-dsh-probe-key-VL0bsB-工作 区 项目--
```

**根因**：`providers/dsh/session-log.ts` 的 `dshProjectKeyOf` 是**近似实现**（`--` + 直接把分隔符折成 `-` + `--`），而厂商的 `projectKey()` 有四条规则：不安全码元走 `~XXXX`、**连续**分隔符只折一个 `-`、掐掉前导 `-`、可读部分截到 **251**；会话 id 那一格同样要过 `encodeSegment()`（`.` / `..` 两个特例 + `~XXXX`——真机把 `probe~会话~id` 落成 `probe~007E~4F1A~8BDD~007Eid`）；cwd 还要先 `resolve()`（SDK 构造时 `this.cwd = resolve(options.cwd ?? …)`、jsonrpc-server 的 `initialize` 又 resolve 一次，真机把带尾斜杠的 cwd 落成去掉斜杠的那一份）。四条里少任何一条，路径就指不到磁盘上那个目录，而 `countSessionSteps` 的 `try/catch` 把它与「文件不在」一起归成 `null` ⇒ **静默不播种**。

同一处还有第二层：解码那一半用「按魔数硬切 + `try/catch` 跳过坏帧」，而 `zstdDecompressSync` **对被截断的帧不抛错**（实测切掉一帧最后 5 字节得到 0 字节、切在第二帧起点之后 10 字节处得到第一帧的完整内容）⇒ 压缩数据里出现字节巧合的魔数时，那一帧被**静默丢掉**（构造样本：硬切到帧内伪魔数处解出 0 字节，该帧的 `step/start` 一条都数不到）。`try/catch` 因此不是「半截帧」的判据，注释里写的那件事没有发生。

**测试环境 ≠ 运行环境**（这一条是根因的一部分）：落这一笔时的真机复核用的是**纯 ASCII 的临时目录**，而探针库（`probe/v11/lib/dsh-session-log.mjs`）里写的是**完整规则**、适配器里写的是近似实现——两者在 ASCII 路径上结果逐字相同，于是「`projectKey` 推导与真机目录逐字一致」这句结论只在 ASCII 那一档成立。**探针跑通的实现 ≠ 落地进适配器的实现**，两处各写一份时必须在**有区分力的输入**上对过账。

**解决方案**：`dshProjectKeyOf` / `dshSessionSegmentOf` 照厂商的 `projectKey()` / `encodeSegment()` 逐字实现（含按 **UTF-16 码元**迭代——按码点迭代会把 emoji 的代理对合成一个字符，转义值与厂商不同）；`countSessionSteps` 先 `resolve(cwd)`；多帧解码改成**按内容形态切帧**（厂商每批 append 的都是完整行 ⇒ 一帧解出来必然以换行收尾，不以换行收尾就说明切在了帧内部，把下一个候选并进来重解）。

判据两条且都是**独立**的：`providers/dsh/session-log.test.ts`（路径片段逐字期望 + 用真 zstd 压出来的受控样本；夹具侧**另抄一份厂商规则**铺目录——写读同源的写法对这类缺陷没有区分力，变异验证时那一条仍然绿）；`providers/dsh/session-log-real-path.test.ts`（真机跑两档 cwd：含空格 / 汉字 / emoji 与可读部分 > 251，判据是**磁盘上厂商写出来的目录名**逐字相同、且原样 / 规范化 / 尾斜杠三种写法都定位得到）。变异验证六条各见红：`projectKey` 还原近似实现 ⇒ 4 + 3 条红、`sessionSegment` 不转义 ⇒ 2 条红、去掉 `resolve` ⇒ 1 + 1 条红、切帧还原「取魔数第一段」⇒ 1 条红。残留缺口如实登记：伪魔数**恰好落在行边界**时切帧判据仍看不出（真机未观测到；要彻底关掉得让解码器交出「这一帧消耗了多少输入字节」，Node 的同步入口不给）。

**相关资料**：
- [《DeepSeek Harness 接入》](/protocols/dsh)——「已知边界与取舍」里往返号播种那一行
- 同一症状的另一个成因：[对话视图里同一段答复出现两次、而第一段那条被顶掉（`roundTrip` 撞号：厂商的 `step` 是每个 turn 内从 1 数）](/faq/deepseek-harness)
- 同一处路径规则的旧判例：[读 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd` 只解出 1 行](/faq/deepseek-harness)

---

## 同一条消息里同一段正文画两次（块位次错开：快照侧数「已产出的块」、旁路增量侧数「见过的块」）

**日期**：2026-10-18

**现象**：执行日志的实时视图里，模型那一句正文出现**两次**——同一轮、同一条消息、两个文本块，产物里也是两条。与上面「对话视图里同一段答复出现两次」那条的区别在**层次**：这一条的 `roundTrip` 是**同一个**，错开的是**消息内部的块位次**（槽位键）。

真机读数（假上游造一个空文本块，其余事件与对照臂逐字相同）：

```text
只有正文块      content[] = ['正文甲']        ⇒ 合并后 ['正文甲']                 ✓
空块 + 正文块   content[] = ['', '正文甲']    ⇒ 修复前 ['正文甲','正文甲']         ✗
```

**根因**：两侧的块位次是两套算法——`stream-tap.ts` 的 `positionOf` 给**每个 `block-start`** 发一个号（发号那一刻还不知道这一块最终有没有内容），而 `message.ts` 的 `dshAssistantMessageDraft` 拿 **`blocks.length`**（已产出块的个数）当位次，空文本块、认不出的类型块都**不产出块** ⇒ 它后面每一个块的号都少 1。两侧差一个号，同一个逻辑块就落进两个槽位，而**两条都留在产物里**（不是短暂的中间态）。

厂商侧为什么可达：装配器的 `blocks()` 是「one block per seen index」（**不滤空**），只有被打断那一支 `interruptedBlocks()` 才滤空白块 ⇒ 正常收尾的空块原样进 `content[]`。历史真机产物里空块 0 条，这条边界因此一直挂在「未观测」上，而它是**可达**的（假上游一次就造出来）。

**解决方案**：快照侧的位次改成「块在 `content[]` 里的**下标**」（`for (let position = 0; …)`），与 tap 侧「第几个 `block-start`」逐格对齐；工具调用块仍用自己的 `callId` 当槽位键（它不占下标号，两侧各自对齐）。

判据：`providers/dsh/message-blocks.test.ts`（四档块形状：空文本块、未知类型块、空思考块、工具块夹在中间）与 `providers/dsh/block-index-real-path.test.ts`（真机两臂只差剧本里那一个空块，并断言那个空块**确实进了流**——否则两臂同形、判据没有区分力）。变异验证：把位次改回 `blocks.length` ⇒ 单元守卫 3 条红、真机守卫 1 条红（还原后哈希逐字一致）。

**未闭合的一档（如实登记）**：`turn/end(kind:'max-tokens')` 时厂商把不安全的 tool-call 块整个丢掉，`content[]` 的下标因此整体前移，而 tap 早已给它占过号——若被丢的块排在正文**之前**，两者仍会差一格（真机未观测到）。要彻底收口得让位次换成**两边共用的厂商块身份**，而正文块没有身份（只有工具块有 `callId`）。

**相关资料**：
- [《DeepSeek Harness 接入》](/protocols/dsh)——「已知边界与取舍」里块位次那一行
- 同一症状的另一层成因：[对话视图里同一段答复出现两次、而第一段那条被顶掉（`roundTrip` 撞号）](/faq/deepseek-harness)
