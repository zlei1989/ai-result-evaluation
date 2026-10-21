/**
 * 真机冒烟各格的判据（**纯函数**：喂一份运行快照，回一句「哪一格不合格」或 `null`）。
 *
 * 为什么抽成模块：这些判据原先直接写在 `live-smoke.test.ts` 的用例里，而那个文件**默认跳过**
 * ——「没见过失败的守卫不算守卫」。装载那一格就因为读了本次运行上不存在的 `errorCode`（契约里叫
 * `error.code`）而**恒绿**：文档说它是「装载缺陷的唯一拦法」，实际一次都没红过。
 * 抽出来之后每条判据都有正反例（`live-smoke-checks.test.ts`），真机那一层只负责调用。
 *
 * 判据读的是**行契约**（`EvalCandidate`），不是本地影子接口：影子接口配 `as T` 会让字段名写错时
 * 静默通过——断言恒读到 `undefined`、那一格永远绿。这一条对前两格尤其致命，因为它们判的正是失败归因。
 *
 * ⚠️ **本文件不是 `*.test.ts`，受业务无关守卫管**：给用户的失败原因里只写契约字段名
 * （`score` / `judgeProviderId` / `verdict` / `raw`），不写评测领域词。
 */
import { AGENT_KINDS, type EvalCandidate, type ScoreResult } from '@aieval/contracts';
import { getProvider } from '../registry';
import type { AgentKind, ProviderTiming } from '../types';

/** 装载类失败：包没装、平台包缺 vendor、入口解析链断在哪一级都会带这些字样 */
const LOAD_FAILURE = /AGENT_LOAD_FAILED|找不到 .*可执行文件|Cannot find module/i;
/** 凭据类失败：密钥错、被拒、无权限 */
const AUTH_FAILURE = /AUTH_FAILED|401|403|Unauthorized/i;
/** 评分通路的失败码（`JUDGE_*` / `PARSE_FAILED`）：只在智能体作答那一档出现 */
const JUDGE_FAILURE = /JUDGE_|PARSE_FAILED/i;

/** 本次运行上的失败归因拼成一句（两份事实同在契约的那一格上） */
function errorText(row: Pick<EvalCandidate, 'error'>): string {
  return `${row.error?.code ?? ''} ${row.error?.message ?? ''}`.trim();
}

/** ① 装载：本次运行没有落到「厂商入口解析 / 加载」类失败 */
export function checkLoadCell(row: Pick<EvalCandidate, 'error'>): string | null {
  const text = errorText(row);
  return LOAD_FAILURE.test(text) ? `装载失败：${text}` : null;
}

/** ② 传输：服务端记录的路由与本次选择一致，且失败不是凭据类 */
export function checkTransportCell(
  row: Pick<EvalCandidate, 'providerId' | 'modelId' | 'baseUrl' | 'error'>,
  expected: { providerId: string; modelId: string },
): string | null {
  if (row.providerId !== expected.providerId) {
    return '本次运行的 providerId 与本次选择不一致——说明本次运行没拿到我们给的那条路由';
  }
  if (row.modelId !== expected.modelId) return '本次运行的 modelId 与本次选择不一致';
  if (row.baseUrl.trim() === '') return '本次运行的 baseUrl 为空——凭据/网关地址没有随行落下去';
  const text = errorText(row);
  return AUTH_FAILURE.test(text) ? `凭据类失败：${text}` : null;
}

/** ③ 产物：本次运行跑完并拿到 `score`（装载 / 凭据 / 超时失败都会让它红） */
export function checkProductCell(row: Pick<EvalCandidate, 'status' | 'error'> & { score: object | null }): string | null {
  if (row.status !== 'judged') return `本次运行没跑完（${row.status}）：${row.error?.message ?? ''}`;
  if (row.score === null) return '跑完了但 score 为 null';
  return null;
}

/** ④ 形状那一格要发请求取消息，不是纯函数——判据留在 `live-smoke.test.ts` 里 */

/**
 * 声明的耗时量级 → **等待预算**（毫秒）。真机冒烟的默认超时按它派生。
 *
 * 这一格的意义全在「有人消费」：声明小了，这一轮会被自己的预算掐掉——红在产物格，
 * 而不是红在一句没人看的注释里。
 */
export function waitBudgetFor(scale: ProviderTiming['runScale']): number {
  /**
   * 分钟级给 **11 分钟**（而不是 10 分钟）：**必须比骨架的单轮墙钟看门狗上限宽出一段**。
   *
   * 看门狗 `DEFAULT_TURN_WALL_CLOCK_MS` 是 600_000，而「上游整机不可达」那一档会**正好走到那个上限**
   * 才收场（真机读数：600.103 s 落 `timed-out`）。若预算也取 600_000，两者**逐毫秒相等**
   * ⇒ 冒烟判据在那一档必抖（收场比预算晚约 100 ms 就成了假红）。
   * 多的那一分钟是给「600 s 收场 + 交卷 + 余量」的。
   */
  return scale === 'seconds' ? 60_000 : 660_000;
}

/**
 * 这一家声明的耗时量级（真值来自注册表）。
 * `kind` 不合法、或还没给时按**最宽**的那一档——免得把「没指定家」判成「秒级」、
 * 把等待预算压到 1 分钟。
 */
export function scaleOf(kind: string): ProviderTiming['runScale'] {
  return (AGENT_KINDS as readonly string[]).includes(kind)
    ? getProvider(kind as AgentKind).metadata.timing.runScale
    : 'minutes';
}

/**
 * 耗时量级 → 实测墙钟的上限（毫秒）。比等待预算**宽一档**：这一格判的是「声明与事实不符」，
 * 不是「刚好卡在预算上」。
 */
