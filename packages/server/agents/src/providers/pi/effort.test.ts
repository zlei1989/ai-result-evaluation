// @vitest-environment node
/**
 * pi 的**档位出站形态**（请求侧事实）：本仓档位 → pi 的 `thinkingLevel` → 两条 wire 上的实际参数。
 *
 * 为什么判据必须是请求体而不是「适配器传了什么参数」：`input.effort` 交给 pi 之后还要过一遍厂商的
 * 夹档——`reasoning` 关着时任何档都被夹成 `off`；`max` 没有映射时被夹到 `high`；anthropic 那条还要
 * 把档位换算成 `budget_tokens` 并被 `maxTokens - 1024` 夹住。只看入参的话，「传了 `max`、发出去的
 * 是 `high`」与「传了 `max`、发出去的是 `max`」完全一样。
 *
 * 时长上报（同一台假网关）在 `timing.test.ts`：两件事的变异体与判据各不相同，分成两份文件。
 */
import { describe, expect, it, vi } from 'vitest';
import { runPiCandidate, startPiGateway, type CapturedPiRequest } from '../../testing/pi-gateway-fixture';
import { PI_DEFAULT_EFFORT, PI_REASONING_EFFORTS, piProvider, piThinkingLevel } from './index';

describe('pi 的档位域与域外值', () => {
  /**
   * 域外值落到缺省档，**不交给厂商去夹**。
   *
   * 变异判据（真机读数，见下面那条请求侧用例）：把这一层改回「直传」⇒ openai wire 上 `xhigh`
   * 变成 `reasoning.effort: "max"`（升档），anthropic wire 上认不出的串变成
   * `thinking: { type: "disabled" }`（**关闭**）——两个方向都不是调用方给的那一档。
   */
  it('域外值（xhigh / 认不出的串）⇒ 缺省档；域内值逐字直传', () => {
    expect(piThinkingLevel('xhigh')).toBe(PI_DEFAULT_EFFORT);
    expect(piThinkingLevel('bogus')).toBe(PI_DEFAULT_EFFORT);
    expect(piThinkingLevel('')).toBe(PI_DEFAULT_EFFORT);
    expect(piThinkingLevel(undefined)).toBe(PI_DEFAULT_EFFORT);
    for (const effort of PI_REASONING_EFFORTS) expect(piThinkingLevel(effort)).toBe(effort);
    // metadata 那一格与这里的判据同源（两处各写一份就是「声明收、实际不收」的缺口）
    expect(piProvider.metadata.reasoningEfforts).toEqual(PI_REASONING_EFFORTS);
  });

  /** 域外值在**两条 wire** 的出站请求里都必须落成缺省档的形态，且落一条点名 WARN */
  it('域外值出站形态 = 缺省档（openai 的 reasoning.effort / anthropic 的预算），并点名', async () => {
    const seen: CapturedPiRequest[] = [];
    const gateway = await startPiGateway(seen);
    // 点名走 `logger.warn`（`console.warn`）：装配期的事实没有事件流出口，它是唯一留痕点
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
    try {
      const openai = await runPiCandidate(seen, gateway.port, { protocolType: 'openai', effort: 'xhigh' });
      expect(reasoningEffortOf(openai.body), '域外值不许被厂商静默升成 max').toBe(PI_DEFAULT_EFFORT);
      const bogus = await runPiCandidate(seen, gateway.port, { protocolType: 'openai', effort: 'bogus' });
      expect(reasoningEffortOf(bogus.body), '域外值不许让「思考」静默关掉').toBe(PI_DEFAULT_EFFORT);

      const anthropic = await runPiCandidate(seen, gateway.port, { protocolType: 'anthropic', effort: 'bogus' });
      expect(anthropic.body['thinking']).toEqual({ type: 'enabled', budget_tokens: 8192, display: 'summarized' });

      const logged = warns.join('\n');
      expect(logged, '域外档位必须点名（否则一次传错档名只剩「好像没思考」这一句症状）').toContain('域外的思考档位');
      expect(logged).toContain('bogus');
      expect(logged).toContain(PI_DEFAULT_EFFORT);
    } finally {
      spy.mockRestore();
      gateway.server.close();
    }
  }, 180_000);
});

/** 从 Responses 的出站请求体里取档位（`reasoning.effort`；缺失给 `undefined`） */
function reasoningEffortOf(body: Record<string, unknown>): unknown {
  const reasoning = body['reasoning'];
  return typeof reasoning === 'object' && reasoning !== null ? (reasoning as Record<string, unknown>)['effort'] : undefined;
}

