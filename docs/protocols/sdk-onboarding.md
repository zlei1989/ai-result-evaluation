# 新增 SDK 接入流程

## 定位

给评测平台接一家新的厂商智能体 SDK 的七步接入清单与验证点。每一步都有可执行的判据；**顺序不能颠倒**——前三步（能力声明、入口定位、凭据传递）的缺陷只有真机能拦，后面几步拦不住它们：agents 包全绿也可能连挂「打包器把 `createRequire` 换掉」与「凭据 / provider 没传到厂商进程」两题。

## 形态与交互

**七步清单**：

| # | 步骤 | 判据 |
|---|---|---|
| 1 | 写**能力声明**：消息面五格（五态 × 五格）+ **注入面两格**（MCP / skills）+ **耗时量级**（`runScale`），`notes` 写清路由 / 模型 / 机器前提 | 契约层 schema 的 `superRefine` + 元数据回归网（`registry.test.ts`） |
| 2 | 定**厂商入口的定位方式**（静态 import？子进程？）；走子进程就必须**打包器免疫**——Next/Turbopack 会把 `import.meta.createRequire` 换成带 `[externals]` 的产物（报错原文 `The argument 'filename' must be a file URL object… Received '[externals]/@openai/codex/package.json [external]'`），做法是 `process.getBuiltinModule('module')` 取真 `createRequire` + 结果形状校验（`isAbsolute` 且不含 `[external`） | 静态层守卫（`static-assertions.test.ts`） |
| 3 | 定**凭据与 provider 的传递**：密钥进子进程环境；provider 条目名与 `model_provider` 类字段**成对**给出；base_url 归一（该补 `/v1` 就补、该剥就剥） | 真机冒烟第 ② 格 |
| 4 | 写 fixture 场景，覆盖能力声明里所有 `yes` 的格；注入面的 `yes` 格给场景，**或**登记它的证明在哪一层 | 契约层「能力声明与产物互钉」+ **接入守卫**（`providers/conformance/onboarding.test.ts`，见下） |
| 5 | 接**生命周期**：取消能终止在途轮次、`dispose` 真正回收子进程、清理遇 `EPERM` 重试 | 一致性套件「生命周期」判据（释放恰好一次 + 取消与声明一致） |
| 6 | 登记**缺失**：能力声明里非 `yes` 的格必须带 `MissingReason`（四句分工），不许静默空格 | 契约层两条 `superRefine`（消息能力格、注入面格） |
| 7 | 跑**真机冒烟**，把四格证据写进当次关账记录 | 见下 |

**接入守卫**（第 4 步的强制层）：套件的 12 组判据由各家自己在 `providers/<kind>/conformance.test.ts` 里
`import` 并调用，**没有总驱动**——少了守卫，「新家压根不写这个文件」不会让任何用例变红，套件再严也只是
自愿参加。`onboarding.test.ts` 把「参加」本身变成判据，三层：

| 层 | 判据 | 拦什么 |
|---|---|---|
| 目录与注册表 | `providers/` 下每个目录都在 `AGENT_KINDS` 里，反之亦然 | 加了目录没登记 / 登记了没目录 |
| 交 fixture | 每家都有 `conformance.test.ts`，且真的调用套件、交了 `scenarios` | 新家整份跳过套件 |
| 覆盖自家声明 | 能力声明里 `yes` 的格，其证明场景必须出现在 `scenarios` 块里；注入面 `yes` 的格要么给场景、要么登记 `injectionProofElsewhere`（守卫核对那份文件真的存在） | 声明与产物不符、登记造假 |

判定方式是**运行期读声明 + 静态读 fixture 源码**：三家的 fixture 都在模块加载期用
`setAgentRuntimeForTesting` 注入各自的假厂商件（模块级），把三家 import 进同一个文件会让注入互相覆盖，
总驱动拿不到真 fixture。它判不出「场景名写了但产物是假的」——那一层由各家 fixture 的能力互钉与
`kit.test.ts` 的反例自测守。

**注入面（MCP / skills）的接入要求**：两条通路各有「我们发出去什么」与「厂商报回来什么」两份事实，
**互钉才算通过**。能力声明里 `injection.mcp` / `injection.skills` 用同一套五态 + `MissingReason`；
声明 `yes` 的家必须拿得出证明：

- **两份都给得出**：证明场景的产物挂 `injectionProbe`（请求侧）+ 带 `vendor-system` 事实（厂商侧）。
  请求侧事实只能由**假件在 run 期间记录**——cc 读假 SDK 的 `options.mcpServers` 与落盘的技能目录、dsh 读
  per-launch overlay 的插件行与技能目录、codex 读假 app-server 的 RPC 台账（`thread/start` 的
  `config.mcp_servers`，所以它那一格**起真 run** 而不是造 payload）。
