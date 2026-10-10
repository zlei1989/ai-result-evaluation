/**
 * dsh 真机探测的共享外壳：起一个**真实的** `DeepSeekHarness`，把**原始通知**逐条落盘。
 *
 * 为什么自己起而不是调适配器：本轮的结论要当**事实依据**，必须看未经我们投影的原文
 * （与 `probe/raw-events.mts` 同一条理由）。适配器的投影正确性另由它的守卫覆盖。
 *
 * 复刻的适配器口径（`src/providers/dsh/index.ts`）：
 *  - `DSH_HOME` = 本次运行的临时目录（隔离，不踩用户 `~/.dsh`）；
 *  - 凭据走 `DEEPSEEK_API_KEY` 环境变量（空 `DSH_HOME` 下**唯一**能拿到 key 的通道，四格对照实测）；
 *  - 两份落盘（`settings.yaml` / `profiles/sdk/cordis.patch.yml`）必须在 `new DeepSeekHarness` **之前**，
 *    否则 profile 里没有 `ask_user_question`；
 *  - `env` 是**整体替换**语义 ⇒ 必须展开宿主环境再覆盖。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendJsonl, note } from './gateway.mjs';

/** 从真实凭据库读 `DEEPSEEK_API_KEY`（**不打印**，只回报长度）。 */
export function readDeepSeekKey() {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const hit = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(text);
  if (hit === null) throw new Error('凭据库里没有 DEEPSEEK_API_KEY');
  return hit[1];
}

/** 写 `settings.yaml`（声明上下文窗口）。`contextWindow` 不给就删文件——与适配器同口径。 */
export function writeSettings(configHome, model, contextWindow, maxTokens) {
  const file = join(configHome, 'settings.yaml');
  if (contextWindow === undefined) return;
  const quoted = `"${model.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  writeFileSync(
    file,
    [
      'llm-deepseek:',
      '  models:',
      `    - id: ${quoted}`,
      `      contextWindow: ${contextWindow}`,
      ...(maxTokens === undefined ? [] : [`      maxTokens: ${maxTokens}`]),
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
}

/** 写本行 profile patch：把 `ask_user_question` 挂进 sdk profile（新增行必须走 `insert`）。 */
export function writeProfilePatch(configHome, withAskUser = true) {
  const file = join(configHome, 'profiles', 'sdk', 'cordis.patch.yml');
  mkdirSync(dirname(file), { recursive: true });
  const lines = ['# 由 v2 探测写入（与适配器 writeDshProfilePatch 同形）'];
  if (withAskUser) {
    lines.push('- insert:', '    - id: tool-ask-user', '      name: "@deepseek-ai/dsh-tool-ask-user"');
  }
  writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * 跑一条 dsh 任务，返回 `{ result, error, notifications }`。
 *
 * **为什么用 `client.subscribe()` 而不是只靠 `RunOptions.onNotification`**（与适配器同形）：
 * `subagent` 工具默认 `run_in_background: true`——父轮次会在子任务还没跑完时就 settle，
 * 而我们要抓的 `subagent.finished` 恰恰在那之后到达。先订阅、再交提示词，
 * 并在 `run()` 落定后继续排空 `settleMs`，才能看到子任务的收场。
 */
export async function runDshProbe({
  label,
  prompt,
  model = 'deepseek-flash',
  workspace,
  configHome,
  withAskUser = true,
  reasoningEffort,
  timeoutMs = 300000,
  settleMs = 45000,
  contextWindow = 200000,
}) {
  const sdk = await import('@deepseek-ai/dsh-sdk-client');
  const Harness = sdk.DeepSeekHarness;
  const home = configHome ?? mkdtempSync(join(tmpdir(), 'aieval-v2-dsh-'));
  const key = readDeepSeekKey();
  writeSettings(home, model, contextWindow, 8192);
  writeProfilePatch(home, withAskUser);

  const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: key };
  const notifications = [];
  const harness = new Harness({
    cwd: workspace,
    dshHome: home,
    processCwd: workspace,
    model,
    // 冷启动要先解析 profile 的插件树（含 `@deepseek-ai/dsh-tool-ask-user`）；
    // 默认 10s 会偶发 `RequestTimeoutError: initialize timed out`（本机实测一次）⇒ 放宽到 60s
    initializeTimeoutMs: 60000,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    env,
  });

  let result = null;
  let error = null;
  let subscription = null;
  let timedOut = false;
  const hardStop = setTimeout(() => {
    timedOut = true;
    void harness.close().catch(() => {});
  }, timeoutMs);
  try {
    // 先把握手做完再订阅：`start()` 幂等，适配器也是这个顺序（否则订阅前的通知会丢）
    await harness.start();
    subscription = harness.client.subscribe((notification) => {
      notifications.push(notification);
      return true;
    });
    result = await harness.run(prompt);
  } catch (caught) {
    error = {
      name: caught?.constructor?.name ?? typeof caught,
      message: String(caught?.message ?? caught).slice(0, 4000),
      code: caught?.code ?? null,
    };
  } finally {
    clearTimeout(hardStop);
    // 排空期：后台子任务的收场通知在父轮次 settle 之后才到。
    // 判据是「已经见到 `subagent.finished` 后再宽限 3 秒」——不看条数（条数在等待期间本就会变）。
    if (settleMs > 0) {
      const deadline = Date.now() + settleMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const finished = notifications.filter((one) => one?.method === 'subagent.finished').length;
        if (finished > 0) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          break;
        }
      }
    }
    try {
      await harness.close();
    } catch (caught) {
      note(`${label} close() 抛错：`, String(caught?.message ?? caught).slice(0, 200));
    }
    try {
      subscription?.close();
    } catch {
      /* 关闭订阅失败不影响结论 */
    }
  }
  if (timedOut) note(`${label} 触发 ${timeoutMs}ms 硬超时（已强制 close）`);

  const file = appendJsonl(`v2/dsh-${label}`, notifications);
  note(`${label}：通知 ${notifications.length} 条 → ${file}`);
  if (error !== null) note(`${label} run 抛错：`, error.name, error.message.slice(0, 300));
  return { home, model, result, error, notifications, dumpFile: file };
}

/** 把一批通知按 `method` + `params.event.type` 归并成计数表（终端里一眼看出这次跑出了什么）。 */
export function summarize(notifications) {
  const counts = new Map();
  for (const one of notifications) {
    const method = one?.method ?? '<无 method>';
    const inner = one?.params?.event?.type;
    const key = typeof inner === 'string' ? `${method} :: ${inner}` : method;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
