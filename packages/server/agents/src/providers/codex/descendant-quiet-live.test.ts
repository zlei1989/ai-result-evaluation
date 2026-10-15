// @vitest-environment node
/**
 * **真机**守卫：主线程先收场、子智能体还在跑时，子线程的**内容 / 用量 / 轮次 / 终态**都还要拿得到。
 *
 * 要拦的缺陷：本轮结算的闸门是**主线程的 `turn/completed`**，而模型派出去的子智能体往往还在跑。
 * 那一刻收尾取数会把子线程读成半截、它的用量通知也没人投影，随后 `dispose` 把那一轮掐掉。
 * 真机读数（同一剧本，子线程那一趟拖 8 s）：
 *
 * ```
 * 修复前  tokens={…} subagentTokens=null turns=2 subagentTurns=null
 *         turn/completed=[main]        用量通知=[main×2]        子线程 0 条
 *         thread/read{child}.status = {"type":"active"}         items 只有 1 条 userMessage
 *         子任务行 = [{status:"running", outcome:null}]
 *         WARN = [WARN] codex 子线程 … 没有用量通知（协议只按线程报累计用量）…
 * 修复后  turns=3 subagentTurns=1 subagentTokens={input:78,cached:33,output:11}
 *         子线程的消息进账本（`<childId>|1|assistant|-`，thinking + text）
 *         子任务行走到 status="completed" 且带 outcome
 * ```
 *
 * 判据是**四格一起**（内容 / 用量 / 轮次 / 终态）——只判一格会让「这一格恰好赶上了」蒙混过关
 * （真机读数里就有「内容读到了而用量丢了」那种各格独立的形状）。
 *
 * 机制：`asRawStream` 在上游产完之后走一段**有界**的静默窗口（`CODEX_DESCENDANT_QUIET_WAIT`）：
 * 每一拍把流停之后入队的通知交出来投影（用量只从通知来），并问一次「后代线程还活着吗」；
 * 收尾取数等这道闸门放行才读树。**没有后代线程时不花任何时间**。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage, SubagentRecord } from '@aieval/contracts';
import { codexProvider } from './index';
import { collectEvents, createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';

const MODEL = 'descendant-quiet-model';
const PLACEHOLDER_KEY = 'descendant-quiet-placeholder-not-a-secret';
const SPAWN_SENTINEL = 'DESCENDANT_QUIET_CHILD_TASK';
const CHILD_ANSWER = 'DESCENDANT_QUIET_CHILD_ANSWER 子线程答复。';
const MAIN_ANSWER = 'DESCENDANT_QUIET_MAIN_ANSWER 主线程答复。';
/** 子线程那一趟拖多久才回（要小于 `CODEX_DESCENDANT_QUIET_WAIT.waitMs`，否则会走到预算那一档） */
const CHILD_DELAY_MS = 1_500;

function sseOf(events: ReadonlyArray<readonly [string, unknown]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** 一帧文本收尾 */
function textTurn(responseId: string, text: string, usage: unknown): string {
  return sseOf([
    ['response.created', { type: 'response.created', response: { id: responseId } }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message', id: `msg_${responseId}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    }],
    ['response.completed', { type: 'response.completed', response: { id: responseId, usage } }],
  ]);
}

/** 一帧 `spawn_agent` 调用（`multi_agent_v1` 在真机工具表里是 namespace 工具） */
function spawnTurn(callId: string, usage: unknown): string {
  return sseOf([
    ['response.created', { type: 'response.created', response: { id: `resp_${callId}` } }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        id: `fc_${callId}`,
        call_id: callId,
        name: 'spawn_agent',
        namespace: 'multi_agent_v1',
        arguments: JSON.stringify({ message: `${SPAWN_SENTINEL} 请回一句话。` }),
        status: 'completed',
      },
    }],
    ['response.completed', { type: 'response.completed', response: { id: `resp_${callId}`, usage } }],
  ]);
}

/**
 * 脚本式上游，按**入站请求体的形状**分派三趟：
 *   ① 工具表里有 `multi_agent_v1` 且还没派过 ⇒ 主线程第一趟：回 `spawn_agent`；
 *   ② `input` 里有 `function_call_output` ⇒ 主线程第二趟：回主线程答复；
 *   ③ 派过之后剩下的 ⇒ **子线程那一趟**：延迟 `CHILD_DELAY_MS` 再回子线程答复。
 */