describe('pi 的档位映射（openai wire 的请求体）', () => {
  /**
   * `off` 的判据是**显式 `reasoning.effort: 'none'`**：Responses 的关闭就是这一档（不是「不发键」，
   * 那是 Completions 的写法）。变异体：把 `off` 映射成 `minimal` ⇒ 这里读到的就是 `'minimal'`，当场红。
   */
  it('`off`：发 `reasoning.effort: "none"`', async () => {
    const seen: CapturedPiRequest[] = [];
    const gateway = await startPiGateway(seen);
    try {
      const { body } = await runPiCandidate(seen, gateway.port, { protocolType: 'openai', effort: 'off' });
      expect(seen.map((request) => request.url)).toEqual(['/v1/responses']);
      expect(body['reasoning']).toEqual({ effort: 'none' });
    } finally {
      gateway.server.close();
    }
  }, 60_000);

  /**
   * 四档同名直传 + `max` 走模型上那条显式映射（字面串原样出站）。
   * 变异体：去掉模型上的 `thinkingLevelMap` 却仍收 `max` ⇒ 厂商把 `max` 夹到 `high`，
   * 这里读到的就是 `'high'`，当场红。
   */
  it('`minimal|low|medium|high` 同名直传、`max` 由映射给出字面串', async () => {
    const seen: CapturedPiRequest[] = [];
    const gateway = await startPiGateway(seen);
    try {
      const sent: Record<string, unknown> = {};
      for (const effort of ['minimal', 'low', 'medium', 'high', 'max']) {
        const { body } = await runPiCandidate(seen, gateway.port, { protocolType: 'openai', effort });
        sent[effort] = reasoningEffortOf(body);
      }
      expect(sent).toEqual({ minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' });
    } finally {
      gateway.server.close();
    }
  }, 120_000);

  it('未选档位：实际发出去的就是声明的缺省档', async () => {
    const seen: CapturedPiRequest[] = [];
    const gateway = await startPiGateway(seen);
    try {
      const { body } = await runPiCandidate(seen, gateway.port, { protocolType: 'openai' });
      expect(reasoningEffortOf(body)).toBe(PI_DEFAULT_EFFORT);
      expect(piProvider.metadata.defaultEffort).toBe(PI_DEFAULT_EFFORT);
    } finally {
      gateway.server.close();
    }
  }, 60_000);
});

describe('pi 的档位映射（anthropic wire 的请求体）', () => {
  /** `off` 在 anthropic 这条 wire 上是**显式关闭**（不是缺席）：`thinking: { type: 'disabled' }` */
  it('`off`：`thinking: { type: "disabled" }`', async () => {
    const seen: CapturedPiRequest[] = [];
    const gateway = await startPiGateway(seen);
    try {
      const { body } = await runPiCandidate(seen, gateway.port, { protocolType: 'anthropic', effort: 'off' });
      expect(seen.map((request) => request.url)).toEqual(['/v1/messages?beta=true']);
      expect(body['thinking']).toEqual({ type: 'disabled' });
    } finally {
      gateway.server.close();
    }
  }, 60_000);

  /**
   * 逐档断言**换算后的预算**：这四档在 anthropic 上的映射结果不是同名直传，而是
   * 1024 / 2048 / 8192 / 16384——只看入参永远看不出这一步换算有没有做对。
   * `max` 与 `high` 同预算：厂商的预算表里只有四档，`max` 按 `high` 的预算下发
   * （档位映射给出的那个串只在 adaptive thinking 那类模型上才被用作出站档名）。
   */
  it('`minimal|low|medium|high` 换算成预算、`max` 按 high 的预算下发', async () => {
    const seen: CapturedPiRequest[] = [];
    const gateway = await startPiGateway(seen);
    try {
      const budgets: Record<string, unknown> = {};
      for (const effort of ['minimal', 'low', 'medium', 'high', 'max']) {
        const { body } = await runPiCandidate(seen, gateway.port, { protocolType: 'anthropic', effort });
        const thinking = body['thinking'] as Record<string, unknown> | undefined;
        budgets[effort] = thinking?.['budget_tokens'];
        expect(thinking?.['type']).toBe('enabled');
      }
      expect(budgets).toEqual({ minimal: 1024, low: 2048, medium: 8192, high: 16384, max: 16384 });
    } finally {
      gateway.server.close();
    }
  }, 120_000);
});
