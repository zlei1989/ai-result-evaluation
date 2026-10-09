# codex app-server 思考内容通道 · v5 真机探针结论

- 真机：`codex-cli 0.156.1`（`node_modules\.pnpm\@openai+codex@0.156.1-win32-x64\...\bin\codex.exe`）
- 上游：`https://api.deepseek.com/v1`（`wire_api: responses`、`env_key: OPENAI_API_KEY`），模型 `deepseek-reasoner`
- 采集：`app-server` stdio JSON-RPC，**逐行原文**落盘；4 个 case 逐字同一提示词，只差 `model_reasoning_summary`（第 4 例另加 `effort: none`）

## ① 逐题一句话结论

1. **`summary[]` 恒为空、`content[]` 非空且是明文推理全文。** 4/4 个 case 的 `item/started` 是 `{"summary":[],"content":[]}` 的**空占位**，`item/completed` 是 `{"summary":[],"content":["…明文…"]}`（1 段，117/227/151/278 字）。拿到的不是厂商摘要，是模型原始思维链（英文），与上游 `content[].type === 'reasoning_text'` 的明文同源。
2. **`item/reasoning/textDelta` 到了（39/54/49/72 条），`item/reasoning/summaryTextDelta` 一条都没到。** 前者拼接结果与 `content[0]` **逐字相等**（4/4，`equal: true`，长度 117/227/151/278 全等）；后者无从比对（数组为空、通道为空）。
3. **`item/reasoning/summaryPartAdded` 没到（0 条）。** `contentIndex` 分布 = `{"0": N}`（恒 0，无第二个值）；`summaryIndex` **无样本**（该通道根本没有通知）。
4. **三档设置对通道没有影响**：未设置 / `detailed` / `none` 的「`summary[]=0` + `content[]=1` + 只有 textDelta」完全一致；`effort: none`（off-both）也一样。`reasoningOutputTokens` 4/4 非 0（39/54/49/72）。
5. **拿思考内容只走一条通道**（见末尾）。

## ② 支撑原文片段（逐字，标注来源）

**`item/started`（`type=reasoning`）—— 两条数组都空，是占位不是内容**（来源：`item/started` 通知的 `params.item`）
```json
{"method":"item/started","params":{"item":{"type":"reasoning","id":"f8475954-2e59-4eaa-9216-4e4e35075206","summary":[],"content":[]},"threadId":"01a115ba-6b20-7c13-9673-c670b0ad1177","turnId":"01a115ba-6b9c-7bb1-91be-6a59d00b686c","startedAtMs":1791365902236},"emittedAtMs":1791365902236}
```

**`item/completed`（`type=reasoning`）—— `summary` 空数组、`content[0]` 是明文全文**（来源：`item/completed` 的 `params.item`）
```json
{"method":"item/completed","params":{"item":{"type":"reasoning","id":"f8475954-2e59-4eaa-9216-4e4e35075206","summary":[],"content":["The riddle: \"除了 9 只以外都跑了\" - all but 9 ran away, so 9 remain. Answer: 9.\n\nNeed one sentence reasoning then conclusion."]},"threadId":"…","turnId":"…","completedAtMs":1791365902458},"emittedAtMs":1791365902460}
```
`content[0]` 前 200 字（逐 case，均取自 `item/completed` 的 `content[]`；`summary[]` 四例都为空数组，无可摘录）：
- `summary-unset`：`The riddle: "除了 9 只以外都跑了" - all but 9 ran away, so 9 remain. Answer: 9.` + `Need one sentence reasoning then conclusion.`
- `summary-detailed`：`We need answer in Chinese. Need first one sentence reasoning, then conclusion. Classic riddle: "除了9只以外都跑了" means all except 9 ran away, so 9 remain. …`
- `summary-none`：`The user asks a classic riddle. "一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只?" Answer: 9.` + `They want one sentence reasoning then conclusion. No tools needed. Chinese.`
- `off-both`：`The riddle: 17 sheep, all but 9 ran away, so 9 remain. Answer: 9.` + `User asks: first explain reasoning in one sentence, then give conclusion.`

**`item/reasoning/textDelta` —— 逐字增量（token 级），`contentIndex` 恒 0**（来源：`item/reasoning/textDelta` 的 `params`）
```json
{"method":"item/reasoning/textDelta","params":{"threadId":"…","turnId":"…","itemId":"f8475954-2e59-4eaa-9216-4e4e35075206","delta":"The","contentIndex":0},"emittedAtMs":1791365902236}
{"method":"item/reasoning/textDelta","params":{"threadId":"…","turnId":"…","itemId":"f8475954-2e59-4eaa-9216-4e4e35075206","delta":" r","contentIndex":0},"emittedAtMs":1791365902303}
```
增量粒度是**子词**（`"The"`、`" r"`、`" conclusion"`、`"."`），不是整段；`delta` 拼接 === `item/completed` 的 `content[0]`（4/4 逐字相等，`-ceq` 为真，且增量条数 = `reasoningOutputTokens`）。

