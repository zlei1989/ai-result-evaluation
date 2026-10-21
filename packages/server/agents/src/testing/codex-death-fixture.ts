/**
 * codex **进程在途死亡**的真路径驱动器：真 `codex app-server` + 本机假 `/v1/responses` 上游
 * （**永不回帧**，那一轮因此保持在途）+ 从探针侧把子进程杀掉。
 *
 * 为什么必须真路径：要证的是一条**分类**——「厂商进程死在在途」这件事在通知流里没有任何终态
 * （没有 `turn/completed`），失败事实只落在会话的终态结算上。假 app-server 里「杀掉真进程」
 * 这个动作本身就不存在（假件的 `die()` 走的是另一条路：它会把待收请求一起拒掉）。
 *
 * 两臂（唯一自变量是**杀不杀**，装配与剧本逐字相同）：
 *   · `control`：不杀，脚本式上游正常收尾 ⇒ 本次运行成功（证明这条臂能看见差异）；
 *   · `killed`：`turn/start` 已受理（上游收到过模型请求）之后 `SIGKILL` ⇒ 本次运行**必须失败**，
 *     原因点名进程退出。
 *
 * 子进程句柄由探针经 `spawnFn` 取得（`AppServerClientOptions.spawnFn` 是客户端自己的注入口，
 * 生产那一侧的 spawn 形状照抄 `providers/codex/appserver/client.ts` 的 `defaultSpawn`）。
 *
 * 本模块只被 `*.test.ts` import（与另几份真路径夹具同一条口径）。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunResult } from '../types';
import { createAppServerClient, type AppServerChild } from '../providers/codex/appserver/client';
import { codexProvider } from '../providers/codex';
import { createRunInput } from './agent-fixtures';
import { removeTreeWithRetry } from './cleanup';

/** 上游模型名：模型那一侧是假的 */
export const CODEX_DEATH_MODEL = 'codex-death-probe-model';

const PLACEHOLDER_KEY = 'codex-death-probe-placeholder-not-a-secret';

/** 单臂墙钟上限（真二进制冷启动 + 上游往返是秒级；等模型请求另给预算） */
const RUN_TIMEOUT_MS = 120_000;

/** 一轮纯文本收尾（帧形与 `codex-real-path-fixture.ts` 同源） */
function textTurn(text: string): string {
  const events: Array<[string, unknown]> = [
    ['response.created', { type: 'response.created', response: { id: 'resp_text' } }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_text', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
    }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_text', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** 上游：`hang` 时收下请求就挂着（那一轮保持在途），否则正常回一帧文本 */
async function startUpstream(hang: boolean): Promise<{ url: string; bodies: string[]; close: () => void }> {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (hang) {
        response.flushHeaders?.();
        return;
      }
      response.end(textTurn('CODEX_DEATH_CONTROL_ANSWER 正常收尾。'));
    });
  });
  server.unref();
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  return { url, bodies, close: () => (server.closeAllConnections?.() ?? server.close()) };
}

export interface CodexDeathRun {
  result: AgentRunResult;
  killed: boolean;
  /** 上游收到过几次模型请求（>0 证明起手三步已经走完、这一轮真的在途） */
  upstreamRequests: number;
}

/** 跑一臂：`killMidTurn` 决定在「`turn/start` 已受理」之后杀不杀 */
async function runArm(killMidTurn: boolean): Promise<{ run: CodexDeathRun; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'codex-death-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  const upstream = await startUpstream(killMidTurn);

  /**
   * 真子进程句柄。声明成**真** `ChildProcess` 而不是 `AppServerChild`：这一臂要发 `SIGKILL`，
   * 而 `AppServerChild` 的窄声明里 `kill()` **不带信号参数**（适配器自己从不直接杀它，
   * 回收走 `process-tree.ts`）⇒ 按窄声明读就只能发默认信号，与这一臂的意图不符。
   */
  let child: ReturnType<typeof spawn> | null = null;
  const original = codexProvider.runtimeHooks;
  codexProvider.runtimeHooks = {
    resolveBinary: original.resolveBinary,
    createClient: (input) => createAppServerClient({
      binary: input.binary,
      env: input.env,
      ...(input.onServerRequest === undefined ? {} : { onServerRequest: input.onServerRequest }),
      /**
       * 与 `appserver/client.ts` 的 `defaultSpawn` 同形（stdio 三管、POSIX 自成进程组），
       * 只多一件事：把句柄留下来——「杀掉真进程」这条臂的物质基础。
       */
      spawnFn: (binary, args, env) => {
        const spawned = spawn(binary, [...args], {
          env: { ...env } as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
        child = spawned;
        return spawned as unknown as AppServerChild;
      },
    }),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  let killed = false;
  try {
    const running = codexProvider.run(createRunInput({
      cwd,
      configHome,
      permission: 'full',
      prompt: 'CODEX_DEATH_PROBE_PROMPT 这一轮不需要答复。',
      route: { protocolType: 'openai', baseUrl: upstream.url, apiKey: PLACEHOLDER_KEY, modelId: CODEX_DEATH_MODEL },
      signal: controller.signal,
      onEvent: () => {},
    }));
    if (killMidTurn) {
      // 等 `turn/start` 已受理：判据是上游收到过模型请求（那一刻这一轮**在途**）
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && upstream.bodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      /**
       * 断言这一格的类型再读：`child` 的唯一一次赋值发生在**闭包**里（`spawnFn`），而 TS 的控制流
       * 分析不穿透闭包 ⇒ 在本次运行它仍按声明处的初始值把 `child` 收窄成 `null`，于是 `child?.kill`
       * 被判成「在 `never` 上取属性」。断言回声明的类型才是「句柄可能已被赋过值」这个真实语义。
       */
      (child as ReturnType<typeof spawn> | null)?.kill('SIGKILL');
      killed = true;
    }
    const result = await running;
    return { run: { result, killed, upstreamRequests: upstream.bodies.length }, root };
  } catch (error) {
    removeTreeWithRetry(root);
    throw error;
  } finally {
    clearTimeout(timer);
    codexProvider.runtimeHooks = original;
    upstream.close();
  }
}

export interface CodexDeathScenario {
  /** 不杀那一臂：正常成功 */
  control: CodexDeathRun;
  /** 在途杀掉那一臂：必须失败 */
  killed: CodexDeathRun;
  /**
   * **两臂各自的行根目录**——两臂是两次独立的运行，各有自己的 root。
   * 收成一个 `root: string` 时被丢掉的那一个会**每次跑泄漏一个临时目录**
   * （实测：跑一次 `<tmpdir>/codex-death-*` 从 65 个变 66 个）。
   */
  roots: string[];
}

export async function runCodexDeathScenario(): Promise<CodexDeathScenario> {
  const control = await runArm(false);
  try {
    const killed = await runArm(true);
    return { control: control.run, killed: killed.run, roots: [control.root, killed.root] };
  } catch (error) {
    removeTreeWithRetry(control.root);
    throw error;
  }
}

export function cleanupCodexDeathScenario(scenario: CodexDeathScenario): void {
  // **两臂都要删**：少删一个就每次跑泄漏一个临时目录（见 `CodexDeathScenario.roots`）
  for (const root of scenario.roots) removeTreeWithRetry(root);
}
