/**
 * 编排层测试的**注入接缝**与三条 `vi.mock` 的**工厂体**。
 *
 * 为什么单独一个模块，而不是放进 `orchestrator-harness.ts`：
 * 各测试文件的前导块要 `await import(...)` 拿工厂体，而 harness 又**静态 import** 了被 mock 的
 * 模块（`../run-store`、`../judge`）——工厂去 import harness 就构成「harness 等工厂、工厂等 harness」
 * 的循环，表现为**整个文件 0 个用例、且没有任何报错**（静默挂死，实测踩过）。
 * ⚠️ **口径修正（2026-10-06）**：本模块今天能从工厂里安全地 import，靠的是「**它的运行时依赖闭包
 * 里没有被 mock 的模块**」——而**不是**「依赖 `./fixtures` 就等于安全」。**修正前那句注释**把结论
 * 建立在一个**假前提**上：`./fixtures` 原先从 `@aieval/agents` **运行时** import 了一个值成员
 * （`permissiveMessageCapability`；已在 **T1 的那个提交**里连同 `:606` 的调用点一起改成字面量；
 * 该调用点修正前在 `:581`），
 * 而 `@aieval/agents` 正是被 mock 的模块之一 ⇒「工厂 → 本模块 → fixtures → **正在求值中**的
 * `@aieval/agents`」构成一条 vite ModuleRunner **解不开的 await 环**，表现与上面那种循环**一字不差**
 * （整个文件 0 个用例、无报错、无超时、零 CPU；本仓实测 19/27 个文件如此 ⇒ `pnpm test` 整个不可用）。
 * 对 `../judge` / `../run-store` 的引用一律只出现在**类型位置**（`typeof import('...')` 编译期擦除，
 * 不产生运行时 import）——这一条**与现状相符**，保持不变；`../text-api` 则本模块**完全未引用**
 * （它只出现在被 mock 的清单里，故不可能经由本模块产生运行时边）。
 * **怎么判、怎么防**都在 `../static-assertions.test.ts` 的
 * `describe('工厂动态 import 的闭包不得运行时 import 被 mock 的模块（防收集期静默挂死）')`：
 * 它从每个工厂的 `import(...)` 出发沿运行时闭包走，凡是对被 mock 的项目模块
 * （`@aieval/agents` / `./judge` / `./run-store` / `./text-api`）存在运行时边就红
 * （`vi.importActual` 按 spec §4.4 **显式放行**：它读的是真模块，属 mock 的旁路 API，不算运行时边）。
 * **往本模块（或 `./fixtures`）加任何运行时 import 之前，先看那条守卫。**
 *
 * 接缝本身（`injected`）为什么需要：两件事在单测里没有别的办法造出来，而它们都不是
 * 「夹具编出来的假场景」，是生产上真实存在的时序：
 *   ① **轮级收尾落盘失败**：`finalizeRun → setRunStatus → saveRun` 会因磁盘满 / 快照被删 / 根目录形状
 *      非法而抛，而它与该轮最后一次行级写入之间**没有任何 `await`** ⇒ 测试不可能「恰好在那一刻」动手脚；
 *   ② **陈旧的 `listRuns()` 结果**：恢复路径拿到的列表与它改写时的当前快照之间可能夹着别人跑完的行
 *      （评审 Low-4 描述的那个窗口），同样没有 `await` 可供插入。
 * 默认全部原样透传（`...actual`）：注入点只在被点名的那一轮 / 那一次调用上生效，用完即失效。
 */
import { vi } from 'vitest';
import { ServiceError, type EvalRun } from '@aieval/contracts';
import { fakeAgentsModule, fakeJudgeModule } from './fixtures';

/**
 * 提升到 import 之前的接缝对象（`vi.hoisted`：夹具在所有 import 之前就要能读写它）。
 * 注意**不要**写成 `export const injected = vi.hoisted(...)`：vite 会把赋值提到 import 之前，
 * 而「导出一个被提升的变量」在 ESM 里是语法错误（`Cannot export hoisted variable`），
 * 整个文件以 SyntaxError 收场——表现同样是「这个文件 0 个用例」。故拆成
 * 「不导出的提升变量 + 导出的别名」，两边指向同一个对象。
 */
