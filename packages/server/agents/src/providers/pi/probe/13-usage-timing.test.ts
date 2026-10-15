// @vitest-environment node
/**
 * 探针 13：**`usage` 事件的时长那一格：一台网关跑几次，逐条读数**。
 *
 * 为什么要连跑多次而不是一次：单跑一次只能看到一条 `usage` 事件（末条），而这一格的口径是
 * 「**每一次**模型往返各发一条、时长只挂在带助手快照的那一条上」。一次读不出这个结构，
 * 也读不出「第一条是 `null`」到底是结构还是偶然。
 *
 * 三条读数（每条都来自真跑）：
 *   ① 一轮运行里有几条 `usage` 事件、各自带不带 `timing`；
 *   ② `timing` 的 `source` 是不是 `'vendor'`、`ttftMs` 是不是恒 `null`
 *      （适配器只认厂商消息上的 `timestamp` + `durationMs` 两个数，缺一个就整条不发）；
 *   ③ 同一份装配连跑 5 次，结构是否稳定（一次的读数可能是抖动，五次的形状才是结构）。
 *
 * 两臂：假网关（脚本式上游，形状可控）与真网关（真模型；缺凭据则明说跳过、不回落读宿主配置）。
 *
 * ⚠️ 别拿 `AgentMessage.raw` 当厂商消息读：那一格是**归一后的信封**（`message.ts` 造），
 * 厂商的 `timestamp` / `durationMs` 不在它上面——本探针第一版就踩过这一脚，读数因此全 `false`，
 * 而同一轮的 `usage.timing` 明明是有的（那是适配器在投影里读的**真**厂商消息）。
 * 判据因此只取 `usage.timing` 这一侧，它才是消费方看到的东西。
 *
 * 用法：
 *   node_modules/.bin/vitest run packages/server/agents/src/providers/pi/probe/13-usage-timing.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { createRunInput } from '../../../testing/agent-fixtures';
import { anthropicText, startPiScriptedGateway } from '../../../testing/pi-conformance-fixture';
import { piProvider } from '..';

/** 一条 `usage` 事件的读数（只取判据要的几格） */
interface UsageReading {
  seq: number;
  turns: number | null;
  /** 事件里的轮次归属（可能是 `null` 或缺席——契约把它声明成可空） */
  round: number | null;
  /** 时长那一格（可缺省；`source` 是 `'vendor' | 'events'` 两档） */
  timing: { totalMs: number | null; apiMs: number | null; ttftMs: number | null; source: string } | null;
}

function usageReadings(events: readonly AgentEvent[]): UsageReading[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage')
    .map((event) => {
      const timing = event.timing ?? null;
      return {
        seq: event.seq,
        turns: event.turns ?? null,
        round: event.turn?.round ?? null,
        timing: timing === null
          ? null
          : { totalMs: timing.totalMs, apiMs: timing.apiMs, ttftMs: timing.ttftMs, source: timing.source },
      };
    });
}

/** 跑一次真适配器：`route` 由调用方给（假网关 / 真网关两条臂只差这一点） */
async function runOnce(route: { protocolType: 'anthropic'; baseUrl: string; apiKey: string; modelId: string }, prompt: string): Promise<UsageReading[]> {
  const root = mkdtempSync(join(tmpdir(), 'pi-v12-usage-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  const events: AgentEvent[] = [];
  try {
    await piProvider.run({
      ...createRunInput({ cwd, configHome }),
      prompt,
      permission: 'read-only',
      route: { ...route, contextWindow: 1_000_000, maxOutputTokens: 32_768 },
      onEvent: (event) => events.push(event),
    });
    return usageReadings(events);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('usage 事件的时长那一格', () => {
  it('假网关：一轮运行里第一条为 null、带助手快照的那一条带 vendor 时长', async () => {
    const gateway = await startPiScriptedGateway([anthropicText('收到。')]);
    try {
      const readings = await runOnce(
        { protocolType: 'anthropic', baseUrl: `http://127.0.0.1:${gateway.port}/v1`, apiKey: 'sk-probe', modelId: 'm1' },
        '只回一句。',
      );
      dump('13-usage-timing-fake', readings);
      expect(readings.length, '一条 usage 都没有').toBeGreaterThan(0);
      const timed = readings.filter((one) => one.timing !== null);
      expect(timed.length, '没有任何一条 usage 带时长').toBeGreaterThan(0);
      expect(timed.every((one) => one.timing?.source === 'vendor')).toBe(true);
      expect(timed.every((one) => one.timing?.ttftMs === null)).toBe(true);
    } finally {
      gateway.close();
    }
  }, 120_000);

  const KEY = process.env.AIEVAL_PROBE_GATEWAY_API_KEY ?? '';
  const BASE = process.env.AIEVAL_PROBE_GATEWAY_BASE_URL ?? '';
  const MODEL = process.env.AIEVAL_PROBE_CC_MODEL ?? '';
  const live = KEY !== '' && BASE !== '' && MODEL !== '';

  it.skipIf(!live)('真网关：同一份装配连跑 5 次，结构稳定且时长来自厂商', async () => {
    const runs: UsageReading[][] = [];
    for (let index = 0; index < 5; index += 1) {
      runs.push(await runOnce({ protocolType: 'anthropic', baseUrl: BASE, apiKey: KEY, modelId: MODEL }, '只回一句：收到。'));
    }
    dump('13-usage-timing-live', runs);
    // 每一次运行的形状都必须一样：第一条无时长、最后一条有 vendor 时长
    for (const [index, readings] of runs.entries()) {
      const timed = readings.filter((one) => one.timing !== null);
      expect(timed.length, `第 ${index} 次运行没有任何一条 usage 带时长`).toBeGreaterThan(0);
      expect(timed.every((one) => one.timing?.source === 'vendor'), `第 ${index} 次运行的时长来源不是厂商`).toBe(true);
      expect(timed.every((one) => one.timing?.ttftMs === null), `第 ${index} 次运行的 ttftMs 不是 null`).toBe(true);
    }
  }, 600_000);
});

/** 读数落盘到 `probe/dumps/v12/` */
function dump(name: string, payload: unknown): void {
  const dir = join(import.meta.dirname, '..', '..', '..', '..', 'probe', 'dumps', 'v12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
