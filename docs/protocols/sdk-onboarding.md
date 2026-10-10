# 新增 SDK 接入流程

## 定位

给评测平台接一家新的厂商智能体 SDK 的七步接入清单与验证点。每一步都有可执行的判据；**顺序不能颠倒**——前三步（能力声明、入口定位、凭据传递）的缺陷只有真机能拦，后面几步拦不住它们：agents 包全绿也可能连挂「打包器把 `createRequire` 换掉」与「凭据 / provider 没传到厂商进程」两题。

## 形态与交互

**七步清单**：

| # | 步骤 | 判据 |
|---|---|---|
| 1 | 写**能力声明**（五态 × 五格 + `notes` 写清路由 / 模型前提） | 契约层「能力声明自身合规」 |
| 2 | 定**厂商入口的定位方式**（静态 import？子进程？）；走子进程就必须**打包器免疫**——Next/Turbopack 会把 `import.meta.createRequire` 换成带 `[externals]` 的产物（报错原文 `The argument 'filename' must be a file URL object… Received '[externals]/@openai/codex/package.json [external]'`），做法是 `process.getBuiltinModule('module')` 取真 `createRequire` + 结果形状校验（`isAbsolute` 且不含 `[external`） | 静态层守卫（`static-assertions.test.ts`） |
| 3 | 定**凭据与 provider 的传递**：密钥进子进程环境；provider 条目名与 `model_provider` 类字段**成对**给出；base_url 归一（该补 `/v1` 就补、该剥就剥） | 真机冒烟第 ② 格 |
| 4 | 写 fixture 场景，**至少覆盖能力声明里所有 `yes` 的那几格** | 契约层「能力声明与产物互钉」 |
| 5 | 接**生命周期**：取消能终止在途轮次、`dispose` 真正回收子进程、清理遇 `EPERM` 重试 | 集成层 + 真机冒烟第 ①/③ 格 |
| 6 | 登记**缺失**：缺失影响矩阵里每一格要么有产物、要么有 `MissingReason`（四句分工），不许静默空格 | 契约层「缺失必须带原因」 |
| 7 | 跑**真机冒烟**，把四格证据写进当次关账记录 | 见下 |

## 数据与契约

**契约层 conformance 套件**（与厂商无关，任何一家都得过；一次接入的全部成本就是一个 fixture）：

```ts
describeProviderConformance({
  kind: '<kind>',
  capability: newProvider.metadata.messageCapability,   // 本家的能力声明
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

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| conformance 夹具空转：`structured-output.ts` 判据本体在，但三家夹具都没挂探针 | 「声明 `structuredOutput: true` 的家必须真把 schema 发出去」靠三家 `index.test.ts` + 骨架 `turn.test.ts` |
| 前三步的缺陷单测拦不住（打包器改写、子进程环境差异——测试环境 ≠ 运行环境） | 真机冒烟是唯一拦法；这也是「为什么不写假 SDK 替代真机」的原因 |
| codex 二进制解析「第二跳基准」守卫缺口：vitest 里裸说明符解析被运行器接管比生产宽松，基准改错仍绿 | 未闭合，两条闭合路径（真 Node 子进程验 / 形状式源码断言）都未做 |

## 相关链接

- 活文档：`packages/server/agents/README.md`——§8.1 接入清单（本篇真源，互链不复制）、§8 测试替换法
- 知识文章：[《Provider 抽象与 run 入口》](/protocols/provider-run)（新家要实现的形状）、[《三家横向对比》](/protocols/comparison)（接入后对照）、[《冒烟测试方法论》](/guard/smoke-testing)（真机冒烟的四要素）、《进程生命周期》（第 5 步的展开）
