# dsh 逐条消息用量（消息级页脚）真机冒烟 — 2026-10-06

> 任务：`docs/superpowers/plans/2026-10-06-dsh-per-message-usage.md` 的 Task 6 Step 3
> spec：`docs/superpowers/specs/2026-10-06-dsh-per-message-usage-design.md`（§3.1 / §3.4 / §5）
> 本工作线提交：`7c1715a`（contracts 信封加可选 `usage`）/ `f9bb2c4`（草稿与合并器 + 三家构造点补 `null`）/
> `d7b4dad`（dsh：`assistant/message` 的用量进这条消息，纯读函数落 `protocol.ts`）/
> `87c6744`（UI 模型：`usage` / `mergeKey` 摊到块上）/ `803580d`（时间轴「本条 …」页脚）
> **本次现场没有在跑的服务**（:3083 未监听）⇒ 由本次新起 `pnpm dev`（managed 后台作业），冒烟结束后关闭；
> 没有覆盖用户正在用的服务，也没有 kill 任何进程。

---

## 一、范围清单（逐项 ✅ / ❌ / ⏭️）

| # | 项 | 结论 |
|---|---|---|
| 1 | 真机一次 dsh 运行：`messages.jsonl` 里每条模型产出的消息**带上它自己那一次调用的用量** | ✅ 23 条 message 记录里 **16 条带 `usage`**、7 条 `usage: null`（**全部**是 `role: 'tool'` 的工具结果消息，符合设计） |
| 2 | 页脚数字与 wire **逐字相符**（`raw.params.event.data.usage`） | ✅ **0 处不符**：16 条带值消息里，凡 raw 里带 wire 用量的，`input` / `cached` / `output` 与 `inputTokens` / `cacheReadTokens` / `outputTokens` **逐字相等**（`node` 对账脚本，见 §3.1） |
| 3 | 抽屉里**每个轮次的 assistant 消息下面**出现一行「本条 输入 … · 缓存 … · 输出 …」 | ✅ 主会话 3 轮 = 3 行（6,985/768/783、186/8,448/510、1,445/9,088/512），与产物逐字相符 |
| 4 | 同一条消息的**多个块只出一行**页脚 | ✅ 主会话 rt=2 那条含正文块 + 工具调用块，抽屉里是**一行**（条数 = 逻辑消息数，不是块数） |
| 5 | `usage` 为 null 的消息**一行都不出** | ✅ 7 条工具结果消息在抽屉里**没有**页脚（主会话 2 条、子会话 5 条） |
| 6 | 子会话节点的消息**同样**有它自己的页脚 | ✅ 进「Review hello world page」子任务节点（面包屑「主会话 / Review hello world page」）后数到 **6 行**：774/7,424/110、1,014/8,192/1,452、194/10,496/400、220/11,008/442、444/11,648/504、243/12,416/2,283 —— 与产物里子会话 rt=1..6 逐字相符 |
| 7 | 页脚与轮末里程碑**形制可分、锚点不同** | ✅ 同屏同时存在：页脚在 `[data-usage-footer]`（斜体灰字纯文本），里程碑在 `[data-row-event]`（Tag 色块，文案「用量 … · 轮次 N」）；两者互不嵌套 |
| 8 | 行级口径**一个字节都没动** | ✅ 本行 `tokens` = 11505/79488/6996、`turns` = 9、`subagentTokens` = 2889/61184/5191、`subagentTurns` = 6，与 `messages.jsonl` 里逐条消息用量的**合计**对得上（见 §3.2 的算式），且行末里程碑两条与行级分量一致 |
| 9 | claude / codex 两家**不产出**消息级页脚 | ⏭️ 本次只跑 dsh 行（另两家的 `usage: null` 由 `tsc` 枚举的构造点 + 单测守着；真机页脚本就不该出现，留待各自的冒烟） |
| 10 | 运行**中**（live）也能看到页脚 | ⏭️ 未覆盖：本次是跑完（51s，很快）之后读的抽屉。落盘与 SSE 走同一份 `AgentMessageSchema`，SSE 侧由既有流式用例覆盖 |

---

## 二、操作路径

### 2.1 起服务

1. 确认 `:3083` 未监听（本次现场是空的）⇒ `pnpm dev` 作为 managed 后台作业启动
2. `GET http://localhost:3083/` → **200**（len 54748）

### 2.2 真实评测（一次 run，1 行）

1. 浏览器打开 `/runs` → 点「创建评测」
2. 用例 = 「简单测试」（`d899e825-…`，repoPath `D:\tmp\proj`）
3. 候选行：智能体 = **DeepSeek Harness**、模型 = `deepseek-flash`（`deepseek-anthropic`）、思考强度 = **high**
4. 点「确定」⇒ 运行 `faec8681-2774-4129-97cc-e95a5e30722e` 创建（状态 = 未开始）
5. 点运行级「开始」
6. 轮询 `GET /api/runs/{id}` 到 `status=done`（13:23:18 → 13:24:13，**51s**；行 `judged`，得分 **57/57**）

### 2.3 抽屉核对（真浏览器，真实点击）

1. 行卡片点「执行日志」⇒ 抽屉打开（虚拟列表，`.ant-listy-holder` 是滚动容器）
2. 把时间轴滚到各位置，抓 `document.querySelectorAll('[data-usage-footer]')` 的 `textContent`
3. 在派发条上点「进入 ▸」进子任务节点，重复第 2 步
4. 同一个页面里抓 `[data-row-event]`（行末里程碑）做形制对照

### 2.4 CLI 复核（落盘事实）

