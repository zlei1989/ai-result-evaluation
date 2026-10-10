/**
 * 执行级取证（v3）：pi-ai 到底把请求发到了**哪个路径**、带了**哪个鉴权头**、请求体里
 * **档位落在哪个字段**。
 *
 * 为什么需要它：那几条事实（URL 拼接 / 鉴权头 / 档位落点）在 v3 之前只有
 * 「pi-ai → 厂商 SDK → 端点常量」三段代码链的推论，两个仓库里都**没有执行级断言**。
 * 真机跑通（`dsh-pi-ai-both.mjs`）只能证明「路径大方向没写错」，说不出具体字符串。
 *
 * 做法：起一个**故意回 404 的本地服务器**，把请求原样记下来再把内容回显进错误信息。
 * 这样一次失败的运行就同时给出三件事的证据，且**不花模型调用**：
 *   ① 路径（含 query）——D8 的归一化方向靠它判定；
 *   ② 头（鉴权头名与是否带 key，凭据只报长度）；
 *   ③ 请求体的顶层键与档位字段（D5 的 wire 拼写靠它判定）。
 */
import { createServer } from 'node:http';
import { note, writeDump } from './lib/gateway.mjs';
import { runPiAiRoute } from './lib/harness.mjs';

/** 收到的请求（按顺序）。 */
const seen = [];

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    const record = {
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [
        key,
        // 凭据只留长度：报告里不该出现密钥，但「有没有带 key」必须可判
        key === 'authorization' ? `Bearer(len=${String(value).replace(/^Bearer\s+/i, '').length})` : value,
      ])),
      bodyKeys: body === null ? null : Object.keys(body),
      // 档位落点：两条 wire 的字段名不同，**两个都抓**
      reasoning: body?.reasoning ?? null,
      thinking: body?.thinking ?? null,
      model: body?.model ?? null,
      stream: body?.stream ?? null,
    };
    seen.push(record);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ notice: 'aieval-v3-forensics: 故意 404，请求已被记录', record }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
note('回声服务器：', origin);

/** 跑一条协议（每次都在同一个服务器上，靠 seen 的增量区分）。 */
async function forensics(protocolType, effort) {
  const before = seen.length;
  const run = await runPiAiRoute({
    label: `forensics-${protocolType}${effort === undefined ? '-noeffort' : `-${effort}`}`,
    protocolType,
    baseUrl: origin,
    apiKey: 'probe-key-1234567890',
    model: 'probe-model',
    prompt: '回答一个字：好。',
    contextWindow: 8192,
    maxTokens: 1024,
    timeoutMs: 120_000,
    ...(effort === undefined ? {} : { effort }),
  });
  const captured = seen.slice(before);
  const first = captured[0] ?? null;
  note(`${protocolType}/${effort ?? '（不给 effort）'} → ${first === null ? '没收到请求' : `${first.method} ${first.url}`}`);
  if (first !== null) {
    note('  鉴权头：', JSON.stringify(Object.fromEntries(Object.entries(first.headers).filter(([key]) => /auth|api-key|anthropic|version/i.test(key)))));
    note('  档位：', JSON.stringify({ reasoning: first.reasoning, thinking: first.thinking }));
  }
  return {
    protocolType,
    effort: effort ?? null,
    capturedCount: captured.length,
    first,
    // 归一化后的 baseURL 由 overlay 自己写着，报告要与「服务器实际收到的路径」互证
    overlayBaseUrl: /baseURL: "([^"]+)"/.exec(run.overlay)?.[1] ?? null,
    error: run.error === null ? null : { name: run.error.name, message: run.error.message.slice(0, 300) },
  };
}

const results = [];
for (const protocolType of ['anthropic', 'openai']) {
  results.push(await forensics(protocolType, undefined));
  results.push(await forensics(protocolType, 'high'));
}

server.close();
const file = writeDump('v3/forensics', { at: new Date().toISOString(), origin, results });
note('落盘：', file);
