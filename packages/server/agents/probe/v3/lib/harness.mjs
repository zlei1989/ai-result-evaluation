/**
 * 真实 harness 的共享外壳（v3）：起一个 `DeepSeekHarness`，**用我们自己的 pi-ai 路由**跑一次。
 *
 * 与 `probe/v2/lib/dsh.mjs` 的差别（也是本计划 D3/D3b 的验证点）：
 *   · 凭据不再走 `DEEPSEEK_API_KEY`，而是 overlay 里 `apiKeyEnv: AIEVAL_ROUTE_API_KEY` 指向的
 *     **自定义环境变量**（凭据引用由 pi-ai 逐请求经 credential seam 解析）；
 *   · 路由不再吃默认的 `deepseek-official`，而是 `provider: 'aieval-route'`
 *     （`initialize` 会先用 `listProviders()` 校验它存在，再用 `resolveCallConfig` 校验 provider/model 可解析）；
 *   · 配置落点是一份 **per-launch overlay**（`patches: [绝对路径]`），不写 `settings.yaml`、
 *     也不整份重写 `profiles/sdk/cordis.patch.yml`。
 *
 * 为什么保留「先订阅、再交提示词」：通知是唯一的事件通道，`run()` 在**下一次 idle** 才落定——
 * 顺序反了会丢掉开头那批事件（含 `turn/start`）。这条与适配器逐字同源。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, loadDeepSeekKey, note } from './gateway.mjs';
import { buildOverlay } from './overlay.mjs';

/** 与适配器一致的路由键（已核对不与 pi-ai catalog 的 39 个键撞车）。 */
export const ROUTE_KEY = 'aieval-route';
/** 凭据引用名（overlay 的 `apiKeyEnv` 与子进程环境里的键名必须逐字一致）。 */
export const ROUTE_API_KEY_ENV = 'AIEVAL_ROUTE_API_KEY';

/**
 * 跑一次「自定义 pi-ai 路由」的真实 harness。
 * @param {object} input
 * @param {string} input.label dump 文件名后缀
 * @param {'openai'|'anthropic'} input.protocolType 协议（决定 wire 与 baseURL 归一化）
 * @param {string} input.baseUrl 供应商地址（**未归一化**）
 * @param {string} [input.model] 模型 id（必须与 overlay 里声明的一致）
 * @param {string} input.prompt 提示词
 * @param {string} [input.effort] 思考强度（不给就**不写这个键**——dsh 侧是硬校验）
 * @param {string} [input.configHome] 复用某个 DSH_HOME；不给就新建临时目录
 * @param {number} [input.timeoutMs] 硬超时
 * @param {number} [input.settleMs] run 落定后的排空期（后台子任务的收场通知在之后才到）
 */
export async function runPiAiRoute(input) {
  const sdk = await import('@deepseek-ai/dsh-sdk-client');
  const Harness = sdk.DeepSeekHarness;

  const home = input.configHome ?? mkdtempSync(join(tmpdir(), `aieval-v3-${input.label}-`));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const model = input.model ?? 'deepseek-chat';

  const overlayPath = join(home, 'aieval-route.patch.yml');
  const overlay = buildOverlay({
    protocolType: input.protocolType,
    baseUrl: input.baseUrl,
    model,
    contextWindow: input.contextWindow ?? 131_072,
    maxTokens: input.maxTokens ?? 8_192,
    // 四档与注册表 `reasoningEfforts` 逐字一致（D5）：界面能选的档必须都在 patch 里，
    // 否则 dsh 侧会在 initialize 阶段以 UNSUPPORTED_REASONING_EFFORT 收场
    reasoningEfforts: { off: null, low: 'low', high: 'high', max: (input.maxWire ?? 'max') },
    routeKey: ROUTE_KEY,
  });
  writeFileSync(overlayPath, overlay, { encoding: 'utf8', mode: 0o600 });

  const env = { ...process.env, DSH_HOME: home, [ROUTE_API_KEY_ENV]: input.apiKey ?? loadDeepSeekKey() };
  const notifications = [];
  const harness = new Harness({
    cwd: workspace,
    dshHome: home,
    processCwd: workspace,
    model,
    provider: ROUTE_KEY,
    patches: [overlayPath],
    // 冷启动要解析整棵插件树；默认 10s 会偶发 initialize 超时（v2 实测过一次）
    initializeTimeoutMs: 60_000,
    ...(input.effort === undefined ? {} : { reasoningEffort: input.effort }),
    env,
  });

  let result = null;
  let error = null;
  let subscription = null;
  let timedOut = false;
  const hardStop = setTimeout(() => {
    timedOut = true;
    void harness.close().catch(() => {});
  }, input.timeoutMs ?? 300_000);

  try {
    await harness.start();
    subscription = harness.client.subscribe((notification) => {
      notifications.push(notification);
      return true;
    });
    result = await harness.run(input.prompt);
  } catch (caught) {
    error = {
      name: caught?.constructor?.name ?? typeof caught,
      message: String(caught?.message ?? caught).slice(0, 2000),
      code: caught?.code ?? null,
    };
  } finally {
    clearTimeout(hardStop);
    const settleMs = input.settleMs ?? 0;
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    try {
      await harness.close();
    } catch (caught) {
      note(`${input.label} close() 抛错：`, String(caught?.message ?? caught).slice(0, 200));
    }
    try {
      subscription?.close();
    } catch { /* 关闭订阅失败不影响结论 */ }
  }

  if (timedOut) note(`${input.label} 触发硬超时（已强制 close）`);
  const dumpFile = appendJsonl(`v3/dsh-${input.label}`, notifications);
  const summary = summarize(notifications);
  note(`${input.label}：通知 ${notifications.length} 条 → ${dumpFile}`);
  note(`${input.label} 分布：`, JSON.stringify(summary));
  if (error !== null) note(`${input.label} run 抛错：`, error.name, error.message.slice(0, 300));
  if (result !== null) {
    note(`${input.label} 结果：`, JSON.stringify({
      sessionId: result.sessionId,
      finalResponse: String(result.finalResponse ?? '').slice(0, 200),
      events: result.events?.length,
      notifications: result.notifications?.length,
    }));
  }
  return { home, workspace, overlayPath, overlay, model, result, error, notifications, summary, dumpFile };
}

/** 按 `method` + `params.event.type` 归并成计数表（终端里一眼看出这次跑出了什么）。 */
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

/** 从通知里挑出用量与失败原因（报告要用，避免每次手写 filter）。 */
export function extractUsage(notifications) {
  const usages = [];
  const failures = [];
  for (const one of notifications) {
    const event = one?.params?.event;
    if (event?.type === 'assistant/message' && event?.data?.usage !== undefined) usages.push(event.data.usage);
    if (event?.type === 'turn/end' && event?.data?.reason?.kind === 'error') failures.push(event.data.reason.error);
  }
  return { usages, failures };
}
