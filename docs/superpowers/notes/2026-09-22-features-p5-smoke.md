# p5 冒烟记录（评测页：列表 + 右栏 + 三个抽屉 + 行级 SSE）

> 计划：`docs/superpowers/plans/2026-09-22-features-p5-runs.md` Task 11 Step 8。
> 执行：2026-09-26 00:48–01:10（本机 `Asia/Shanghai`），分支 `feat/features`，基线 `be40487`。
> **只记实测值**：每条都能指向证据（浏览器里的 URL/文案/几何量、HTTP 请求、CLI 输出、磁盘文件）。
> 读不出实测值的写「未执行 + 原因」。

## 0. 环境与隔离

- 隔离配置目录：`C:\Users\ZHANGL~1\AppData\Local\Temp\aieval-p5-smoke-4fd2d6035d30432faa6851272ee6e96b\config.json`
  （`AIEVAL_CONFIG_DIR` 指到它；**全程不碰真实 `~/.aieval`**）。
- 工作区根：同一目录下的 `ws\`；被测仓库：同目录下的 `repo\`（真 `git init` + 一次提交 `bcc0016b`）。
- dev 服务：`pnpm dev`（`next dev -p 3083`，Turbopack），启动日志含 `[instrumentation] 服务启动：已完成被中断候选行的恢复 { recovered: 0 }`。
- 浏览器：MCP Playwright（Edge），视口 1438×900（第 8 项期间缩到 1438×480 复测）。
- 两个供应商：`p-ant` / `p-oai`（假网关 `gw.example.com`，用于界面链路）；`p-relay`（**真实可达**：本机 `cc-switch` 中继 `http://127.0.0.1:15721`，只讲 Anthropic Messages）。

## 1. 逐项结果

