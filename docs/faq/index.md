# 故障索引

四家厂商适配 FAQ 的现象条目索引：标题照抄报错原文（含报错码与英文原句），排障时拿报错原文在本页一搜即命中，锚点直达对应 FAQ 的方案层条目。根因与解决办法在 FAQ 原文，本页只做标题与链接，不复制方案层内容——单一真源。

### Codex

- [`AGENT_LOAD_FAILED：找不到 codex 可执行文件：The argument 'filename' must be a file URL object… Received '[externals]/@openai/codex/package.json [external] (…)`](/faq/codex#agent-load-failed-找不到-codex-可执行文件-the-argument-filename-must-be-a-file-url-object-received-externals-openai-codex-package-json-external)
- [`http 401`，但密钥明明就在子进程环境里（`auth.header_attached=false`）](/faq/codex#http-401-但密钥明明就在子进程环境里-auth-header-attached-false)
- [`unsupported call: probe_echo`（MCP 注入成功、`mcpServer/startupStatus` 报 `ready`，但模型调不动那台工具）](/faq/codex#unsupported-call-probe-echo-mcp-注入成功、mcpserver-startupstatus-报-ready-但模型调不动那台工具)
- [`Reconnecting... waiting for network`（App 里一直重连；同一份配置在 CLI 里 200）](/faq/codex#reconnecting-waiting-for-network-app-里一直重连-同一份配置在-cli-里-200)
- [终止一轮之后、或点「重新执行」时：`INTERNAL：清理上一轮的行产物失败：…（EPERM, Permission denied: \\?\…\.agenthome '\\?\…\.agenthome'）`](/faq/codex#终止一轮之后、或点「重新执行」时-internal-清理上一轮的行产物失败-eperm-permission-denied-agenthome-agenthome)
- [测试里「本轮永不结算」/ `Error: Test timed out in 40000ms`（整个 codex 测试目录跑十几分钟）](/faq/codex#测试里「本轮永不结算」-error-test-timed-out-in-40000ms-整个-codex-测试目录跑十几分钟)
- [`AGENT_LOAD_FAILED：厂商 SDK 加载失败：@openai/codex（原因：找不到 codex 可执行文件：解析 @openai/codex-darwin-arm64/package.json 失败（… ⇒ Cannot find module '@openai/codex-darwin-arm64/package.json'））](/faq/codex#agent-load-failed-厂商-sdk-加载失败-openai-codex-原因-找不到-codex-可执行文件-解析-openai-codex-darwin-arm64-package-json-失败-⇒-cannot-find-module-openai-codex-darwin-arm64-package-json)
- [二进制解析的真机守卫对「第二跳基准」没有区分力](/faq/codex#二进制解析的真机守卫对「第二跳基准」没有区分力)
- [解析链里的 `ensureV1Suffix` 不能省：codex 只走 `{base}/v1/responses`](/faq/codex#解析链里的-ensurev1suffix-不能省-codex-只走-base-v1-responses)
- [适配器只能钉 `wire_api: 'responses'`（`chat` 及其别名全被 CLI 拒）](/faq/codex#适配器只能钉-wire-api-responses-chat-及其别名全被-cli-拒)
- [`JUDGE_PARSE_FAILED：评分智能体没有给出可读的最终答复（该适配器未回传最终消息）`（codex 当评分智能体时必现）](/faq/codex#judge-parse-failed-评分智能体没有给出可读的最终答复-该适配器未回传最终消息-codex-当评分智能体时必现)
- [带 `outputSchema` 的一轮跑满 180s 仍无任何答复条目（`settle=timeout`；同题面同模型的对照组 94s 正常收尾）](/faq/codex#带-outputschema-的一轮跑满-180s-仍无任何答复条目-settle-timeout-同题面同模型的对照组-94s-正常收尾)
- [`codex exec --json` 里一条 `item.type === 'reasoning'` 都没有（`show_raw_agent_reasoning=true` 也不管用）](/faq/codex#codex-exec-json-里一条-item-type-reasoning-都没有-show-raw-agent-reasoning-true-也不管用)
- [评分智能体回「无法读取任何工作区文件」、三项全判未达成（`read-only` 下连 `echo` / `git status` 都被拒）](/faq/codex#评分智能体回「无法读取任何工作区文件」、三项全判未达成-read-only-下连-echo-git-status-都被拒)
- [思考块恒为 `{"type":"thinking","text":null,"textKind":"none"}`（增量明明带着文本；界面显示「思考文本未采集」，修前显示「厂商有、我们还没接」）](/faq/codex#思考块恒为-type-thinking-text-null-textkind-none-增量明明带着文本-界面显示「思考文本未采集」-修前显示「厂商有、我们还没接」)
- [`turn/completed` 只收到**子线程**那一条，主线程仍是 `"status":"inProgress","completedAt":null`](/faq/codex#turn-completed-只收到子线程那一条-主线程仍是-status-inprogress-completedat-null)
- [子智能体用量与思考正文：responses 上真机已可得（**不必**换 `wire_api`）](/faq/codex#子智能体用量与思考正文-responses-上真机已可得-不必换-wire-api)
- [`Error: ENOENT: no such file or directory, open '…/probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl'`（干净检出上「真机抓包重放」那条守卫必红）](/faq/codex#error-enoent-no-such-file-or-directory-open-probe-dumps-v6-codex-chat-wire-appserver-live-responses-subagent-jsonl-干净检出上「真机抓包重放」那条守卫必红)
- [`当前会话没有暴露 Playwright MCP 工具或资源`（注入成功、`mcpServer/startupStatus` 也报了 `ready`，模型却从第一轮起就断言没有这台工具）](/faq/codex#当前会话没有暴露-playwright-mcp-工具或资源-注入成功、mcpserver-startupstatus-也报了-ready-模型却从第一轮起就断言没有这台工具)
- [`codex app-server --listen unix://<path>` 连得上、但一行 JSON-RPC 都不回](/faq/codex#codex-app-server-listen-unix-path-连得上、但一行-json-rpc-都不回)
- [`request_user_input is unavailable in Default mode`（模型调了提问工具，我们一条服务端请求都收不到）](/faq/codex#request-user-input-is-unavailable-in-default-mode-模型调了提问工具-我们一条服务端请求都收不到)
- [提问请求到了不回帧 ⇒ 厂商**不会**自己收场（那一轮一直挂着）](/faq/codex#提问请求到了不回帧-⇒-厂商不会自己收场-那一轮一直挂着)
- [两臂产物指纹恒红：未识别通知只留方法名、厂商通知里又带本次运行的线程 id](/faq/codex#两臂产物指纹恒红-未识别通知只留方法名、厂商通知里又带本次运行的线程-id)
- [执行日志里没有「向用户提问」卡片：codex 那一条只剩一句 `这一问的答案（收场方式：answered）：`](/faq/codex#执行日志里没有「向用户提问」卡片-codex-那一条只剩一句-这一问的答案-收场方式-answered)

### Claude Code

- [`AGENT_FAILED：Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`](/faq/claude-code#agent-failed-native-cli-binary-for-darwin-arm64-not-found-reinstall-anthropic-ai-claude-agent-sdk-without-omit-optional-or-set-options-pathtoclaudecodeexecutable)
- [`[22:21:22] stdout {"type":"system","subtype":"thinking_tokens","estimated_tokens":1,"estimated_tokens_delta":1,"session_id":"8a23d018-0dec-4c5c-b67f-8d98ac31d970","uuid":"b51b18af-2b8c-4af6-a4d8-abbc51c011ac"}`（「原始输出」抽屉被思考进度帧刷满、页面卡死）](/faq/claude-code#_22-21-22-stdout-type-system-subtype-thinking-tokens-estimated-tokens-1-estimated-tokens-delta-1-session-id-8a23d018-0dec-4c5c-b67f-8d98ac31d970-uuid-b51b18af-2b8c-4af6-a4d8-abbc51c011ac-「原始输出」抽屉被思考进度帧刷满、页面卡死)
- [`AGENT_FAILED：Claude Code returned an error result: There's an issue with the selected model (test-model). It may not exist or you may not have access to it.`](/faq/claude-code#agent-failed-claude-code-returned-an-error-result-there-s-an-issue-with-the-selected-model-test-model-it-may-not-exist-or-you-may-not-have-access-to-it)
- [技能面确证 `[{"name":"tang-poem-meal","source":"userSettings"},…]` 在，但 `工具调用名：[]`、哨兵 `AIEVAL-SKILL-OK-7f3a` 未命中](/faq/claude-code#技能面确证-name-tang-poem-meal-source-usersettings-在-但-工具调用名-、哨兵-aieval-skill-ok-7f3a-未命中)
- [Write 落点缺一级 workspace：`"file_path":"…/rows/54fbe2bf-…/poetry.md"` 应为 `…/workspace/poetry.md`（评分「工作区无任何改动、无未跟踪文件」→ 0 分）](/faq/claude-code#write-落点缺一级-workspace-file-path-rows-54fbe2bf-poetry-md-应为-workspace-poetry-md-评分「工作区无任何改动、无未跟踪文件」→-0-分)
- [执行日志里没有思考、原始输出里有（`messages.jsonl` 折叠后只剩 `text`；原文 `[{"type":"thinking","thinking":"…","signature":""}]`）](/faq/claude-code#执行日志里没有思考、原始输出里有-messages-jsonl-折叠后只剩-text-原文-type-thinking-thinking-signature)
- [`AGENT_FAILED：Claude Code returned an error result: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)`（这一行在 `running` 上挂了 6 分钟才失败）](/faq/claude-code#agent-failed-claude-code-returned-an-error-result-api-error-connection-refused-—-a-firewall-or-proxy-may-be-blocking-it-econnrefused-这一行在-running-上挂了-6-分钟才失败)
- [`No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.`（没有批准面时，提问工具根本不提供给模型）](/faq/claude-code#no-such-tool-available-askuserquestion-askuserquestion-is-disabled-for-this-session-in-subagents-as-well-as-here-没有批准面时-提问工具根本不提供给模型)
- [`[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted.`（全权档并没有遮蔽提问工具）](/faq/claude-code#claude-sdk-can-use-tool-shadowed-warning-canusetool-will-not-be-invoked-permissionmode-bypasspermissions-auto-approves-every-tool-call-except-explicit-deny-rules-before-the-callback-is-consulted-全权档并没有遮蔽提问工具)
- [`updatedInput.response` 一给就把选项答案整条盖掉：`The user responded: …`（自由输入该走选项值那一格）](/faq/claude-code#updatedinput-response-一给就把选项答案整条盖掉-the-user-responded-自由输入该走选项值那一格)
- [执行日志里任务工具没有「计划清单」卡片：一行一个「计划清单」标签 + 参数原文（`{"taskId":"1","status":"in_progress"}`），而 codex 同题是一整张表](/faq/claude-code#执行日志里任务工具没有「计划清单」卡片-一行一个「计划清单」标签-参数原文-taskid-1-status-in-progress-而-codex-同题是一整张表)

### DeepSeek Harness

- [`dsh：声明 streamingDelta=yes，但 plain-reply 场景里没有任何 delta 消息`](/faq/deepseek-harness#dsh-声明-streamingdelta-yes-但-plain-reply-场景里没有任何-delta-消息)
- [`AssertionError: expected false to be true // Object.is equality`（`providers/dsh/index.test.ts` 的 overlay 绝对路径那条）＋仓库根长出 `D:\runs\run-1\rows\r-1\workspace`](/faq/deepseek-harness#assertionerror-expected-false-to-be-true-object-is-equality-providers-dsh-index-test-ts-的-overlay-绝对路径那条-仓库根长出-d-runs-run-1-rows-r-1-workspace)
- [同一条脚本两次运行的行级事件条数差一条（`24 / 24 / 25 / 25`：收尾那条 `usage` 与 run 落定抢跑）](/faq/deepseek-harness#同一条脚本两次运行的行级事件条数差一条-24-24-25-25-收尾那条-usage-与-run-落定抢跑)
- [`原始输出 38164 行，但执行日志是空的`（dsh 行：厂商会话日志 201 条事件，我们只收到前 13 条）](/faq/deepseek-harness#原始输出-38164-行-但执行日志是空的-dsh-行-厂商会话日志-201-条事件-我们只收到前-13-条)

### Pi Coding Agent

- [`mcp__<服务器>__<工具>` 握手成功却不在出站请求的 `tools` 里（SDK 注释原文：`MCP tools kept registered without being named stay inactive`）](/faq/pi#mcp-服务器-工具-握手成功却不在出站请求的-tools-里-sdk-注释原文-mcp-tools-kept-registered-without-being-named-stay-inactive)
- [`This extension ctx is stale after session replacement or reload.`（后台档子智能体活过本行时，完成回调打旧 ctx ⇒ 未处理的 Promise 拒绝）](/faq/pi#this-extension-ctx-is-stale-after-session-replacement-or-reload-后台档子智能体活过本行时-完成回调打旧-ctx-⇒-未处理的-promise-拒绝)
- [子智能体转写固定落 `os.tmpdir()/pi-subagents-<uid>/…`（不随行隔离）](/faq/pi#子智能体转写固定落-os-tmpdir-pi-subagents-uid-不随行隔离)
- [只跑一次 `pi --help`，真实家目录长出 `~/.pi/agent/auth.json` 与 `~/.pi/agent/models-store.json`](/faq/pi#只跑一次-pi-help-真实家目录长出-pi-agent-auth-json-与-pi-agent-models-store-json)
- [思考正文重复 5 段（同一段推理在执行日志的思考块里出现 5 次）](/faq/pi#思考正文重复-5-段-同一段推理在执行日志的思考块里出现-5-次)
- [`MCP「my-server」未能启动：工具表里没有它的工具（这一家起不来时不投结构化错误）`（行落 `failed` + `AGENT_MCP_UNAVAILABLE`，而那一台的工具就在出站请求里）](/faq/pi#mcp「my-server」未能启动-工具表里没有它的工具-这一家起不来时不投结构化错误-行落-failed-agent-mcp-unavailable-而那一台的工具就在出站请求里)
- [「这个子任务没有逐条对话记录」（pi 行的子任务节点点进去是空的：子会话的步骤不在父会话的事件流里）](/faq/pi#「这个子任务没有逐条对话记录」-pi-行的子任务节点点进去是空的-子会话的步骤不在父会话的事件流里)

## 跨家与环境

**不属于任何一家厂商**的条目（任何一家只要注入了会拉起浏览器的 MCP server 都成立；`unsupported call` 那种
「某一家 × 某个环境」的组合仍归该厂商 FAQ）。落点是知识文章，不在四份 FAQ 原文里——本页只给指针。
本节的条目**不受**上面那条「目录层与四份 FAQ 二级标题集合逐字一致」的守卫约束（那条守卫只管四个厂商分组）。

- [行结束后仍能 `pgrep` 到上一轮的浏览器（重跑同一行撞 `Browser is already in use for …, use --isolated …`）](/protocols/process-lifecycle#行结束后仍能-pgrep-到上一轮的浏览器-重跑同一行撞-browser-is-already-in-use-for-use-isolated)

## 维护口径