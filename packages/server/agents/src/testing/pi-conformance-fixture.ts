/**
 * pi 一致性套件的**测试台**：真包 + 可编排的假网关，只经 `piProvider.run` 一个入口取产物。
 *
 * 为什么走网关而不是假 SDK：注入面（MCP / 技能）的判据落在**出站请求**上——技能段是 pi 在
 * 拼系统提示词时写进请求的，MCP 工具名是连接建立后才进 `tools` 的。假 SDK 交回的 payload 是我们
 * 自己搓的，于是「适配器有没有把入参真的交给厂商」这一整类缺陷在夹具里不可见。真包 + 本地 HTTP
 * 网关拿到的请求体是厂商自己发出来的那一份，请求侧事实因此不是自述。
 *
 * 三条边界（写清楚免得下一个人以为这里能证明更多）：
 *   · **只驱动 anthropic wire**：思考块、`redacted_thinking`、工具调用的增量帧都在这一条上最完整，
 *     一条 wire 足以覆盖能力格；另一条 wire 的请求侧差异由 `providers/pi/index.test.ts` 与
 *     `observer.test.ts` 守（它们各自有 openai 那条的载荷）。
 *   · **剧本按请求序号取**：工具调用会带来第二轮请求，越界时复用最后一段（多轮收尾场景不必逐段写全）。
 *   · **挂起档**是取消场景的输入，见 `PiGatewayHang`。
 *
 * 本模块只被 `*.test.ts` import（与 `pi-gateway-fixture.ts` 同一条口径）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage, McpServers, SubagentRecord } from '@aieval/contracts';
import { createRunInput } from './agent-fixtures';
import { removeTreeWithRetry } from './cleanup';
import { piProvider } from '../providers/pi';
import { PI_AI_PACKAGE_NAME, PI_PACKAGE_NAME } from '../providers/pi/sdk';
import { RELEASE_GRACE_MS } from '../release';
import type { AgentPermission, AgentRunInput, AgentRunResult } from '../types';
import { piRequestSkills, piRequestToolDeclaration, piRequestToolNames, type PiRequestSkill, type PiRequestToolDeclaration } from '../providers/pi/observer';
import { PI_STRUCTURED_OUTPUT_TOOL } from '../providers/pi/structured-output';
import type { ConformanceProduct } from '../providers/conformance/kit';

/** 一条出站请求：打过来的路径 + 解析后的请求体（判据读的就是后者） */
export interface CapturedPiRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * 假网关的挂起档（取消场景的输入）：
 *   · `none`：按剧本回包；
 *   · `no-headers`：连响应头都不给——在途轮次停在「等首个字节」那一段；
 *   · `mid-stream`：只发第一帧就停住——在途轮次停在「已经开流、正文还没吐完」那一段。
 * 两档的可取消性不同（见 `observePiLifecycle`），故不是一个布尔。
 */
export type PiGatewayHang = 'none' | 'no-headers' | 'mid-stream';

/** 一段 SSE 剧本：按出站请求的顺序取，越界复用最后一段 */
export type PiSseScript = ReadonlyArray<readonly string[]>;

export interface PiScriptedGateway {
  port: number;
  /** 收到的请求，顺序即到达顺序 */
  requests: CapturedPiRequest[];
  /**
   * 第一次**在途**的那一刻：厂商已经收到请求。
   *
   * 为什么需要它：中途取消只有在轮次真的起手之后才是「在途取消」。按墙钟定时（比如「跑起来 200ms
   * 后翻转信号」）在冷启动下会翻在装配还没跑完的时候——那时停止信号拦不住这一轮，它会照常发出并
   * 挂满释放兜底窗口。等这个 Promise 再翻信号，观测的才是适配器在途取消那件事。
   */
  firstRequest: Promise<void>;
  close: () => void;
}

/** 起一台按剧本回包的假网关（端口由系统给，避免并发用例抢同一个号） */
export interface PiGatewayOptions {
  hang?: PiGatewayHang;
  /** 直接回这个 HTTP 状态码（不给流）：传输层失败的输入，与「流里报错」是两条不同的失败通道 */
  status?: number;
}

