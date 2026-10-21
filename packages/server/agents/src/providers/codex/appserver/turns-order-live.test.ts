// @vitest-environment node
/**
 * **真机**守卫：收尾回读拿到的轮次必须是**由旧到新**（`turns.at(-1)` = 最新一轮）。
 *
 * 要拦的缺陷：`thread/turns/list` 的 `sortDirection` 是**可选**格，厂商生成物的原文是
 * *"Optional turn pagination direction; defaults to descending."* —— 不传就是**最新一轮在前**。
 * 而 `message.ts` 的 `terminalStatusOf` / `outcomeOf` / `lastAgentText` 一律按 `turns.at(-1)`
 * 读「最后一轮」⇒ 多轮子线程会把**第一轮**的状态与结论当成它的终态交出去：
 * 真机两轮对照，`outcome` 交回第一轮的答复（`CHILD_ANSWER_TURN1`），而实际最后一轮是
 * `CHILD_ANSWER_TURN2`。
 *
 * 为什么必须真机：这一格是**厂商的默认值**，假 client 只会回放我们自己写进去的顺序——
 * 「我们传了 asc」与「厂商按 asc 回」是两件事，只有真二进制能同时证到。
 *
 * 臂：真 `codex app-server` + 脚本式上游，同一条线程上跑**两轮**（上游逐次回可分辨的正文），
 * 再走适配器自己的取数面 `readThreadContent`：
 *   · 两轮的 id 顺序必须与**发起顺序**一致（`turns[0]` 是第一轮）；
 *   · `turns.at(-1)` 的答复必须是**第二轮**那一句（下游读的就是这一格）。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCodexBinary } from './binary';
import { createAppServerClient } from './client';
import { readThreadContent } from './reader';
import { removeTreeWithRetry } from '../../../testing/cleanup';

/** 每次请求回一句可分辨的答复（第 n 次 ⇒ `TURNS_ORDER_ANSWER_<n>`） */
async function startCountingUpstream(): Promise<{ url: string; close: () => void }> {
  let index = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const n = index;
      index += 1;
      const events: Array<readonly [string, unknown]> = [
        ['response.created', { type: 'response.created', response: { id: `resp_${n}` } }],
        ['response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: `msg_${n}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: `TURNS_ORDER_ANSWER_${n}`, annotations: [] }],
          },
        }],
        ['response.completed', { type: 'response.completed', response: { id: `resp_${n}`, usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }],
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  server.unref();
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  return { url, close: () => (server.closeAllConnections?.() ?? server.close()) };
}

describe('真机：收尾回读的轮次顺序', () => {
  it('两轮线程回读必须由旧到新（`turns.at(-1)` = 最新一轮的答复）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-turns-order-'));
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    const upstream = await startCountingUpstream();
    const client = createAppServerClient({
      binary: resolveCodexBinary(),
      env: {
        ...process.env,
        // 三格全指候选配置目录：宿主家目录里的 codex 配置与 skills 都不许进来
        CODEX_HOME: configHome,
        HOME: configHome,
        USERPROFILE: configHome,
        OPENAI_API_KEY: 'turns-order-placeholder-not-a-secret',
      },
    });
    try {
      await client.initialize();
      const started = await client.request<{ thread: { id: string } }>('thread/start', {
        model: 'turns-order-model',
        cwd,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        config: {
          model_provider: 'turnsorder',
          model_providers: {
            turnsorder: {
              name: 'turns-order upstream',
              base_url: `${upstream.url}/v1`,
              wire_api: 'responses',
              env_key: 'OPENAI_API_KEY',
              request_max_retries: 1,
            },
          },
        },
      });
      const threadId = started.thread.id;

      /** 同一条线程上跑两轮：记下**发起顺序**的 turn id，收尾回读要能还原它 */
      const turnIds: string[] = [];
      for (const round of [1, 2]) {
        const turn = await client.request<{ turn: { id: string } }>('turn/start', {
          threadId,
          input: [{ type: 'text', text: `TURNS_ORDER_PROMPT 第 ${round} 轮` }],
        });
        turnIds.push(turn.turn.id);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const done = client.notifications().filter((one) => one.method === 'turn/completed'
            && (one.params as { threadId?: unknown } | null)?.threadId === threadId).length;
          if (done >= round) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      const content = await readThreadContent(client, threadId);
      expect(content).not.toBeNull();
      const turns = content?.thread.turns ?? [];
      // ① 顺序：收尾回读给的必须与发起顺序一致（不给 `sortDirection` 时厂商回的是倒序）
      expect(turns.map((one) => one.id), '轮次必须由旧到新').toEqual(turnIds);
      // ② 影响面：下游读的就是 `at(-1)`，它必须是**第二轮**那一句
      const lastText = turns.at(-1)?.items.find((one) => one.kind === 'agentMessage');
      expect(lastText?.kind === 'agentMessage' ? lastText.text : null, '最后一轮必须是第二轮').toBe('TURNS_ORDER_ANSWER_1');
    } finally {
      await client.close();
      upstream.close();
      removeTreeWithRetry(root);
    }
  }, 300_000);
});
