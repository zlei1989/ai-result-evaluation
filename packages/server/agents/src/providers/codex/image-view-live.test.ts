// @vitest-environment node
/**
 * **真机**守卫：`imageView`（模型看过一张图）必须落成 `image-view` 块，路径照厂商原文。
 *
 * 要拦的缺陷：静默丢、或者只留一段看不懂的原始载荷。`readItem` 把 `imageView` 归进
 * `{kind:'other'}`，而这一格若没有自己的分支，候选产物里就只剩两条假相等：
 * 「厂商没发」与「厂商发了、我们没接」长得一模一样（真机读数：事件流与账本对它的命中数都是 0）。
 *
 * 为什么必须真机：`imageView` 只有**真 `codex app-server`** 会投——脚本式上游只能替模型「决定」
 * 去调 `view_image`（该工具的逐字 schema 取自真机出站请求体：`{path: string}` required），
 * 真正读盘、真正产条目的是厂商自己。纯夹具写的形状若与厂商不符，这条守卫就是假绿。
 *
 * 两臂（同一次运行，唯一区别是**条目类型**）：
 *   · 被测：`view_image` ⇒ 厂商投 `item/started` + `item/completed{type:'imageView'}`
 *     ⇒ 账本里必须有一条 `image-view` 块，`path` 里带那个文件名；同一次运行**不许**再多出
 *     一条以 `imageView` 为 `vendorType` 的 `unrecognized` 块（那说明归一又退回了兜底）；
 *   · 对照：`exec_command` ⇒ 厂商投 `commandExecution`（已归一的类型）⇒ 账本里照旧有工具调用块。
 *   没有对照臂时，「账本里什么都没有」与「这一整套投影本来就不产东西」分不开。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage } from '@aieval/contracts';
import { codexProvider } from './index';
import { collectEvents, createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';

/** 1×1 的合法 PNG（脚本式上游只让模型「决定」看图，真正读盘的是厂商） */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 一句话的 SSE 序列（`event: …\ndata: …` 两行一组） */
function sseOf(events: ReadonlyArray<readonly [string, unknown]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/**
 * 剧本：第 1 轮让「模型」调 `view_image` 看那张真图；第 2 轮调 `exec_command`（对照臂）；
 * 之后一律纯文本收尾。
 *
 * 入参逐个字段照真机出站请求体里的 schema 给（`view_image` 只有 `path`；`exec_command` 的必填是
 * `cmd` 字符串）——给错字段名时厂商会把这次调用判失败，而失败的表现是「条目没出现」，
 * 会被误读成「投影丢了」⇒ 假红。
 */
function turnScript(index: number, imagePath: string): string {
  const created = ['response.created', { type: 'response.created', response: { id: `resp_${index}` } }] as const;
  const completed = ['response.completed', {
    type: 'response.completed',
    response: { id: `resp_${index}`, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  }] as const;
  const call = (id: string, name: string, args: unknown): readonly [string, unknown] => ['response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'function_call', id, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' },
  }];
  if (index === 0) return sseOf([created, call('call_img_0', 'view_image', { path: imagePath }), completed]);
  if (index === 1) return sseOf([created, call('call_exec_1', 'exec_command', { cmd: '/bin/echo IMAGE_VIEW_LIVE_CONTROL' }), completed]);
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
        content: [{ type: 'output_text', text: 'IMAGE_VIEW_LIVE 收尾。', annotations: [] }],
      },
    }],
    completed,
  ]);
}

/** 本地脚本式上游（落点 `127.0.0.1`，请求根本不出本机；不需要任何凭据） */
async function startScriptedUpstream(imagePath: string): Promise<{ url: string; close: () => void }> {
  let index = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const at = index;
      index += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(turnScript(at, imagePath));
    });
  });
  server.unref();
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  return { url, close: () => (server.closeAllConnections?.() ?? server.close()) };
}

describe('真机：模型看过的图片落成 image-view 块', () => {
  it('厂商投 `imageView` ⇒ 一条 `image-view` 块（对照臂：已归一的 `commandExecution` 照旧成块）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-image-view-'));
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    const imagePath = join(cwd, 'pixel.png');
    writeFileSync(imagePath, Buffer.from(PNG_BASE64, 'base64'));

    const upstream = await startScriptedUpstream(imagePath);
    /** 厂商真的投过哪些条目类型（这一格没有 ⇒ 这条臂没有区分力） */
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
        prompt: 'IMAGE_VIEW_LIVE_PROMPT：先看一眼工作区里的 pixel.png，再跑一条 echo，然后收尾。',
        route: { protocolType: 'openai', baseUrl: upstream.url, apiKey: 'unrecognized-live-placeholder-not-a-secret', modelId: 'unrecognized-live-model' },
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

    // ① 厂商侧：`imageView` 真的出现过（否则下面那条断言只是在测空气）
    expect(vendorItemTypes, '真厂商必须投过 imageView').toContain('imageView');
    // ② 对照臂：已归一的类型照旧成块（证明判据不是「这一整套投影本来就不产东西」）
    const toolNames = messages.flatMap((message) => message.blocks
      .filter((block) => block.type === 'tool-call')
      .map((block) => (block.type === 'tool-call' ? block.name : '')));
    expect(toolNames, '对照臂：exec_command 的工具调用块必须出现').toContain('exec_command');
    // ③ 被测：`imageView` 落成 `image-view` 块，路径（厂商原文）在块里
    const images = messages.flatMap((message) => message.blocks).filter((block) => block.type === 'image-view');
    expect(images.length, '`imageView` 必须产 image-view 块').toBeGreaterThan(0);
    expect(images[0]?.type === 'image-view' ? images[0].path : '', '路径是这一块的唯一内容').toContain('pixel.png');
    // ④ 反臂：同一个载荷不许再落出一条 `unrecognized`（两条并存说明兜底支先命中了）
    const imageUnrecognized = messages.flatMap((message) => message.blocks)
      .filter((block) => block.type === 'unrecognized' && block.vendorType === 'imageView');
    expect(imageUnrecognized, '`imageView` 不该再走 unrecognized 兜底').toEqual([]);
  }, 300_000);
});
