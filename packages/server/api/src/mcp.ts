/**
 * MCP 探活（设置页「测试连接」）服务：把一次探活折成 `McpProbeResult`。
 *
 * 分工：**机制**在 `core/src/mcp-probe.ts`（stdio 子进程与行协议收帧），
 * 这里放**策略**——http 三步握手 + 一次只读调用、失败分档与中文文案、超时预算、串行。
 * 先例是 `providers.ts` 的 `fetchProviderModels`（同样是「api 层对外发 HTTP + 超时 + 错误映射」）。
 *
 * ⚠️ **探活不是跑智能体**，不受 AGENTS.md「调智能体只有 `agentProvider.run` 一个入口」那条铁律约束
 * 对象是 MCP 端点（对 claude / codex / dsh 一无所知）、要在零 provider / 零仓库的
 * 干净状态下可用、也没有与 `run` 相同的形状。它同样**不是**「再包一层跑一次智能体的门面」。
 *
 * 五条口径（每条都对应一个已经实测过的坑）：
 *   1. **http 侧叠一次只读 `tools/call`**：握手对**任何** key 都回 200（含伪造 key），只有真调一次工具
 *      才会在 **HTTP 200 的体里**回一句软错误，且 `isError` 是 `null`——只看状态码、只看 `isError` 都会漏
 *      **必填参必须给齐**（`query` + `libraryName`），少一个会被 `Input validation
 *      error` 盖掉鉴权错误，于是「所有 key 看起来都没报鉴权错」。
 *   2. **stdio 侧保持 A 档**：playwright MCP 没有「只读且不启浏览器」的探测工具（连 `browser_close`
 *      都会逼出浏览器初始化），故 stdio 探活对「浏览器通道非法」**必然假绿**——这条以 note 出现在结果里，
 *      不能只写在文档里。
 *   3. **超时罩住收尾**：http 15 s / stdio 30 s（contracts 的 `MCP_PROBE_TIMEOUT_MS`）；http 用自建
 *      AbortController + setTimeout 罩住「fetch + 读正文」整段，stdio 由 core 的那条预算罩住握手与收尾。
 *   4. **同一时刻只允许一个探活**：宿主侧并发是唯一会撞浏览器 profile 的组合，也避免连点起多个 `npx`。
 *      串行在**服务端**做（前端 loading 只是提示，两个标签页就绕过去了）。
 *   5. **不落盘**：纯读操作。行内入口读已保存的那份，表单入口用传进来的那份——两者都不写配置。
 */
import {
  MCP_PLACEHOLDER_PATTERN,
  MCP_PROBE_FAILURE_LABELS,
  MCP_PROBE_NOTES,
  MCP_PROBE_TIMEOUT_MS,
  MCP_UNSUPPORTED_PLACEHOLDER,
  ServiceError,
  endpointText,
  hasSensitiveValue,
  type McpProbeFailure,
  type McpProbeFailureTier,
  type McpProbeRequest,
  type McpProbeResult,
  type McpProbeTier,
  type McpServerConfig,
} from '@aieval/contracts';
import { McpStdioProbeError, createLogger, loadConfig, probeMcpStdio } from '@aieval/core';
import { upstreamStatusErrorCode } from './providers';

const log = createLogger('mcp');

/**
 * 只读探测工具表：**必须是只读且幂等的**工具，参数逐条写死（必填参给齐，见文件头第 1 点）。
 * 今天只有 context7 的 `resolve-library-id`（`readOnlyHint` + `idempotentHint`）；
 * 表里没有的端点如实停在 A 档并说明「未校验密钥」，**不**拿一个会改状态或起浏览器的工具去试。
 */
const READONLY_PROBES: Record<string, Record<string, unknown>> = {
  'resolve-library-id': { query: 'react hooks', libraryName: 'react' },
};

/** 厂商原文的截断上限：网关可能回一整页 HTML，全带回去只会把真正的那句话淹掉 */
const VENDOR_TEXT_LIMIT = 2_000;