export function startPiScriptedGateway(
  script: PiSseScript,
  options: PiGatewayOptions = {},
): Promise<PiScriptedGateway> {
  const hang = options.hang ?? 'none';
  const requests: CapturedPiRequest[] = [];
  let noteFirstRequest: () => void = () => {};
  const firstRequest = new Promise<void>((resolve) => {
    noteFirstRequest = resolve;
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const index = requests.length;
      requests.push({ url: req.url ?? '', body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>) });
      noteFirstRequest();
      // 挂起档与状态码都在解析完请求之后生效：请求侧事实照样记下来
      if (options.status !== undefined) {
        res.writeHead(options.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'conformance probe' } }));
        return;
      }
      if (hang === 'no-headers') return;
      const frames = script[Math.min(index, script.length - 1)] ?? [];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (hang === 'mid-stream') {
        res.write(frames[0] ?? '');
        return;
      }
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  server.unref();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        requests,
        firstRequest,
        close: () => server.close(),
      });
    });
  });
}

/*
 * 帧构造器：anthropic wire 的具名 SSE 事件。
 * `message_start.message.usage` **必须给**——pi 在这一格上直接读 `input_tokens`，缺了它整轮以
 * 厂商原文的 `Cannot read properties of undefined` 收场（那是夹具坏了，不是被测对象坏了）。
 */
export function anthropicStart(usage: Record<string, unknown> = { input_tokens: 5, output_tokens: 1 }): string {
  const message = { id: 'm1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage };
  return sse('message_start', { type: 'message_start', message });
}

export function anthropicBlockStart(index: number, block: unknown): string {
  return sse('content_block_start', { type: 'content_block_start', index, content_block: block });
}

export function anthropicDelta(index: number, delta: unknown): string {
  return sse('content_block_delta', { type: 'content_block_delta', index, delta });
}

export function anthropicBlockStop(index: number): string {
  return sse('content_block_stop', { type: 'content_block_stop', index });
}

export function anthropicEnd(stopReason: string, usage: Record<string, unknown> = { output_tokens: 2 }): string {
  return sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage })
    + sse('message_stop', { type: 'message_stop' });
}

/** 厂商在流里报错（不抛在 HTTP 层）：失败姿态因此只能从 `stopReason` / `errorMessage` 读 */
export function anthropicStreamError(message: string): string {
  return sse('error', { type: 'error', error: { type: 'api_error', message } });
}

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 纯文本答复：一条正文增量 + 收尾快照（`streamingDelta` 那一格的取数通道就是这条增量）。
 * 用量两处都可给：厂商把「这一轮报了多少」分别挂在起始与收尾两条帧上，适配器按次累加。
 */
export function anthropicText(
  text: string,
  usage?: { start?: Record<string, unknown>; end?: Record<string, unknown> },
): string[] {
  return [
    anthropicStart(usage?.start),
    anthropicBlockStart(0, { type: 'text', text: '' }),
    anthropicDelta(0, { type: 'text_delta', text }),
    anthropicBlockStop(0),
    anthropicEnd('end_turn', usage?.end),
  ];
}

/** 思考正文（`full` 档）：思考块与正文块各一段，两段都带增量帧 */
export function anthropicThinking(thinking: string, text: string): string[] {
  return [
    anthropicStart(),
    anthropicBlockStart(0, { type: 'thinking', thinking: '', signature: '' }),
    anthropicDelta(0, { type: 'thinking_delta', thinking }),
    anthropicDelta(0, { type: 'signature_delta', signature: 'sig' }),
    anthropicBlockStop(0),
    anthropicBlockStart(1, { type: 'text', text: '' }),
    anthropicDelta(1, { type: 'text_delta', text }),
    anthropicBlockStop(1),
    anthropicEnd('end_turn'),
  ];
}

/** 密文思考（厂商把正文换成不透明载荷 ⇒ 这一格的正文拿不到，`textKind: 'none'`） */
export function anthropicRedactedThinking(text: string): string[] {
  return [
    anthropicStart(),
    anthropicBlockStart(0, { type: 'redacted_thinking', data: 'opaque' }),
    anthropicBlockStop(0),
    anthropicBlockStart(1, { type: 'text', text: '' }),
    anthropicDelta(1, { type: 'text_delta', text }),
    anthropicBlockStop(1),
    anthropicEnd('end_turn'),
  ];
}

