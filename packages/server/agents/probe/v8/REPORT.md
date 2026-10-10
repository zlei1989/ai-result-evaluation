# v8 探针报告：思考强度在两协议上**真的生效**吗（2026-10-07）

**一句话结论**：**「被接受」有据、「生效」只有 `off` 这一侧有据。**
六行全 200、承载字段名与预期一致 ⇒ `reasoning_effort` / `output_config.effort` / `thinking:{type:'disabled'}`
三个字段名**都被网关接受**；`off` **确证关掉思考**（0 字符 vs 非 off 的 8 格读数全部有思考内容，定性差异）；
但 **`low` 与 `max` 的强度效力在本机未能证实**——补样本后 openai 侧两组读数**区间重叠**、还出现过方向相反的
读数，anthropic 侧只有 n=1/组且比值（2.70×）**低于**已观测最大同档抖动（3.80×）。
另有一条新发现的**未闭合项**：`MAX_TOKENS = 4096` 会在难题上截断 anthropic 侧高档位的思考（见「未闭合」）。

> 本报告在 2026-10-07 评审后**改过一次结论口径**：此前写的「区间不重叠 ⇒ 档位确证生效」被控制器补跑的
> 第三组样本推翻（详见「难题对照」）。凡「确证 / 证实」二字，下面都注明 **n/组**与所用统计量。

## 要回答的问题

`text-api.ts` 的 JSDoc 里有一句「非 DeepSeek 网关未实测」；本探针让**本机这条 DeepSeek 路由**从此有实测
（**非 DeepSeek 网关仍未验证**）。判据**不是「200 被接受」**（本仓 codex 侧踩过「参数到了、
网关照样按自己的默认强度推理」，见 `docs/faq/codex.md` 与 `probe/v4` 的 reasoning 系列），而是：

1. 六行主表里的**状态码**：字段是被收下，还是被 400 / 422 顶回来（⇒ 哪些字段被接受）；
2. 同一协议内 `low` 与 `max` 的 reasoning **字符数是否可区分**（要写明 n/组与统计量）；
3. `off`（两协议同一个形状 `thinking: { type: 'disabled' }`）那两次**没有** reasoning 内容。

## 跑法

```powershell
$env:AIEVAL_PROBE_GATEWAY_API_KEY = '<本机 key>'   # 只从环境变量读，不写进任何文件
node packages/server/agents/probe/v8/judge-effort.mjs
```

- 模型 `deepseek-flash`；主表问题与 brief 逐字一致（`用一句话说明 2+2 为什么等于 4`）；整轮 `exit=0`；
- 路由：脚本**只保证 DeepSeek 的三条形状**——裸根 `https://api.deepseek.com`（**生产实际用的就是这条**，
  `text-api.ts:135-139` 去尾斜杠后拼 `${base}/chat/completions`）、OpenAI 惯用的 `…/v1`、anthropic 路由
  `…/anthropic`——都能还原出同一对协议 base（`<根>/chat/completions` + `<根>/anthropic/v1/messages`）；
  非 DeepSeek 网关用 `AIEVAL_PROBE_ANTHROPIC_BASE_URL` 显式指定。（评审前这里因为「剥 `/v1` 再拼
  `/v1/messages`」而**对 DeepSeek 推出错误的 anthropic base**，已修，见文末「脚本改了什么」。）
- ⚠️ **不要用 `| Select-Object -First N` 截断 stdout**：管道提前关闭会让 node 以非 0 退出，看起来像探针失败；
- ⚠️ anthropic 侧重跑难题对照要加 `AIEVAL_PROBE_MAX_TOKENS=16384`（默认 2048 会把思考截断，见「未闭合」）；
- 429 / 5xx 与网络异常**各重试一次**（2s 后），重试次数落进读数；数值型环境变量写错会直接报错，不静默变 NaN；
- 附加探针（噪声基线 / `budget_tokens` / 按需难题对照）默认开，`AIEVAL_PROBE_EXTRA=0` 只跑六行主表。

