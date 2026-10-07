# 上下文窗口与思考强度 —— 冒烟与关账记录（2026-09-29，真机）

> 计划：`docs/superpowers/plans/2026-09-28-agent-context-window.md`（15 个任务）
> 设计：`docs/superpowers/specs/2026-09-28-agent-context-window-design.md`（D1–D14）
> 实现提交：`3ba00c7..a24a0df`（逐任务 TDD + 变异验证；ledger 在 `.superpowers/sdd/2026-09-28-agent-context-window/progress.md`）
> 网关恢复后（2026-09-29 08:3x）做的真机冒烟见 §③ —— **spec §9 点名的那条上线前硬验收已通过**。

## ① 范围清单

| # | 验收项（spec §10） | 状态 | 证据 |
|---|---|---|---|
| 1 | 拉取后模型清单带各自窗口，`gpt-image-2` 显示「未知」 | ✅ | `POST /api/providers/{id}/models/fetch` → 47 条、**46 条有窗口**；CLI 复核落盘：`Claude-Sonnet-4.6=1000000`、`GLM-5.3=1048576`（档位 low/high/max，推荐 high）、`GPT 5.3-codex=400000`、`jd/glm-5.2=1048576`（high/max，推荐 max）、`gpt-image-2=undefined` |
| 2 | 手工改窗口后再拉取，改过的值还在且带「手工」标记 | ✅ | 真机往返：`PUT {contextWindow:200000}` → 落盘 `200000 / manual` → 对真网关再拉一次（上游给 1000000）→ **仍是 200000 / manual**；「手工」标签与清空⇒`null` 由 `provider-form-modal.test.tsx` 两条钉住 |
| 3 | cc 行 ≥1M 的模型传 `…[1m]`；400k 的原样 | ✅ | **真机**：cc 行的 CLI `init` 事件报 `model = GLM-5.3[1m]`，活进程 argv 是 `--model GLM-5.3[1m]`，该行正常跑到 judging；对照真 CLI 直跑：`GLM-5.3` 明码 200、`GLM-5.3[1m]` 与 `Claude-Sonnet-4.6[1m]` 均返回 `ok` |
| 4 | codex 行的 `--config model_context_window=…` | ✅ | **真机 argv**：`--config model_context_window=1048576`（同批还有 `model_providers.aieval.*` / `tools.web_search=false` / `features.multi_agent=false`） |
| 5 | dsh 行 `settings.yaml` 正确，且 `request/context` 报出窗口 | ✅ | 文件：`llm-deepseek: models: [- id: "GLM-5.3" / contextWindow: 1048576 / maxTokens: 131072]`；**运行时事件**：`request/context data = {"provider":"deepseek-official","model":"GLM-5.3","contextWindow":1048576}` |
| 6 | 窗口未知时三家都不注入 | ✅ | 三家各自的 `Object.hasOwn` 阴性面（cc/codex/dsh 的 index.test.ts + codex/sdk.test.ts）；真机上 `gpt-image-2` 无窗口 ⇒ 不注入 |
| 7 | 三绿 + 每条守卫做过变异验证 | ⚠️ | `pnpm lint` exit=0；**我改过的 6 个包 scoped `tsc --noEmit` 全干净**、逐包测试契约 152 / agents 247 / evaluator 244 / client 99 / ui 359 / web-next 163 全绿。全仓聚合面有两类**外部**红，见 §④；变异验证逐条记在 ledger |
| 8 | 强度下拉的交集（GLM-5.3 三档 / qwen-3.8-max 在 dsh 只剩 low / 无档位只有默认 / 推荐只在交集内） | ✅ | `runs.test.ts` 表驱动四条边界 + `run-create-panel.test.tsx`（只列交集、标推荐、不预选、换模型/换智能体都作废已选档） |
| 9 | 不在交集的档位 ⇒ `INVALID_QUERY` + 中文点名两个值域 | ✅ | **真机**（意外但完整地走了一遍）：给未声明档位的旧清单提交 `effort=high` ⇒ 400 `INVALID_QUERY`「Codex 不能按 high 跑 GLM-5.3：该模型支持的档位是 （上游未声明），Codex 能收的是 minimal / low / … / persistent，可选的是 （只有默认）」 |
| 10 | 逐行显示档位、没选显示为空 | ✅（组件层） | `eval-row-card.test.tsx` 正反两条 |

## ② 操作路径（真机冒烟，2026-09-29 08:3x–08:5x）

