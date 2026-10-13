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
import { describe, expect, it } from 'vitest';
import { runPiRow, startPiGateway, type CapturedPiRequest } from '../../testing/pi-gateway-fixture';
import { PI_DEFAULT_EFFORT, piProvider } from './index';

describe('pi 的档位映射（openai wire 的请求体）', () => {
  /**
   * `off` 的判据是**键不存在**，不是「值等于某个串」：pi 对关闭的表达方式就是不发这个键
   * （发 `'none'` 是另一家的写法）。变异体：把 `off` 映射成 `minimal` ⇒ 这里会多出
   * `reasoning_effort: 'minimal'`，当场红。
   */
  it('`off`：不发 `reasoning_effort` 键', async () => {
    const seen: CapturedPiRequest[] = [];
    const gateway = await startPiGateway(seen);
    try {
      const { body } = await runPiRow(seen, gateway.port, { protocolType: 'openai', effort: 'off' });
      expect(seen.map((request) => request.url)).toEqual(['/v1/chat/completions']);
      expect(body).not.toHaveProperty('reasoning_effort');
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
        const { body } = await runPiRow(seen, gateway.port, { protocolType: 'openai', effort });
        sent[effort] = body['reasoning_effort'];
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
      const { body } = await runPiRow(seen, gateway.port, { protocolType: 'openai' });
      expect(body['reasoning_effort']).toBe(PI_DEFAULT_EFFORT);
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
      const { body } = await runPiRow(seen, gateway.port, { protocolType: 'anthropic', effort: 'off' });
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
        const { body } = await runPiRow(seen, gateway.port, { protocolType: 'anthropic', effort });
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
