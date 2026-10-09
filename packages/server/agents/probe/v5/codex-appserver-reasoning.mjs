/**
 * v5 探针：`codex app-server`（**真机**，codex-cli 0.156.1）上，模型的思考内容
 * 到底从哪个字段/通知到达、是全文还是摘要、有没有逐字增量。
 *
 * 三个 case 只差一格 `model_reasoning_summary`：**未设置** / `detailed` / `none`，
 * 提示词逐字相同；每 case 独立 `$CODEX_HOME` + 独立 cwd（见下方硬约束）。
 *
 * 落盘（`probe/dumps/v5/`）：
 *   · `codex-appserver-reasoning-<case>.jsonl` —— **原始通知原文**，一行一条，不 parse 后重排；
 *   · `codex-appserver-reasoning-<case>.thread.json` —— 本轮结束后 `thread/read` 的快照（对照用）；
 *   · `codex-appserver-reasoning.json` —— 汇总（含逐条判定与逐字样本）。
 *
 * 四条硬约束（前几轮真机踩出来的，逐条都不能省）：
 *   1. **`$CODEX_HOME`（连同 `HOME` / `USERPROFILE`）必须落在工作区内**：指向 `%TEMP%` 之类
 *      会以 `os error 5（拒绝访问）` 失败 ⇒ 一律用 `probe/dumps/v5/tmp/`；
 *   2. **`turn/start` 返回 ≠ 跑完**：要一直读通知直到 `turn/completed`（或进程退出）；
 *   3. **超时也要留证据**：到点强杀，把**已经收到的**通知原样写入 JSONL 再报告；
 *   4. **上游网关用 `env_key: 'OPENAI_API_KEY'`**，不用 `requires_openai_auth`（后者走 ChatGPT
 *      登录态、请求不带 Authorization ⇒ 401）。
 *
 * 用法：node probe/v5/codex-appserver-reasoning.mjs
 * 前置：环境里要有 `AIEVAL_PROBE_DEEPSEEK_API_KEY`（由 runner 脚本从 `~/.dsh/.credentials.yaml` 注入）。
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenConfig } from '../v4/lib/codex-exec.mjs';
import { analyzeCase } from './lib/analyze.mjs';
import { startAppServer } from './lib/client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 工作区根：`probe/v5` → 上三级 = `packages/server/agents` → 再上两级 = 仓库根 */
const REPO = join(HERE, '..', '..', '..', '..', '..');
const DUMP = join(HERE, '..', 'dumps', 'v5');
const SCRATCH = join(DUMP, 'tmp');
const CODEX_EXE = join(
  REPO,
  'node_modules',
  '.pnpm',
  '@openai+codex@0.156.1-win32-x64',
  'node_modules',
  '@openai',
  'codex',
  'vendor',
  'x86_64-pc-windows-msvc',
  'bin',
  'codex.exe',
);

const MODEL = 'deepseek-reasoner';
const BASE_URL = 'https://api.deepseek.com/v1';
/** 三个 case 逐字相同的提示词：要它「先说推理再给结论」，才有稳定的推理产出 */
const PROMPT = '请先用一句话说明你的推理过程，再给出结论：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？';
/** 单 case 上限（真机一次 30~180s；到点强杀但已收到的通知照样落盘） */
const CASE_TIMEOUT_MS = 240_000;

const CASES = [
  { label: 'summary-unset', summary: undefined },
  { label: 'summary-detailed', summary: 'detailed' },
  { label: 'summary-none', summary: 'none' },
  // 生产侧的「关闭档」是两格一起给（`effort:'none'` + `model_reasoning_summary:'none'`）：
  // 这一格顺带钉住「关闭档到底关掉了什么」，也是第 4 问的补充
  { label: 'off-both', summary: 'none', effort: 'none' },
];

// ── 密钥：只在内存与环境变量里流转，绝不落盘 ─────────────────────────────────
const apiKey = process.env.AIEVAL_PROBE_DEEPSEEK_API_KEY ?? '';
if (apiKey === '') {
  console.error('[v5] 缺少 AIEVAL_PROBE_DEEPSEEK_API_KEY（runner 脚本会从 ~/.dsh/.credentials.yaml 注入）');
  process.exit(2);
}
/** 落盘前的替换表：只认**精确**的密钥串，不做宽松正则（避免把正常文本也抹掉） */
const SECRETS = [apiKey].filter((one) => one.length >= 8);
const redact = (text) => SECRETS.reduce((out, secret) => out.split(secret).join('***'), text);

mkdirSync(DUMP, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });

