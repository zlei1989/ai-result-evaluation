/**
 * 极简 **wire 抓包 relay**：codex 的 Responses 请求照原样转发给上游，顺手把
 * 「请求体关键格 + 响应状态 + SSE 事件类型」留下来。
 *
 * 为什么需要它：app-server 的通知流只说「有没有答复」，说不清**是 CLI 没把 schema 发出去**
 * 还是**上游不认那一格**。这两件事的修法完全不同，必须由入站请求体分辨。
 *
 * 三条口径（都踩过）：
 *  1. **逐块转发**：`await upstream.text()` 会把 SSE 变成一次性 blob，造出「厂商不给增量」的假象；
 *  2. **`accept-encoding: identity`**：转发的是原字节，上游若 gzip 而我们又摘掉 `content-encoding`，
 *     客户端拿到的是「标称明文、实为压缩」的流；
 *  3. **不打印密钥**：`authorization` 头只记「有没有」，值一律不进产物。
 */
import { createServer } from 'node:http';

/** 请求体里我们关心的那几格（`text.format` 是 Responses 的结构化输出落点） */
function summarizeRequest(url, raw) {
  const base = { url, bytes: raw.length };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, parseError: true, head: raw.slice(0, 400) };
  }
  const input = Array.isArray(parsed.input) ? parsed.input : [];
  return {
    ...base,
    model: parsed.model ?? null,
    stream: parsed.stream ?? null,
    include: parsed.include ?? null,
    text: parsed.text ?? null,
    responseFormat: parsed.response_format ?? null,
    keys: Object.keys(parsed).sort(),
    inputTypes: input.map((one) => one?.type ?? 'unknown'),
    toolNames: Array.isArray(parsed.tools) ? parsed.tools.map((one) => one?.name ?? `<${one?.type}>`) : null,
    raw: raw.length > 20_000 ? `${raw.slice(0, 20_000)}…（截断，共 ${raw.length} 字节）` : raw,
  };
}

/** SSE 原文 → 事件类型计数 + 关键事件（`response.completed` 里才有最终 output） */
function summarizeStream(text) {
  const counts = {};
  let completed = null;
  let failed = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let json = null;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    const type = json?.type ?? 'unknown';
    counts[type] = (counts[type] ?? 0) + 1;
    if (type === 'response.completed') {
      completed = {
        status: json.response?.status ?? null,
        outputTypes: Array.isArray(json.response?.output) ? json.response.output.map((one) => one?.type ?? 'unknown') : null,
        outputTexts: Array.isArray(json.response?.output)
          ? json.response.output.map((one) => ({
            type: one?.type ?? null,
            text: typeof one?.text === 'string' ? one.text.slice(0, 600) : null,
            contentType: one?.content?.[0]?.type ?? null,
            contentText: typeof one?.content?.[0]?.text === 'string' ? one.content[0].text.slice(0, 600) : null,
          }))
          : null,
        usage: json.response?.usage ?? null,
        incomplete: json.response?.incomplete_details ?? null,
      };
    }
    if (type === 'response.failed' || type === 'error') {
      failed = json;
    }
  }
  return { counts, completed, failed };
}

/**
 * 起一个 relay。返回 `url` 是 codex 该填的 base（**不带** `/v1`，与仓内 `ensureV1Suffix` 同口径）。
 */
export function startWireRelay({ upstreamBase, maxStreamBytes = 2_000_000 }) {
  const records = [];
  const upstream = upstreamBase.replace(/\/+$/, '');
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks);
        const record = {
          method: request.method ?? 'GET',
          request: request.method === 'GET' ? { url: request.url } : summarizeRequest(request.url ?? '', raw.toString('utf8')),
          authorizationAttached: request.headers.authorization !== undefined,
        };
        records.push(record);

        const headers = { ...request.headers };
        delete headers.host;
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        headers['accept-encoding'] = 'identity';
        if (request.method !== 'GET') headers['content-length'] = String(raw.length);

        try {
          const upstreamResponse = await fetch(`${upstream}${request.url ?? ''}`, {
            method: request.method,
            headers,
            ...(request.method === 'GET' ? {} : { body: raw }),
          });
          record.status = upstreamResponse.status;
          record.contentType = upstreamResponse.headers.get('content-type');
          response.writeHead(upstreamResponse.status, {
            'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json',
          });
          if (upstreamResponse.body === null) {
            response.end();
            return;
          }
          let streamText = '';
          for await (const chunk of upstreamResponse.body) {
            if (streamText.length < maxStreamBytes) streamText += Buffer.from(chunk).toString('utf8');
            response.write(chunk);
          }
          response.end();
          record.stream = summarizeStream(streamText);
        } catch (error) {
          record.transportError = String(error?.message ?? error);
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: record.transportError } }));
        }
      })();
    });
  });

  return {
    records,
    /** codex 的 `base_url`：`http://127.0.0.1:<port>`（它自己会拼 `/v1/responses`） */
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`);
        });
      }),
    close: () => {
      server.close();
    },
  };
}