**操作提示**：手工补样本时若把 `off` 当成 `reasoning_effort` 的**取值**发出去（`reasoning_effort: 'off'`），
上游会回 **422**——那是取值写错，**不是上游对 `off` 档的行为**。生产代码与探针都不发这个取值
（`off` 走 `thinking: { type: 'disabled' }`，主表 `openai/off → 200` 即证）。

## 六行主表（原始读数，脚本批次）

| 协议 | 档位 | 状态码 | reasoning 是否存在 | 字符数 |
|---|---|---|---|---|
| openai | low | 200 | 是 | 702 |
| openai | max | 200 | 是 | 935 |
| openai | off | 200 | 否 | 0 |
| anthropic | low | 200 | 是 | 155 |
| anthropic | max | 200 | 是 | 460 |
| anthropic | off | 200 | 否 | 0 |

逐行附注（承载字段 / `stop`）：

| 协议 · 档位 | 承载字段 | `stop` |
|---|---|---|
| openai · low / max | `message.reasoning_content` | `stop` |
| openai · off | —（没有 reasoning 内容） | `stop` |
| anthropic · low / max | `content[].thinking` | `end_turn` |
| anthropic · off | —（没有 reasoning 内容） | `end_turn` |

`off` = `thinking: { type: 'disabled' }`（两协议同一个形状）；`low` / `max` = openai 侧 `reasoning_effort`、
anthropic 侧 `output_config.effort`。**六行全 200：三个字段名没有一个被 400 / 422 顶回来。**

⚠️ 主表这一轮用的是**简单题**，它只能当冒烟：档位差在这一轮里读出来的是 1.33×（openai）/ 2.97×（anthropic），
而补样本后同档抖动就有 1.7~3.8 倍（见「噪声基线」）⇒ **这两行的档位对照不足以支撑任何结论**。

## 附加读数

来源分两类，逐表标注：**【脚本批次】** = `judge-effort.mjs` 默认跑出来的；**【控制器手跑】** = 控制器在脚本之外
补的样本（请求体与题目与脚本逐字一致）。

### 【脚本批次】噪声基线复跑 + `budget_tokens`

| 协议 | 档位 | 状态码 | reasoning 是否存在 | 字符数 |
|---|---|---|---|---|
| openai | low（复跑·噪声基线） | 200 | 是 | 297 |
| anthropic | low（复跑·噪声基线） | 200 | 是 | 420 |
| anthropic | low + `budget_tokens: 1024` | 200 | 是 | 269 |
| anthropic | low + `budget_tokens: 8192` | 200 | 是 | 324 |

### 【控制器手跑】噪声基线（简单题每组 3 次，含主表那次；与上面那两行复跑是各自独立的采样，未合并）

| 协议 | 档位 | 三次读数 | 均值 | 同档极差 |
|---|---|---|---|---|
| openai | low | 702 / 290 / 224 | 405 | **3.13×** |
| openai | max | 935 / 523 / 540 | 666 | 1.79× |
| anthropic | low | 155 / 377 / 589 | 374 | **3.80×** |
| anthropic | max | 460 / 794 / 555 | 603 | 1.73× |

⇒ 档间均值比 **1.64×**（405→666）与 **1.61×**（374→603）**小于同档自身的极差 3.13× / 3.80×**
⇒ **简单题上判不出档位**；主表那一次的「可区分」是**假阳性**（脚本的初判给 1.33× / 2.97× 判了比值达标，
并据此**跳过**了难题对照——评审后已把跳过条件改成「差额必须超过同档抖动」）。

### 【控制器手跑】`budget_tokens` 另一批

1024 → 269 字符、8192 → 324 字符，比值 **1.20×，落在噪声内** ⇒ 与官方兼容表「`budget_tokens` 被忽略」
**一致**。**n=1/组**，不构成证实。

### 难题对照（题目用脚本里的 `HARD_PROMPT`，多步推理题）

**【控制器手跑】**，两批：第 1 批 `AIEVAL_PROBE_BASE_URL` 未设（裸根，同生产）、第 2 批走生产形状的
`…/v1/chat/completions`；anthropic 侧第 2 批加了 `AIEVAL_PROBE_MAX_TOKENS=16384`：