1. `pnpm dev`（带 `AIEVAL_DEBUG=1`）起 :3083；`POST /api/providers/{likecode}/models/fetch` 与 `{likecode2}` 各拉一次。
2. 建一个**本地目录**用例（临时 git 仓库 + 一句改写 README 的题面），避开内网 git。
3. `POST /api/runs` 建一轮三候选：`claude-code + likecode + GLM-5.3`（不带档）、`codex + likecode2 + GLM-5.3 (high)`、`dsh + likecode + GLM-5.3 (high)`；`POST /api/runs/{id}/start`。
4. 等三行起跑后取证（CLI init 事件 / 活进程 argv / 磁盘 settings.yaml / 事件流 request/context），随后 `POST /api/runs/{id}/abort` 中止，避免继续烧 token。
5. 手工覆盖往返：`PUT /api/providers/{id}/models` 改窗口 → 再 fetch → 复核落盘。

## ③ 证据（原始输出片段）

```text
# 拉取后落盘（node 读 config.json）
模型数 47 有窗口 46
Claude-Sonnet-4.6 -> 1000000 | efforts:  | rec: undefined
GLM-5.3 -> 1048576 | efforts: low/high/max | rec: high
GPT 5.3-codex -> 400000 | efforts:  | rec: undefined
gpt-image-2 -> undefined | efforts:  | rec: undefined
jd/glm-5.2 -> 1048576 | efforts: high/max | rec: max

# 网关直连（对照）：后缀名不被接受
GLM-5.3               -> HTTP 200  {"id":"20260929083009af5a13a57ce346ee","type":"message",...}
GLM-5.3[1m]           -> HTTP 404  模型(GLM-5.3[1m])不存在或已下线
Claude-Sonnet-4.6[1m] -> HTTP 404  模型(Claude-Sonnet-4.6[1m])不存在或已下线

# 但真 CLI 用带后缀的名字**成功**（后缀由 CLI 在客户端消化，不会原样发网关）
claude --model 'GLM-5.3'      -> 提示「本版本目录里没有它…自动压缩按 200k 算；若模型能吃更多，在模型名后加 [1m]」
claude --model 'GLM-5.3[1m]'  -> 诊断 [claude-code:unrecognized_model] + 回复 ok（exit=0）
claude --model 'Claude-Sonnet-4.6[1m]' -> 提示 Sonnet 4 已退役 + 回复 ok（exit=0）

# 我们这一侧的进程 argv（决定性）
claude.exe   --model GLM-5.3[1m]
codex.exe    --config model_context_window=1048576  （另含 model_providers.aieval.* / tools / features）
cc 行 CLI init 事件： model = GLM-5.3[1m] | tools = 17

# dsh
.agenthome/settings.yaml:
  llm-deepseek:
    models:
      - id: "GLM-5.3"
        contextWindow: 1048576
        maxTokens: 131072
事件流： request/context data = {"provider":"deepseek-official","model":"GLM-5.3","contextWindow":1048576}

# 手工覆盖往返
PUT 之后   -> 200000 | source: manual
拉取之后   -> 200000 | source: manual   （上游给的是 1000000）
```

## ④ 未覆盖项与外部红（都**不是**本次改动引入）

1. **浏览器逐项点击未做**：设置页/创建评测面板的可见面由组件测试 + web-next 路由测试覆盖，真机验证走的是 HTTP 路由 + 进程 argv + 磁盘事实。没有用浏览器逐项点过（`read_picked_element`/截图那套）。
2. **全仓 `pnpm typecheck` 红**：唯一报错在 `packages/client/client/src/runs.test.tsx`（`useDeleteRun` / `useUpdateRun` 未导出）——**另一会话在途改动**（该文件工作树为 `M`，我的提交里从未出现它）。我改过的 6 个包 scoped `tsc --noEmit` 全干净。
3. **全仓 `pnpm test` 有环境类红**：`core` 的 git 重活 60s 超时（实测 `git --version` 588ms vs 仓库登记基线 350ms、`%TEMP%` 216329 个文件）、`api` 的 `cases-remote` 在 `afterEach` 删临时目录时 EPERM（Windows 文件锁）——逐包单跑全绿。两类都与本功能零交集。
4. **spec §9 第 1 条（非 Claude 名字 + `[1m]`）已通过**：真机 cc 行 + 直跑 CLI 双重证据；网关拒绝后缀名这一点**不构成风险**，因为后缀在 CLI 侧就被消化了。若将来换到会转发原始模型名的客户端，这条要重新验。
