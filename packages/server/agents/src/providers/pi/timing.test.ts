// @vitest-environment node
/**
 * pi 的**时长上报**（请求侧事实）：真机往返之后 `usage` 事件里报的是什么、来源是什么。
 *
 * 口径只有一条：`usage.timing` 的每一格都必须是**同一把尺子**上的数。厂商在每条助手消息上给了
 * `timestamp`（请求起点）与 `durationMs`（从该起点量到响应收尾），于是两个端点与 `apiMs` 全取它，
 * 整格记 `'vendor'`；首字时延**恒为空**——它只能我们按自己的时钟测，混进同一格会让 `mergeTiming`
 * 把整格作废（代价不是「这一格不准」，而是整条时长消失）。
 *
 * 判据分两层：这一层是**线上真跑出来的那条事件**（报了什么、来源是什么），逐数的变异判据在
 * `events.test.ts`。为什么需要后者：真机往返只有十几毫秒，自测的墙钟与厂商的 `durationMs`
 * 在数值上本来就几乎相等 ⇒ 单看线上那条事件区分不出「估算冒充厂商数」，
 * 只有投影层那组把入参定死的用例能确定地把它照出来。
 */
import { describe, expect, it } from 'vitest';
import { lastPiUsage, runPiRow, startPiGateway, type CapturedPiRequest } from '../../testing/pi-gateway-fixture';

describe('pi 的时长上报（真机往返的 usage 事件）', () => {
  /**
   * 两条 wire 各跑一次真往返：`source` 是 `'vendor'`、`ttftMs` 为空、单轮里 `totalMs` 与 `apiMs`
   * 逐字相等（`apiMs` 是「本行到目前为止」的累计口径，这一行只有一轮往返）。
   */
  for (const protocolType of ['openai', 'anthropic'] as const) {
    it(`${protocolType} wire：两个端点与 apiMs 同源、ttftMs 为空`, async () => {
      const seen: CapturedPiRequest[] = [];
      const gateway = await startPiGateway(seen);
      try {
        const { events } = await runPiRow(seen, gateway.port, { protocolType, effort: 'low' });
        const timing = lastPiUsage(events).timing;
        expect(timing).not.toBeNull();
        expect(timing?.source).toBe('vendor');
        expect(timing?.ttftMs).toBeNull();
        expect(timing?.apiMs).toBeTypeOf('number');
        expect(timing?.totalMs).toBeTypeOf('number');
        expect(timing?.apiMs).toBe(timing?.totalMs);
        expect(timing?.apiMs ?? -1).toBeGreaterThanOrEqual(0);
      } finally {
        gateway.server.close();
      }
    }, 60_000);
  }
});
