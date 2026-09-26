/**
 * 模型名中转（"牌 A" 的本机复现）：把 codex 发出的 **codex 认识、但网关没有**的模型名
 * 改写成网关**有**的名字，其余字节原样透传。
 *
 * 为什么需要它：设计稿 §7.5.3 牌 A 的结论是「只能由网关提供 `gpt-6-astra/sol/luna`，
 * **本仓无解**」——那正是 `SubagentStart/Stop` hook 被定性为"无法实测"的唯一前提。
 * 但本轮实测发现 **codex 0.154.0 认识 `gpt-6-astra`**（无 `Model metadata … not found` 告警），
 * 而网关上有对应的 `gt-6-as-a`。⇒ 只要在两者之间放一层改名中转，
 * codex 就会用**它自己的 gpt-6-astra 元数据**（含 multi_agent profile）来注册本地执行器，
 * `spawn_agent` 于是有机会真的跑起来，hook 也才有机会真的触发。
 *
 * 边界（必须如实登记）：这是**探测用**的中转，不是本仓的解法——
 * 产品路径仍应要求网关直接提供带 profile 的模型名。
 *
 * ⚠️ 必须**逐块**转发（设计稿 §9.4.1 最贵的一课）：用 `await upstream.text()` 会把整条流转成一个
 * blob，破坏 SSE 分块语义，把"厂商不给增量"这类假象造出来。
 *
 * 用法：node probe/v2/lib/codex-model-relay.mjs <监听端口> <上游 base>
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 7999);
const upstreamBase = (process.argv[3] ?? 'http://likecode-llm-proxy-test.jd.com').replace(/\/+$/, '');

/** 改名表：codex 认识的名字 → 网关有的名字。 */
const MODEL_ALIASES = {
  'gpt-6-astra': 'gt-6-as-a',
  'gpt-6-sol': 'gt-6-sol-a',
  'gpt-6-luna': 'gt-6-lu-a',
};

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    void (async () => {
      const raw = Buffer.concat(chunks);
      let body = raw;
      let rewritten = null;
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        const target = MODEL_ALIASES[parsed.model];
        if (target !== undefined) {
          rewritten = `${parsed.model} → ${target}`;
          parsed.model = target;
          /**
           * `gt-6-*` 这一档的真机噪声是 `invalid_encrypted_content`（设计稿 §9.4 已登记）：
           * codex 会把上一轮的**加密推理条目**原样回传，而该模型不认。
           * ⇒ 改名之后必须同时 ①去掉 `include` 里的加密推理请求、②从 `input` 里剔除 `reasoning` 条目，
           * 否则子智能体的每一次模型调用都会以同一个错误收场（真机实测：父轮次 spawn 成功、
           * 子轮次全部失败，于是 `SubagentStop` 永远等不到）。
           */
          if (Array.isArray(parsed.include)) {
            parsed.include = parsed.include.filter((item) => !String(item).includes('encrypted_content'));
          }
          if (Array.isArray(parsed.input)) {
            parsed.input = parsed.input.filter((item) => item?.type !== 'reasoning');
          }
        }
        body = Buffer.from(JSON.stringify(parsed), 'utf8');
      } catch {
        /* 非 JSON（例如 GET）原样转发 */
      }

      const headers = { ...request.headers };
      delete headers.host;
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      // **强制不压缩**：下面转发的字节是原样的；若上游 gzip 了而我们又摘掉 `content-encoding`，
      // 客户端会拿到一段"标称明文、实为压缩"的 SSE ⇒ 表现为
      // `stream disconnected before completion: stream closed before response.completed`
      // （本轮实测踩过一次：18 条重连错误全部来自这里）。
      headers['accept-encoding'] = 'identity';
      headers['content-length'] = String(body.length);

      const url = `${upstreamBase}${request.url}`;
      console.log(`[relay] ${request.method} ${url} model=${rewritten ?? '(未改名)'}`);
      try {
        const upstream = await fetch(url, { method: request.method, headers, body: request.method === 'GET' ? undefined : body });
        if (upstream.status >= 400) {
          // 非 2xx 时把上游原文打出来：不打印就只能看到 codex 侧那句"重连中"，无法定位
          const text = (await upstream.text()).slice(0, 500);
          console.log(`[relay] 上游 HTTP ${upstream.status}：`, text.replaceAll('\n', ' '));
          response.writeHead(upstream.status, { 'content-type': 'application/json' });
          response.end(text);
          return;
        }
        const outHeaders = {};
        upstream.headers.forEach((value, key) => {
          if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return;
          outHeaders[key] = value;
        });
        response.writeHead(upstream.status, outHeaders);
        if (upstream.body === null) {
          response.end();
          return;
        }
        // 逐块转发：保持 SSE 的分块边界
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          response.write(value);
        }
        response.end();
      } catch (error) {
        console.log('[relay] 上游失败：', String(error?.message ?? error).slice(0, 200));
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'relay upstream failed', type: 'api_error' } }));
      }
    })();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[relay] 监听 127.0.0.1:${port} → ${upstreamBase}；改名表 ${JSON.stringify(MODEL_ALIASES)}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
