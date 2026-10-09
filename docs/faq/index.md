# 故障索引

三家厂商适配 FAQ 的现象条目索引：标题照抄报错原文（含报错码与英文原句），排障时拿报错原文在本页一搜即命中，锚点直达对应 FAQ 的方案层条目。根因与解决办法在 FAQ 原文，本页只做标题与链接，不复制方案层内容——单一真源。

### Codex

- [`AGENT_LOAD_FAILED：找不到 codex 可执行文件：The argument 'filename' must be a file URL object… Received '[externals]/@openai/codex/package.json [external] (…)`](/faq/codex#agent-load-failed-找不到-codex-可执行文件-the-argument-filename-must-be-a-file-url-object-received-externals-openai-codex-package-json-external)
- [`http 401`，但密钥明明就在子进程环境里（`auth.header_attached=false`）](/faq/codex#http-401-但密钥明明就在子进程环境里-auth-header-attached-false)
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

### Claude Code

- [`AGENT_FAILED：Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`](/faq/claude-code#agent-failed-native-cli-binary-for-darwin-arm64-not-found-reinstall-anthropic-ai-claude-agent-sdk-without-omit-optional-or-set-options-pathtoclaudecodeexecutable)

### DeepSeek Harness

- [`dsh：声明 streamingDelta=yes，但 plain-reply 场景里没有任何 delta 消息`](/faq/deepseek-harness#dsh-声明-streamingdelta-yes-但-plain-reply-场景里没有任何-delta-消息)
- [`AssertionError: expected false to be true // Object.is equality`（`providers/dsh/index.test.ts` 的 overlay 绝对路径那条）＋仓库根长出 `D:\runs\run-1\rows\r-1\workspace`](/faq/deepseek-harness#assertionerror-expected-false-to-be-true-object-is-equality-providers-dsh-index-test-ts-的-overlay-绝对路径那条-仓库根长出-d-runs-run-1-rows-r-1-workspace)
## 维护口径

FAQ 按「发现即追加」持续增长：往任一份厂商 FAQ 追加二级标题条目后，必须同步本页对应厂商分组——索引同步守卫（`pnpm vitest run docs`）按二级标题解析比对三份 FAQ 的现象标题集合，少一条、多一条、改写一条都红，不允许静默漂移。本页条目的锚点由 `docs/.vitepress/pages.mjs` 复算（与 VitePress 构建产物的 heading id 逐字一致），不要手写锚点、也不要改写现象标题。

## 相关链接

- [Codex FAQ](/faq/codex)
- [Claude Code FAQ](/faq/claude-code)
- [DeepSeek Harness FAQ](/faq/deepseek-harness)