const startedAt = new Date().toISOString();
const summaries = [];
for (const one of CASES) summaries.push(await runCase(one));

// ── 汇总落盘 ────────────────────────────────────────────────────────────────
const payload = {
  at: startedAt,
  finishedAt: new Date().toISOString(),
  probe: 'codex-appserver-reasoning',
  codexExe: CODEX_EXE,
  model: MODEL,
  baseUrl: BASE_URL,
  prompt: PROMPT,
  cases: summaries,
};
const summaryFile = join(DUMP, 'codex-appserver-reasoning.json');
writeFileSync(summaryFile, `${redact(JSON.stringify(payload, null, 2))}\n`, 'utf8');

// ── 控制台速览 ──────────────────────────────────────────────────────────────
console.log('\n[v5] ==== 速览 ====');
for (const row of summaries) {
  const lastCompleted = row.analysis.reasoning.completed.at(-1) ?? null;
  const summaryLen = lastCompleted?.summary === null ? 'null' : `${lastCompleted?.summary?.length ?? '-'}`;
  const contentLen = lastCompleted?.content === null ? 'null' : `${lastCompleted?.content?.length ?? '-'}`;
  console.log(
    [
      row.label.padEnd(16),
      `summary=${row.summarySetting}`,
      `exit=${row.exitCode}`,
      `turn=${row.turnCompleted ? 'completed' : `未收到(timedOut=${row.timedOut})`}`,
      `reasoningItem=${row.analysis.reasoning.startedCount}/${row.analysis.reasoning.completedCount}`,
      `summary[]=${summaryLen}`,
      `content[]=${contentLen}`,
      `textDelta=${row.analysis.textDelta.count}`,
      `summaryDelta=${row.analysis.summaryDelta.count}`,
      `partAdded=${row.analysis.summaryPartAdded.count}`,
      `reasoningTokens=${row.analysis.usage.lastReasoningOutputTokens ?? '-'}`,
    ].join('  '),
  );
}
console.log('[v5] 汇总：', summaryFile);

/**
 * 跑一个 case：独立 scratch → 建线程 → 起轮次 → 读到 `turn/completed` → 补一份 `thread/read` → 判定。
 *
 * 帧的处理有一条分工：**通知**进 `notifications`（判定用），`thread/read` 的**响应**单独收
 * （它带 id，按 id 配对），两者都从同一份原始行落盘 ⇒ JSONL 是唯一的证据源。
 */
