/**
 * v13 的**本机假上游**：一台只回 scripted SSE 的 anthropic-messages 服务。
 *
 * 为什么不用真网关：本目录的探针要证的是「厂商运行时把会话日志落在哪」，与上游是谁无关；
 * 假上游让每次运行都能离线复现，且入站请求体本身就是判据（见 `records`）。
 *
 * 帧形状与 `src/testing/dsh-real-path-fixture.ts` 的 `textTurn` 逐字同源——那份已在真路径用例里
 * 跑通过，各写一份必然在「少一个 content_block_stop 会怎样」这类细节上分叉。
 */
import { createServer } from 'node:http';

/** 一轮纯文本收尾的 SSE（`event: …\ndata: …` 两行一组） */
function textTurn(text) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_text', type: 'message', role: 'assistant', model: 'probe-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/**
 * 起一台假上游。
 *
 * @param {object} [options]
 * @param {string} [options.reply] 每一轮的收尾正文
 * @returns {Promise<{url: string, records: Array<{url: string, body: unknown}>, close: () => void}>}
 */
export async function startFakeUpstream(options = {}) {
  const reply = options.reply ?? '探针收尾。';
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = raw === '' ? {} : JSON.parse(raw);
      } catch {
        // 不是 JSON 体（探活之类）：照旧记一条，判据只读 JSON 那几条
      }
      records.push({ url: request.url ?? '', body });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(textTurn(reply));
    });
  });
  server.unref();
  const url = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`);
    });
  });
  return { url, records, close: () => server.close() };
}