/** 一次工具调用：`stop_reason` 是 `tool_use`，pi 据此执行工具并带着结果再发一轮 */
export function anthropicToolUse(name: string, input: Record<string, unknown>, callId = 'toolu_1'): string[] {
  return [
    anthropicStart(),
    anthropicBlockStart(0, { type: 'tool_use', id: callId, name, input: {} }),
    anthropicDelta(0, { type: 'input_json_delta', partial_json: JSON.stringify(input) }),
    anthropicBlockStop(0),
    anthropicEnd('tool_use'),
  ];
}

/** 空答复（无正文块）：`finalText` 该记 `null` 而不是空串 */
export function anthropicEmptyTurn(): string[] {
  return [anthropicStart(), anthropicEnd('end_turn')];
}

/**
 * 极简 MCP stdio 服务器（换行分隔的 JSON-RPC）：只回答 `initialize` / `tools/list`。
 * 工具名给 `echo` ⇒ 网关侧应看到厂商把它声明成 `mcp__<服务器名>__echo`。
 */
export const MCP_PROBE_SERVER_SOURCE = `
const readline = require('node:readline');
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } });
    return;
  }
  if (message.method === 'tools/list') {
    send(message.id, { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
    return;
  }
  if (message.id !== undefined) send(message.id, { result: {} });
});
`;

/** 一份 stdio MCP 服务器的注入条目（命令走当前 Node，省掉对 PATH 的依赖） */
export function piMcpProbeServers(): McpServers {
  return {
    probe: { transport: 'stdio', enabled: true, command: process.execPath, args: ['-e', MCP_PROBE_SERVER_SOURCE] },
  };
}

/** 一棵行目录：`configHome` 与 `cwd` 各一份（技能与凭据都往 `configHome` 落，共用会让场景互相泄漏） */
export interface PiRowLayout {
  root: string;
  cwd: string;
  configHome: string;
}

export function createPiRowLayout(prefix = 'pi-conformance-'): PiRowLayout {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  return { root, cwd, configHome };
}

/**
 * 造一条技能的**源目录**（物化的来源，不是物化结果）：`input.skills` 要的是「名字 + 源目录」，
 * 落到本行的是 `materializeSkills` 复制出来的那一份。
 */
