#!/usr/bin/env node
// 探针用的最小 MCP stdio server：一个回显工具 `probe_echo`，每次 `tools/call` 追加进 PROBE_CALL_LOG。
// `PROBE_DELAY_MS` 让 initialize 回应**同步**晚到（模拟 playwright MCP 那 6 秒的启动窗口）：
// 这一格是本轮 A/B 的自变量——「codex 起轮次时这台 server 还在 starting」。
import { appendFileSync } from 'node:fs';

const TOOL = process.env.PROBE_TOOL ?? 'probe_echo';
const LOG = process.env.PROBE_CALL_LOG;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let nl; (nl = buffer.indexOf('\n')) >= 0; ) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === 'initialize') {
      const delay = Number(process.env.PROBE_DELAY_MS ?? 0);
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'aieval-probe', version: '1.0.0' },
        },
      });
    } else if (msg.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: TOOL,
              description: '回显给定字符串',
              inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
            },
          ],
        },
      });
    } else if (msg.method === 'tools/call') {
      if (LOG !== undefined) {
        appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), name: msg.params?.name, args: msg.params?.arguments ?? null })}\n`, 'utf8');
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `echo:${String(msg.params?.arguments?.value ?? '')}` }], isError: false },
      });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