| 路径 | 档位 | 读数 | `stop` |
|---|---|---|---|
| 裸根 | openai · low | 30,929 / 73,979 | `stop` / `stop` |
| 裸根 | openai · max | 104,192 / 165,122 | `stop` / `stop` |
| `/v1` | openai · low | 30,690 | `stop` |
| `/v1` | openai · max | **23,548** | `stop` |
| anthropic（`max_tokens=2048`） | low | 6,936 | **`max_tokens`** |
| anthropic（`max_tokens=2048`） | max | 7,279 | **`max_tokens`** |
| anthropic（`max_tokens=16384`） | low | 11,476 | `end_turn` |
| anthropic（`max_tokens=16384`） | max | 30,984 | `end_turn` |

**openai（合并三批，n=3/组）**：`low ∈ [30,690, 73,979]`（均值 45,199）、`max ∈ [23,548, 165,122]`（均值 97,621）
⇒ **两组区间重叠**，且 `/v1` 那一轮的 max（23,548）**比同轮 low（30,690）还短**——方向相反。
统计量：均值比 2.16×，而 max 同档极差 **7.01×**（165,122 / 23,548）⇒ 均值比也**不成立**。
（只看裸根那两批时：相邻间隔比 104,192 / 73,979 = **1.41×**，低于同档极差 2.39×（low 73,979 / 30,929）
与 1.58×（max 165,122 / 104,192），只有均值比 2.57× 刚超过——补进 23,548 后连这个也不成立。）

**anthropic（n=1/组）**：`max_tokens=16384` 时 11,476 → 30,984，比值 **2.70×**，两次都 `end_turn`（没截断）
⇒ **方向一致**，但 2.70× **低于**已观测最大同档抖动 **3.80×** ⇒ 也说不上证实。
`max_tokens=2048` 时 low 6,936 ≈ max 7,279（几乎相同），两次都 `stop=max_tokens` ⇒ 档位差被上限**折平**。

## 结论（逐条给证据强度）

1. **三个字段名被接受**——有据：六行 + 附加全 200，无 400 / 422；承载字段是 `message.reasoning_content`
   与 `content[].thinking`。**「被接受」到此为止，不要读成「生效」。**
2. **`off` 真的关掉思考——确证**：两协议都 **0 字符**，而同一轮里 **8 格非 off 读数全部有思考内容**
   （后续手跑的采样亦然）。这是**定性 / 存在性差异**，不受采样抖动影响 ⇒ 这条结论从此有本机事实。
3. **`low` 与 `max` 的强度效力——未能证实**：openai 侧区间重叠 + 反向读数（n=3/组，均值比 2.16× 低于同档极差 7.01×）；
   anthropic 侧 n=1/组、2.70× 低于同档抖动 3.80×。同档抖动（1.6~3.8×）**不小于**档间差；
   每格样本只有 1~3 个。**要证实需要更多样本（每种组合 ≥8~10 次、按同档抖动定样本量），本探针不做。**
4. **`budget_tokens` 被忽略——与官方口径一致，未能证实**：1024 → 269 / 8192 → 324（1.20×，噪声内），**n=1/组**。
5. **方法学（重要）**：**简单题分辨不出档位**（同档抖动 ≥ 档间差）⇒ brief 那句「`low` 与 `max` 的 reasoning
   长度可区分」的判据必须补两句：**① 要在多步推理题上测；② 差额要超过同档抖动、并写明 n/组与统计量**。
   单样本比值只能当初筛——本探针的机器初判正是在这里**假阳性**了一次。

## 未闭合（照实登记，**本任务只测量不修改**）

**`MAX_TOKENS = 4096` 会在难题上截断 anthropic 侧高档位的思考。**
`packages/server/evaluator/src/text-api.ts:96` 是 `const MAX_TOKENS = 4096`，`:188` 把它用作
**anthropic 分支的 `max_tokens`**（openai 分支不传 `max_tokens`，故不受影响）。而 Anthropic 协议下
**思考块与正文共享这个上限**：探针在难题上量到 anthropic 的思考有 **30,984 字符**，`max_tokens=2048` 那组
两次都 `stop=max_tokens`、且 low 6,936 ≈ max 7,279（档位差被折平）⇒ 真实评分里 `max` / `high` 档会被 4096 截断，
即「配置了高强度、实际效果被上限吃掉」。

