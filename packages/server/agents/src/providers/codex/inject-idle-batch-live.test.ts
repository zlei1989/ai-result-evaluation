// @vitest-environment node
/**
 * **真机**守卫：一次 `drain('idle')` 交出**多条**人话时，一条都不许丢。
 *
 * 要拦的缺陷（真机复现 3/3）：条目录在**空闲**线程上时，厂商在 `thread/queue/add` 那一刻就把
 * **第 1 条**撒成了新一轮 ⇒ 第 2 条 add 撞在忙线程上只入队，我们紧接着的 `thread/queue/start`
 * 被拒（`thread already has an active or pending turn`）。旧实现把这一批当**整体**处置：
 * 只要「有任意一条被消费」就整批返回，于是第 2 条**既不登记交付、也不回滚、也没人等它**，
 * 随 `dispose` 一起没（读数：`deliveredIds=['…msg-1']`、msg-2 哨兵 **0** 次进出站请求体、
 * `turnStarted=2=turnCompleted`、`finalText` 取第 1 条那一轮，且默认日志一条 WARN 都不打）。
 *
 * 真机事实（本守卫的第三条断言就是它）：**厂商会自己在当前轮收场后把队列里剩下那条撒出去**
 * ——裸臂读数：空闲线程连加两条、之后什么都不做 ⇒ `turnStarted=3=turnCompleted=3`、
 * 两条哨兵都进了出站请求体。⇒ 正确处置是「别收场，等它」，不是「回滚」也不是「谎报已交付」。
 *
 * 四条判据（与 `turn-injection-delivery.test.ts` 同一口径）：
 *   ① 两条都登记交付；② 两条哨兵都进**厂商出站请求体**（不经过我们的投影）；
 *   ③ 起过的轮次全部跑完（收场即 `dispose` 杀进程）；④ 结论取最后一轮（两句都收到那一轮）。
 * 阴性对照：同一套装配、同一份提示词，只是不挂注入面 ⇒ 哨兵一次都不许出现。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import type { AppServerClient } from './appserver/client';
import { codexProvider, defaultCodexRuntimeHooks } from './index';
import { collectEvents, createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import type { InjectionPort, UserMessage } from '../../types';

const MODEL = 'inject-idle-batch-model';
const PLACEHOLDER_KEY = 'inject-idle-batch-placeholder-not-a-secret';
const SENTINEL_1 = 'INJECT_IDLE_BATCH_SENTINEL_1';
const SENTINEL_2 = 'INJECT_IDLE_BATCH_SENTINEL_2';
const FIRST_ANSWER = 'INJECT_IDLE_BATCH_FIRST_ANSWER 首轮。';
const ONE_ANSWER = 'INJECT_IDLE_BATCH_ONE_ANSWER 只收到第 1 条。';
const TWO_ANSWER = 'INJECT_IDLE_BATCH_TWO_ANSWER 收到第 1 与第 2 条。';

/** 每次请求按「请求体里带了哪些哨兵」回一句可分辨的答复（模型那一侧是假的，厂商那一侧全真） */
async function startScriptedUpstream(): Promise<{ url: string; sentinelCount: (sentinel: string) => number; close: () => void }> {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      bodies.push(raw);
      const has1 = raw.includes(SENTINEL_1);
      const has2 = raw.includes(SENTINEL_2);
      // 两条都在 ⇒ 那句话就是两条都收到；只有第 1 条 ⇒ 只说收到第 1 条；都没有 ⇒ 首轮答复
      const text = has1 && has2 ? TWO_ANSWER : has1 ? ONE_ANSWER : FIRST_ANSWER;
      const events: Array<readonly [string, unknown]> = [
        ['response.created', { type: 'response.created', response: { id: `resp_${String(bodies.length)}` } }],
        ['response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: `msg_${String(bodies.length)}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        }],
        ['response.completed', { type: 'response.completed', response: { id: `resp_${String(bodies.length)}`, usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }],
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  server.unref();
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  return {
    url,
    sentinelCount: (sentinel: string) => bodies.filter((one) => one.includes(sentinel)).length,
    close: () => (server.closeAllConnections?.() ?? server.close()),
  };
}

interface ArmReading {
  deliveredIds: string[];
  sentinel1InOutbound: number;
  sentinel2InOutbound: number;
  turnStarted: number;
  turnCompleted: number;
  finalText: string | null;
  queueOps: string[];
}

/** 跑一臂：`count` = 端口**一次**交出几条（两臂唯一的自变量）；`withPort=false` 是阴性对照 */
async function runArm(root: string, count: number, withPort: boolean): Promise<ArmReading> {
  const cwd = join(root, `ws-${String(count)}-${String(withPort)}`);
  const configHome = join(root, `home-${String(count)}-${String(withPort)}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  const upstream = await startScriptedUpstream();
  const all: UserMessage[] = [
    { id: 'inject-idle-batch-msg-1', text: `${SENTINEL_1} 第 1 条人话` },
    { id: 'inject-idle-batch-msg-2', text: `${SENTINEL_2} 第 2 条人话` },
  ];
  const delivered: string[] = [];
  let drained = false;
  const port: InjectionPort = {
    available: true,
    drain: (boundary) => {
      if (boundary !== 'idle' || drained) return [];
      drained = true;
      return all.slice(0, count);
    },
    markDelivered: (ids) => {
      delivered.push(...ids);
    },
    retract: async () => 'unsupported',
  };

  const notifications: Array<{ method: string }> = [];
  const requests: string[] = [];
  const original = codexProvider.runtimeHooks;
  codexProvider.runtimeHooks = {
    resolveBinary: defaultCodexRuntimeHooks.resolveBinary,
    createClient: (input) => {
      const client: AppServerClient = defaultCodexRuntimeHooks.createClient(input);
      client.subscribe((notification) => {
        notifications.push({ method: notification.method });
      });
      const request = client.request.bind(client);
      client.request = (method, params) => {
        requests.push(method);
        return request(method, params);
      };
      return client;
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const events: AgentEvent[] = [];
  try {
    const result = await codexProvider.run(createRunInput({
      cwd,
      configHome,
      permission: 'full',
      prompt: 'INJECT_IDLE_BATCH_PROMPT 先跑第一轮。',
      route: { protocolType: 'openai', baseUrl: upstream.url, apiKey: PLACEHOLDER_KEY, modelId: MODEL },
      signal: controller.signal,
      onEvent: collectEvents(events),
      ...(withPort ? { inject: port } : {}),
    }));
    return {
      deliveredIds: delivered,
      sentinel1InOutbound: upstream.sentinelCount(SENTINEL_1),
      sentinel2InOutbound: upstream.sentinelCount(SENTINEL_2),
      turnStarted: notifications.filter((one) => one.method === 'turn/started').length,
      turnCompleted: notifications.filter((one) => one.method === 'turn/completed').length,
      finalText: result.finalText,
      queueOps: requests.filter((one) => one.startsWith('thread/queue')),
    };
  } finally {
    clearTimeout(timer);
    codexProvider.runtimeHooks = original;
    upstream.close();
    removeTreeWithRetry(root);
  }
}

describe('真机：一次 drain(\'idle\') 交出多条人话', () => {
  it('两条都要投出去（对照臂：单条行为逐字不变；阴性对照：不挂注入面时哨兵零出现）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-inject-idle-batch-'));
    try {
      // 对照臂在前：单条那一档是本行 `real-path` 已验的行为，改动不许碰它
      const single = await runArm(root, 1, true);
      expect(single.deliveredIds, '对照臂：单条照旧登记交付').toEqual(['inject-idle-batch-msg-1']);
      expect(single.sentinel1InOutbound, '对照臂：第 1 条哨兵要进请求体').toBeGreaterThan(0);
      expect(single.sentinel2InOutbound, '对照臂：第 2 条压根没交出去').toBe(0);
      expect(single.turnCompleted, '对照臂：起过的轮次都要跑完').toBe(single.turnStarted);

      const batch = await runArm(root, 2, true);
      // ① 两条都登记交付（旧实现在这里只交回第 1 条）
      expect(batch.deliveredIds, '两条人话都必须登记交付').toEqual(['inject-idle-batch-msg-1', 'inject-idle-batch-msg-2']);
      // ② 两条都真的到了模型面前：判据是厂商出站请求体，不经过我们的任何投影
      expect(batch.sentinel1InOutbound, '第 1 条哨兵必须进出站请求体').toBeGreaterThan(0);
      expect(batch.sentinel2InOutbound, '第 2 条哨兵必须进出站请求体（厂商会在当前轮收场后自己撒出去）').toBeGreaterThan(0);
      // ③ 那一轮不许被我们杀掉（收场即 dispose 杀进程）
      expect(batch.turnCompleted, '起过的轮次全部跑完').toBe(batch.turnStarted);
      expect(batch.turnStarted, '两条人话至少要各占一轮').toBeGreaterThanOrEqual(3);
      // ④ 结论取最后一轮（两句都收到那一轮）
      expect(batch.finalText ?? '', '最终答复应当来自两句都收到的那一轮').toContain(TWO_ANSWER);
      expect(batch.queueOps, '投递路径含 add / start / list（对账读队列）').toEqual(
        expect.arrayContaining(['thread/queue/add', 'thread/queue/start', 'thread/queue/list']),
      );

      // 阴性对照：不挂注入面 ⇒ 哨兵一次都不许出现（证明上面那两条不是提示词泄漏）
      const control = await runArm(root, 2, false);
      expect(control.sentinel1InOutbound, '不挂注入面时第 1 条哨兵不该出现').toBe(0);
      expect(control.sentinel2InOutbound, '不挂注入面时第 2 条哨兵不该出现').toBe(0);
      expect(control.deliveredIds, '不挂注入面时不该有交付登记').toEqual([]);
    } finally {
      removeTreeWithRetry(root);
    }
  }, 600_000);
});