export function writeSkillSource(root: string, name: string, body: string): { name: string; sourceDir: string } {
  const sourceDir = join(root, name);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 示例技能\n---\n\n${body}\n`, 'utf8');
  return { name, sourceDir };
}

export interface PiConformanceRun {
  product: ConformanceProduct;
  outcome: AgentRunResult;
  /** 收到的请求（请求侧判据的取证点；空数组 = 一次模型往返都没发出去） */
  requests: CapturedPiRequest[];
  /** 请求系统段里逐条列出的技能（`observer.ts` 的纯读法，两条 wire 各一处已收在那一层） */
  requestSkills: PiRequestSkill[];
  /** 请求里声明的工具名（含 `mcp__<服务器>__<工具>`） */
  requestTools: string[];
  /** 请求里结构化输出那一件的声明（`null` = 一次都没声明出去，判据读它的 `strict` 与 `parameters`） */
  strictTool: PiRequestToolDeclaration | null;
}

export interface PiConformanceOptions {
  script: PiSseScript;
  prompt: string;
  hang?: PiGatewayHang;
  signal?: AbortSignal;
  /** 直接回这个 HTTP 状态码（不给流）：传输层失败的输入 */
  status?: number;
  skills?: Array<{ name: string; sourceDir: string }>;
  mcpServers?: McpServers;
  outputSchema?: unknown;
  cwdSetup?: (cwd: string) => void;
  /** 权限档（缺省 `full`，与 `createRunInput` 一致）。只读档的用例用它判出站工具表 */
  permission?: AgentPermission;
  /**
   * 提问回调：给不给它决定这一轮有没有应答面（不给 ⇒ 适配器一个钩子都不挂、一个工具都不注册）。
   * 提问应答场景要拿同一行跑两次（带 / 不带），差别只在这一格。
   *
   * 提问工具只装在全权限档，故只读档 + 这一格非空 = 工具面里没有它（这条也是判据）。
   */
  onAskUser?: AgentRunInput['onAskUser'];
}

/**
 * 跑一行：真装配、真出站、真工具执行，只把**厂商那一端**换成假网关。
 *
 * 产物按套件的形状收齐（消息 / 子任务 / 行级事件 / 用量 / 结果），并附上请求侧事实。
 * 临时目录在返回前删掉：产物里不留任何路径依赖（技能那一条的落点从请求里读，不从盘上读）。
 */
export async function runPiConformanceRow(options: PiConformanceOptions): Promise<PiConformanceRun> {
  const layout = createPiRowLayout();
  options.cwdSetup?.(layout.cwd);
  const gateway = await startPiScriptedGateway(options.script, {
    ...(options.hang === undefined ? {} : { hang: options.hang }),
    ...(options.status === undefined ? {} : { status: options.status }),
  });
  const messages: AgentMessage[] = [];
  const subagents: SubagentRecord[] = [];
  const events: AgentEvent[] = [];
  try {
    const outcome = await piProvider.run({
      ...createRunInput({ cwd: layout.cwd, configHome: layout.configHome }),
      prompt: options.prompt,
      route: {
        protocolType: 'anthropic',
        baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
        apiKey: 'sk-conformance',
        modelId: 'm1',
        contextWindow: 100_000,
        maxOutputTokens: 32_768,
      },
      onMessage: (message) => messages.push(message),
      onSubagent: (record) => subagents.push(record),
      onEvent: (event) => events.push(event),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.skills === undefined ? {} : { skills: options.skills }),
      ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
      ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
      ...(options.permission === undefined ? {} : { permission: options.permission }),
      ...(options.onAskUser === undefined ? {} : { onAskUser: options.onAskUser }),
    });
    const last = gateway.requests.at(-1)?.body;
    const requestSkills = last === undefined ? [] : piRequestSkills(last, 'anthropic-messages');
    const requestTools = last === undefined ? [] : piRequestToolNames(last);
    /**
     * 结构化输出那一件的**请求侧事实**：从厂商真正发出去的那一份请求里读它的 `strict` 与
     * `parameters`（读法用 `observer.ts` 的纯函数）。要了 schema 却没读到这一件 = 适配器根本没把它
     * 声明出去——那时 `finalText` 里那份 JSON 只可能是模型自己按提示词写的，与「原生通道」无关。
     */
    const strictTool = last === undefined ? null : piRequestToolDeclaration(last, PI_STRUCTURED_OUTPUT_TOOL);
    /**
     * 注入面探针（**请求侧**）：两份事实都从厂商真正发出去的那一份请求里读，读法用 `observer.ts`
     * 的纯函数——不另造判据。空数组 = 那一格没进请求（这正是「适配器没把入参交给厂商」的形状）。
     *
     * `mcpServerNames` 取**我们交给厂商的配置键**：`mcpSent` 回答「这一格到没到厂商那儿」，
     * 这一格回答「我们配的是**哪几台**」——套件的逐名绑定按它对厂商工具表（名字形态差异由共享
     * 匹配器吸收）。
     */
    const injectionProbe = {
      mcpSent: requestTools.filter((name) => name.startsWith('mcp__')),
      mcpServerNames: Object.keys(options.mcpServers ?? {}),
      skillsInstalled: requestSkills.map((skill) => skill.name),
    };
    const product: ConformanceProduct = {
      messages,
      subagents,
      events,
      usage: {
        tokens: outcome.tokens,
        turns: outcome.turns,
        subagentTokens: outcome.subagentTokens,
        subagentTurns: outcome.subagentTurns,
      },
      result: { ok: outcome.ok, finalText: outcome.finalText },
      injectionProbe,
      ...(options.outputSchema === undefined
        ? {}
        : {
          /**
           * 结构化输出探针：两份事实**各自从真源读**。
           *
           * `nativeChannel` 取本次运行上报的通道事实（`applied.structuredOutput`）；
           * `hasOutputSchema` 取**请求侧**事实——「我们那一件工具真的带着 schema 出站了吗」。
           * 两者由套件的互钉判据连起来（上报走了原生通道 ⇒ 请求里必须有那份 schema）；
           * 只判其中一份等于没判：适配器整段忽略 `outputSchema` 时，另一份照样是自述。
           */
          structuredOutput: {
            nativeChannel: outcome.applied.structuredOutput,
            hasOutputSchema: strictTool?.parameters != null,
            finalText: outcome.finalText,
          },
        }),
    };
    return { product, outcome, requests: gateway.requests, requestSkills, requestTools, strictTool };
  } finally {
    gateway.close();
    removeTreeWithRetry(layout.root);
  }
}

/** 生命周期观测：`dispose` 是**行为**，产物里没有它的形状，只能数调用次数 */
export interface PiLifecycleObservation {
  disposeAfterRun: number;
  disposeAfterCancel: number;
  canceledMidTurn: boolean;
  /** 取消到运行落定的墙钟（判「abort 真的终结了在途轮次」还是「走了 5 秒兜底」） */
  cancelSettleMs: number;
  /** 取消时厂商侧的收场姿态（`agent_settled` 的 `aborted`），供守卫点名 */
  cancelExitReason: AgentRunResult['exitReason'];
}

/** 取消观测的一条支路：同一套观测换挂起档（在途 vs 无响应），两条的结论相反 */
export interface PiCancelObservation {
  canceledMidTurn: boolean;
  /** 取消之后会话被释放了几次（同一口径：必须恰好一次） */
  disposes: number;
  settleMs: number;
  exitReason: AgentRunResult['exitReason'];
}

/** 计数把手：`disposes` 读当前累计次数，`reset` 在两次运行之间清零 */
interface DisposalCounter {
  disposes: () => number;
  reset: () => void;
}

/**
 * 装一份**加了释放计数**的假 pi 模块，并把它注入运行时。
 *
 * 为什么要包一层 `createAgentSession`：释放是行为，真会话不往外报「我被 dispose 了几次」。
 * 包的那一层**只加计数**——会话本身仍是真包造出来的那一个，`abort` / `waitForIdle` / `dispose`
 * 全部原样转发；被测的是适配器在两条出口上各释放一次这件事。
 *
 * 注入表按**包名**查表（`load-once.ts` 的 `injectedModule`），所以两张表都得给：少一张，另一张
 * 就退回真实加载，装配会以「缺导出」的形式红在一个离真因很远的地方。用完必须复位注入表。
 */
async function installDisposalCounter(): Promise<DisposalCounter> {
  const { setAgentRuntimeForTesting } = await import('../runtime');
  // 动态 import：厂商包只允许动态装载（静态导入会把「一家故障」放大成「整包不可用」）
  const real = await import('@earendil-works/pi-coding-agent');
  const realAi = await import('@earendil-works/pi-ai');
  let count = 0;
  setAgentRuntimeForTesting({
    sdkModule: {
      [PI_PACKAGE_NAME]: {
        ...real,
        createAgentSession: async (sessionOptions: unknown) => {
          const created = await real.createAgentSession(
            sessionOptions as Parameters<typeof real.createAgentSession>[0],
          );
          // 逐方法转发（展开一个类实例会丢原型上的方法）：形状就是 `PiSession` 用到的那七格
          const session = created.session;
          return {
            session: {
              subscribe: (listener: (event: unknown) => void) => session.subscribe(listener),
              prompt: (text: string) => session.prompt(text),
              abort: () => session.abort(),
              waitForIdle: () => session.waitForIdle(),
              dispose: () => {
                count += 1;
                session.dispose();
              },
              bindExtensions: (bindings: { mode: 'rpc'; onError?: (error: unknown) => void }) =>
                session.bindExtensions(bindings),
              getLastAssistantText: () => session.getLastAssistantText(),
            },
          };
        },
      },
      [PI_AI_PACKAGE_NAME]: realAi,
    },
  });
  return { disposes: () => count, reset: () => { count = 0; } };
}

/**
 * 起一台挂起的网关、跑一次、在**轮次真的起手之后**翻转信号，交回出口上的三个事实。
 *
 * 翻转的时机是「厂商收到请求」而不是一个墙钟延时：延时会在冷启动时翻在装配还没跑完的时候，
 * 那时停止信号拦不住这一轮（它会照常发出、挂满兜底窗口），观测到的就不是「在途取消」了。
 */
async function observeCancelAt(
  counter: DisposalCounter,
  hang: PiGatewayHang,
): Promise<PiCancelObservation> {
  const gateway = await startPiScriptedGateway([anthropicText('半截')], { hang });
  const controller = new AbortController();
  try {
    const running = runWithGateway(gateway, { signal: controller.signal });
    await gateway.firstRequest;
    const abortedAt = Date.now();
    controller.abort();
    const outcome = await running;
    const settleMs = Date.now() - abortedAt;
    return {
      /**
       * 判据取自 `release.ts` 的兜底窗口：落定得比它早 ⇒ 中断通道真的终结了在途轮次；
       * 等到它 ⇒ 走的是「不响应停止信号」那条兜底。从产品常量取而不是抄个 5000，
       * 两处不同步时判据会静默失效。
       */
      canceledMidTurn: settleMs < RELEASE_GRACE_MS,
      disposes: counter.disposes(),
      settleMs,
      exitReason: outcome.exitReason,
    };
  } finally {
    gateway.close();
  }
}

/**
 * 生命周期观测：真包跑两次运行（一次正常收尾、一次**在途**取消）。
 *
 * 取消那一档挂在 **`mid-stream`**（厂商已经开流、正文还没吐完）——在途轮次最常见的那一档。
 *
 * 已知边界（不在本观测里，因为它是**时序**而不是相位）：停止信号若早于轮次起手到达
 * （冷启动时装配还没跑完），`abort()` 拦不住那一轮，它会照常发出并在无人应答时挂满释放兜底窗口
 * 才落定。行仍然以 `canceled` 收场、仍然恰好释放一次，代价只是**慢**（5 秒级）。
 * 观测因此等「厂商收到请求」再翻信号，量到的才是适配器在途取消那件事。
 */
export async function observePiLifecycle(): Promise<PiLifecycleObservation> {
  const counter = await installDisposalCounter();
  try {
    const gateway = await startPiScriptedGateway([anthropicText('收尾。')]);
    try {
      await runWithGateway(gateway, {});
    } finally {
      gateway.close();
    }
    const disposeAfterRun = counter.disposes();
    counter.reset();
    const canceled = await observeCancelAt(counter, 'mid-stream');
    return {
      disposeAfterRun,
      disposeAfterCancel: canceled.disposes,
      canceledMidTurn: canceled.canceledMidTurn,
      cancelSettleMs: canceled.settleMs,
      cancelExitReason: canceled.exitReason,
    };
  } finally {
    const { setAgentRuntimeForTesting } = await import('../runtime');
    setAgentRuntimeForTesting(null);
  }
}

/**
 * 换一档挂起姿态观测取消（守卫用）：`no-headers` 那一档证明的是**另一件事**——
 * 厂商在等首个字节的阶段不响应停止信号时，运行仍会在兜底窗口内落定并**恰好释放一次**
 * （不静默挂死、也不泄漏）。它的 `canceledMidTurn` 是 `false`，与声明无关，是能力的边界。
 */
export async function observePiCancelAt(hang: PiGatewayHang): Promise<PiCancelObservation> {
  const counter = await installDisposalCounter();
  try {
    return await observeCancelAt(counter, hang);
  } finally {
    const { setAgentRuntimeForTesting } = await import('../runtime');
    setAgentRuntimeForTesting(null);
  }
}

/** 生命周期观测里跑一次真运行（不建产物，只要出口上的行为） */
async function runWithGateway(
  gateway: PiScriptedGateway,
  options: { signal?: AbortSignal },
): Promise<AgentRunResult> {
  const layout = createPiRowLayout('pi-lifecycle-');
  try {
    return await piProvider.run({
      ...createRunInput({ cwd: layout.cwd, configHome: layout.configHome }),
      prompt: 'say done',
      route: {
        protocolType: 'anthropic',
        baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
        apiKey: 'sk-conformance',
        modelId: 'm1',
        contextWindow: 100_000,
        maxOutputTokens: 32_768,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    removeTreeWithRetry(layout.root);
  }
}
