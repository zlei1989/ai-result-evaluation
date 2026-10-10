# 故障索引

三家厂商适配 FAQ 的现象条目索引：标题照抄报错原文（含报错码与英文原句），排障时拿报错原文在本页一搜即命中，锚点直达对应 FAQ 的方案层条目。根因与解决办法在 FAQ 原文，本页只做标题与链接，不复制方案层内容——单一真源。

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

### Claude Code

- [`AGENT_FAILED：Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`](/faq/claude-code#agent-failed-native-cli-binary-for-darwin-arm64-not-found-reinstall-anthropic-ai-claude-agent-sdk-without-omit-optional-or-set-options-pathtoclaudecodeexecutable)
- [`[22:21:22] stdout {"type":"system","subtype":"thinking_tokens","estimated_tokens":1,"estimated_tokens_delta":1,"session_id":"8a23d018-0dec-4c5c-b67f-8d98ac31d970","uuid":"b51b18af-2b8c-4af6-a4d8-abbc51c011ac"}`（「原始输出」抽屉被思考进度帧刷满、页面卡死）](/faq/claude-code#_22-21-22-stdout-type-system-subtype-thinking-tokens-estimated-tokens-1-estimated-tokens-delta-1-session-id-8a23d018-0dec-4c5c-b67f-8d98ac31d970-uuid-b51b18af-2b8c-4af6-a4d8-abbc51c011ac-「原始输出」抽屉被思考进度帧刷满、页面卡死)
- [`AGENT_FAILED：Claude Code returned an error result: There's an issue with the selected model (test-model). It may not exist or you may not have access to it.`](/faq/claude-code#agent-failed-claude-code-returned-an-error-result-there-s-an-issue-with-the-selected-model-test-model-it-may-not-exist-or-you-may-not-have-access-to-it)

### DeepSeek Harness

- [`dsh：声明 streamingDelta=yes，但 plain-reply 场景里没有任何 delta 消息`](/faq/deepseek-harness#dsh-声明-streamingdelta-yes-但-plain-reply-场景里没有任何-delta-消息)
- [`AssertionError: expected false to be true // Object.is equality`（`providers/dsh/index.test.ts` 的 overlay 绝对路径那条）＋仓库根长出 `D:\runs\run-1\rows\r-1\workspace`](/faq/deepseek-harness#assertionerror-expected-false-to-be-true-object-is-equality-providers-dsh-index-test-ts-的-overlay-绝对路径那条-仓库根长出-d-runs-run-1-rows-r-1-workspace)
- [`原始输出 38164 行，但执行日志是空的`（dsh 行：厂商会话日志 201 条事件，我们只收到前 13 条）](/faq/deepseek-harness#原始输出-38164-行-但执行日志是空的-dsh-行-厂商会话日志-201-条事件-我们只收到前-13-条)

## 跨家与环境

**不属于任何一家厂商**的条目（任何一家只要注入了会拉起浏览器的 MCP server 都成立；`unsupported call` 那种
「某一家 × 某个环境」的组合仍归该厂商 FAQ）。落点是知识文章，不在三份 FAQ 原文里——本页只给指针。
本节的条目**不受**上面那条「目录层与三份 FAQ 二级标题集合逐字一致」的守卫约束（那条守卫只管三个厂商分组）。

- [行结束后仍能 `pgrep` 到上一轮的浏览器（重跑同一行撞 `Browser is already in use for …, use --isolated …`）](/protocols/process-lifecycle#行结束后仍能-pgrep-到上一轮的浏览器-重跑同一行撞-browser-is-already-in-use-for-use-isolated)

## 维护口径