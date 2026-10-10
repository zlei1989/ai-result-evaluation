/**
 * **差分回路**：dsh 通知流在「握手之后戛然而止」到底是不是 tap 插件造成的（2026-10-10）。
 *
 * 症状（真机两次复现，run `7f05c765` 的 dsh 行）：厂商会话日志 201/∞ 条事件，我们只收到前 13 条
 * （+56ms），`messages.jsonl` 为 0、执行日志整段空白，而行照旧判成功。
 *
 * 为什么用**差分**：已知「探针配置跑得通」（`dsh-pi-ai-both.mjs` 收到 `assistant/message` 与
 * `turn/end`），而适配器配置收不到内容 ⇒ 两者之间**唯一的**结构差异就是
 * `<configHome>/profiles/sdk/aieval-stream-tap.mjs` + overlay 里那条 `insert`。
 * 变体只差这一个变量，其余（网关、模型、提示词、订阅方式）逐字相同。
 *
 * 三个变体（各自独立进程内跑一次）：
 *   A `baseline`：探针 overlay（**无** tap insert）
 *   B `tap-insert`：探针 overlay + tap insert + 插件文件落盘（适配器形状）
 *   C `filtered`：B 的配置 + **适配器那条过滤器**（把三个纯函数照抄成 JS）
 *
 * 判据（A 必须绿、B/C 是否红就是结论）：收齐 `assistant/message` 与 `turn/end` 即绿——
 * 只数「有没有内容进来」，不看别的。红的时候打印订阅 `next()` 的**拒绝原因**（适配器会吞掉它）。
 *
 * 用法：`node probe/v3/dsh-tap-truncation.mjs [a|b|c|all]`（默认 all）。
 * 输出：每条通知落 `probe/dumps/v3/dsh-tap-<variant>.jsonl`（已 redact）。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, loadProductProvider, note } from './lib/gateway.mjs';
import { buildOverlay } from './lib/overlay.mjs';
import { ROUTE_API_KEY_ENV, ROUTE_KEY } from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT = '回答一个字：好。不要调用任何工具，不要写文件。';
/**
 * `heavy` 变体用的**真任务**（生产形状）：会真的调用工具、跑好几步。
 * 为什么需要它：琐碎提示词下三个变体全绿（19 条通知含内容）⇒ 触发条件与「真实的智能体运行」有关，
 * 必须把回路调到与真机同形（工具调用 / 多步 / 大上下文）才可能复现。
 */
/**
 * `eval` 变体：**把真机的两个输入原样搬进来**——用例题面（6217 字）+ 那一行的真实工作区拷贝
 * （88 MB 的 Java 仓，含 `CLAUDE.md` 工作区指令）。这是「本机可控制的、与真机最同形」的回路。
 */
const EVAL_CASE = '/Users/zhanglei1120/Workspaces/tmp/aieval-cases/27e77c7c-92c2-4ca6-be7f-1155efb9e49b.json';
const EVAL_WORKSPACE = '/Users/zhanglei1120/Workspaces/tmp/aieval/.runs/7f05c765-9c7b-48aa-ad2f-212787d52475/rows/15753985-77d4-4bf2-8952-a90e232b3e60/workspace';

const HEAVY_PROMPT = [
  '在 workspace 目录里完成三件事，每件都要真的调用工具：',
  '1) 用 shell 跑 `pwd && ls -la`；',
  '2) 创建文件 note.txt，内容写 ok；',
  '3) 读回 note.txt 确认内容。',
  '最后用一句话汇报你做了什么。不要问我任何问题。',
].join('\n');
const TIMEOUT_MS = 240_000;
/** 收尾排空期：`run()` 落定后仍可能有通知在路上（真机上「内容全丢」正是发生在这段） */
const SETTLE_MS = 5_000;

/** 从 `stream-tap.ts` 里取**真实的**插件源码（求值模板字符串，与 TS 编译时逐字一致） */
function tapPluginSource() {
  const ts = readFileSync(join(HERE, '..', '..', 'src', 'providers', 'dsh', 'stream-tap.ts'), 'utf8');
  const hit = /export const DSH_STREAM_TAP_PLUGIN_SOURCE = `([\s\S]*?)`;\n/.exec(ts);
  if (hit === null) throw new Error('stream-tap.ts 里找不到 DSH_STREAM_TAP_PLUGIN_SOURCE');
   
  return eval(`\`${hit[1]}\``);
}