/**
 * 占位判据与**注入层共用一份**（`contracts/src/mcp.ts` 的 `MCP_PLACEHOLDER_PATTERN` /
 * `MCP_UNSUPPORTED_PLACEHOLDER`）：两边判的是同一段配置文本，各抄一份正则迟早出现
 * 「探活认、注入不认」——而那时用户看到的是「测试连接绿了，行里却没注入」。
 * 差别只在**残留之后怎么办**：注入侧整条判死（`MCP_UNRESOLVED_PLACEHOLDER`），
 * 探活侧只丢掉这一格并记一条说明（`MCP_UNSUPPORTED_PLACEHOLDER`）。
 */

/**
 * 探活失败：内部分档结果。
 * `phase` 记「失败发生在哪一档」（握手 / 只读调用），它决定结果的 `tier`——
 * 界面据此说清「验到哪一步就断了」，而不是笼统地说「测试失败」。
 */
class ProbeStepError extends Error {
  readonly tier: McpProbeFailureTier;
  readonly userMessage: string;
  readonly vendorText: string;
  readonly phase: McpProbeTier;

  constructor(tier: McpProbeFailureTier, detail: string, vendorText: string, phase: McpProbeTier) {
    const label = MCP_PROBE_FAILURE_LABELS[tier];
    super(detail === '' ? label : `${label}（${detail}）`);
    this.name = 'ProbeStepError';
    this.tier = tier;
    this.userMessage = detail === '' ? label : `${label}（${detail}）`;
    this.vendorText = vendorText.slice(0, VENDOR_TEXT_LIMIT);
    this.phase = phase;
  }
}

/** 造一条分档失败（省得每处都写四个参数） */
function stepFailure(
  tier: McpProbeFailureTier,
  detail: string,
  vendorText: string,
  phase: McpProbeTier,
): ProbeStepError {
  return new ProbeStepError(tier, detail, vendorText, phase);
}

/**
 * 探活队列：**串行**执行（文件头第 4 点）。
 * 写成「前一个 settle 之后再跑下一个」，而不是「并发跑 + 计数」：并发本身就是要避免的东西。
 * 前一个失败**不影响**后一个（`then` 的两个分支都排下一个），否则一次失败会让按钮从此没反应。
 */
let probeQueue: Promise<unknown> = Promise.resolve();

