# codex 结构化输出：能力核实与真机证据（2026-10-07）

> 起因：核对「codex 是否已支持结构化输出能力」——`capability.structuredOutput: true` 与 `turn/start.outputSchema` 的透传都已在代码里，但**从协议到评分通路**这条链上没有一次真机验证。
> 结论：**能力成立，但原先断在最后一跳**（本仓交不出答复）；断点已修，并补了 5 条守卫 + 2 个变异 + 1 次真机对照。
> 产物：`packages/server/agents/probe/v4/codex-structured-output.mjs`（探针）、`probe/v4/lib/wire-relay.mjs`（抓包 relay）、`probe/dumps/v4/codex-structured-output.json`（原始记录，`dumps/` 已 gitignore）。

## 1. 结论

| 层 | 判据 | 结果 |
|---|---|---|
| 协议 | `codex app-server generate-json-schema` 的 `v2/TurnStartParams.outputSchema` | **有这一格**，且**非 experimental**（不带 `--experimental` 也在），原文「Optional JSON Schema used to constrain the final assistant message for this turn」 |
| CLI | `turn/start` 带 `outputSchema` 是否被受理 | **受理**（`turnStartAccepted=true`，无 `-32602`） |
| wire | 它变成 Responses 请求的哪一格 | `text.format = { format: { type: 'json_schema', strict: true, name: 'codex_output_schema', schema: … } }`，上游 `status=200` |
| 上游行为 | schema 是否真被执行 | **执行**（见 §3 的 A/B 对照：同一份「要散文不要 JSON」的题面，带 schema 回 JSON、不带回散文） |
| 本仓 | `AgentRunResult.finalText` 拿不拿得到那份 JSON | **原先拿不到**（恒 `null`）⇒ 已修，见 §4 |

## 2. 协议与 wire（`only=schema`）

```
[v4]    turn/start 接受=true 结算=completed 耗时=1.7s
[v4]    最终答复是裸 JSON=true
[v4]    wire#0 /v1/responses status=200 model=deepseek-flash
[v4]      text.format={"format":{"type":"json_schema","strict":true,"schema":{…},"name":"codex_output_schema"}}
[v4]      SSE 事件：{"response.created":1,…,"response.output_text.done":1,"response.completed":1}
[v4]      response.completed: status=completed outputTypes=["reasoning","message"] incomplete=null
```

⇒ CLI 把 `outputSchema` **原样**放进了 Responses 的结构化输出格（`strict: true`），网关照单执行。

## 3. A/B 对照：schema 被执行，而不只是「提示词效应」

题面用的是评分口吻 + 本仓 `JUDGE_OUTPUT_CONTRACT`（要求「只输出 JSON」）；对抗组把题面换成「请用**中文散文**回答，不要输出 JSON、不要输出代码块」。

| 组 | 题面 | schema | wire `text.format` | 最终答复 |
|---|---|---|---|---|
| `with-schema` | 契约（要 JSON） | 有 | `json_schema strict:true` | 裸 JSON（形状合格） |
| `with-schema-adversarial` | **对抗**（要散文） | 有 | `json_schema strict:true` | **仍是 JSON** |
| `no-schema-adversarial` | **对抗**（要散文） | 无 | `null` | **中文散文** |

对抗组里模型自己在 reasoning 里写明「the response format schema is enforced by the system. I must comply with the schema」——**对照组成立**：没有 schema 时同一份题面确实会给散文。

## 4. 本仓端到端：修复前拿不到答复（**这是本次真正的缺陷**）

`capability.structuredOutput: true` 只说明「我们把 schema 发出去了」；能不能**收回来**取决于适配器有没有写骨架的 `state.finalText`。app-server 重构后 codex 一处都没写它（`message.ts` 只出内容块；`lastAgentText` 只服务子任务 `outcome`），于是：

| 状态 | 真机结果（`deepseek-flash` + `JUDGE_OUTPUT_JSON_SCHEMA`，同一份用例） |
|---|---|
| 修复前（变异体：摘掉 `events.ts` 里那段写入） | `ok=true, turns=1, finalText=null` ⇒ 用例红（`AssertionError: expected null not to be null`） |
| 修复后 | `finalText` 是符合 schema 的裸 JSON ⇒ 用例绿（2.37s） |

修法与守卫见 `docs/codex-faq.md` 的同日条目；5 条守卫在 `providers/codex/index.test.ts` 的「最终答复出口：finalText」，2 个变异各只红对应那一条，`events.ts` 的 sha256 复原一致。

## 5. 一次未复现的异常

首次探针运行里 `with-schema` 组跑满 180s（37 条 reasoning、0 条 `agentMessage`），同参数复跑 1.7s 正常收尾。**未定位**，已按「发现即记录」写进 `docs/codex-faq.md`（含下一步与判据），此处不重复。

## 6. 复跑

```powershell
cd packages\server\agents
node probe\v4\codex-structured-output.mjs only=schema,adversarial,adversarial-control timeoutMs=300000
# 落盘：probe/dumps/v4/codex-structured-output.json（wire 请求体 + SSE 事件 + 通知计数 + 最终答复）
```

探针只读宿主 `~/.aieval/config.json`（或 `AIEVAL_CONFIG_DIR`）里 **openai 协议**的那条 provider；密钥只在子进程环境里传递，落盘前 redact。

§4 那份端到端用例是**临时文件**（依赖宿主配置与网络，故不入库，跑完即删）：它是「`provider.run` 收得到 JSON」这一跳的唯一真机证据，形状等于「构造 scratch + `createRunInput` 的字段 + `outputSchema: JUDGE_OUTPUT_JSON_SCHEMA`，断言 `result.ok` 与 `finalText` 可解析」；要复跑就照这个形状重建，或直接用 §6 的探针（探针多一层 relay，能同时看到 wire）。
