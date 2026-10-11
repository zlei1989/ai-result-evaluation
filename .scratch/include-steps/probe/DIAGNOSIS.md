# 附件支持端点诊断（is-10）

- 诊断脚本：`.scratch/include-steps/probe/diagnose-endpoint.mjs`
- 日期：2026-10-11
- 背景：is-09 探针证明 likecode 网关对 anthropic `document` 附件块静默丢弃、对 openai `file` 块显式拒绝。本诊断回答定性问题：**网关问题还是协议问题**，并给出降级候选机制。
- 方法：三个端点 × 四种「意图与证据分开输入」机制，每格最小请求、证据埋随机哨兵词（12 位 hex）、判据 = 模型复述哨兵词。anthropic 的机制 (a) 走生产代码路径（jiti 加载 `text-api.ts` 的 `callTextApiConversation`，即生产 `wireContent` 形态）；其余直连构造。

## 端点

| 端点 | 供应商 | baseUrl | 模型 |
|------|--------|---------|------|
| A：官方 DeepSeek（anthropic 协议） | 配置里 `deepseek`（anthropic 协议） | `https://api.deepseek.com/anthropic` | deepseek-flash |
| B：likecode 网关（anthropic 协议） | defaultJudge（likecode-anthropic） | `http://likecode-llm-proxy-test.jd.com` | DeepSeek-V4.1-Flash-a |
| C：likecode 网关（openai 协议） | 配置里 `deepseek`（openai 协议） | `http://likecode-llm-proxy-test.jd.com`（诊断按网关真实路由补 `/v1`，见旁证 1） | GLM-5.3 |

## 矩阵结果

| 机制 | A 官方 DeepSeek（anthropic） | B likecode 网关（anthropic） | C likecode 网关（openai） |
|------|----------------|----------------|----------------|
| a) document/file 附件块（生产形态） | ❌ FAIL（`[Unsupported Document]` 占位） | ❌ FAIL（静默丢弃） | ❌ 400（file part，见下） |
| b) 双 text 块 / 双 text part | ✅ PASS | ✅ PASS | ✅ PASS |
| c) 两条 user 消息 | ✅ PASS | ✅ PASS | ✅ PASS |
| d) system 带证据（anthropic 顶层 system 字段 / openai system 角色消息） | ✅ PASS | ✅ PASS | ✅ PASS |
| openai `file` content part（官方 `/v1/chat/completions`，单条） | — | — | ❌ 400（见旁证 2） |

## 每格证据（原文摘录）

### a) document 附件块 —— 两个 anthropic 端点都不支持，但失败方式不同

- **A 官方 DeepSeek**：HTTP 200，但模型拿到的消息里 document 块被替换成占位文本，模型 thinking 自述：
  `But provided "[Unsupported Document]" likely no actual document content.`
  即官方端点的 anthropic 兼容层**不实现 document 块**：它把块翻译成字面量 `[Unsupported Document]` 塞进消息——不是静默丢（模型看得到「有东西不支持」的信号），但也**读不到内容**。响应里没有 text 块，生产解析报「响应里没有 type=text 的内容块」。
- **B likecode 网关**：HTTP 200，模型 thinking 自述：
  `But no evidence content provided. We need infer? We have no evidence content. … We only have user message.`
  请求里明明带着 document 块，模型却说「没有任何证据内容」——**静默丢弃**，连 `[Unsupported Document]` 这样的信号都没有（比官方端点更危险：证据无声消失，且无任何可观测信号）。
- **C（openai file part）**：HTTP 400，官方 DeepSeek openai 端点报
  `.messages[0]: file must have a file_id or file_data (request_id: …)`——openai 兼容层不认 `{type:'file', file:{file_data,…}}` 形状（见旁证 2）。

### b) 双 text 块 / 双 text part —— 三端点全 PASS

- A：模型复述 `SI-DIAG-dc8031e97a20`（thinking 里完整引用了证据文本）。
- B：模型复述 `SI-DIAG-803de64796bb`（thinking 里完整引用了证据文本）。
- C：模型复述 `SI-DIAG-e5a51745969d`。

### c) 两条 user 消息 —— 三端点全 PASS