function serializeProbe<T>(task: () => Promise<T>): Promise<T> {
  const run = probeQueue.then(
    () => task(),
    () => task(),
  );
  // 队列只关心「跑完了」，不关心结果：把结果吞掉，避免未处理的拒绝挂在链上
  probeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 探活一台 MCP 服务器（设置页「测试连接」的唯一入口）。
 *
 * 失败**不抛**（除了「名字不存在」这种请求本身的问题）：连不上、404、key 无效都是**探活的结论**，
 * 以 `{ ok: false, failure }` 返回，路由照旧 200 —— 把它们抛成 5xx 会让界面把一次正常的探测
 * 当成系统故障（而且客户端 `postJson` 会把 4xx/5xx 折成 `ServiceError`，界面上就只剩一句错误提示，
 * 拿不到厂商原文那一段）。
 */
export async function probeMcpServer(request: McpProbeRequest): Promise<McpProbeResult> {
  const { name, config } = resolveEntry(request);
  log.debug('探活请求', {
    name,
    transport: config.transport,
    endpoint: endpointText(config),
    enabled: config.enabled,
  });

  return serializeProbe(async () => {
    const startedAt = Date.now();
    const notes = baseNotes(config);
    try {
      const outcome =
        config.transport === 'http'
          ? await probeHttp(config, MCP_PROBE_TIMEOUT_MS.http, notes)
          : await probeStdio(config, MCP_PROBE_TIMEOUT_MS.stdio, notes);
      const result: McpProbeResult = {
        ok: true,
        tier: outcome.tier,
        serverName: outcome.serverName,
        serverVersion: outcome.serverVersion,
        toolCount: outcome.toolCount,
        elapsedMs: Date.now() - startedAt,
        notes,
      };
      log.info('MCP 探活完成', {
        name,
        transport: config.transport,
        tier: outcome.tier,
        toolCount: outcome.toolCount,
        elapsedMs: result.elapsedMs,
      });
      return result;
    } catch (error) {
      // 非预期错误（配置读坏了、我们自己的 bug）：**原样抛**，由路由折成 500 + 中文原因。
      // 不许把它冒充成某个分档（那会把「我们的缺陷」说成「你的端点有问题」，用户照着改配置永远改不好）。
      if (!(error instanceof ProbeStepError)) {
        log.error('MCP 探活内部错误', { name, transport: config.transport, error });
        throw error;
      }
      const failure: McpProbeFailure = {
        tier: error.tier,
        message: error.userMessage,
        vendorText: error.vendorText,
      };
      const elapsedMs = Date.now() - startedAt;
      log.warn('MCP 探活失败', {
        name,
        transport: config.transport,
        tier: failure.tier,
        message: failure.message,
        elapsedMs,
      });
      return { ok: false, tier: error.phase, elapsedMs, failure, notes };
    }
  });
}

/** 入口二选一：`{ name }` 读已保存的那份（不存在 ⇒ 中文 NOT_FOUND），`{ entry }` 直接用传进来的那份 */
function resolveEntry(request: McpProbeRequest): { name: string; config: McpServerConfig } {
  // 表单入口没有名字（可能还没填）：日志里给一个可辨认的标签，别让它看起来像「名字是空串的条目」
  if ('entry' in request) return { name: '(表单当前值)', config: request.entry };
  const saved = loadConfig().settings.mcpServers[request.name];
  if (saved === undefined) {
    throw new ServiceError('NOT_FOUND', `MCP 服务器「${request.name}」不在配置里，先保存再测`);
  }
  return { name: request.name, config: saved };
}

/** 与具体传输无关的补充说明：停用 + npx 首次下载 */
function baseNotes(config: McpServerConfig): string[] {
  const notes: string[] = [];
  if (!config.enabled) notes.push(MCP_PROBE_NOTES.disabled);
  if (isNpxLike(config)) notes.push(MCP_PROBE_NOTES.npxFirstRun);
  return notes;
}

/** 这条会不会走 npx / npm 拉包（判据是命令里那个词） */
function isNpxLike(config: McpServerConfig): boolean {
  return config.transport === 'stdio' && /\bnpx\b|\bnpm\b/.test(config.command);
}

/**
 * 解析 `env` / `headers` 值里的 `${VAR}` 占位（只在探测时解析，配置里存的是字面）。
 * 未设置 / 不支持的写法 ⇒ **丢掉这个键**并记一条说明：把 `${CONTEXT7_API_KEY}` 当字面发出去，
 * 上游只会回一句「key 无效」，用户拿着这句话去查密钥怎么填都填不对（真因是环境变量没设）。
 */
function resolveValues(map: Record<string, string> | undefined, notes: string[]): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (map === undefined) return resolved;
  for (const [key, raw] of Object.entries(map)) {
    let missing: string | null = null;
    const value = raw.replace(MCP_PLACEHOLDER_PATTERN, (_match, name: string) => {
      const fromEnv = process.env[name];
      if (fromEnv === undefined || fromEnv === '') {
        missing = name;
        return '';
      }
      return fromEnv;
    });
    if (missing !== null) {
      notes.push(MCP_PROBE_NOTES.envUnset(missing));
      continue;
    }
    if (MCP_UNSUPPORTED_PLACEHOLDER.test(value)) {
      notes.push(MCP_PROBE_NOTES.envUnsupported(raw));
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

interface ProbeOutcome {
  tier: McpProbeTier;
  serverName?: string | undefined;
  serverVersion?: string | undefined;
  toolCount?: number | undefined;
}

/** 一次 JSON-RPC 往返的原料：响应头与正文都留着，分档时要看它们 */
interface RpcExchange {
  status: number;
  contentType: string;
  text: string;
  message: Record<string, unknown> | null;
}

/**
 * http 探活：`initialize` → `notifications/initialized` → `tools/list` →（表里有只读工具时）`tools/call`。
 *
 * 三个协议细节（都是实测口径）：
 *   · `accept` 必须同时声明 `application/json` 与 `text/event-stream`——context7 回的是 **SSE**；
 *   · `Mcp-Session-Id` 读到就回带、读不到就走无状态，**不把它当判据**（context7 从不下发）；
 *   · `notifications/initialized` 的 202 空体是正常的，不许当成失败。
 */
async function probeHttp(
  config: Extract<McpServerConfig, { transport: 'http' }>,
  timeoutMs: number,
  notes: string[],
): Promise<ProbeOutcome> {
  const headers = resolveValues(config.headers, notes);
  // 「有没有带上密钥」与设置页那个「已配置密钥」小标同一把尺（`hasSensitiveValue`，契约层一份）：
  // 两处各判一遍会让「界面说有密钥、探活却记成匿名调用」这种自相矛盾的话同时出现在页面上
  if (!hasSensitiveValue(headers)) notes.push(MCP_PROBE_NOTES.anonymous);

  // 自建计时器而不是 `AbortSignal.timeout`：后者不落在全局 setTimeout 上，测试里推不动（同 providers.ts 的口径），
  // 而「15 秒」这个配置值的守卫必须真的验得到。这一个计时器罩住**整段** http 等待（四条请求 + 读正文）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId: string | null = null;

  /** 发一条 JSON-RPC；非 2xx 与网络层失败都在这里折成中文分档 */
  const rpc = async (payload: Record<string, unknown>, phase: McpProbeTier): Promise<RpcExchange> => {
    let response: Response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
          ...(sessionId === null ? {} : { 'mcp-session-id': sessionId }),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      // 自己掐的那一次 ⇒ 超时；其余是连接层失败（DNS / TLS / 拒绝连接）
      if (controller.signal.aborted) {
        throw stepFailure('timeout', `已等待 ${Math.round(timeoutMs / 1000)} s`, '', phase);
      }
      throw networkFailure(error, phase);
    }

    const session = response.headers.get('mcp-session-id');
    if (session !== null && session !== '') sessionId = session;

    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw stepFailure('timeout', `已等待 ${Math.round(timeoutMs / 1000)} s`, '', phase);
      }
      throw networkFailure(error, phase);
    }

    if (!response.ok) throw httpStatusFailure(response, text, phase);

    const contentType = response.headers.get('content-type') ?? '';
    return { status: response.status, contentType, text, message: decodeBody(text, contentType) };
  };

  try {
    // ① initialize：先分档「端点存不存在 / 是不是 MCP」，再谈内容
    const init = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'aieval-mcp-probe', version: '1.0.0' },
        },
      },
      'A',
    );
    const initResult = asRecord(init.message?.result);
    if (initResult === null || typeof initResult.protocolVersion !== 'string') {
      throw stepFailure('not-mcp', `HTTP ${init.status} 的响应里没有 initialize 结果`, init.text, 'A');
    }

    // ② notifications/initialized：协议上必须发（有的服务端强制）；空体 / 202 都正常
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'A');

    // ③ tools/list
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 'A');
    const listResult = asRecord(listed.message?.result);
    const tools = listResult === null ? null : listResult.tools;
    if (!Array.isArray(tools)) {
      throw stepFailure('not-mcp', 'tools/list 的响应里没有工具清单', listed.text, 'A');
    }
    const toolNames = tools
      .map((tool) => asRecord(tool)?.name)
      .filter((name): name is string => typeof name === 'string');

    const serverInfo = asRecord(initResult.serverInfo);
    const outcome: ProbeOutcome = {
      tier: 'A',
      serverName: typeof serverInfo?.name === 'string' ? serverInfo.name : undefined,
      serverVersion: typeof serverInfo?.version === 'string' ? serverInfo.version : undefined,
      toolCount: toolNames.length,
    };

    // ④ 只读调用：**唯一**能验 key 的一步（文件头第 1 点）。表里没有这台服务器的工具就如实停在 A 档
    const probeTool = toolNames.find((name) => name in READONLY_PROBES);
    if (probeTool === undefined) {
      notes.push(MCP_PROBE_NOTES.noReadonlyTool);
      return outcome;
    }
    const called = await rpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: probeTool, arguments: READONLY_PROBES[probeTool] } },
      'http+call',
    );
    assertCallSucceeded(called);
    return { ...outcome, tier: 'http+call' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只读调用是否戳穿了上游的软错误。
 * context7 的形状是「HTTP 200 + `result.content[].text` 里一句话 + `isError === null`」，
 * 故**匹配文案**是唯一可行的判据；`isError: true` 与 JSON-RPC `error` 一并归到兜底档
 * （认不出的错误也要判失败——成功文案会写「连通」，而工具调不动就不该说连通）。
 */
function assertCallSucceeded(exchange: RpcExchange): void {
  const result = asRecord(exchange.message?.result);
  const text = firstText(result);
  if (/invalid\s*api\s*key/i.test(text)) {
    throw stepFailure('invalid-key', '', text, 'http+call');
  }
  const rpcError = exchange.message?.error;
  if (rpcError !== undefined && rpcError !== null) {
    throw stepFailure('tool-call-failed', '', JSON.stringify(rpcError), 'http+call');
  }
  if (result?.isError === true) {
    throw stepFailure('tool-call-failed', '', text, 'http+call');
  }
}

/** 取 `result.content[]` 里第一段文本（MCP 的 tools/call 结果形状） */
function firstText(result: Record<string, unknown> | null): string {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    const text = asRecord(item)?.text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * 非 2xx → 分档（表格）。
 *
 * 401 / 403 / 429 的**判据**复用 `providers.ts` 的 `upstreamStatusErrorCode`：
 * 那条判断是两条上游调用路径唯一可共用的部分，中文结论则是探活自己的（`需要鉴权` / `被上游限流`，
 * 见 `MCP_PROBE_FAILURE_LABELS`）。为什么不是直接调 `upstreamError`：它造的是**抛给路由的**
 * `ServiceError`（HTTP 4xx/5xx + 单段 message，且 404 那条还要读正文），而探活的失败是
 * **HTTP 200 里的一段分档结论 + 厂商原文**（两段式）——形状接不上的正是这一格。
 *
 * 405 的判据是**两半**（`405` **+** `text/html`）：只有 HTML 那一种才说得出
 * 「该地址不是 MCP 端点」；别的内容类型的 405 落兜底档，宁可少说一句，也不给一个照着改不好的结论
 * （用户能做的下一步完全不同：换地址 vs 查这个方法本身）。
 */
function httpStatusFailure(response: Response, text: string, phase: McpProbeTier): ProbeStepError {
  const vendor = vendorTextOf(response, text);
  if (response.status === 404) return stepFailure('not-found', 'HTTP 404', vendor, phase);
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status === 405 && contentType.includes('text/html')) {
    return stepFailure('not-mcp-endpoint', 'HTTP 405', vendor, phase);
  }
  const code = upstreamStatusErrorCode(response.status);
  if (code === 'AUTH_FAILED') return stepFailure('auth', `HTTP ${response.status}`, vendor, phase);
  if (code === 'RATE_LIMITED') return stepFailure('rate-limited', 'HTTP 429', vendor, phase);
  return stepFailure('http-error', `HTTP ${response.status}`, vendor, phase);
}

/** 厂商原文：`www-authenticate` 这类响应头也照抄（401 的真因常常只在它里面） */
function vendorTextOf(response: Response, text: string): string {
  const authenticate = response.headers.get('www-authenticate');
  const parts = [authenticate === null ? '' : `www-authenticate: ${authenticate}`, text];
  return parts.filter((part) => part.trim() !== '').join('\n');
}

/** 连接层失败（DNS / TLS / 拒绝连接）：`TypeError: fetch failed` 的真因在 `cause.code` 上 */
function networkFailure(error: unknown, phase: McpProbeTier): ProbeStepError {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const detail = code === '' ? (error instanceof Error ? error.message : String(error)) : code;
  return stepFailure('network', detail, describeError(error), phase);
}

/** 错误原文：有 cause 就把 cause 一起带上（`fetch failed` 本身什么都没说） */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) return `${error.message}\ncause: ${cause.message}`;
  return error.message;
}

