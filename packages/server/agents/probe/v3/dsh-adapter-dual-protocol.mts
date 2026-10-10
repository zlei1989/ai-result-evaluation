/**
 * **走真实适配器**的双协议端到端 —— 与 `dsh-pi-ai-both.mjs` 的关键差别是
 * 「谁在装配」：那份探针自己 new `DeepSeekHarness`、自己拼 overlay、自己设 `provider` / `patches`，
 * 证明的是 **pi-ai 路由机制**成立；本探针只交一个 `AgentRunInput`，其余全部由
 * `dshProvider.run()` 自己做——overlay 生成与落盘、`provider` / `patches` / 环境变量、
 * 通知投影、计量归集。**这是唯一能证明「两种协议真的都能从产品代码路径跑通」的一步**：
 * 适配器里任何一处接线写错（patch 的 model id 漂移、档位缺键、baseURL 归一化方向反了、
 * `patches` 给了相对路径），都会在这里以真实的 `ok:false` / `initialize` 报错现形，
 * 而单测里的假 SDK 看不到这些。
 *
 * 为什么用 jiti 而不是直接 `node xxx.mts`：Node 24 的类型剥离**不解析无扩展名的相对导入**
 * （本仓按 TS 习惯写 `./events`），实测直接 import 会在 `@aieval/core` 的 `./logger` 处
 * `ERR_MODULE_NOT_FOUND`。`jiti` 是仓库根本已有的 devDependency（零新增依赖），且它按 TS 的
 * 解析规则处理扩展名 ⇒ 与 `tsc` 看到的是同一张图。
 *
 * 为什么读 `~/.aieval/config.json`（产品自己的供应商记录）而不是自己编一份：探测与生产必须是
 * 同一份事实。本机那两条记录恰好覆盖 D8 的两个归一化方向。
 *
 * 用法：`node probe/v3/dsh-adapter-dual-protocol.mts [anthropic|openai|both]`（默认 both）。
 * 判据（三条，两条协议各自独立判定）：
 *   · `result.ok === true`；
 *   · `result.tokens !== null`（「跑完了但没计量」不算通过）；
 *   · `result.turns !== null && result.turns >= 1`。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { appendJsonl, loadProductProvider, note, redact, writeDump } from './lib/gateway.mjs';

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { dshProvider, DSH_ROUTE_PATCH_RELATIVE_PATH, DSH_ROUTE_KEY } = await jiti.import(
  '../../src/providers/dsh/index.ts',
);

const which = process.argv[2] ?? 'both';
const prompt = '回答一个字：好。不要调用任何工具，不要写文件。';

/**
 * 跑一条协议：**只给 `AgentRunInput`**，注入与接线全交给适配器。
 * 不抛：失败也要能落盘（探测的产物是结论，不是退出码）。
 */
async function probe(protocolType) {
  const provider = loadProductProvider(protocolType);
  const configHome = mkdtempSync(join(tmpdir(), `aieval-adapter-${protocolType}-`));
  const cwd = join(configHome, 'workspace');
  mkdirSync(cwd, { recursive: true });
  note(`供应商「${provider.name}」：协议=${protocolType}，baseUrl=${provider.baseUrl}，模型=${provider.model}`);

  const events = [];
  const controller = new AbortController();
  // 硬超时：适配器自己**不设**内层上限（`AgentRunInput` 已无 timeoutMs，用户口径「执行不限时间」），
  // 探测必须自己兜住，否则网关卡住会把探针变成挂死
  const timer = setTimeout(() => controller.abort(), 300_000);
  let result = null;
  let error = null;
  const startedAt = Date.now();
  try {
    result = await dshProvider.run({
      cwd,
      configHome,
      // 执行阶段的最宽档（与编排层的候选执行一致）：评分用的 `read-only` 档在无交互环境里
      // 会把「本该弹批准」的操作挂住，而这条探针要的是「跑到收场」，不是「测权限」
      permission: 'full',
      prompt,
      route: {
        protocolType,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        modelId: provider.model,
        ...(provider.contextWindow === undefined ? {} : { contextWindow: provider.contextWindow }),
        ...(provider.maxOutputTokens === undefined ? {} : { maxOutputTokens: provider.maxOutputTokens }),
      },
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
  } catch (caught) {
    error = {
      name: caught?.constructor?.name ?? typeof caught,
      message: String(caught?.message ?? caught).slice(0, 2000),
    };
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - startedAt;

  // 适配器的落点是 `configHome/<相对路径>`（per-launch overlay）
  const patchPath = join(configHome, DSH_ROUTE_PATCH_RELATIVE_PATH);
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : null;

  const ok = error === null && result !== null && result.ok === true
    && result.tokens !== null && result.turns !== null && result.turns >= 1;
  return {
    protocolType,
    provider: { name: provider.name, baseUrl: provider.baseUrl, model: provider.model },
    routeKey: DSH_ROUTE_KEY,
    configHome,
    patchPath,
    patch,
    // 事件流在适配器里已经投影过（不是原始通知）：这里是**产品拿到的**那一份
    events,
    result,
    error,
    durationMs,
    ok,
  };
}

const targets = which === 'both' ? ['anthropic', 'openai'] : [which];
const verdicts = [];
for (const target of targets) {
  note(`──────── 适配器路径 · ${target} ────────`);
  const verdict = await probe(target);
  verdicts.push(verdict);
  note(verdict.ok
    ? `✅ ${target} 走适配器跑通：ok=${verdict.result?.ok} tokens=${JSON.stringify(verdict.result?.tokens)} turns=${verdict.result?.turns}`
    : `❌ ${target} 未跑通：${verdict.error?.message ?? JSON.stringify(verdict.result)}`);
  if (verdict.result !== null) {
    note(`${target} 结果：`, JSON.stringify({
      exitReason: verdict.result.exitReason,
      finalText: String(verdict.result.finalText ?? '').slice(0, 120),
      durationMs: verdict.durationMs,
      events: verdict.events.length,
    }));
  }
}

const summary = verdicts.map((one) => ({
  protocolType: one.protocolType,
  provider: one.provider,
  routeKey: one.routeKey,
  ok: one.ok,
  exitReason: one.result?.exitReason ?? null,
  tokens: one.result?.tokens ?? null,
  turns: one.result?.turns ?? null,
  finalText: one.result?.finalText ?? null,
  error: one.error ?? one.result?.error ?? null,
  durationMs: one.durationMs,
  eventTypes: [...new Set(one.events.map((event) => event?.type))],
}));
note('结论：', redact(JSON.stringify(summary)));
const file = writeDump('v3/dsh-adapter-dual-protocol-verdict', {
  at: new Date().toISOString(),
  routeKey: DSH_ROUTE_KEY,
  // 适配器路径产生的**原始事件流**（每条约一行，便于 grep 而不必读整个大文件）
  verdicts,
  summary,
});
for (const one of verdicts) appendJsonl(`v3/dsh-adapter-${one.protocolType}-events`, one.events);
note('结论落盘：', file);
process.exitCode = verdicts.every((one) => one.ok) ? 0 : 1;