- **够不着的格**（codex 的技能清单来自 `skills/list` 的**响应**）走 `injectionProofElsewhere` 登记它在
  哪一层被证明——登记不是免检，守卫核对那份文件真的存在。
- 声明非 `yes` 的格**不许**给证明场景（声明不支持却造得出事实，同样是自相矛盾）。

为什么两份都要：**只判厂商侧会放过「适配器压根没把入参交给厂商」**——夹具喂的厂商载荷照样产出那条事实，
套件全绿而 MCP 一台都没装到；只判请求侧则会放过「发出去了、厂商没认」。

厂商侧读 `vendor-system` 事件，且 MCP 那一格**两台通道合读**（服务状态表：cc 的 `mcp_servers[].status`、
codex 的 `mcpServer/startupStatus`；工具表：dsh 的 `request/header` 里 `mcp__<server>__*`）——只认服务表
会把 dsh 判成「没注入」，那是判据错不是它错。技能那一格看厂商侧非空清单。

**这一层拦的是「顺着写但漏了一环」，不是「成心骗」**：探针仍写在夹具里，刻意造假的接入者能把两边一起
写对。后者只有真机冒烟拦得住。

**生命周期（释放 / 取消）的接入要求**：这两条出口是**行为**，产物里没有它们的形状，所以各家交一个
**异步观测函数**（`ConformanceFixture.lifecycle`），套件在用例里 `await` 它：

```ts
lifecycle: async () => ({
  disposeAfterRun: …,      // 正常收尾后释放了几次（必须恰好 1）
  disposeAfterCancel: …,   // 取消之后释放了几次（同一口径）
  canceledMidTurn: …,      // 取消有没有真的终结在途轮次
}),
cancelMidTurn: provider.metadata.capability.cancelMidTurn,   // 声明；判据拿它与观测对照
```

三条判据：① 正常运行收尾后释放**恰好一次**（0 = 泄漏，>1 = 重复释放）；② 取消之后同样恰好一次；
③ `canceledMidTurn` 必须与**声明**一致——声明能中途取消却做不到，是这一层最该拦的假话。
证明不了的家在 `lifecycleElsewhere` 登记它在哪一层被证明（接入守卫核对路径存在）。

> `canceledMidTurn` 对声明 `false` 的家没有区分力（填 `false` 是必然的，如 dsh 的 5 秒兜底档）；
> 它拦的是「声明 `true` 却做不到」。

**并发隔离不在这一层**：它由静态层守——`static-assertions.test.ts` 用 7 种写法禁掉 `process.env` 写入，
而「替换型子进程环境」是那条禁令下唯一可行的实现方式，故不必再造一个更弱的运行期判据。

**耗时量级（`metadata.timing`）的接入要求**：声明这一家跑完一次运行是 `'seconds'` 还是 `'minutes'`，
外加这一格成立的**前提**（机器 / 模型 / 路由 / 任务规模）。

为什么是**量级**而不是精确数字：耗时由机器、模型、路由与任务共同决定，写一个精确值必然很快过期或
变成假话。量级则必须**有人消费**才有意义——真机冒烟的**等待预算按它派生**：声明 `seconds`，那一轮的
超时就是 1 分钟，跑不完会被自己的预算掐掉（红在产物格）；真机冒烟的 ⑦ 格再从结果侧判一次
「跑完了但远超声明」，即使预算被 `AIEVAL_LIVE_TIMEOUT_MS` 放大也照样红。

**已知边界**：这一层只有量级，没有精确基线——「这家比那家慢 30%」判不出来，本仓也没有 benchmark 口径。


**结构化输出这一格的接入要求**（每家都要面对入参 `outputSchema`，两种合法接法）：

- **有原生 schema 通道的家**：把它翻成厂商选项（`turn/start` 那一类一等字段），并**如实上报**本次有没有真的走成（`applied.structuredOutput`）——「厂商这一轮没照做」与「我们已经要求了」是两件事。
- **没有原生通道的家**：在适配器内部**填充**——首轮把 schema 约束（schema 原文 + 「只输出 JSON、不要围栏」）追加在调用方提示词之后，并**实现 `TurnStart.continue`**：骨架的修正轮靠它在**同一会话**里追问，模型手里保留工作区与自己的上一轮答复，只改形状、不重跑任务。
- **实现不了同会话追问的家如实收场**：答复不合格时骨架落一条 WARN，`ok` / `finalText` 保持原样，由调用方按 `finalText` 的既有契约处置（评分通路的落点是 `JUDGE_PARSE_FAILED`）——**不许假装合格**。两种接法的**保证强度不同、交付契约相同**。

## 数据与契约