async function startScriptedUpstream(): Promise<{ url: string; childRequests: number; close: () => void }> {
  let spawnIssued = false;
  let childRequests = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        /* 非 JSON 体不是本臂读的对象 */
      }
      const tools = Array.isArray(body['tools']) ? (body['tools'] as Array<{ type?: string; name?: string }>) : [];
      const input = Array.isArray(body['input']) ? (body['input'] as Array<{ type?: string }>) : [];
      const hasMultiAgent = tools.some((one) => one?.type === 'namespace' && one?.name === 'multi_agent_v1');
      const hasToolOutput = input.some((one) => one?.type === 'function_call_output');

      const send = (payload: string, delayMs: number): void => {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (delayMs > 0) setTimeout(() => response.end(payload), delayMs);
        else response.end(payload);
      };

      if (!spawnIssued && hasMultiAgent) {
        spawnIssued = true;
        send(spawnTurn('call_spawn_0', { input_tokens: 31, output_tokens: 7, total_tokens: 38 }), 0);
        return;
      }
      if (hasToolOutput) {
        send(textTurn('resp_main', MAIN_ANSWER, { input_tokens: 222, output_tokens: 22, total_tokens: 244 }), 0);
        return;
      }
      childRequests += 1;
      send(textTurn('resp_child', CHILD_ANSWER, { input_tokens: 111, output_tokens: 11, total_tokens: 122 }), CHILD_DELAY_MS);
    });
  });
  server.unref();
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  return {
    url,
    get childRequests() {
      return childRequests;
    },
    close: () => (server.closeAllConnections?.() ?? server.close()),
  };
}

describe('真机：主线程先收场、子智能体还在跑', () => {
  it('子线程的内容 / 用量 / 轮次 / 终态四格都要拿得到（四格一起判）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-descendant-quiet-'));
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    const upstream = await startScriptedUpstream();

    const messages: AgentMessage[] = [];
    const subagents: SubagentRecord[] = [];
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    try {
      const result = await codexProvider.run(createRunInput({
        cwd,
        configHome,
        permission: 'full',
        prompt: 'DESCENDANT_QUIET_PROMPT：派一个子智能体去回一句话，然后自己收尾。',
        route: { protocolType: 'openai', baseUrl: upstream.url, apiKey: PLACEHOLDER_KEY, modelId: MODEL },
        signal: controller.signal,
        onEvent: collectEvents(events),
        onMessage: (message) => messages.push(message),
        onSubagent: (record) => subagents.push(record),
      }));

      // 臂的有效性前提：子线程真的被派出去、真的发过请求
      expect(upstream.childRequests, '子线程必须真的跑过（否则这条臂没有区分力）').toBeGreaterThan(0);

      // ① 用量：子线程那一份必须被采到（它只从运行期通知来）
      expect(result.subagentTokens, '子线程用量必须采到（通知要被投影，不能留在队列里没人读）').not.toBeNull();
      expect(result.subagentTokens?.output ?? 0, '子线程那一趟的输出 token').toBeGreaterThan(0);
      // ② 轮次：子线程那一趟要算进分母
      expect(result.subagentTurns, '子线程的往返数必须采到').not.toBeNull();
      expect(result.subagentTurns ?? 0, '子线程至少跑了一趟往返').toBeGreaterThanOrEqual(1);
      // ③ 内容：子线程的答复要进账本（带它自己的身份）
      const childTexts = messages
        .filter((one) => one.subagentId !== null)
        .flatMap((one) => one.blocks)
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''));
      expect(childTexts.join(''), '子线程的答复必须进账本').toContain(CHILD_ANSWER);
      // ④ 终态：子任务行最终要走到 completed 且带结论（不是停在 running/null）
      const settled = subagents.filter((one) => one.status === 'completed');
      expect(settled.length, '子任务行必须走到终态').toBeGreaterThan(0);
      expect(settled.at(-1)?.outcome ?? '', '终态那一行要带子线程的结论').toContain(CHILD_ANSWER);
    } finally {
      clearTimeout(timer);
      upstream.close();
      removeTreeWithRetry(root);
    }
  }, 300_000);
});
