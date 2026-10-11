# 网关附件探针报告（is-09）

- 探针：`.scratch/include-steps/probe/attachment-gateway.mjs`
- 日期：2026-10-11
- 配置来源：`loadConfig()`（`~/.aieval/config.json`，未改动）
- defaultJudge：`likecode-anthropic`（anthropic 协议）· `DeepSeek-V4.1-Flash-a` · effort=high
- 另一协议供应商：`deepseek`（openai 协议）· `GLM-5.3`

## 结论：不通过（2/2 项未 PASS）——评分附件形态不得启用

| 协议 | 供应商 | 判据 | 结果 |
|------|--------|------|------|
| anthropic | likecode-anthropic（defaultJudge） | 最小附件请求（text 意图块 + document/PlainTextSource 附件块）走生产代码 `callTextApiConversation` | **FAIL（静默丢弃）** |
| openai | deepseek | 最小附件请求（text 意图块 + file 附件块）走生产代码 `callTextApiConversation` | **FAIL（路由 404 + 显式拒绝）** |

## anthropic 协议：网关**静默丢弃** document 附件块

- 生产调用报错：`文本 API 未返回文本内容（likecode-llm-proxy-test.jd.com，模型 DeepSeek-V4.1-Flash-a）：响应里没有 type=text 的内容块`（HTTP 200，但 content 里只有 thinking 块，模型选择「空回复」，因为没看到附件）。
- 原始响应取证（探针自动补抓，HTTP 200）里模型自述：
  `"Current message has no attachment content. We need inspect attachments? … I only see user text, no file contents."`
  请求里明明带着 `document` 块（哨兵 `SI-PROBE-<随机 12 位 hex>`），模型却明确说「消息里没有附件内容」——附件被网关**在返回 200 的同时**丢掉了，评分证据会无声消失，这是探针要拦的最危险形态。
- 独立对照（`/tmp` 诊断脚本，两主机、两模型、text/base64 两种 source）：
  - `likecode-llm-proxy-test.jd.com` 与 `likecode-llm-proxy.jd.com` 两台都丢；
  - `DeepSeek-V4.1-Flash-a` 与 `GLM-5.3` 两个模型都看不到附件；
  - `source.type: 'text'` 与 `'base64'` 两种编码都被丢（不是编码口径问题）；
  - 对照组：**无附件**的纯文本请求返回 200 且正常输出（`OK`）——路由、鉴权、模型都正常，唯独附件块不翼而飞。

## openai 协议：生产路由 404 + 网关显式拒绝 file 附件块

- 生产调用报错：`文本 API 返回 HTTP 404（likecode-llm-proxy-test.jd.com，模型 GLM-5.3）`——配置的 openai 供应商 baseUrl 是裸根（无 `/v1`），生产 `endpoint()` 拼出 `/chat/completions`，网关该路径不存在（`Not found, POST /chat/completions`）。
- 显式拒绝取证（探针自动补打 `/v1/chat/completions`）：HTTP 400，
  `{"error":{"message":"messages.content.type 参数非法，取值范围 ['text'] (code: 1210)"}}`
  ——即便把 baseUrl 修成网关真实路由，file 附件块也被**显式拒绝**（该网关只收 `text` 类型 content part）。
- 对照组：`/v1/chat/completions` 纯文本请求返回 200 正常输出——问题只在附件块。

## 判读

- 探针打的是**生产 wire 形状**（jiti 加载本仓 `text-api.ts` 的 `callTextApiConversation`，附件块经 `wireContent` 翻译），探针与生产不存在形状漂移；失败点就是上线后评分会撞上的点。
- anthropic 侧是**静默丢弃**（200 + 无证据），openai 侧是**路由 404 / 显式 400**——两种失败都不能靠「重试」绕过，也不是本仓代码的形状错误。
- 按 spec 硬守卫口径：**探针不通过 = 评分附件形态不得启用**。未做任何静默降级（例如悄悄把附件内容内联进正文）：如实报告，等网关侧支持附件块后再启用。
- 网关侧需要的支持：anthropic 路由透传 `document` 块；openai 路由在 `/v1/chat/completions` 收 `type: 'file'` 的 content part（并让 openai 供应商的 baseUrl 带 `/v1` 或网关在根路由兼容）。