**`thread/tokenUsage/updated` —— 旁证非 0**（来源：该通知的 `params.tokenUsage.total`）
```json
{"method":"thread/tokenUsage/updated","params":{"threadId":"…","turnId":"…","tokenUsage":{"total":{"totalTokens":14764,"inputTokens":14678,"cachedInputTokens":14464,"cacheWriteInputTokens":0,"outputTokens":86,"reasoningOutputTokens":39},"last":{…},"modelContextWindow":258400}},"emittedAtMs":1791365902715}
```

**上游那一侧（不经 codex）：明文在 `content[].type='reasoning_text'`，`summary` 是空数组**（来源：`wire-responses-sse.json` + `tmp/wire/nonstream-summary-auto.sse.txt` 第 1 行原文；流式 194 条 `response.reasoning_text.delta`）
```json
{"type":"reasoning","id":"da07979f-…","status":"completed","content":[{"type":"reasoning_text","text":"我们需要回答中文。用户要求：…共 274 字…"}],"summary":[],"encrypted_content":"5d7a24a8-b77b-4a04-a040-1cb1c516f457-0"}
```
`reasoning.summary: 'none'` 被上游**逐字拒绝**（来源：`wire-responses-sse.json` 的 `errorBody`，HTTP 422）：
```
{"error":{"message":"Failed to deserialize the JSON body into the target type: reasoning.summary: unknown variant `none`, expected one of `auto`, `concise`, `detailed` at line 1 column 280 (request_id: …)","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}
```

**codex 自己的枚举含 `none`**（来源：`generate-ts --experimental` 导出）：
```ts
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";
```
⇒ `model_reasoning_summary: 'none'` 那一 case **没有** 422：`turn/completed.status = "completed"`、`error = null`、`warning`/`error` 通知 0 条、推理照样到齐。**这说明 codex 这一层已把 `none` 消化掉（丢弃或翻译），并未把 `none` 转给上游**；具体是丢弃还是翻译成别的值，本轮**没有直读 wire 请求体**（见 ④）。

## ③ 四个 case 的对照读数（同一句提示词）

| case | `model_reasoning_summary` | `effort` | 终结 | reasoning 条目 | `summary[]` | `content[]`(段/字) | `textDelta` 条数 | 拼接=content | `summaryTextDelta` | `summaryPartAdded` | `reasoningOutputTokens` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| summary-unset | 未设置 | 未设置 | completed，无 error | 1 | `[]` | 1 / 117 | 39 | ✅ 逐字相等 | 0 | 0 | 39 |
| summary-detailed | `detailed` | 未设置 | completed，无 error | 1 | `[]` | 1 / 227 | 54 | ✅ 逐字相等 | 0 | 0 | 54 |
| summary-none | `none` | 未设置 | completed，无 error | 1 | `[]` | 1 / 151 | 49 | ✅ 逐字相等 | 0 | 0 | 49 |
| off-both | `none` | `none` | completed，无 error | 1 | `[]` | 1 / 278 | 72 | ✅ 逐字相等 | 0 | 0 | 72 |

补充事实（4/4 一致）：`item/started` 的 `summary` 与 `content` **两个键都存在**且都是空数组；结束后 `thread/read`（`itemsView:"full"`）读回的 reasoning 条目与 `item/completed` **逐字相同**—— 通知通道与持久化通道同源同值。

## ④ 未能验证的部分（如实说，不猜）

- **codex 发给上游的请求体没有直读**（v4 那种本地中继本轮没做）⇒ 「`none` 是被丢弃还是被翻译成 `auto`/`concise`」**未验证**。已证实的只有观测面：无 4xx、无 error 通知、推理照常到齐。
- **`item/reasoning/summaryTextDelta` 与 `summaryPartAdded` 为什么永不出现**：本轮只证明「在 DeepSeek 官方 responses 上游 + 这 4 档设置下一条都没有」。因为上游 `summary` 恒为 `[]`（非流式原文可证），可推断这两条通道**没有数据可推**；但「换个会上摘要的上游会不会出现」**未验证**。
- **`summaryIndex` 的取值分布**：该通道零通知 ⇒ **没有样本**（不是「恒 0」，是「没数据」）。`contentIndex` 的「恒 0」是 4/4 case × 全部增量的结论。
- **`app-server` 退出码恒为 `null`**（4/4；`kill()` 后 Node 给的是 `{code:null}`）⇒ 退出码**不能**当作本轮成败判据，本轮成败由 `turn/completed.status = completed` + `error = null` + 实际内容判定。
- **`thread/read` 的 `itemsView`**：`turn/completed` 里是 `"summary"`，`thread/read` 里是 `"full"`（生产 `reader.ts` 的降级判据正依赖这个差异，本轮顺带证实）。
- 探针第一版有个**采集缺陷**已在复跑中修掉：`turn/completed` 一到就结算客户端，导致收尾 `thread/read` 被 reject（当时落盘的 `.thread.json` 只有 `{"error":"探针主动关闭"}`）；现版本 `turn/completed` 只作信号、不结算，收尾读回正常。