**契约层 conformance 套件**（与厂商无关，任何一家都得过；一次接入的全部成本就是一个 fixture）：

```ts
describeProviderConformance({
  kind: '<kind>',
  capability: newProvider.metadata.messageCapability,   // 本家的消息能力声明
  injection: newProvider.metadata.injection,             // 本家的注入面声明（MCP / skills）
  injectionProof: { mcp: 'mcp-injection' },              // 声明 yes 的注入面格 → 证明场景
  scenarios: { 'plain-reply': () => …, 'thinking-full': () => …, subagent: () => … },
});
```

判据逐条挂在消息规范条目上（信封 / 内容块 / 行级事件 / 计量 / 能力声明与产物**互钉** / 子任务桥 / 环境 / 行结果 / 工具族 / 合并键）。**形状不在套件里重复写**——它由 `@aieval/contracts` 的 zod schema 管，套件只补 schema 表达不了的语义不变量（两份形状必然漂移）。

**测试里怎么替换掉真实厂商**：三家共用 `sdkModule` 一个注入字段（不另起名字），一张假模块表能同时喂饱三家；注入值不缓存（同一进程里能从「坏模块」换到「好模块」，验证「一次加载失败不会毒化后续运行」）；假件要**保真**（真生成器的排队语义、订阅关闭会 reject 挂起的等待者）——夹具悄悄变弱时用例只会**假绿**不会红，所以夹具自己也有回归网。

## 状态机与时序

**真机冒烟**（装载与传输两类缺陷的**唯一**拦法；默认跳过，不进内循环）：

```bash
AIEVAL_LIVE_SMOKE=1 AIEVAL_LIVE_KIND=<kind> \
AIEVAL_LIVE_PROVIDER_ID=<uuid> AIEVAL_LIVE_MODEL_ID=<model id> \
pnpm vitest run packages/server/agents/src/providers/live-smoke.test.ts
```

四格：① **装载**（没有落到入口解析 / 加载类失败）② **传输**（服务端记录的路由与本次选择一致、且不是凭据类失败）③ **产物**（跑到 `judged` 且有分数）④ **形状**（`messages` 接口的线上形态逐个过 schema）。`AIEVAL_LIVE_KIND` **必填**——不给默认家，避免「默认跑的那家绿了就当四家都绿」。

① 与 ② 判的是**失败归因**，读的是行契约上的那一格（`EvalRow.error.code` / `error.message`，可空）——行的形状
在测试里**直接取契约类型**，不另立影子接口：影子接口配 `as T` 强转会让字段名写错时静默通过（断言恒读到
`undefined`、那一格永远绿），而这两格是「装载与传输缺陷的唯一拦法」这句话的全部依据。

**一条命令跑完几家**（日常用它，不必手拼四个环境变量）：

```bash
pnpm live-smoke                  # 跑全部有候选的家，逐家打印四格并汇总
pnpm live-smoke -- --kind cc     # 只跑一家（可重复给多次）
pnpm live-smoke -- --agent-judge # 连 ⑤⑥（智能体评分档）一起跑，七格全覆盖
pnpm live-smoke -- --dry-run     # 只检查服务与候选、打印将执行的命令（毫秒级）
```

`scripts/live-smoke.mjs` 从 `GET /api/runs/model-options` 取「哪家配哪个 provider / model」——那份知识
在服务端的候选池里（按 `acceptsProtocol` 过滤），脚本**不复制**它，也**不读配置文件、不碰密钥**。
跑完打印逐格结果与可粘贴进 `LIVE_SMOKE_COVERAGE` 的证据行；退出码 0 = 必跑格全过。

**绿的口径**：①②③④⑦ 是**必跑格**（跳过即异常），⑤⑥ 只在 `--agent-judge` 那一档有意义。
不给这个开关时 ⑤⑥ 跳过属正常，但汇总会写明「未覆盖」——**不让「绿」被读成「七格都验过了」**；
给台账的建议行也随之改写（默认档写「必跑五格通过」，开档且全过才写「七格全通过」）。

两个实测过的坑：`/api/cases` 的信封是 `{ cases: […] }`（不是裸数组）；vitest 的 `--reporter=json` 会
**吃掉**默认输出，于是前置失败（服务没起、用例 id 不存在）的原因既不在报告字段里也不在 stdout 里
——脚本因此同时挂 `--reporter=default`，并从输出里把原因抬成一行「↳ 前置失败：…」。

**单轮红先当噪声看**：真机通路会抖（同一候选、同一用例，上一轮 ③ 报 `文本 API 返回 HTTP 404`、
下一轮两条评分通路都通）。定性前先复跑一次，别把一次网关抖动写成产品缺陷或配置错误。