/**
 * 适配器的过滤器（`dsh/index.ts` 的 `noteChildSession` / `noteFinishedChildSession` /
 * `acceptsRunNotification`）的 JS 照抄版——只为变体 C 用，好把「过滤器抛错」与「插件」分开。
 */
function adapterFilter(ownSessionId) {
  const childSessions = new Set();
  const identities = (n) => {
    const params = n?.params;
    if (params === undefined) return [];
    return [params.subagentId, params.childSessionId, params.agentId]
      .filter((c) => typeof c === 'string' && c !== '');
  };
  return (n) => {
    for (const id of identities(n)) if (id !== ownSessionId) childSessions.add(id);
    const own = typeof n?.params?.sessionId === 'string' && n.params.sessionId !== '' ? n.params.sessionId : null;
    if (own === null) return true;
    return own === ownSessionId || childSessions.has(own);
  };
}

/** 跑一个变体：返回产物 + 判据 */
async function runVariant(variant) {
  const sdk = await import('@deepseek-ai/dsh-sdk-client');
  const provider = loadProductProvider('anthropic');
  const home = mkdtempSync(join(tmpdir(), `aieval-tap-${variant}-`));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });

  const overlayPath = join(home, 'aieval-route.patch.yml');
  const base = buildOverlay({
    protocolType: 'anthropic',
    baseUrl: provider.baseUrl,
    model: provider.model,
    contextWindow: provider.contextWindow,
    maxTokens: provider.maxOutputTokens,
    reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
    routeKey: ROUTE_KEY,
  });
  const withTap = `${base}    - id: aieval-stream-tap\n      name: "./aieval-stream-tap.mjs"\n`;

  const heavy = variant === 'heavy';
  const evalLike = variant === 'eval';
  const usesTap = variant === 'tap-insert' || variant === 'filtered' || heavy || evalLike;
  writeFileSync(overlayPath, usesTap ? withTap : base, { encoding: 'utf8', mode: 0o600 });
  if (usesTap) {
    /**
     * 与 `startDsh` 逐字同形：插件落 **`<dshHome>` 根下**（2026-10-10 实测修正——运行时按 `dshHome`
     * 解析 overlay 里的 `./aieval-stream-tap.mjs`；写进 `profiles/sdk/` 的后果是 stderr 一句
     * `1 entry did not activate` + 插件从未加载、旁路文件恒 0 字节），旁路文件先建出来（适配器启动前清零）。
     */
    writeFileSync(join(home, 'aieval-stream-tap.mjs'), tapPluginSource(), { encoding: 'utf8', mode: 0o600 });
    writeFileSync(join(home, 'aieval-stream-tap.jsonl'), '', { encoding: 'utf8', mode: 0o600 });
  }

  const sessionId = `session-${Buffer.from(`${variant}`.padEnd(16, '0')).toString('hex').slice(0, 32)}`;
  const harness = new sdk.DeepSeekHarness({
    cwd: workspace,
    dshHome: home,
    processCwd: workspace,
    model: provider.model,
    provider: ROUTE_KEY,
    patches: [overlayPath],
    initializeTimeoutMs: 60_000,
    reasoningEffort: 'high',
    env: {
      ...process.env,
      DSH_HOME: home,
      [ROUTE_API_KEY_ENV]: provider.apiKey,
      // `heavy` = 生产形状：权限档与 HOME 隔离都与适配器逐字一致（见 route.ts 的 buildSubprocessEnv）
      ...(heavy || evalLike ? { HOME: home, USERPROFILE: home, DSH_PERMISSION_MODE: 'danger-full-access' } : {}),
    },
  });

  const received = [];
  let rejection = null;
  let runError = null;
  let result = null;
  let subscription = null;
  const hardStop = setTimeout(() => { void harness.close().catch(() => {}); }, TIMEOUT_MS);

  try {
    await harness.start();
    // **按适配器的方式消费**：`next()` 而不是 push 回调——订阅被拒时能拿到原因
    subscription = harness.client.subscribe(variant === 'filtered' ? adapterFilter(sessionId) : () => true);
    const pump = (async () => {
      for (;;) {
        try {
          received.push(await subscription.next());
        } catch (error) {
          rejection = {
            name: error?.constructor?.name ?? typeof error,
            message: String(error?.message ?? error).slice(0, 600),
          };
          return;
        }
      }
    })();
    if (heavy) writeFileSync(join(workspace, 'seed.txt'), 'seed\n', 'utf8');
    if (evalLike) {
      // 真工作区**拷贝**一份（绝不在评测产物上跑智能体）
      cpSync(EVAL_WORKSPACE, workspace, { recursive: true });
      note(`eval 变体：已拷贝真工作区（${workspace}）`);
    }
    const evalPrompt = evalLike
      ? JSON.parse(readFileSync(EVAL_CASE, 'utf8')).taskPrompt
      : null;
    result = await harness.run(evalPrompt ?? (heavy ? HEAVY_PROMPT : PROMPT), { sessionId });
    await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, SETTLE_MS))]);
  } catch (error) {
    runError = { name: error?.constructor?.name ?? typeof error, message: String(error?.message ?? error).slice(0, 600) };
  } finally {
    clearTimeout(hardStop);
    try { await harness.close(); } catch { /* close 失败不影响判据 */ }
    try { subscription?.close(); } catch { /* 同上 */ }
  }

  const kindOf = (n) => {
    const method = n?.method ?? '<none>';
    const type = n?.params?.event?.type;
    return typeof type === 'string' ? `${method} :: ${type}` : method;
  };
  const counts = new Map();
  for (const n of received) counts.set(kindOf(n), (counts.get(kindOf(n)) ?? 0) + 1);
  const dump = appendJsonl(`v3/dsh-tap-${variant}`, received);
  let tapBytes = null;
  try {
    tapBytes = statSync(join(home, 'aieval-stream-tap.jsonl')).size;
  } catch { /* 文件没有就是 0 字节那一档 */ }
  const sawAssistant = received.some((n) => n?.params?.event?.type === 'assistant/message');
  const sawTurnEnd = received.some((n) => n?.params?.event?.type === 'turn/end');
  return {
    variant,
    usesTap,
    sessionId,
    notifications: received.length,
    kinds: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    lastKind: received.length === 0 ? null : kindOf(received.at(-1)),
    sawAssistant,
    tapBytes,
    sawTurnEnd,
    rejection,
    runError,
    finalResponse: typeof result?.finalResponse === 'string' ? result.finalResponse.slice(0, 40) : null,
    dump,
    home,
  };
}

