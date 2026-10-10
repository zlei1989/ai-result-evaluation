/**
 * 用量 → 展示文案的**唯一出口**（纯函数，无 React 依赖）：千分位与 token 单位、三个派生指标。
 *
 * 为什么单独一个模块、而不是散在各个视图里：这些公式与文案是**跨三家统一口径**的落点，
 * 而「统一」的唯一保证是**只有一份实现**——本仓已经在 `formatCacheHitRate` 上吃过一次教训
 * （命中率的分母定义与 `input` 的语义绑在一起，抄到第二处就必然漂移），
 * 也在 `输入 … · 缓存 … · 输出 …` 上吃了一次（四张面各写一份模板 ⇒ 加一个单位漏掉一处）。
 *
 * ⚠️ **纯函数模块不许 import `metric-line.tsx`**（后者是 `.tsx`、带 React）：里程碑
 * （`composite/agent-log/build-model.ts`）与台账行（`composite/log-format.ts`）都要用这里的
 * 文案函数，而它们本身没有 React 依赖。反向的 `metric-line.tsx` 只做**再导出**。
 *
 * ## 公式与原料（原料由 `usage` 事件给，见 contracts 的 `UsageTokensSchema` 注释）
 *
 * 1. **缓存命中率 = `cached / (input + cached)`**
 *    分母是这次的 prompt 总量。它成立的前提是**适配器已经把 `input` 归一到「非缓存输入」**
 *    （codex 那边做过减法 `input_tokens − cached_input_tokens`，claude/dsh 原文就不含 cache）
 *    ——消费方**不需要**、也**不许**再按家分支。只除 `input` 会算出 4051% 这种读不懂的数。
 * 2. **生成速率 ≈ `output / ((apiMs − ttftMs) / 1000)`**，只有 claude 能这么算（它三个时间都有）；
 *    另两家没有 `apiMs` ⇒ 退化成 `output / (totalMs / 1000)`，而**那个数含工具执行时间**，
 *    与 claude 的**不可直接比** ⇒ 调用方必须看 `timing.source`（`'events'` = 墙钟）并如实标注。
 * 3. **首字延迟 = `ttftMs`**（只有 claude 有）。
 *
 * ## 三条共同的显示口径
 *
 * - **采不到就是「未采集」**：`null` 一路传出去，绝不返回 `0` / `NaN` / `Infinity`
 *   （`0 tok/s` 与「没采到」含义相反，`NaN` 更是直接往界面上漏脏值）；
 * - **真实的 0 照常显示**：`output: 0` 时速率就是 `0.0`（那是真的没产出），不是「未采集」；
 * - **脏值一律按「采不到」处理**：负的时长、分母为 0、非有限数都返回 `null`。
 */
import type { UsageTiming, UsageTokens } from '@aieval/contracts';

/** 千分位：横排数字用逗号分组，扫一眼就能估量级 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * 单个 **token 计数**：千分位 + ` tok` 后缀（`15,763 tok`）。
 *
 * 后缀回答的是「这个数**是什么**」：`输入 15763` 里的 15763 是字节、字符还是 token，
 * 只有卡片上那一格 `tok 13,715` 说得清，其余四处都得靠读者自己知道上下文。
 *
 * 判据是**这个数是不是 token 计数**，不是「标签里有没有那个词」：命中率（`缓存命中 45%`）
 * 与生成速率（`生成 3.6 tok/s`）都不是，它们各有各的单位，故**不走这里**。
 */
export function formatTokens(value: number): string {
  return `${formatCount(value)} tok`;
}

/**
 * 用量三元组的文案形态：`输入 15,763 tok · 缓存 45,824 tok · 输出 2,164 tok`。
 *
 * 同一份三元组会出现在**六处**面上（顶部事实条、轮末里程碑、逐条消息页脚、子任务卡片）：
 * 四处的这个数**必须长得一样**，各写一份模板就必然在「加一个单位」时漏掉其中一处。
 * 里程碑与台账行同时从裸数字升到千分位——同一个数在事实条上早就是 `15,763`。
 */