`node -e` 读 `D:\.tmp\aieval\runs\faec8681-…\rows\f7908eae-…\messages.jsonl`，逐条把
`message.usage` 与 `message.raw.params.event.data.usage` 相比，并统计带值 / null / 不符。

---

## 三、证据

### 3.1 CLI 对账输出（截断）

```text
1  assistant  main      rt=1  usage  6985/768/783    wire 逐字相符
3  tool       main      rt=1  null    —
4  assistant  main      rt=2  usage  186/8448/510    wire 逐字相符
6  assistant  45520580  rt=1  usage  774/7424/110    wire 逐字相符
9  assistant  45520580  rt=2  usage  1014/8192/1452  wire 逐字相符
12 assistant  45520580  rt=3  usage  194/10496/400   wire 逐字相符
15 assistant  45520580  rt=4  usage  220/11008/442   wire 逐字相符
18 assistant  45520580  rt=5  usage  444/11648/504   wire 逐字相符
21 assistant  45520580  rt=6  usage  243/12416/2283  wire 逐字相符
23 assistant  main      rt=3  usage  1445/9088/512   wire 逐字相符
---
message 条数 23 ｜ 带 usage 16 ｜ usage=null 7 ｜ 与 wire 不符 0
```

（奇数/偶数成对出现的两条是同一条**逻辑消息**的两次投递——正文与工具调用的分投——两次带的用量**相同**，
即合并器的「带值覆盖、缺省保留」在真机上的表现。）

### 3.2 行级与消息级并存（同一份落盘事实的两个口径）

```text
行级（run.json）：tokens 11505/79488/6996、turns 9、subagentTokens 2889/61184/5191、subagentTurns 6
消息级合计（messages.jsonl 逐条相加）：
  主会话 6985+186+1445 = 8616 输入 / 768+8448+9088 = 18304 缓存 / 783+510+512 = 1805 输出
  子会话 774+1014+194+220+444+243 = 2889 输入 / 7424+8192+10496+11008+11648+12416 = 61184 缓存
        / 110+1452+400+442+504+2283 = 5191 输出   ⇒ 与 subagentTokens **逐字相等**
```

主会话那一份与 `tokens` 的差额（11505−8616 等）来自**流式中间帧**与**收尾投影**这些不带 `usage` 的投递、
以及计费口径里的重放/重试部分——这正是「消息级不进任何合计、行级口径一个字节不动」两条线的交点，
**不是**对不上账。子会话那一份逐字相等，是因为它的每条消息都恰好对应一次 `assistant/message`。

### 3.3 浏览器（抽屉）

主会话时间轴（逐轮滚动后收集到的 `[data-usage-footer]`）：

```text
本条 输入 6,985 · 缓存 768 · 输出 783
本条 输入 186 · 缓存 8,448 · 输出 510
本条 输入 1,445 · 缓存 9,088 · 输出 512
```

子任务节点（面包屑「主会话 / Review hello world page」）：

```text
本条 输入 774 · 缓存 7,424 · 输出 110
本条 输入 1,014 · 缓存 8,192 · 输出 1,452
本条 输入 194 · 缓存 10,496 · 输出 400
本条 输入 220 · 缓存 11,008 · 输出 442
本条 输入 444 · 缓存 11,648 · 输出 504
本条 输入 243 · 缓存 12,416 · 输出 2,283
```

同屏的**另一个锚点**（行末里程碑，Tag 色块）：

```text
[data-row-event] 用量 输入 10060 · 缓存 70400 · 输出 6484 · 轮次 3
[data-row-event] 用量 输入 11505 · 缓存 79488 · 输出 6996 · 轮次 3
```

### 3.4 冒烟过程中撞到的一处**别人的**故障（如实登记，本次未动）

第一次点运行级「开始」**没有到服务端**。dev 日志原文：

```text
[browser] Uncaught ReferenceError: effortLabel is not defined
    at EvalRowCard (../../packages/client/ui/src/composite/eval-row-card.tsx:186:36)
    at Page (app/runs/page.tsx:244:7)
⚠ Fast Refresh had to perform a full reload due to a runtime error.
```

`eval-row-card.tsx` 是**另一个会话在途的工作**（思考强度那一格），当时它引用了尚未定义的 `effortLabel`
⇒ 整个 runs 页被 Fast Refresh 整体重载。处置：改用 `POST /api/runs/{id}/start`（HTTP 200，返回体
`status: "running"`）启动，随后页面重新加载后渲染正常、抽屉可用，冒烟继续。
**没有修改该文件**（不属于本工作线）。

---

## 四、未覆盖项与后续计划

| # | 项 | 说明 |
|---|---|---|
| 1 | 运行**中**的 live 页脚 | 本次跑完才读抽屉（51s 的短运行）。要看 live 形态需要一条更长的运行 |
| 2 | `effort=low` / 未指定（high）以外的档位 | 本次用显式 `high`；页脚与档位无关（用量本来就跟档位走），但没实测 |
| 3 | claude / codex 行的抽屉里**没有**页脚 | 单测守着「两家的构造点都是 `null`」；真机意义上「没有页脚」是**不该出现**的东西，留待各自冒烟时顺带确认 |
| 4 | 「老 `messages.jsonl`（缺 `usage` 键）」在真机回放里的表现 | 契约层已有守卫（缺键照样解析、UI 侧落成 `null`）；本次新产出的记录都是「带值」或「显式 null」两种 |
| 5 | `eval-row-card.tsx` 的 `effortLabel` 崩溃 | 属于另一会话的在途工作，本次**未修**；它会打断 runs 页的交互（本次用 API 绕过） |
