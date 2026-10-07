/**
 * 验证路线①「**本地中继直读上游响应体**」：codex 的事件流不含推理正文，但**我们控制它的 `base_url`**——
 * 在 codex 与上游之间放一层**只观察、不改写**的中继，就能把上游原始的 `reasoning_text` 完整落档。
 *
 * 判据（缺一条就不算成立）：
 *   ① 中继收到的响应里**确实含** `reasoning_text` 且**非空**；
 *   ② 流**走到了 `response.completed`**（否则可能是半截流，正文不完整 —— 上一轮踩过"整块转发破坏 SSE"的坑）；
 *   ③ codex 那一侧**照常跑完**（exit=0 且有 `agent_message`）⇒ **中继没有破坏被测链路**；
 *   ④ 中继**逐块转发**（`reader.read()` + `res.write(chunk)`），**不得** `await up.text()`。
 *
 * 顺带把 codex 的**请求体**也留档（看它向上游要的是 `summary` 还是完整推理）。
 *
 * 用法：node probe/v4/codex-reasoning-relay.mjs
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEEPSEEK_ORIGIN, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';
import { buildExecArgs, spawnCapture } from './lib/codex-exec.mjs';

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const CODEX_EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const SCRATCH = join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', 'tmp', 'reason-relay');
mkdirSync(SCRATCH, { recursive: true });

const PORT = 7986;
const CAPTURE = join(SCRATCH, 'relay-capture.txt');
writeFileSync(CAPTURE, '', 'utf8');

const apiKey = loadDeepSeekKey();
const PROMPT = '请先用一句话说明你的推理过程，再给出结论：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？';

let requestCount = 0;

/** 只观察不改写的中继：请求体留档 → 转发 → **逐块**回写并留档。 */
const server = createServer(async (request, response) => {
  requestCount += 1;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const requestBody = Buffer.concat(chunks);

  appendFileSync(CAPTURE, `\n=== REQUEST #${requestCount} ${request.method} ${request.url} ===\n${requestBody.toString('utf8')}\n=== RESPONSE #${requestCount} ===\n`, 'utf8');

  try {
    const upstream = await fetch(`${DEEPSEEK_ORIGIN}${request.url}`, {
      method: request.method,
      headers: {
        // 只保留上游需要的头；host/content-length 交给 fetch 自己算
        'content-type': request.headers['content-type'] ?? 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: request.headers.accept ?? 'text/event-stream',
      },
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : requestBody,
    });

    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (upstream.body === null) { response.end(); return; }
    // ✅ 逐块转发（这是硬要求：整块 await .text() 会破坏 SSE 分块语义）
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      appendFileSync(CAPTURE, Buffer.from(value).toString('utf8'), 'utf8');
      response.write(value);
    }
    response.end();
  } catch (error) {
    appendFileSync(CAPTURE, `[relay] 转发失败：${String(error?.message ?? error)}\n`, 'utf8');
    try { response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"error":{"message":"relay failure"}}'); } catch { /* 已经回过了 */ }
  }
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
note(`中继已监听 127.0.0.1:${PORT} → ${DEEPSEEK_ORIGIN}`);

const home = join(SCRATCH, 'home');
const cwd = join(SCRATCH, 'cwd');
for (const dir of [home, cwd]) mkdirSync(dir, { recursive: true });

const args = buildExecArgs({
  config: {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'relay-observed',
        base_url: `http://127.0.0.1:${PORT}/v1`,   // ← 指向中继；链路其余部分不变
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    tools: { web_search: false },
  },
  model: 'deepseek-reasoner',
  sandboxMode: 'danger-full-access',
  cwd,
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
});

const run = await spawnCapture(CODEX_EXE, args, {
  env: { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, CODEX_API_KEY: apiKey },
  cwd,
  timeoutMs: 240_000,
  stdin: PROMPT,
});

await new Promise((resolve) => server.close(resolve));

// ── 解析 ──────────────────────────────────────────────────────────────────────
const events = [];
for (const line of run.stdoutLines) { try { events.push(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ } }
const items = events.filter((e) => String(e.type).startsWith('item.')).map((e) => e.item);

const raw = readFileSync(CAPTURE, 'utf8');
/**
 * 上游的推理正文以**两种形态**出现，两种都要收：
 *   · `response.content_part.added` 里的 `part:{type:'reasoning_text',text:''}` —— **空占位**（不能当正文）；
 *   · `response.output_item.done` / `response.completed` 里**拼装好的** `{type:'reasoning_text',text:'<全文>'}`。
 * ⇒ 取样必须取**最长**的那一条，取第一条会拿到空占位（第一版就是这么被自己坑了一下）。
 */
const reasoningTexts = [...raw.matchAll(/"type"\s*:\s*"reasoning_text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
  .map((hit) => { try { return JSON.parse(`"${hit[1]}"`); } catch { return hit[1]; } });
/** 增量形态：`response.reasoning_text.delta` 的 `delta` 字段（拼起来应等于全文）。 */
const deltas = [...raw.matchAll(/"type"\s*:\s*"response\.reasoning_text\.delta"[^}]*?"delta"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
  .map((hit) => { try { return JSON.parse(`"${hit[1]}"`); } catch { return hit[1]; } });
const longest = reasoningTexts.reduce((a, b) => (b.length > a.length ? b : a), '');

const completedCount = raw.split('response.completed').length - 1;
const encryptedCount = raw.split('encrypted_content').length - 1;
const summaryEmpty = /"summary"\s*:\s*\[\s*\]/.test(raw);
/** `part.added` 的空占位（证明"取第一条会踩坑"这件事是真的，不是推理）。 */
const emptyPlaceholders = reasoningTexts.filter((t) => t === '').length;

const checks = {
  '① 中继含非空 reasoning_text': longest.trim() !== '',
  '② 流走到 response.completed': completedCount > 0,
  '③ codex 侧照常跑完（exit=0 且有 agent_message）': run.exitCode === 0 && items.some((i) => i?.type === 'agent_message'),
  '④ 逐块转发（增量拼起来 = 全文）': deltas.join('').trim() === longest.trim() && deltas.length > 0,
  '⑤ codex 自己的事件流里仍无 reasoning item': !items.some((i) => i?.type === 'reasoning'),
};
note('中继捕获：全文样本 =', reasoningTexts.length, '条（其中空占位', emptyPlaceholders, '条），增量 delta =', deltas.length, '条');
note('增量拼接长度 =', deltas.join('').length, '；全文长度 =', longest.length, '；两者一致 =', deltas.join('').trim() === longest.trim());
note('response.completed =', completedCount, '；encrypted_content 出现 =', encryptedCount, '；summary 为空数组 =', summaryEmpty);
for (const [key, ok] of Object.entries(checks)) note(`  ${ok ? '✅' : '❌'} ${key}`);
if (longest !== '') {
  note('推理正文开头：', longest.slice(0, 80));
  note('推理正文结尾：', longest.slice(-80));
}

const file = writeDump('v4/codex-reasoning-relay', {
  at: new Date().toISOString(),
  relay: `http://127.0.0.1:${PORT}/v1`,
  upstream: DEEPSEEK_ORIGIN,
  model: 'deepseek-reasoner',
  codexExitCode: run.exitCode,
  codexItemTypes: [...new Set(items.map((i) => i?.type))],
  requestCount,
  reasoningTextCount: reasoningTexts.length,
  reasoningTextEmptyPlaceholders: emptyPlaceholders,
  reasoningTextLengths: reasoningTexts.map((t) => t.length),
  longestReasoningTextLength: longest.length,
  deltaCount: deltas.length,
  deltasJoinedLength: deltas.join('').length,
  deltasJoinEqualsFullText: deltas.join('').trim() === longest.trim(),
  reasoningTextSample: longest.slice(0, 400) || null,
  reasoningTextTail: longest.slice(-160) || null,
  responseCompletedCount: completedCount,
  encryptedContentCount: encryptedCount,
  summaryWasEmpty: summaryEmpty,
  checks,
  stderrHead: run.stderrLines.slice(0, 4),
  captureFile: CAPTURE,
});
note('落盘：', file);