export function formatUsageTriple(usage: Pick<UsageTokens, 'input' | 'cached' | 'output'>): string {
  return `输入 ${formatTokens(usage.input)} · 缓存 ${formatTokens(usage.cached)} · 输出 ${formatTokens(usage.output)}`;
}

/**
 * 缓存命中率：`缓存读 / 总输入`，四舍五入成整数百分比（`98%`）。
 * 脏值（负数 / 非有限数）与「压根没有输入」（分母 0）都按 `0%` 处理：界面绝不出现 NaN。
 *
 * ⚠️ 分母是 `input + cached`：归一之后 `input`（未命中）与 `cached`（命中）**互斥**，
 * 两者之和才是这次送进模型的 prompt 总量。这个比值**在数学上不可能超过 100%**
 * （`cached` 是 `input + cached` 的一部分）——分母里本来就含分子，`cached > total` 无法成立。
 * 所以这里**刻意不做 `Math.min(100, …)` 的钳位**：`input` 为负时前面那条脏值判据已经拦下，
 * 剩下的输入在代数上出不了 100%。多写一行只会让人以为「这个数真有可能超 100%」。
 */
export function formatCacheHitRate(tokens: Pick<UsageTokens, 'input' | 'cached'>): string {
  const { input, cached } = tokens;
  if (!Number.isFinite(input) || !Number.isFinite(cached) || input < 0 || cached < 0) return '0%';
  const totalInput = input + cached;
  if (totalInput === 0) return '0%';
  return `${Math.round((cached / totalInput) * 100)}%`;
}

/**
 * 生成速率（tok/s）：保留一位小数。
 *
 * 分母的取法按**优先级**，每一步都有理由：
 *   · 有 `apiMs` 与 `ttftMs`（claude）⇒ `apiMs − ttftMs`：**这才是「生成」的那段时间**
 *     （首 token 之前模型在排队/预填充，把它算进分母会让速度看起来更慢）；
 *   · 否则退回 `totalMs`（codex / dsh）⇒ 这个数**把工具执行也算了进去**，
 *     与上面那个不是一回事（调用方必须看 `timing.source` 并标注）；
 *   · `apiMs` 与 `ttftMs` 差 ≤ 0（脏数据 / 极短轮次）⇒ 退回 `totalMs`（仍算不出来就给 `null`）。
 *
 * 返回 `null` = **未采集 / 算不出来**（没有时间、没有用量、分母 ≤ 0、非有限数）。
 * 真实产出为 0 时返回 `'0.0'` —— 那是「真的没生成」，与「没采到」必须分得开。
 */
export function formatGenerationRate(
  tokens: Pick<UsageTokens, 'output'> | null,
  timing: UsageTiming | null | undefined,
): string | null {
  if (tokens === null || timing == null) return null;
  const output = tokens.output;
  if (!Number.isFinite(output) || output < 0) return null;
  const denominatorMs = generationWindowMs(timing);
  if (denominatorMs === null) return null;
  const seconds = denominatorMs / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return (output / seconds).toFixed(1);
}

/**
 * 「生成速率」公式的分母（毫秒）；算不出来给 `null`。
 * 单独抽出来是为了让「速率」与「这个速率是从哪段时间算的」两件事各自可断言——
 * 后者（`apiMs − ttftMs` 还是 `totalMs`）决定了这个数能不能与另一家横着比。
 */
export function generationWindowMs(timing: UsageTiming): number | null {
  const { apiMs, ttftMs, totalMs } = timing;
  if (apiMs !== null && ttftMs !== null) {
    const window = apiMs - ttftMs;
    if (Number.isFinite(window) && window > 0) return window;
  }
  if (totalMs !== null && Number.isFinite(totalMs) && totalMs > 0) return totalMs;
  return null;
}

/**
 * 这段时间的来源在界面上该怎么标注（**必须标**：两种来源不可比）。
 * 文案刻意短（要进日志行与 tooltip），但把关键差别说出来：「纯模型」 vs 「含工具」。
 */
export function timingSourceLabel(source: UsageTiming['source']): string {
  return source === 'vendor' ? '厂商自报（纯模型时间，不含工具执行）' : '按事件时间戳算（墙钟，含工具执行）';
}