| # | 操作 | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| 1 | 打开 `http://localhost:3083/` | 落到 `/runs`，顶栏「评测」高亮 | URL 变 `http://localhost:3083/runs`；`.ant-menu-item-selected` 文本 = `评测`；控制台唯一 error 是 `GET /favicon.ico 404`（脚手架既有，非本批引入） | **通过** |
| 2 | 打开 `/runs`（无评测） | 空态 + 引导按钮 | 「还没有评测 / 先创建一个用例，再用它开一轮评测」+ 工具栏与空态各一个「创建评测」按钮 | **通过** |
| 3 | 点「创建评测」 | 右栏出现表单，URL 变 `?panel=new` | URL = `/runs?panel=new`；表单标签实测 `["用例","执行模式","智能体","模型"]`，执行模式默认勾选 `并行`，候选行默认 `Claude Code` | **通过** |
| 4 | 默认行选「Claude Code」 | 模型下拉只有 anthropic 供应商的模型 | 可见选项 = `["claude-opus-4-6手工维护"]` | **通过** |
| 5 | 换成「Codex」 | 下拉变 `gpt-5`（自动拉取），上一行选的 anthropic 模型被清空 | 切换后模型 Select 文本回到占位「选择模型」；可见下拉 = `["gpt-5自动拉取"]`，**不含** `claude-opus-4-6` | **通过** |
| 6 | 删掉唯一候选行后点「创建评测」 | 出现「至少需要一个候选行」，且没有 POST | 表单文本含「至少需要一个候选行」；网络记录里 `/api/runs` 只有 2 条 **GET**（列表 + model-options），**无 POST** | **通过** |
| 7 | 选回一行并提交 | 右栏切详情；列表最上面出现该轮（未开始） | URL → `?panel=detail&id=48edfddc-…`；列表首行 `多协议入站转换 未开始 1 串行 2026-09-26 00:50`；网络 `POST /api/runs → 201`；磁盘出现 `ws\48edfddc-…\run.json`（`status: idle`、`executionMode: serial`、行 `pending`） | **通过** |
| 8 | 详情顶部信息行 + 吸底栏 | 四项齐全；吸底栏固定在右栏可视区底部 | 顶部行 = `多协议入站转换 · <repoPath> · 默认分支 HEAD · <workspaceBase>` 四项齐全；`getComputedStyle(footer)` = `position: sticky` / `bottom: 0px` / **`padding: 0px`**；6 张卡片时宿主 `scrollHeight 1028 > clientHeight 730`，`scrollTop=0` 与 `scrollTop=99999` 两次量的 `footer.bottom` 都是 **892.0**（视口 900）⇒ 真滚动下不动 | **通过**（同时是 M6 的肉眼结论，见 §3） |
| 9 | 点「开始」 | 确认框列出将执行的候选 | 弹窗文本逐字：`开始执行这一轮评测？ / 执行模式：串行（一行跑完含评分，才起下一行） / 本次将执行 1 个候选： / · Claude Code · claude-opus-4-6 / 取消 开始` | **通过** |
| 10 | 点「取消」；CLI 改 `run.json`（行 running + diff 摘要）后刷新 | 卡片变「执行中」并出现「diff 已截断」 | 卡片文本 = `… diff 已截断 / 执行中 / 分支 test/… / tok 2,000 / 轮次 3 / 耗时 45s / 得分 未评分`；串行进度 `0/6 已完成`、`role="progressbar"` 的 `aria-valuenow = "0"` | **通过** |
| 11 | 打开「代码改动」抽屉 | 与 CLI 的 `git diff` 一致 | CLI：`git status --porcelain` = ` M a.ts` / `?? c.ts`，`git diff HEAD` = 单段 `a.ts` hunk。抽屉：`共 2 个文件 · +2 −0`、文件表 `a.ts 1/0`、`c.ts 1/0`，正文含 `### 已提交改动（f565c0f190897f420e47ed1d76daab1f47af16e0..HEAD）（无）`、`### 未提交改动（工作区 vs HEAD）`（`a.ts` 那段与 CLI **逐字相同**）与 `### 未跟踪文件 c.ts`（api 的 `add -N --all` 让新文件正文也进来了）；`baselineCommit` 用的是快照里那个 40 位 hash | **通过** |
| 12 | 打开「执行日志」抽屉，再用 CLI 逐条追加事件 | 先显示历史，随后**实时**出现新行（走 `/stream`） | **历史 ✓**：抽屉显示 `[00:52:13] 状态 执行中` / `[00:52:14] stdout 第一行输出：开始读代码`（`at` 是 16:52Z，渲染成本机 `00:52`）。**实时 ★ 不成立**：CLI 追加 seq 3 之后抽屉文本不变（原因见 §2 —— 两条：① 跨进程追加本来就不进进程内总线，R6 明写；② 真实跑的 6913 条事件也一条没到，见 §2 的模块实例缺陷） | **部分通过**（历史通过；实时**未通过**，缺陷在 `@aieval/api` / `@aieval/evaluator`，不在本批可改范围） |
| 13 | 追加一条 `end` 事件 | 抽屉保留全量；随后出现一次 `GET /api/runs/<runId>` | **全量 ✓**：真实跑完那一轮抽屉 6969 行 / 1,515,609 字符，末三行 = `状态 评分中` / `评分 总分 20 · claude-haiku-4-5` / `状态 已评分`，最后一行 `结束 completed`。**终态→mutate ✓（但走的是轮询）**：卡片收敛为 `第 1 名 … 已评分 … 得分 20`，网络里 `GET /api/runs/<id>` 每 3 秒一次（`refreshInterval: 3000` 的兜底）；**SSE 终态帧那条路是死的**（同 §2） | **部分通过** |
| 14 | 点「下载」 | 落下一个 `.log`，内容与抽屉一致 | 真下载到 `D:\zhanglei1120\Github\deepseek-harness\.playwright-mcp\row-8b781d42-2511-4bbf-be44-b164d4f3d176.log`；`6969` 行 / `1515609` 字符，**与抽屉逐字相等**（头两行 = `[00:55:24] 状态 准备中` / `[00:55:26] 状态 执行中`） | **通过** |
| 15 | 访问 `?panel=detail&id=不存在的id` | 右栏显示「评测不存在或已被删除」，不白屏 | 右栏 = 「评测不存在或已被删除 / 它可能被手工清理过；回到列表重新选择一轮 / 回到列表」，左栏列表完好。另跑了 4 种脏 URL：`?panel=foo`、`?id=`、`?panel=detail`（无 id）⇒ **右栏不出现**（`[role=group][aria-label=详情]` 不存在，列表仍占满）；`?panel=foo&id=<有效>` ⇒ 详情；`?panel=new&id=<有效>` ⇒ 创建表单（id 被忽略） | **通过** |
| 16 | 点单行的「终止」 | 弹 `Popconfirm`；确认后发 POST | **POST ✓**：网络记录 `POST /api/runs/48edfddc-…/rows/6ffdbd1b-…/abort → 200`，行状态由 `running` 变 `canceled`，卡片改显示「已终止」且不再有终止按钮。**Popconfirm ✗**：`EvalRowCard` 的终止按钮是裸 `Button onClick={onAbort}`，**没有 `Popconfirm`**——一次点击直接杀，实测两次都是如此（见 §4 发现 F2）。对照：整轮终止（吸底栏）的 Popconfirm 实测渲染出「终止这一轮评测？ / 正在跑的 agent 子进程会被杀掉，且不可撤销。/ 取消 确定」，点「取消」后浮层关闭且状态零变化 | **部分通过**（请求链路通过；确认框**未通过**） |

