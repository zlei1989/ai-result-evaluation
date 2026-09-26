/**
 * v4 的 dsh 外壳：起一个真实 `DeepSeekHarness`，用**我们自己的 pi-ai 路由**跑一次。
 *
 * 与 `probe/v3/lib/harness.mjs` 的关系：那份是上一轮的产物，且把 dump 名写死在 `v3/` 下。
 * 本轮要跑的子任务/计量探测都在这里，故**自带一份**（v3 的理由同样适用：跨版本 import 会让
 * 「另一份检出」直接跑不起来）。差别只有三处：
 *   · dump 落 `v4/`；
 *   · overlay 支持**额外的 patch 行**（本轮要覆盖 `tool-web` 等）；
 *   · 返回原文通知，调用方自己判据。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, loadDeepSeekKey, note } from './env.mjs';

export const ROUTE_KEY = 'aieval-route';
export const ROUTE_API_KEY_ENV = 'AIEVAL_ROUTE_API_KEY';

/** 协议 → pi-ai wire（与 v3 逐字一致：openai 只走 responses）。 */
export function wireForProtocol(protocolType) {
  return protocolType === 'openai' ? 'openai-responses' : 'anthropic-messages';
}

/** 按 wire 归一化 baseURL：anthropic 剥掉尾部 `/v1`、openai 补上 `/v1`。 */
export function baseUrlForWire(baseUrl, protocolType) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (protocolType === 'openai') return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return trimmed.replace(/\/v1$/, '');
}

function quote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** 生成 overlay YAML：① id 定向覆盖 llm-pi-ai（**整份替换**）② 可选 extraLines 追加 patch。 */
export function buildOverlay(input) {
  const effortEntries = Object.entries(input.reasoningEfforts ?? {});
  const lines = [
    '# 由 probe/v4 写入：本次运行的路由、模型与档位（overlay，叠在 profile 之上）',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${input.routeKey ?? ROUTE_KEY}:`,
    `        api: ${wireForProtocol(input.protocolType)}`,
    `        baseURL: ${quote(baseUrlForWire(input.baseUrl, input.protocolType))}`,
    `        apiKeyEnv: ${ROUTE_API_KEY_ENV}`,
    '        models:',
    `          - id: ${quote(input.model)}`,
    ...(input.contextWindow === undefined ? [] : [`            contextWindow: ${input.contextWindow}`]),
    ...(input.maxTokens === undefined ? [] : [`            maxTokens: ${input.maxTokens}`]),
    ...(effortEntries.length === 0
      ? []
      : [
        '            reasoningEfforts:',
        ...effortEntries.map(([level, wire]) => `              ${level}: ${wire === null ? 'null' : quote(wire)}`),
      ]),
    '',
    ...(input.extraLines ?? []),
  ];
  return lines.join('\n');
}

/**
 * 跑一次真实 harness。
 * @param {object} input
 * @param {string} input.label dump 文件名后缀
 * @param {'openai'|'anthropic'} input.protocolType
 * @param {string} input.baseUrl
 * @param {string} [input.model]
 * @param {string} input.prompt
 * @param {string} [input.effort]
 * @param {string[]} [input.extraLines] overlay 追加行（如 `- id: tool-web` 的覆盖）
 * @param {number} [input.timeoutMs]
 * @param {number} [input.settleMs] run 落定后的排空期（后台子任务收场通知在之后才到）
 * @param {boolean} [input.closeAfter] 是否在收尾时 close（abandon 场景要 false）
 */
export async function runDshTurn(input) {
  const sdk = await import('@deepseek-ai/dsh-sdk-client');
  const Harness = sdk.DeepSeekHarness;

  const home = input.configHome ?? mkdtempSync(join(tmpdir(), `aieval-v4-${input.label}-`));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const model = input.model ?? 'deepseek-chat';

  const overlayPath = join(home, 'aieval-route.patch.yml');
  writeFileSync(overlayPath, buildOverlay({
    protocolType: input.protocolType,
    baseUrl: input.baseUrl,
    model,
    contextWindow: input.contextWindow ?? 131_072,
    maxTokens: input.maxTokens ?? 8_192,
    reasoningEfforts: { off: null, low: 'low', high: 'high', max: input.maxWire ?? 'max' },
    extraLines: input.extraLines,
  }), { encoding: 'utf8', mode: 0o600 });

  const env = { ...process.env, DSH_HOME: home, [ROUTE_API_KEY_ENV]: input.apiKey ?? loadDeepSeekKey() };
  const notifications = [];
  const harness = new Harness({
    cwd: workspace,
    dshHome: home,
    processCwd: workspace,
    model,
    provider: ROUTE_KEY,
    patches: [overlayPath],
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
  }, input.timeoutMs ?? 420_000);

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
    if ((input.settleMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, input.settleMs));
    if (input.closeAfter !== false) {
      try { await harness.close(); } catch (caught) { note(`${input.label} close() 抛错：`, String(caught?.message ?? caught).slice(0, 200)); }
    }
    try { subscription?.close(); } catch { /* 关闭订阅失败不影响结论 */ }
  }

  if (timedOut) note(`${input.label} 触发硬超时（已强制 close）`);
  const dumpFile = appendJsonl(`v4/dsh-${input.label}`, notifications);
  note(`${input.label}：通知 ${notifications.length} 条 → ${dumpFile}`);
  note(`${input.label} 分布：`, JSON.stringify(summarize(notifications)));
  if (error !== null) note(`${input.label} run 抛错：`, error.name, error.message.slice(0, 300));
  if (result !== null) {
    note(`${input.label} 结果：`, JSON.stringify({
      sessionId: result.sessionId,
      finalResponse: String(result.finalResponse ?? '').slice(0, 200),
      events: result.events?.length,
      notifications: result.notifications?.length,
    }));
  }
  return { home, workspace, overlayPath, model, result, error, notifications, summary: summarize(notifications), dumpFile, timedOut, harness };
}

/** 按 `method` + `params.event.type` 归并成计数表。 */
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
