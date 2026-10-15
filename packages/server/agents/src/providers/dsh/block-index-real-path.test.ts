// @vitest-environment node
/**
 * dsh **块位次的真机判据**：`content[]` 里出现空块时，快照侧与旁路增量侧仍然落在同一个槽位。
 *
 * 为什么必须真机：单测（`message-blocks.test.ts`）只能钉住「我们按 `content` 下标发号」这条实现，
 * 而**前提**是「厂商会把空块放进 `content[]`」——那一格由厂商的装配器决定（`BlockAssembly.blocks()`
 * 是 one block per seen index、只有被打断那一支 `interruptedBlocks()` 滤空白）。假上游能稳定造出
 * 空块，于是这一条同时钉住两件事：厂商确实保留了它、我们两侧的口径因此仍然对齐。
 *
 * 两臂只差剧本里那一个空块（其余事件逐字相同），判据是**合并后的消息里有几个文本槽位**：
 * 位次是槽位键，两侧差一个号 ⇒ 同一段正文落两个槽位（真机读数：`['正文甲','正文甲']`），
 * 界面上画两次而两条都留在产物里。
 *
 * ⚠️ 这条判据对**两侧任一**变化都敏感：把快照侧改回「已产出块的个数」会红，
 * 而厂商哪天开始过滤空块（增量侧仍按 `block-start` 发号）同样会红——后者不是我们错，
 * 而是两侧的尺子不再同源，得重新对齐。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@aieval/contracts';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { createRunInput } from '../../testing/agent-fixtures';
import { setAgentRuntimeForTesting } from '../../runtime';
import { dshProvider } from './index';
import { DSH_STREAM_TAP_RELATIVE_PATH } from './stream-tap';

/** 那一段正文（两臂逐字相同，判据比的是它落在几个槽位上） */
const REPLY = '正文甲';

function sse(events: ReadonlyArray<readonly [string, unknown]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** 假上游：第一轮回「[可选空块] + 正文块」，其余轮次回纯文本 */
function startUpstream(emptyBlock: boolean): Promise<{ url: string; close: () => void }> {
  const server = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      const events: Array<readonly [string, unknown]> = [
        ['message_start', {
          type: 'message_start',
          message: {
            id: 'msg_blocks', type: 'message', role: 'assistant', model: 'real-path-model', content: [],
            stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }],
      ];
      let index = 0;
      if (emptyBlock) {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
        events.push(['content_block_stop', { type: 'content_block_stop', index }]);
        index += 1;
      }
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: REPLY } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index }]);
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }]);
      events.push(['message_stop', { type: 'message_stop' }]);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(sse(events));
    });
  });
  server.unref();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`,
        close: () => server.close(),
      });
    });
  });
}

interface ArmObservation {
  /** 旁路文件里 `block-start` 的条数：流里到底有几个块（空块也占一条） */
  blockStarts: number;
  /** 合并后的消息里，那一段正文落在几个文本槽位上 */
  replySlots: number;
}

async function runArm(emptyBlock: boolean): Promise<ArmObservation> {
  const root = mkdtempSync(join(tmpdir(), 'aieval-dsh-blocks-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.dshhome');
  mkdirSync(cwd, { recursive: true });
  const upstream = await startUpstream(emptyBlock);
  setAgentRuntimeForTesting(null);
  try {
    const messages: AgentMessage[] = [];
    await dshProvider.run(createRunInput({
      cwd,
      configHome,
      permission: 'full',
      prompt: '回一句话。',
      route: {
        protocolType: 'anthropic',
        baseUrl: upstream.url,
        apiKey: 'probe-placeholder',
        modelId: 'real-path-model',
      },
      onMessage: (message: AgentMessage) => messages.push(message),
    }));
    const tapText = (() => {
      try {
        return readFileSync(join(configHome, DSH_STREAM_TAP_RELATIVE_PATH), 'utf8');
      } catch {
        return '';
      }
    })();
    const blockStarts = tapText
      .split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => {
        try {
          return (JSON.parse(line) as { frame?: { chunk?: { type?: unknown } } }).frame?.chunk?.type === 'block-start';
        } catch {
          return false;
        }
      }).length;
    // 合并后的产物里那一段正文占几个文本槽位（每条投递各算一次，取**最大值** = 最完整的那个快照）
    const replySlots = Math.max(
      0,
      ...messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.blocks.filter((block) => block.type === 'text' && block.text === REPLY).length),
    );
    return { blockStarts, replySlots };
  } finally {
    upstream.close();
    setAgentRuntimeForTesting(null);
    removeTreeWithRetry(root);
  }
}

describe('dsh 块位次的真机判据（空块那一档）', () => {
  it('两臂：那一段正文都只占一个文本槽位', async () => {
    const control = await runArm(false);
    const withEmpty = await runArm(true);
    // 前提：空块**确实进了流**（旁路文件按 block-start 逐条记），否则实验臂等于对照臂、判据没有区分力
    expect(withEmpty.blockStarts, '空块没进流 ⇒ 这一臂与对照臂同形').toBeGreaterThan(control.blockStarts);
    expect(control.replySlots, '对照臂里那一段正文没落成文本块').toBe(1);
    expect(withEmpty.replySlots, '空块让同一段正文落进了多个槽位 ⇒ 两侧的块位次不再同源').toBe(1);
  });
});