async function runCase({ label, summary, effort }) {
  const dir = join(SCRATCH, label);
  const home = join(dir, 'home');
  const cwd = join(dir, 'cwd');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const jsonlFile = join(DUMP, `codex-appserver-reasoning-${label}.jsonl`);
  writeFileSync(jsonlFile, '', 'utf8'); // 覆盖写：两次运行不混在一个文件里

  const config = {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'deepseek-official',
        base_url: BASE_URL,
        wire_api: 'responses',
        // 真机验证过的凭据取法：Bearer 从子进程环境里的 OPENAI_API_KEY 取
        env_key: 'OPENAI_API_KEY',
        request_max_retries: 1,
      },
    },
    tools: { web_search: false },
    ...(summary === undefined ? {} : { model_reasoning_summary: summary }),
  };

  const env = { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, OPENAI_API_KEY: apiKey };
  const notifications = [];
  const resultsById = new Map();
  let liveThreadId = null;
  let rawLineCount = 0;
  let turnCompleted = false;
  /** 进程退出码（正常收尾时由 `finish()` 之后 `close` 的 exit 事件填上） */
  let exitCode = null;

  const server = startAppServer({
    binary: CODEX_EXE,
    env,
    cwd,
    timeoutMs: 60_000,
    onExit: (info) => {
      exitCode = info.code;
    },
    onLine: (line) => {
      rawLineCount += 1;
      // 原始行**原样**落盘（只替换精确密钥串）；解析失败的行也是证据，照样写
      appendFileSync(jsonlFile, `${redact(line)}\n`, 'utf8');
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.id === 'number' && message.result !== undefined) {
        resultsById.set(message.id, message.result);
        return;
      }
      if (typeof message.method === 'string') {
        notifications.push({ method: message.method, params: message.params ?? null });
        if (message.method === 'turn/completed' && message.params?.threadId === liveThreadId) turnCompleted = true;
      }
    },
  });

  const startedMs = Date.now();
  let timedOut = false;
  let error = null;
  let threadId = null;
  let turnId = null;
  let threadRead = null;

  /** 硬超时：到点强杀（已收到的通知已经逐行落盘 ⇒ 超时也有证据） */
  let onTimeout = () => undefined;
  const timeoutSignal = new Promise((resolve) => {
    onTimeout = resolve;
  });
  const guard = setTimeout(() => {
    timedOut = true;
    onTimeout('timeout');
    server.close();
  }, CASE_TIMEOUT_MS);

  try {
    await server.request('initialize', {
      clientInfo: { name: 'aieval-v5-reasoning-probe', title: 'aieval v5 reasoning probe', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const thread = await server.request('thread/start', {
      model: MODEL,
      cwd,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      config,
    });
    threadId = thread?.thread?.id ?? null;
    liveThreadId = threadId;
    if (threadId === null) throw new Error('thread/start 未返回 thread.id');

    const turn = await server.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: PROMPT, text_elements: [] }],
      ...(effort === undefined ? {} : { effort }),
    });
    turnId = turn?.turn?.id ?? null;
    if (turnId === null) throw new Error('turn/start 未返回 turn.id');

    // **一直读到本轮终结**（或超时/进程退出）：`turn/start` 返回 ≠ 跑完。
    // 三条竞速：本轮 `turn/completed`、进程退出、硬超时——任一到达都往下走（超时也要留证据）
    await Promise.race([server.turnCompleted(), server.done, timeoutSignal]);

    // 收尾对照：把线程从**持久化视角**再读一遍（`content`/`summary` 在通知里与读回里是否一致）
    try {
      const result = await withTimeout(server.request('thread/read', { threadId, includeTurns: true }), 30_000);
      threadRead = result?.thread ?? null;
    } catch (readError) {
      threadRead = { error: String(readError?.message ?? readError) };
    }
  } catch (failure) {
    error = String(failure?.message ?? failure);
  } finally {
    clearTimeout(guard);
    // 正常收尾走 `finish()` 再等退出码；被超时杀过的那条路只需兑现「客户端已关」
    if (timedOut) {
      server.close();
    } else {
      server.finish();
      // 等**进程真的退出**（`done` 在 `finish()` 时就落定了，拿退出码得靠 `exited`）
      const exit = await withTimeout(server.exited, 15_000).catch((failure) => ({ error: String(failure?.message ?? failure) }));
      // 退出码缺失（或非 0）时留一条可诊断的痕迹：退出码是「进程正常收场」的旁证
      if (exit?.code === undefined || exit?.code === null || exit.code !== 0) {
        process.stderr.write(`[v5] ${label}: app-server 收场 exit=${JSON.stringify(exit)}\n`);
      }
    }
  }

  const threadReadFile = join(DUMP, `codex-appserver-reasoning-${label}.thread.json`);
  writeFileSync(threadReadFile, `${redact(JSON.stringify(threadRead, null, 2))}\n`, 'utf8');

  const analysis = analyzeCase({ notifications, threadId: threadId ?? '<未拿到>' });
  const stats = server.stats();

  // 从 `thread/read` 里把 reasoning 条目单独摘一份：这是「持久化视角」的同一件事
  const readItems = [];
  for (const oneTurn of threadRead?.turns ?? []) {
    for (const item of oneTurn?.items ?? []) {
      if (item?.type === 'reasoning') {
        readItems.push({
          turnId: oneTurn.id,
          itemId: item.id,
          itemKeys: Object.keys(item),
          hasSummaryKey: Object.hasOwn(item, 'summary'),
          hasContentKey: Object.hasOwn(item, 'content'),
          summary: item.summary ?? null,
          content: item.content ?? null,
        });
      }
    }
  }

  return {
    label,
    summarySetting: summary ?? '<未设置>',
    effortSetting: effort ?? '<未设置>',
    jsonlFile,
    threadReadFile,
    threadId,
    turnId,
    exitCode,
    terminalReason: stats.terminal?.reason ?? null,
    timedOut,
    turnCompleted,
    error,
    durationMs: Date.now() - startedMs,
    rawLineCount,
    unparsedLines: stats.unparsed,
    serverRequests: stats.serverRequests,
    stderrTail: redact(stats.stderrTail).slice(-1500),
    configFlattened: flattenConfig(config),
    analysis,
    threadReadReasoning: readItems,
    threadReadItemsView: (threadRead?.turns ?? []).map((oneTurn) => oneTurn?.itemsView ?? null),
  };
}

/** 给「收尾读回」加个上界：主轮次已经结束，读回挂住不该把整个 case 拖满 */
function withTimeout(promise, ms) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`收尾请求超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