/**
 * 解响应体：`content-type` 含 `text/event-stream` 就按 `data:` 行取（context7 回的就是 SSE），
 * 否则整体当 JSON 读。解析不出来返回 null —— 由调用方判「不是 MCP」，这里不抛。
 */
function decodeBody(text: string, contentType: string): Record<string, unknown> | null {
  if (contentType.includes('text/event-stream')) {
    const frames = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== '');
    // 取最后一条能解析的 data 帧：一次 POST 对应一条响应，前面的可能是心跳（注释行）或空帧
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index];
      if (frame === undefined) continue;
      const parsed = tryParseObject(frame);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  return tryParseObject(text);
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

/** 对象取值：拿不到对象时返回 null（比到处 `as` 稳，也挡住 `null?.x` 这类崩） */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * stdio 探活：委托 core 的进程原语，把机制层的四类信号翻成中文分档。
 *
 * 「依赖拉取失败」与「命令无法启动」的分界**逐字照那两行**：
 *   · 命令无法启动 = `spawn` 的 error（ENOENT）**或「握手前退出」**；
 *   · 依赖拉取失败 = **npx/npm + 非零退出 + stderr**。
 * 于是三条退出码都不算拉包失败：`code === null`（进程没给出码就没了 = 握手前退出那一档）、
 * `code === 0`（自己正常收工，问题在命令本身）、以及**非 npx/npm** 的命令（「下载失败」这个结论
 * 只对会下载的那一类成立——`uvx --nope` 是参数错，给用户的下一步动作与「拉不到包」完全不同）。
 * stderr 那一半是 spec 的原文判据：没有 stderr 就没有厂商原话可抄，那种失败归「起不来」更诚实。
 */