## ⑤ 落盘文件清单

| 路径 | 内容 |
|---|---|
| `packages/server/agents/probe/v5/codex-appserver-reasoning.mjs` | 主探针（4 case，逐行原文落盘 + 判定） |
| `packages/server/agents/probe/v5/lib/client.mjs` | app-server JSON-RPC 探针客户端（原文回吐、`turn/completed` 不结算） |
| `packages/server/agents/probe/v5/lib/analyze.mjs` | 从原始 JSONL 重算读数（键存在性 vs 空数组、逐字比对、下标分布） |
| `packages/server/agents/probe/v5/wire-responses-sse.mjs` | 上游 `/v1/responses` 直连探针（流式 + 非流式 + `summary:none` 的 422 原文） |
| `packages/server/agents/probe/v5/run.ps1` | 运行外壳（从 `~/.dsh/.credentials.yaml` 注入密钥，不打印、不落盘） |
| `packages/server/agents/probe/dumps/v5/codex-appserver-reasoning.json` | 汇总（含逐 case 全部读数与失败证据格） |
| `packages/server/agents/probe/dumps/v5/codex-appserver-reasoning-<case>.jsonl` | **每 case 一份原始通知 JSONL**（105/121/121/150 行，未重新序列化） |
| `packages/server/agents/probe/dumps/v5/codex-appserver-reasoning-<case>.thread.json` | 每 case 的 `thread/read` 快照（持久化视角对照） |
| `packages/server/agents/probe/dumps/v5/wire-responses-sse.json` | 上游响应摘要（事件类型清单、报文、422 原文） |
| `packages/server/agents/probe/dumps/v5/tmp/wire/*.sse.txt` | 上游 SSE/JSON **逐行原文**（含 194 条 `response.reasoning_text.delta`） |
| `packages/server/agents/probe/dumps/v5/tmp/gen-ts/ts/**` | `codex app-server generate-ts --experimental` 导出（84 个通知方法名、三个 reasoning 通知类型逐字） |

密钥只经环境变量流转：`dumps/v5/**` 全量 1236 个文件已逐一扫描，**未出现**密钥原文。

## ⑥ 结论一段话：拿思考内容该走哪个通道

**在 codex app-server + DeepSeek 官方 responses 上游这条链路上，思考内容只有一条实通道：`item/reasoning/textDelta`（增量，token 级逐字）+ `item/completed` 的 `reasoning.content[]`（终态全文快照，`summary[]` 恒为空数组）。**
落地的正确口径是「**增量优先、终态封口**」：运行期把 `item/reasoning/textDelta` 按 `itemId` 拼接即时上屏（`contentIndex` 当前恒 0，但**必须分桶**——协议给了下标就说明一个条目可以有多个部分，混拼是错的）；收到 `item/completed` 后用 `content[]`（按 `\n` 拼行）与之比对，**逐字相同就不重复发送、只封口，不同则补一条快照**——本仓 `message.ts` 的 `reasoningDrafts` 正是这个口径，本轮实测它在真机上的分支是「增量拼接 === content[0]」⇒ 走"不重发、只封口"。
**降级口径（`content[]` 恒空时）**：只能落到 `text: null` + `textKind: 'none'`（= 「有思考但拿不到文本」，**绝不**拿 `summary[]` 冒充全文），因为这条链路上 `summary[]` 也是空的、`item/reasoning/summaryTextDelta` 一条都不来——**两处都空时正确做法就是承认拿不到**；将来若上游开始回摘要，它应作为**独立的一块**（`textKind: 'summary'`）出现，而不是填进全文那一格。配置侧**不需要**为拿到全文做取舍：`model_reasoning_summary` 三档观测面上完全等价，`effort: none` 也照样拿到全文；但 `none` 是 **codex 自己的枚举**（上游会 422 拒收 `summary: 'none'`），本机行为是「不报错、不影响推理」⇒ **不要**把「关掉摘要」当「关掉思考」的手段。
