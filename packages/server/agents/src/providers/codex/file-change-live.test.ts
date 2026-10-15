// @vitest-environment node
/**
 * **真机**守卫：文件改动清单里的 `kind` 必须读得到（`add` / `delete` / `update`）。
 *
 * 要拦的缺陷：厂商的 `FileUpdateChange.kind` 是 **`PatchChangeKind`——一个带标签的对象**
 * （`{"type":"add"}`，`update` 还带 `move_path`；生成物 `required = ['diff','kind','path']`），
 * 而 `readItem` 把它当字符串读 ⇒ **恒得 `null`**：账本上「哪些文件是新增、哪些是删除、
 * 哪些是改写」整格丢失，`{path, kind}` 只剩 `path`。
 *
 * 为什么必须真机：既有单测把**归一之后的条目**喂给投影（`changes: [{path, kind: 'update'}]`），
 * 根本没经过 `readItem` ⇒ 读错形状这件事在单测里完全隐形（「单测绿、真机红」的典型）。
 * 唯一能证到的形状是**厂商自己投的那一帧**，而它只有真二进制会产。
 *
 * 臂：脚本式上游让「模型」发一帧 `custom_tool_call`（`apply_patch` 是 freeform 工具，入参是
 * lark 补丁文本），真 `codex app-server` 自己执行它、自己投 `fileChange` 条目。判据读出站账本里
 * 那条 `apply_patch` 调用块的 `input.changes`：`kind` 必须是厂商那个标签，不是 `null`。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage } from '@aieval/contracts';
import { codexProvider } from './index';
import { collectEvents, createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';

/** 补丁正文（lark 语法，厂商原文） */
const PATCH_TEXT = '*** Begin Patch\n*** Add File: file-change-live.txt\n+hello\n*** End Patch\n';

function sseOf(events: ReadonlyArray<readonly [string, unknown]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/**
 * 剧本：第 1 轮发一帧 `custom_tool_call`（freeform 工具走的是 `custom_tool_call`，不是
 * `function_call`——`apply_patch` 的入参是一段 lark 文本而不是 JSON 对象）；之后纯文本收尾。
 */
function turnScript(index: number): string {
  const created = ['response.created', { type: 'response.created', response: { id: `resp_${index}` } }] as const;
  const completed = ['response.completed', {
    type: 'response.completed',
    response: { id: `resp_${index}`, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  }] as const;
  if (index === 0) {
    return sseOf([
      created,
      ['response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'custom_tool_call',
          id: 'ctc_live_0',
          call_id: 'call_file_change_live',
          name: 'apply_patch',
          input: PATCH_TEXT,
          status: 'completed',
        },
      }],
      completed,
    ]);
  }
  return sseOf([
    created,
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: `msg_${index}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'FILE_CHANGE_LIVE 收尾。', annotations: [] }],
      },
    }],
    completed,
  ]);
}

async function startScriptedUpstream(): Promise<{ url: string; close: () => void }> {
  let index = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const at = index;
      index += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(turnScript(at));
    });
  });
  server.unref();
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  return { url, close: () => (server.closeAllConnections?.() ?? server.close()) };
}

describe('真机：文件改动清单的 `kind`', () => {
  it('厂商的 `kind` 是带标签的对象 ⇒ 账本里必须是那个标签，不是 null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-file-change-'));
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configHome, { recursive: true });

    const upstream = await startScriptedUpstream();
    /** 厂商真的投过 `fileChange` 条目吗（没有 ⇒ 这条臂没有区分力） */
    const vendorItemTypes: string[] = [];
    const events: AgentEvent[] = [];
    const messages: AgentMessage[] = [];
    const original = codexProvider.runtimeHooks;
    codexProvider.runtimeHooks = {
      resolveBinary: original.resolveBinary,
      createClient: (input) => {
        const client = original.createClient(input);
        client.subscribe((notification) => {
          const item = ((notification.params ?? {}) as Record<string, unknown>)['item'] as { type?: unknown } | undefined;
          if (typeof item?.type === 'string') vendorItemTypes.push(item.type);
        });
        return client;
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    try {
      await codexProvider.run(createRunInput({
        cwd,
        configHome,
        permission: 'full',
        prompt: 'FILE_CHANGE_LIVE_PROMPT：给工作区加一个 file-change-live.txt。',
        route: { protocolType: 'openai', baseUrl: upstream.url, apiKey: 'file-change-live-placeholder-not-a-secret', modelId: 'gpt-5.5' },
        signal: controller.signal,
        onEvent: collectEvents(events),
        onMessage: (message) => messages.push(message),
      }));
    } finally {
      clearTimeout(timer);
      codexProvider.runtimeHooks = original;
      upstream.close();
      removeTreeWithRetry(root);
    }

    // ① 厂商侧：这条臂真的点亮了 `fileChange`
    expect(vendorItemTypes, '真厂商必须投过 fileChange').toContain('fileChange');
    // ② 账本侧：那条 `apply_patch` 调用块的入参里 `changes[].kind` 必须是厂商的标签
    const patchCalls = messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'tool-call' && block.name === 'apply_patch');
    expect(patchCalls.length, 'apply_patch 的调用块必须出现').toBeGreaterThan(0);
    const changes = (patchCalls[0]?.type === 'tool-call' ? patchCalls[0].input : null) as { changes?: Array<{ path?: string; kind?: string | null }> } | null;
    expect(changes?.changes?.[0]?.path, '路径要带上').toContain('file-change-live.txt');
    expect(changes?.changes?.[0]?.kind, '`kind` 必须读得到（厂商给的是 {type:"add"}）').toBe('add');
  }, 300_000);
});