async function probeStdio(
  config: Extract<McpServerConfig, { transport: 'stdio' }>,
  timeoutMs: number,
  notes: string[],
): Promise<ProbeOutcome> {
  const env = resolveValues(config.env, notes);
  try {
    const outcome = await probeMcpStdio({
      command: config.command,
      args: config.args ?? [],
      env,
      timeoutMs,
    });
    // 保持 A 档的原因必须出现在结果里（文件头第 2 点）：stdio 侧对「浏览器通道非法」必然假绿
    notes.push(MCP_PROBE_NOTES.stdioHandshakeOnly);
    return {
      tier: 'A',
      serverName: outcome.serverName,
      serverVersion: outcome.serverVersion,
      toolCount: outcome.toolCount,
    };
  } catch (error) {
    if (!(error instanceof McpStdioProbeError)) throw error;
    const vendor = error.stderr === '' ? error.message : error.stderr;
    switch (error.kind) {
      case 'spawn':
        throw stepFailure('spawn', '', `${error.message}${error.stderr === '' ? '' : `\n${error.stderr}`}`, 'A');
      case 'exited': {
        const detail = error.code === null ? '握手前退出' : `exit code ${error.code}`;
        const dependencyFailure =
          isNpxLike(config) && error.code !== null && error.code !== 0 && error.stderr !== '';
        throw stepFailure(dependencyFailure ? 'dependency' : 'spawn', detail, vendor, 'A');
      }
      case 'timeout':
        // 没有厂商原文可抄：超时的「原文」就是我们自己的等待时长（要求带上它）
        throw stepFailure('timeout', `已等待 ${Math.round(timeoutMs / 1000)} s`, '', 'A');
      case 'protocol':
      default:
        throw stepFailure('not-mcp', '', vendor, 'A');
    }
  }
}