const which = (process.argv[2] ?? 'all').toLowerCase();
const variants = which === 'all' ? ['baseline', 'tap-insert', 'filtered'] : [
  { a: 'baseline', b: 'tap-insert', c: 'filtered', d: 'heavy', e: 'eval' }[which] ?? which,
];
const verdicts = [];
for (const variant of variants) {
  note(`──────── 变体 ${variant} ────────`);
  const one = await runVariant(variant);
  verdicts.push(one);
  note(`${variant}：通知 ${one.notifications} 条，含 assistant/message=${one.sawAssistant} turn/end=${one.sawTurnEnd}`
    + `，最后一条=${one.lastKind ?? '<无>'}，旁路文件=${one.tapBytes ?? 0} 字节`);
  note(`${variant} 分布：`, JSON.stringify(one.kinds.slice(0, 6)));
  if (one.rejection !== null) note(`${variant} 订阅 next() 被拒：`, JSON.stringify(one.rejection));
  if (one.runError !== null) note(`${variant} run() 抛错：`, JSON.stringify(one.runError));
  note(`${variant} 落盘：`, one.dump);
}
note('════ 结论 ════');
for (const one of verdicts) {
  const green = one.sawAssistant && one.sawTurnEnd;
  note(`${green ? '✅' : '❌'} ${one.variant}：assistant/message=${one.sawAssistant} turn/end=${one.sawTurnEnd}`
    + `（tap=${one.usesTap}）${one.rejection === null ? '' : `；拒绝=${one.rejection.name}`}`);
}
// 红＝「tap 变体没收到内容」；A 绿而 B 红 ⇒ tap 插件就是变量
const baseline = verdicts.find((one) => one.variant === 'baseline');
const taped = verdicts.filter((one) => one.usesTap);
process.exitCode = baseline !== undefined && baseline.sawAssistant && taped.some((one) => !one.sawAssistant) ? 1 : 0;