**判据住在 `src/testing/live-smoke-checks.ts`（纯函数），不留在那个默认跳过的文件里**：跳过意味着它们
从没有机会见红——装载那一格就因为读了行上不存在的 `errorCode` 而**恒绿**过。抽出来之后每格都有正反例
（`live-smoke-checks.test.ts`：喂一份合规的行不抛、喂一份对应缺陷的行必须抛），真机那一层只负责调用。

**覆盖台账**（`LIVE_SMOKE_COVERAGE`，同文件）逐家登记「这家怎么跑的、结论是什么」。它**不是机器验证**
——谁也拦不住随手填一句；它是一张**编译期强制回答的清单**：加第四家时 `Record<AgentKind, …>` 会缺格、
`tsc` 直接点名。值必须点名 `AIEVAL_LIVE_KIND=<kind>`，复制粘贴蒙不过去。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| 一致性套件的 `structured-output` 组：判据本体 `providers/conformance/structured-output.ts` 与运行时**共用** `src/structured-output.ts`；cc 与 dsh 的夹具已挂探针（请求侧事实分别取假 SDK 的 `options.outputFormat` 与首轮提示词里的输出约束），codex 的夹具是**消息级**的（造 `AppServerNotificationPayload` 喂归一函数，看不到 `turn/start` 的请求）⇒ 这一家在套件里仍空转 | 这一组判三件事：① **上报与请求互钉**——上报走了原生 schema 通道（`applied.structuredOutput`）就必须真的把 schema 发给了厂商，没走原生通道是**允许**的（填充层那条路）；② **答复可解析**——非失败场景的 `finalText` 必须过同一份判据（剥整段围栏 → `JSON.parse`），给了期望再逐字段比对；③ **失败可见**——失败场景必须带归因，空串不算答复（`finalText === ''` 是「没采到」的伪装）。codex 的请求侧事实由 `providers/codex/index.test.ts` 的 `turn/start` 两态断言（给 / 不给 `outputSchema`）守 |
| 无原生 schema 通道的家怎么过这一组 | 靠适配器内部的填充层（首轮提示词追加 schema 约束）交出 JSON，`applied.structuredOutput` 记 `false` **不算失败**——那一格回答的是**方法**，不是结果；答复仍不合格时走调用方的既有处置（不静默） |
| 前三步的缺陷单测拦不住（打包器改写、子进程环境差异——测试环境 ≠ 运行环境） | 真机冒烟是唯一拦法；这也是「为什么不写假 SDK 替代真机」的原因 |
| **真机冒烟的覆盖只有一张编译期清单，没有机器验证**：8 个 `live-*` 文件全部默认跳过，跑没跑过在代码与产物里不留痕 ⇒ `LIVE_SMOKE_COVERAGE` 只能保证「新家必须回答这个问题」，保证不了「答的是真话」 | 未闭合。要真正闭合，覆盖事实得落在产品侧能自动读到的地方（例如把「这一行是真机冒烟」记进行快照），代价是给产品加一个只为验证而存在的字段 |
| 一致性套件里有一组判据对三家**全部空转**：`transport` 那份「传输时序（C 类）」（无一家交得出笔迹）。`usage-pair` 那一组虽然三家都注册，但取值结构使不变量恒真 | 两组都保留：判据本身在 `kit.test.ts` 用合成 fixture 见过红，空转的是三家的输入而不是判据。补输入要各家夹具能录到「订阅与响应的先后」，那是各家的下一步 |
| 生命周期的**并发隔离**没有运行期判据 | 由静态层守：`process.env` 写入被 7 种写法的禁令封死，而「替换型子进程环境」是那条禁令下唯一可行的实现 ⇒ 真并行时的凭据串扰没有载体。代价是「从别的通道串」（模块级缓存、单例状态）拦不住 |
| 性能只有**量级**声明，没有精确基线 | 由「声明驱动消费方」兜住：真机冒烟的等待预算与 ⑦ 格都按它判，声明小了会被自己的预算掐掉。代价是「这家比那家慢 30%」这类差异判不出来——那需要 benchmark 口径，本仓没有 |
| codex 二进制解析「第二跳基准」守卫缺口：vitest 里裸说明符解析被运行器接管比生产宽松，基准改错仍绿 | 未闭合，两条闭合路径（真 Node 子进程验 / 形状式源码断言）都未做 |

## 相关链接

- 活文档：`packages/server/agents/README.md`——§8.1 接入清单（本篇真源，互链不复制）、§8 测试替换法
- 知识文章：[《Provider 抽象与 run 入口》](/protocols/provider-run)（新家要实现的形状）、[《三家横向对比》](/protocols/comparison)（接入后对照）、[《冒烟测试方法论》](/guard/smoke-testing)（真机冒烟的四要素）、《进程生命周期》（第 5 步的展开）