### 1.1 控制方追加的两条复核

| 复核 | 结果 |
|---|---|
| ① 日志抽屉开着时点「重跑」⇒ 新一轮头几条**立刻出现** | **按字面不可达 + 实时通道已死，改验等价路径**。不可达的理由（几何实测）：抽屉 `size="large"` 的内容宽 **736px**，右边缘到视口右界（x 702→1438），正好盖住右栏与吸底栏；`document.elementFromPoint(开始按钮中心)` 返回 `DIV.ant-drawer-body` ⇒ 抽屉开着时点不到「开始/终止」。等价路径（可测且通过）：先让抽屉显示旧一代（2 条）→ CLI `resetEvents`（删文件）+ 追加新一代 seq 1/2 → 重开抽屉 ⇒ 抽屉**只有**新一代那 2 行（`新一轮的第一行（重跑之后）`），旧一代的 `第一行输出：开始读代码` **不在**（逐字断言 `hasOldGeneration: false`）。B4 的同连接「新一代」判定另有单测（`row-stream.test.tsx` 两条） |
| ② 创建表单选「串行」提交后，详情页显示串行 | **通过**。URL → `?panel=detail&id=48edfddc-…`；列表首行执行模式列 = `串行`；详情顶部出现串行进度条（`0/6 已完成`）与吸底栏 `串行 · 共 6 行`；磁盘 `run.json` 的 `executionMode = serial` |

## 2. 真实跑一轮：跑了，而且跑通了（同时暴露一个高危缺陷）

