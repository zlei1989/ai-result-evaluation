// @vitest-environment node
/**
 * 结构化输出的**真出站证据**（真 `codex app-server` + 本机假 `/v1/responses` 上游）。
 *
 * 为什么要这一条：`capability` 里没有结构化输出这一格——「这一次有没有真的走原生 schema 通道」
 * 由适配器在收尾按 `turn/start` 有没有带 `outputSchema` 上报（`applied.structuredOutput`）。
 * 而**入参传对了不等于厂商发出去了**：`outputSchema` 要经 codex 翻成 Responses 请求体的
 * `text.format`，那一份只有**出站请求体**看得见。没有这一条，把 `applied` 改成恒 `false`、
 * 或把 schema 悄悄丢掉，仓库里没有任何用例会红。
 *
 * 两臂（唯一自变量是**给不给 schema**）：给 ⇒ 请求体里有 `text.format`（`strict` 且 name 固定）；
 * 不给 ⇒ 那个键**不在**。阴性对照证明判据不是「请求体里总有 text.format」。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { codexProvider } from './index';
import { collectEvents, createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';

/** 一轮纯文本收尾（帧形与 `testing/codex-real-path-fixture.ts` 同源） */
function textTurn(text: string): string {
  const events: Array<[string, unknown]> = [
    ['response.created', { type: 'response.created', response: { id: 'resp_text' } }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_text', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
    }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_text', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** 本地假网关：把每一次入站请求体记下来（落点 `127.0.0.1`，请求根本不出本机） */
async function startRecordingGateway(): Promise<{ url: string; records: Array<{ body: Record<string, unknown> }>; close: () => void }> {
  const records: Array<{ body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* 非 JSON 体不是本用例读的对象 */
      }
      records.push({ body });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(textTurn('STRUCTURED_OUTPUT_LIVE_ANSWER 收尾。'));
    });
  });
  server.unref();
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  return { url, records, close: () => (server.closeAllConnections?.() ?? server.close()) };
}

/**
 * 跑一臂：`schema` 给不给是唯一自变量。
 *
 * 返回**两样**：第一条出站请求体（厂商那一侧的判据）与 `result.applied`（我们这一侧上报的那一格）。
 * 两样都要——只返回请求体时，「适配器上报得对不对」这一格在仓库里**没有任何判据**
 * （把 `applied.structuredOutput` 改成恒 `false`，相关用例会全绿，只有真机产物拦得住）。
 */
async function runArm(
  root: string,
  arm: string,
  schema: Record<string, unknown> | undefined,
): Promise<{ body: Record<string, unknown>; applied: { structuredOutput: boolean } }> {
  const cwd = join(root, `workspace-${arm}`);
  const configHome = join(root, `.agenthome-${arm}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  const gateway = await startRecordingGateway();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const events: AgentEvent[] = [];
  try {
    const result = await codexProvider.run(createRunInput({
      cwd,
      configHome,
      permission: 'full',
      prompt: 'STRUCTURED_OUTPUT_LIVE_PROMPT 跑一轮。',
      route: { protocolType: 'openai', baseUrl: gateway.url, apiKey: 'structured-output-placeholder-not-a-secret', modelId: 'structured-output-live-model' },
      signal: controller.signal,
      onEvent: collectEvents(events),
      ...(schema === undefined ? {} : { outputSchema: schema }),
    }));
    /**
     * 判据全部在返回值上（下面几条断言读的就是它）⇒ **不落任何产物文件**。
     * 落盘那一条曾经写进 `.scratch/`（gitignore，clone 读不到）——那是**取材目录当真源**，
     * 守卫 `docs/.vitepress/guards/kb-guards.test.ts` 按「全仓对 `.scratch/` 的引用计数为 0」判红。
     * 排障要留档时用 `mkdtempSync` 起一个本次用例自己的目录，不要指向仓内取材目录。
     */
    return { body: gateway.records[0]?.body ?? {}, applied: result.applied };
  } finally {
    clearTimeout(timer);
    gateway.close();
  }
}

describe('真机：结构化输出走的是原生 schema 通道（判据＝出站请求体）', () => {
  it('带 schema ⇒ 请求体 `text.format` 是 strict 的 json_schema；不带 ⇒ 那个键不在', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-structured-output-'));
    const schema = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
    try {
      const withSchema = await runArm(root, 'with-schema', schema);
      const withoutSchema = await runArm(root, 'without-schema', undefined);

      /**
       * **我们这一侧上报的那一格**（`applied.structuredOutput`）——它与出站请求体是两件事：
       * 前者是适配器的自述、后者是厂商真的收到了什么。只判后者时把 `applied` 改成恒 `false`
       * 在仓库里**一条都不红**（真机变异读数：356 条 codex 用例 + judge-agent + judge-route×2
       * 全绿），而下游是按前者分叉的（`score.structuredOutput` 与行级那条降级留痕）。
       */
      expect(withSchema.applied.structuredOutput, '带 schema 时适配器必须上报「走了原生通道」').toBe(true);
      expect(withoutSchema.applied.structuredOutput, '不给 schema 时不许上报成走了').toBe(false);

      // 带 schema：厂商真的把它翻成了 Responses 的 `text.format`
      const text = withSchema.body['text'] as { format?: { type?: string; name?: string; strict?: boolean; schema?: unknown } } | undefined;
      expect(text?.format?.type, '出站请求体的 text.format.type 必须是 json_schema').toBe('json_schema');
      expect(text?.format?.name, 'name 由 codex 固定').toBe('codex_output_schema');
      expect(text?.format?.strict, 'strict 必须是 true（否则形状不被厂商强制）').toBe(true);
      expect(text?.format?.schema, 'schema 原文必须逐字在请求体里').toEqual(schema);

      // 阴性对照：不给 schema ⇒ 那个键不在（证明上面那条不是「请求体里总有它」）
      const controlText = withoutSchema.body['text'];
      const hasFormat = controlText !== undefined
        && typeof controlText === 'object'
        && controlText !== null
        && Object.hasOwn(controlText, 'format');
      expect(hasFormat, '不给 schema 时请求体里不该有 text.format').toBe(false);
    } finally {
      removeTreeWithRetry(root);
    }
  }, 300_000);
});