- A：复述 `SI-DIAG-5490d9cbc08a`；B：复述 `SI-DIAG-a8a14c6dd484`；C：复述 `SI-DIAG-4601492e938a`。

### d) system 带证据 —— 三端点全 PASS

- A：复述 `SI-DIAG-6d0922fe53bc`；B：复述 `SI-DIAG-5e2728bf96b6`；C：复述 `SI-DIAG-4df50a405d66`。

## 分类判读

**协议问题为主，网关问题叠加**：

1. **协议层**：DeepSeek 系 anthropic 兼容端点**不实现 document 附件块**。铁证是官方端点（A）自己把块替换成 `[Unsupported Document]` 占位——这不是 likecode 的翻译缺漏，而是上游（DeepSeek）协议能力缺失。openai 侧的 `file` content part 同样不被官方端点支持（400）。⇒ 在 DeepSeek 系模型上，`document` / `file` 两种协议附件形态**都没有可用端点**。
2. **网关层（likecode 叠加问题）**：同样的 document 块，官方端点至少留下 `[Unsupported Document]` 占位（模型可见「有个东西没被支持」），likecode 则**整块丢弃**、零信号——模型自述「没有证据内容」。这是网关侧比官方更差的翻译行为，也是 is-09 探针要拦的「评分证据静默丢失」的机制层解释。

## 降级候选机制与跨协议统一推荐

| 机制 | anthropic（A/B） | openai（C） | 说明 |
|------|-----------------|-------------|------|
| b) 双 text 块 / 双 text part | ✅ ✅ | ✅ | **推荐**：content 里意图与证据各自一个 text 块/part，与生产 `wireContent` 改动最小（attachment 块翻成 text 块即可），三端点全 PASS |
| c) 两条 user 消息 | ✅ ✅ | ✅ | 三端点全 PASS，但改动消息结构（意图/证据拆两条消息），比 (b) 动得多 |
| d) system 带证据 | ✅ ✅ | ✅ | 三端点全 PASS，但证据与生产 system（输出契约）混用，语义边界变差 |

**推荐 (b)**：它是**两个协议 × 三个端点都验证可用**的机制里改动面最小的一个（`wireContent` 里把 attachment 块翻成 `{type:'text'}`，openai 侧删掉 file 翻译分支），且保持「意图与证据分开、单条 user 消息」的现状结构。(c) 不是唯一共同交集——b/c/d 三个机制在两协议三端点上全部 PASS；(c) 只在「想要消息级隔离证据」时才优于 (b)，作为备选。

**代价（选任一降级路径都要接受）**：文本机制失去「协议附件」的优势——网关不再把证据当独立文件，长证据会撑大消息体、模型可能跳读。若走降级路径需把截断口径重新评估（现 `diffBudgetBytes` 只裁 diff；events.jsonl 无截断）。这是降级方案的代价，不是本诊断的结论。

## 旁证（与本次请求无关，记录在案）

1. openai 供应商（likecode 的 deepseek 记录）baseUrl 缺 `/v1`：生产 `endpoint()` 拼出 `/chat/completions` → 404（is-09 探针已录）。官方 DeepSeek 的 openai 路由是 `/v1/chat/completions`；本诊断的端点 C 按网关真实路由补 `/v1` 后测（只补诊断脚本，未改产品代码）。
2. openai `file` content part：官方 DeepSeek `/v1/chat/completions` 报 400 `file must have a file_id or file_data`——官方 openai 兼容层不认文件型 content part。
3. 官方 DeepSeek anthropic 端点的 `document` 块行为（替换成 `[Unsupported Document]`）与 DeepSeek 官方文档对 Messages API 的支持面一致——文档只声明 text/image 内容块，无 document/file。

## 复现与退出码

- `node .scratch/include-steps/probe/diagnose-endpoint.mjs`：全部已尝试的格拿到判决（PASS / FAIL / 4xx-FAIL）时退出 0；任一格网络/超时（没拿到网关答复）退出 1；官方供应商缺配置则记 SKIP（不影响退出码）。
- 密钥只从 `~/.aieval/config.json` 读取，脚本不回显、不落盘。
