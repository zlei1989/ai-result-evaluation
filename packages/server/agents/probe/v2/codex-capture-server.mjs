/**
 * codex 入站 `tools[]` 抓包服务（只读观测，落盘后立刻回 400）。
 *
 * 手法与 `docs/superpowers/notes/2026-09-30-agent-builtin-tools-inventory.md` 完全一致：
 * 起一个最小 HTTP 服务，把 `POST /v1/responses` 的请求体里 `tools[]` 落盘。
 * 用途（本轮）：判定 `update_plan` **到底是不是一个工具**——
 * 真机已看到 `item.type === 'todo_list'` 的 started/updated/completed 三连，
 * 但"它是 `update_plan` 工具的投影"还是"codex 自己的待办功能"必须由**入站工具表**分辨。
 *
 * 用法：node probe/v2/codex-capture-server.mjs <端口> <落盘名>
 */
import { createServer } from 'node:http';
import { note, writeDump } from './lib/gateway.mjs';

const port = Number(process.argv[2] ?? 7998);
const name = process.argv[3] ?? 'v2/codex-inbound-tools';

const captured = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      captured.push({
        url: request.url,
        model: parsed.model ?? null,
        tools: (parsed.tools ?? []).map((tool) => ({
          type: tool.type,
          name: tool.name,
          // namespace 容器把子工具摊开，便于一眼看出 multi_agent_v1 里有什么
          children: Array.isArray(tool.tools) ? tool.tools.map((child) => child.name) : null,
          description: typeof tool.description === 'string' ? tool.description.slice(0, 400) : null,
        })),
      });
    } catch (error) {
      captured.push({ url: request.url, parseError: String(error?.message ?? error).slice(0, 200) });
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'probe: captured', type: 'invalid_request_error' } }));
  });
});

server.listen(port, '127.0.0.1', () => {
  note('抓包服务已监听 127.0.0.1:' + port);
});

/** 收到请求就写一份快照；SIGINT 或 60 秒后自动收尾，避免留下孤儿进程。 */
const finish = () => {
  const last = captured.at(-1) ?? { tools: [] };
  const file = writeDump(name, {
    at: new Date().toISOString(),
    port,
    requestCount: captured.length,
    toolCount: last.tools.length,
    toolNames: last.tools.map((tool) => tool.name ?? `<${tool.type}>`),
    tools: last.tools,
  });
  note('请求数 =', captured.length, '；工具数 =', last.tools.length);
  note('工具表 =', last.tools.map((tool) => tool.name ?? `<${tool.type}>`).join(', '));
  note('→', file);
  server.close();
  process.exit(0);
};
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
setTimeout(finish, Number(process.env.AIEVAL_V2_CAPTURE_MS ?? 90000));