- **换算依据（这是 chars → token 的推断，不是直接读数）**：`4096` 是 **token** 上限，`30,984` 是**字符数**，
  两者不同量纲，本探针**没有**测 token 数 ⇒ 本报告能直接给出的只有**观测上限**（都在上面的表里）：
  · `max_tokens=2048` 那组的 6,936 / 7,279 字符两次都以 `stop=max_tokens` 收场（思考与正文共享这个上限）
    ⇒ 那一组实际产出的思考 token **≤ 2048**；
  · `max_tokens=16384` 那组的 11,476 / 30,984 字符是 `end_turn` 自然收场 ⇒ 对应 token **≤ 16,384**。
  ⚠️ **不要**按「1 token ≈ 1~2 字符」把 30,984 折成「约 1.5 万~3 万 token」：那个数**超过 16,384**，
  与同两行的 `end_turn` 上限直接冲突（本报告上一版就写了这个数，已按观测上限改正）。可说的是：
  30,984 字符对应的 token 数落在 16,384 以下（≥ 1.9 字符/token）。
- **「4096 会截断」这个方向的判据不是上面那个折算值，而是同一张表里的直接观测**：`max_tokens=2048` 那组
  **实测两次 `stop=max_tokens`**——截断确实发生过；4096 只是把门槛抬高一倍，不改变「会截断」这个方向。
- 这是**单测绿、真机才有**的形态（单测只证明「我们递下去了什么」，量不到思考长度），也是本探针新发现的**待办**。
  处置留给后续任务：要么给 anthropic 分支留出思考预算（抬高 `max_tokens`），要么把「强度」与「输出上限」的
  关系写进设计口径。**本任务不改代码。**

## 脚本在评审后改了什么（2026-10-07，同一提交内）

| 改动 | 原因 |
|---|---|
| 承载字段取**首个非空**候选 | 只看「非 null」时，`reasoning_content: ''` + 有内容的 `reasoning` 别名会被判成「无 reasoning」——恰是加别名想防的误读 |
| 路由推导：`…/v1` 的 anthropic base 改成 `<根>/anthropic` | 原写法（剥 `/v1` 再拼 `/v1/messages`）**对 DeepSeek 是错的**；头注释与 REPORT 里「传哪一条都能还原」的承诺也改成只对 DeepSeek 三条形状成立 |
| 429 / 5xx 与网络异常**各重试一次**（2s），重试次数落进读数；429/5xx 单独喊「不是对字段的答复」 | 不重试时一次抖动会落成「合法读数」并按退出码 0 收场，把「字段被拒」与「网关抽风」混成一格 |
| 数值环境变量校验为正整数 | `Number('abc')` 会静默变成 NaN 再传进 `fetch` |
| 跳过难题对照的条件加严：**差额必须超过同档抖动** | 实测里 1.33× 判了「可区分」并据此跳过对照，补样本后发现区间重叠 |
| 初判措辞：`✅ 可区分` → `⚠️ 比值达标（不等于生效…）`；噪声段直接印「差 ≤ 同档抖动 ⇒ 未能证实」 | 结论不能比数据强 |

六行主表与全部附加读数的**请求体一字未改**，上表的读数就是改动前 / 改动后同一套请求的输出。

## 复现

```powershell
# 六行主表 + 附加（噪声基线 / budget_tokens / 按需难题对照）
$env:AIEVAL_PROBE_GATEWAY_API_KEY = '<本机 key>'; node packages/server/agents/probe/v8/judge-effort.mjs

# 只想复现六行主表
$env:AIEVAL_PROBE_EXTRA = '0'; node packages/server/agents/probe/v8/judge-effort.mjs

# 难题对照（anthropic 侧必须抬高上限，否则档位差被折平；样本量要自己加到「差额 > 同档抖动」为止）
$env:AIEVAL_PROBE_PROMPT = '<多步推理题>'; $env:AIEVAL_PROBE_MAX_TOKENS = '16384'
node packages/server/agents/probe/v8/judge-effort.mjs
```