export function durationCeilingFor(scale: ProviderTiming['runScale']): number {
  return scale === 'seconds' ? 90_000 : 900_000;
}

/**
 * ⑦ 耗时：这一轮的墙钟与**声明的量级**一致。
 *
 * 与等待预算是同一件事的两侧：预算管「跑不完就被掐」，这一格管「跑完了但远超声明」——
 * 即使预算被环境变量放大，声明与事实不符仍然会红。`null`（没采到）不判：「没采到」不是「超了」。
 */
export function checkDurationCell(durationMs: number | null, scale: ProviderTiming['runScale']): string | null {
  if (durationMs === null) return null;
  const ceiling = durationCeilingFor(scale);
  if (durationMs <= ceiling) return null;
  return `这一轮跑了 ${Math.round(durationMs / 1000)} 秒，超出声明量级（${scale}）的上限 `
    + `${ceiling / 1000} 秒——声明与事实不符（要么改适配器，要么改声明）`;
}

/**
 * ⑤ 智能体作答那一档：`score` 落下来了，且是**智能体给的**（`judgeProviderId` 非空、`verdict` 非空）。
 * 确定性评分档看不到这一格，故只在 `AIEVAL_LIVE_AGENT_JUDGE=1` 时有意义。
 */
export function checkAgentJudgeCell(
  row: Pick<EvalCandidate, 'error'> & { score: Pick<ScoreResult, 'judgeProviderId' | 'verdict'> | null },
): string | null {
  const text = errorText(row);
  if (JUDGE_FAILURE.test(text)) return `出现了 JUDGE_* / PARSE_FAILED 类失败：${text}`;
  if (row.score === null) return '这一档下必须落一份 score';
  if (row.score.judgeProviderId.trim() === '') return 'score 里没有 judgeProviderId——这一分不是智能体给出的';
  if (row.score.verdict.trim() === '') return 'verdict 为空——智能体没拿到答复';
  return null;
}

/**
 * ⑥ 智能体的产出可解析，且记录里带「输出约束」那一格。
 * 两条通路都要过：原生 schema 通道与文本降级（`structuredOutput: false` 不是失败）。
 */
export function checkStructuredScoreCell(
  row: Pick<EvalCandidate, 'error'> & { score: Pick<ScoreResult, 'structuredOutput' | 'raw'> | null },
): string | null {
  if (row.score === null) return '这一档下必须落一份 score';
  if (typeof row.score.structuredOutput !== 'boolean') {
    return 'score 缺少 structuredOutput 这一格（无法回答「有没有按 schema 作答」）';
  }
  if (row.score.raw.trim() === '') return 'score 里没有 raw 原文';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.score.raw) as Record<string, unknown>;
  } catch {
    return 'raw 不是可解析的 JSON';
  }
  if (!Array.isArray(parsed['judgments'])) return 'raw 解析出来没有 judgments';
  if (String(parsed['verdict'] ?? '') === '') return 'raw 解析出来没有 verdict';
  const text = errorText(row);
  return JUDGE_FAILURE.test(text) ? `出现了 JUDGE_* / PARSE_FAILED 类失败码：${text}` : null;
}

/**
 * **真机冒烟覆盖台账**：哪几家真的跑过、覆盖到哪几格、证据在哪。
 *
 * 为什么需要它：8 个 `live-*` 文件全部默认跳过，「某家从没跑过」在代码与产物里一个字都读不到。
 * 这一格**不是机器验证**——谁也拦不住随手填一句；它是一张**编译期强制回答的清单**：
 * 加一家时 `Record<AgentKind, …>` 会缺格、`tsc` 直接点名，接入者必须去回答「这家跑过真机没有」。
 *
 * 值写**证据**：`pnpm live-smoke` 跑完直接给出可粘贴的行（写法、环境、结论、墙钟都在里面）。
 * 格式由 `live-smoke-checks.test.ts` 约束：每一种取值都要点名 `AIEVAL_LIVE_KIND=<kind>`，且必须落在
 * 两种形状之一——**跑过**（含日期、provider / 模型、墙钟）或**未跑**（逐字以「未跑」开头）。
 * 「没跑过却写得像跑过」是这一格唯一要防的事，故未跑的家也必须把跑法写进去（下一个人照着就能跑）。
 * 默认档下 ⑤⑥ 不跑，故写「七格全通过」的家要说明是哪七格；别让本次运行读成「都验过了」。
 */
export const LIVE_SMOKE_COVERAGE: Record<EvalCandidate['agentKind'], string> = {
  cc: '七格全通过（2026-10-12：AIEVAL_LIVE_KIND=cc，provider likecode-anthropic / DeepSeek-V4.1-Flash-a，墙钟 25.9s）',
  codex: '七格全通过（2026-10-12：AIEVAL_LIVE_KIND=codex，provider deepseek / GLM-5.3，墙钟 29.9s）',
  dsh: '七格全通过（2026-10-12：AIEVAL_LIVE_KIND=dsh，provider likecode-anthropic / DeepSeek-V4.1-Flash-a，墙钟 25.9s）',
  // pi 的台账**如实写「没跑过」**：这一格回答的是「这家跑过真机没有」，而不是「这家接完了没有」。
  // 填一句没跑过的墙钟与结论，正是这一格存在的理由（防止把「没验过」读成「验过了」）。
  pi: '未跑（跑法：AIEVAL_LIVE_KIND=pi，供应商与模型按本机配置给；本家尚未在真机上执行过，故不填日期、provider / 模型与墙钟）',
};