**授权与凭据**：本机唯一可达的网关是 `cc-switch` 本地中继 `http://127.0.0.1:15721`（p3 探测报告 §1 记录，凭据由中继自己管理，`apiKey` 传 `PROXY_MANAGED`；claude-code 适配器把它写进 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`）。实测先单独打了一发 `POST /v1/messages` → **200**，才把它配成 `p-relay` 供应商。

**跑法与结果**（用例「冒烟：给 a.ts 加一行注释」，1 行候选，claude-code + `claude-haiku-4-5`，默认评分模型同款）：

```
run.status = done        row.status = judged
tokens = { input: 27891, cached: 414720, output: 8714 }   turns = 16   durationMs = 93286
diff   = { filesChanged: 0, insertions: 0, deletions: 0, truncated: false }
score  = { totalScore: 20 }        error = null
events.jsonl = 6913 行 / 2,122,167 字节，最后一条是 end
```

- 编排层真实动作（dev 日志逐条）：`[runs] 创建评测` → `[evaluator] 评测开始` → `[git] 用例缓存已克隆` → `[workspace] 清理上一轮的行产物` → `[git] 行分支已建立 { branch: test/8b781d42-…, baselineCommit: bcc0016b84fcfdfc6b9a72badee016fe862cea4d }` → `[workspace] 行工作区已就绪`。
- 界面：卡片实时显示 `执行中` → 收敛为 `第 1 名 | 已评分 | tok 36,605 | 轮次 16 | 耗时 1m33s | 得分 20`；抽屉里 7 种事件类型**全部**渲染过（`状态/日志/用量/改动/评分/结束` + `stdout` 原文）。
- **这一轮是本阶段唯一的真实端到端证据**，也正因为它是真的，才暴露了下面这条单测永远测不到的缺陷。

### 发现 F1（High，不在本批可改范围）：`R6` 的「进程内事件总线」在 Next 下不成立 ⇒ 行级 SSE 零交付

- 现象：真实跑那一轮在 16:55:32 打开日志抽屉（网络记录 `GET …/stream?afterSeq=2` 保持打开约 100 秒），期间编排层向 `events.jsonl` 写了 6913 条事件，**抽屉一直停在打开那一刻 `/log` 拿到的 2 条**（`logChars = 35`，反复量了 5 次都没变）。
- 判据（不靠猜）：用一条**临时探针**（`apps/web-next/src/zz-instance-probe.ts` 导出一个随机串，两条路由各自把它塞进响应头）实测：

  | 路由 | `x-instance-probe` |
  |---|---|
  | `GET /api/runs` | `394dl10h` |
  | `GET /api/runs/model-options` | `2774gmjy` |

  ⇒ **Next dev（Turbopack）给每个 route handler 一份独立的模块实例**。`@aieval/evaluator` 的 `subscribers`（`events.ts:37`）与 `@aieval/core` 的其他模块级状态因此**不跨路由共享**：`POST /start` 在自己的实例里 `publishRowEvent` 扇出，`GET /stream` 在另一个实例里订阅 —— 谁也收不到谁。探针跑完已删除，两个路由文件按 `git cat-file blob e7714d3:<path>` **逐字节还原**并核对哈希（`cb23ec9e…` / `909826c7…`，与提交里的 blob 一致）。
- 影响面（同一根因）：`run-root-memory.ts` 的 `runRoots`（R10 的写侧兜底）同样按路由各存一份；凡是以「模块级单例」跨 route handler 共享状态的假设都不成立。
- 为什么单测测不到：Task 10 的路线测试把 `@aieval/evaluator` 整块 mock、api 的 `streamRowEvents` 测试直接在**同一实例**里调发布与订阅、client 的 `useRowStream` 测试用假 `EventSource` —— 三者都绕过了真实进程里「一张路由一张图」这个事实。
- 修法方向（留给整阶段评审裁决）：事件总线与根目录记忆改成锚在 `globalThis` 上的单例（或把总线挪到与路由图无关的进程级通道），并**在 `next build && next start` 下复测**（本记录只实测了 dev；prod 的产物布局同样是每路由一个 chunk，风险大概率相同，未验证）。
- 与终端态的关系：Terminal 后「关连接 + mutate 一次快照」这段（spec §8.3）同样走不到，界面靠 `refreshInterval: 3000` 的轮询兜底收敛（实测 3 秒一次 `GET /api/runs/<id>`，卡片最终显示 `已评分/得分 20`）。所以**症状是「延迟最多 3 秒」而不是「永远不更新」**，这也是它更难被发现的原因。

### 勘误（2026-09-26，p5 整阶段评审推翻本节根因；**原文保留不改**）

上面这一节的**观测**（抽屉停在 `/log` 拿到的 2 条、`logChars` 反复量都不变、终态靠 3 秒轮询收敛、
探针读到的两个 id 不同）都是实测事实，仍然有效；**但「判据」与「修法方向」两段是错的**：

- **被推翻的结论**：「Next dev（Turbopack）给每个 route handler 一份独立的模块实例 ⇒
  `subscribers` / `runRoots` 不跨路由共享 ⇒ R6 的进程内总线在真实服务里不成立」。
- **真实根因**：api 的 `toFrame`（`packages/server/api/src/run-stream.ts:43`）发的是**具名** SSE 事件
  （`event: <type>`），而客户端只绑了 `next.onmessage`（`packages/client/client/src/row-stream.ts`）——
  SSE 规范规定 `onmessage` **只收无名（默认）事件**，于是 7 种事件在浏览器里**一个接收者都没有**。
  历史靠 `/log`、终态靠 3 秒轮询兜底，所以症状只表现为「实时通道没有」，看起来像「慢一点」。
- **推翻它的关键证据**（评审者独立实测，dev 与 prod 各一遍；完整清单见
  `.superpowers/sdd/2026-09-22-features-p5-runs/phase-review-report.md` §3）：
  1. 模块实例探针在两条不同路由里 id **完全相同**（dev `n24n48l6`/pid 61200，prod `fynjv4za`/pid 71844）
     ⇒ 不存在「每路由一份模块实例」；prod 产物里两条路由共用同一个 chunk。
  2. 同一进程内用 curl 订 `/stream`，在 `POST /start`、`POST /abort`（**不同的 route handler**）
     之后**收到了实时帧**（dev 2089B / prod 2068B）⇒ R6 的进程内总线在真实服务里成立。
  3. 同一个浏览器、同一个 URL、同一时刻：只绑 `onmessage` → **零帧**；加绑
     `addEventListener('status'|'end'|…)` → 帧全到（`lastId` 依次 1、3、4）⇒ 根因在**投递契约**。
  4. 无总线的纯 SSE 探针路由在浏览器里逐步到达 9 个 chunk ⇒ 传输、压缩、Next 流式响应都正常。
- **因此**：本文档 §2 原先建议的「把 `subscribers` / `runRoots` 锚到 `globalThis`」**修不好 F1**
  （总线本来就跨路由共享）。该方向对 dev 的模块图换代（Turbopack 重编译，评审编号 **L4**）仍然有效，
  但它是另一个问题，且只影响 dev。
- **修法与验收**：客户端按事件名订阅 + 测试替身补齐浏览器语义，验收标准见评审报告 §3.5（dev 与 prod
  各跑一遍）；契约 §11 已据此新增 **R38**（SSE 的投递契约与订阅时机分开裁决）。修复波的结果见
  `.superpowers/sdd/2026-09-22-features-p5-runs/phase-fix-report.md`。

### 发现 F2（Medium）：单行「终止」没有确认框
- `packages/client/ui/src/composite/eval-row-card.tsx:111` 是 `<Button danger onClick={onAbort}>`，没有 `Popconfirm`；而 `run-detail-panel.tsx` 的整轮终止有。实测两次：点一下即发 `POST …/abort` 并把该行置 `canceled`（不可撤销）。
- 规格口径：B4 的 `RunDetailPanel` 文件头写的是「「终止」用 `Popconfirm`（它杀进程、不可撤销）；单行的终止在卡片上，**同一套语义**」——单行这一侧没做到。
- 不在本批可改范围（`packages/client/ui/**` 本批只允许动 `run-create-panel.test.tsx`），交整阶段评审。

### 观察 F3（Low，登记不判缺陷）：`connected` 徽标的两个时间窗

1. **连接已建立但还没吐第一个字节时显示「未连接」**：SSE 响应头要等第一次 `controller.enqueue` 才 flush（实测：抽屉刚打开时 `/stream` 在 DevTools 里 pending、徽标「未连接」；第一次收到帧或第一次 15s 心跳之后才变「实时连接中」）。空历史 + 无新事件时最长约 15 秒。
2. **抽屉关掉后 `connected` 不复位**：`useRowStream` 的 effect 在 `enabled === false` 时直接 `return`，没有把 `connected` 置回 false，于是关抽屉后徽标状态留在上一次的值（页面组件不随抽屉卸载）。抽屉本身被 `destroyOnHidden` 卸载，所以只有重新打开那一刻会看到一次陈旧值。

### 观察 F4（Low）：`events.jsonl` 的 O(n²) 追加重放

真实跑产生了 6913 条事件 / 2.1 MB，其中绝大多数是 claude-code 的 `thinking_tokens` 逐条 stdout。`appendEvent` 每次追加都要整文件回读定 seq（R17 已登记的取舍），实测这一轮的后段明显变慢（同一秒内事件数从个位数掉到需要跨秒），期间并发的 `GET /api/runs/<id>` 出现一次 ~1.9s 的响应。本轮不影响正确性，p6 若跑更长的 agent 需要留意。

## 3. M6 边界（B5 上报的唯一存活变异体）：真实页面肉眼结论

- 变异体「吸底栏去掉 `padding: 0`」在 jsdom 里无法被真实断言（写 `style.padding === '0px'` 等于把实现抄进测试），故按控制方裁决改到真实页面看。
- 实测：`getComputedStyle(document.querySelector('[data-testid="run-footer"]')).padding === '0px'`（`position: sticky`、`bottom: 0px`）。视口缩到 1438×480、候选卡片撑到 6 张（宿主 `scrollHeight 1028 > clientHeight 730`）时，`footer.bottom` 在 `scrollTop=0` 与 `scrollTop=99999` 两次读数都是 **892.0 ≤ 900**（480 那次是 472.0 ≤ 480）。
- 结论：**实现是对的**（`padding: 0` 真的生效、吸底也真的不动），M6 维持「已登记边界、不在单测里补」的裁决。

## 4. 未做项与后续计划

1. **R10 的未做项（必须关账）**：读侧只扫当前 `settings.workspaceRoot`。实测：`PUT /api/settings { workspaceRoot: <ws2> }` 之后 `GET /api/runs` 返回 `[]`、`GET /api/runs/<id>` 返回 `404 {"code":"NOT_FOUND","message":"评测不存在：…"}`——**产物明明还在旧根目录下**（`ws\1731ff2f-…\run.json` 一直在）。把根目录改回去即恢复（实测列表重新出现该轮、详情 200）。跨重启 + 改过根目录的旧轮次因此**既不在列表也 `getRun` 不到**，与契约 §11 R10 的裁决逐字一致。需要新增「已知根目录索引」这个落盘物才能修，本阶段不做。
2. **F1（行级 SSE 零交付）**：见 §2，属 `@aieval/api` + `@aieval/evaluator` 的接缝，需要整阶段评审裁决修法，并在 prod 模式复测。
3. **F2（单行终止无确认框）**：见 §2，属 `packages/client/ui`。
4. **未执行**：`next build && next start`（prod 模式）下的同一组冒烟——需要额外一次完整构建，本批没有余量；F1 的 prod 复测与它合并做。
5. **未执行**：真实 codex / dsh 的候选行（本机只有讲 Anthropic Messages 的中继；p3 探测报告已登记 codex 网关不可达）。本批的真实跑只覆盖了 claude-code 一家。
6. **未被自动化覆盖**：`stream/route.ts` 的 `dynamic` / `runtime` 段配置现在有断言（本轮补的），但「SSE 在真实服务里真的会把帧推给浏览器」这条**没有**任何自动化守卫 —— 正是 F1 溜过去的地方；建议随 F1 的修法补一条真实服务的集成用例。