const injectedState = vi.hoisted(() => ({
  /** 让**这一轮**的「轮级终态」写入失败一次（done / partial 才是收尾那一笔） */
  failRunStatusSaveFor: null as string | null,
  /** 「收尾那一笔已经被拒绝」的标记：用例等它发生（它一定晚于该轮最后一行的落库） */
  runStatusSaveFailed: false,
  /** 下一次 `listRuns()` 返回这份**陈旧**快照（模拟「读到之后、改写之前别人把这行跑完了」） */
  staleList: null as EvalRun[] | null,
  /**
   * 让**这一轮**的「行级」写入失败一次（`rescoreRow` 入口区的等价物：磁盘满 / 快照被删）。
   * 为什么需要它：入口区那三步（登记控制器 → 标记事件 → 写状态）之间**没有 `await`**，
   * 测试不可能「恰好在那一刻」动手脚；而不回退的后果是「这一行永久不可重评」——
   * 一条只在真实故障下出现、却再也修不回来的状态（见 rescoreRow 入口区的注释）。
   */
  failRowSaveFor: null as string | null,
  /** 「行级那一笔已经被拒绝」的标记：用例等它发生 */
  rowSaveFailed: false,
}));

/** 接缝对象（各测试文件读写它来制造落盘失败 / 陈旧列表） */
export const injected = injectedState;

/**
 * agents：换掉 `getProvider(kind).run()` 这个唯一边界，既不加载任何厂商 SDK，也完全掌控时序
 * （什么时候开始、什么时候结束、是否响应终止、返回什么计量）。
 *
 * **返回 Promise**（`fakeAgentsModule` 要从真模块取协议判据与文案，见那里的注释）——调用点
 * 一律写在 `vi.mock(…, async () => …)` 里，async 箭头会把嵌套 promise 摊平，故调用点无需解包。
 */
export function agentsMock() {
  return fakeAgentsModule();
}

/**
 * judge：只替换 `judgeRow`，`parseJudgeResponse` / `finalizeScore` 必须是真的——
 * `judge-agent.ts` 也 import 它们，整模块替换会让智能体通路拿到 undefined（崩成 TypeError，
 * 指向完全错误的方向）。
 */
export function judgeMock(actual: typeof import('../judge')) {
  return { ...actual, ...fakeJudgeModule() };
}

/** run-store：落盘失败 / 陈旧列表两个接缝（评审 Medium-3 / Low-4 的守卫靠它） */
export function runStoreMock(actual: typeof import('../run-store')) {
  return {
    ...actual,
    listRuns: () => {
      const stale = injected.staleList;
      if (stale !== null) {
        injected.staleList = null; // 一次性
        return stale;
      }
      return actual.listRuns();
    },
    saveRun: (run: EvalRun) => {
      if (run.id === injected.failRunStatusSaveFor && (run.status === 'done' || run.status === 'partial')) {
        injected.failRunStatusSaveFor = null; // 一次性：只让收尾这一笔失败，行级写入照常
        injected.runStatusSaveFailed = true;
        throw new ServiceError('INTERNAL', '夹具注入：轮级收尾落盘失败（磁盘满 / 快照被删的等价物）');
      }
      // 行级那一笔（轮状态是 idle / running 的那些写入）：按**调用顺序**一次性失败。
      // 判据用「这一轮」而不是状态：行级写入落在各种轮状态下（idle / running / partial），
      // 按状态判会漏掉一半，而这条注入要的正是「不管当时轮状态是什么，下一次行级写入失败」
      if (run.id === injected.failRowSaveFor) {
        injected.failRowSaveFor = null;
        injected.rowSaveFailed = true;
        throw new ServiceError('INTERNAL', '夹具注入：行级落盘失败（磁盘满 / 快照被删的等价物）');
      }
      actual.saveRun(run);
    },
  };
}
