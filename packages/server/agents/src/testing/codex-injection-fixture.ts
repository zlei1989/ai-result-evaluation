/**
 * codex **idle 档人工消息投递**的真路径驱动器：真 `codex app-server` + 本机假 `/v1/responses` 上游
 * + 一个最小的注入端口。
 *
 * 为什么必须走真路径：这一档的判据是「那句话真的进到了模型面前」，而投递动作是**厂商自己**做的
 * ——条目录在一个空闲线程上时，厂商在 `thread/queue/add` 那一刻就把它撒成新一轮（上游 README：
 * *"dispatches the oldest pending row … once the thread is idle"*）。假 app-server 顶替厂商那一侧时
 * 「厂商拿这条消息做了什么」看不见；只有**出站请求体**看得见。
 *
 * 三段读数（与 `codex-resume-fixture.ts` 同形）：
 *   ① **交付登记**：端口那一侧的 `markDelivered` 收到过这条 id（账本记的就是它）；
 *   ② **真到模型面前**：哨兵文本出现在**厂商出站请求体**里（`/v1/responses` 的原文，不经过我们任何投影）；
 *   ③ **那一轮跑完**：`turn/started` 与 `turn/completed` 同数（没被 `dispose` 杀掉），
 *      且它的答复就是本次运行 `finalText`——结论取的是续跑那一轮，不是首轮。
 *
 * **阴性对照**（同装配、同剧本，只是不挂注入面）：哨兵一次都不许出现在出站请求体里
 * ——没有它，「哨兵在里面」可能只是工作区/提示词泄漏，而不是投递真的发生了。
 *
 * 本模块只被 `*.test.ts` import（与另两份真路径夹具同一条口径）。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@aieval/contracts';
import type { AppServerClient } from '../providers/codex/appserver/client';
import { codexProvider, defaultCodexRuntimeHooks } from '../providers/codex';
import { collectEvents, createRunInput } from './agent-fixtures';
import { startCodexScriptedUpstream } from './codex-real-path-fixture';
import { removeTreeWithRetry } from './cleanup';
import type { InjectionPort, UserMessage } from '../types';

/** 上游模型名：模型那一侧是假的，这个名字只决定请求体里的一个字符串 */
export const CODEX_INJECTION_MODEL = 'codex-injection-probe-model';

/** 人话里的暗号：它只存在于**注入的那条消息**里（提示词里没有），因此出现在请求体里就只有一个来因 */
export const CODEX_INJECTION_SENTINEL = 'CODEX_INJECTION_SENTINEL_7f21';

/** 首轮与续轮的答复（判 `finalText` 取的是哪一轮） */
export const CODEX_INJECTION_FIRST_ANSWER = 'CODEX_INJECTION_FIRST_ANSWER 第一轮。';
export const CODEX_INJECTION_SECOND_ANSWER = 'CODEX_INJECTION_SECOND_ANSWER 我收到了那句话。';

/** 脚本式上游要的凭据：占位串即可（请求根本不出本机） */
const PLACEHOLDER_KEY = 'codex-injection-probe-placeholder-not-a-secret';

/** 单次运行的墙钟上限：真二进制冷启动 + 上游往返是秒级，带负载时慢一个数量级 ⇒ 宁可超时也不假红 */
const RUN_TIMEOUT_MS = 180_000;

/** 一次运行的读数 */
export interface CodexInjectionRun {
  /** 端口那一侧登记为「已交付」的条目 id */
  deliveredIds: string[];
  /** 哨兵出现在**出站请求体**里的次数（>0 = 那句话真的到了模型面前） */
  sentinelInOutbound: number;
  /** 厂商起的轮数（`turn/started` 条数） */
  turnStarted: number;
  /** 厂商收场的轮数（`turn/completed` 条数）：与 `turnStarted` 同数才算那一轮跑完了 */
  turnCompleted: number;
  ok: boolean;
  /** 本次运行的最终答复（判「结论取的是哪一轮」） */
  finalText: string | null;
  /** 这一次运行发出了哪些 wire 请求（判投递路径：`queue/add` → `queue/start` → `queue/list`） */
  requests: string[];
  /**
   * 厂商**出站请求体**里的工具表（`type:name` 串）：`web_search` 那件内置 hosted 工具关没关掉，
   * 只有这一份看得见（`tools.web_search=false` 是参数容器、关不掉它）。
   */
  outboundToolTypes: string[];
}

export interface CodexInjectionScenario {
  /** 挂注入面那一臂：人话在收场那一刻交出去 */
  delivery: CodexInjectionRun;
  /** 不挂注入面那一臂（阴性对照）：同一个剧本、同一份提示词，哨兵一次都不该出现 */
  control: CodexInjectionRun;
  /** 这一组读数落在哪个临时目录（用例收尾删它） */
  root: string;
}

/** 一次运行：`withPort` 决定挂不挂注入面（两臂唯一的自变量） */
async function runOnce(root: string, withPort: boolean): Promise<CodexInjectionRun> {
  const cwd = join(root, withPort ? 'workspace-delivery' : 'workspace-control');
  const configHome = join(root, withPort ? '.agenthome-delivery' : '.agenthome-control');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  const upstream = await startCodexScriptedUpstream({
    // 这件工具不在真机工具表里 ⇒ 上游永远走「纯文本收尾」那一支；判据是**入站请求体**
    callId: 'codex-injection-never-called',
    toolName: 'codex_injection_probe_never_called',
    args: {},
    finalText: CODEX_INJECTION_FIRST_ANSWER,
    // 第二轮（请求体里带哨兵）回另一句 ⇒ `finalText` 落在哪一句上就说明结论取的是哪一轮
    finalTextOf: (body) => (JSON.stringify(body).includes(CODEX_INJECTION_SENTINEL) ? CODEX_INJECTION_SECOND_ANSWER : CODEX_INJECTION_FIRST_ANSWER),
  });

  const delivered: string[] = [];
  let drained = false;
  // `UserMessage` 只有 `id` 与 `text` 两格：`origin` 是**账本**那一侧的概念（编排层落记录时写），
  // 端口这一层不认它——多给一格在这里是编译错，不是「以后可能用得上」
  const message: UserMessage = { id: 'codex-injection-msg-1', text: `${CODEX_INJECTION_SENTINEL} 请把这句话复述一遍` };
  /** 端口：`'round'` 档空手而归（要测的是收场那一刻的 `'idle'` 档） */
  const port: InjectionPort = {
    available: true,
    drain: (boundary) => {
      if (boundary !== 'idle' || drained) return [];
      drained = true;
      return [message];
    },
    markDelivered: (ids) => {
      delivered.push(...ids);
    },
    retract: async () => 'unsupported',
  };

  const notifications: Array<{ method: string; params: unknown }> = [];
  const requests: string[] = [];
  const original = codexProvider.runtimeHooks;
  codexProvider.runtimeHooks = {
    // 真二进制照旧由产品那一侧解析；客户端也由产品那一侧建（连 spawn 都是真的）
    resolveBinary: defaultCodexRuntimeHooks.resolveBinary,
    createClient: (input) => {
      const client: AppServerClient = defaultCodexRuntimeHooks.createClient(input);
      client.subscribe((notification) => {
        notifications.push({ method: notification.method, params: notification.params });
      });
      const request = client.request.bind(client);
      client.request = (method, params) => {
        requests.push(method);
        return request(method, params);
      };
      return client;
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  const events: AgentEvent[] = [];
  try {
    const result = await codexProvider.run(createRunInput({
      cwd,
      configHome,
      permission: 'full',
      prompt: 'CODEX_INJECTION_PROBE_PROMPT 先跑第一轮。',
      route: { protocolType: 'openai', baseUrl: upstream.url, apiKey: PLACEHOLDER_KEY, modelId: CODEX_INJECTION_MODEL },
      signal: controller.signal,
      onEvent: collectEvents(events),
      ...(withPort ? { inject: port } : {}),
    }));
    const firstBody = upstream.records[0]?.body as { tools?: Array<{ type?: string; name?: string }> } | undefined;
    const tools = Array.isArray(firstBody?.tools) ? firstBody.tools : [];
    return {
      deliveredIds: delivered,
      sentinelInOutbound: upstream.records.filter((one) => JSON.stringify(one.body).includes(CODEX_INJECTION_SENTINEL)).length,
      outboundToolTypes: tools.map((one) => `${one.type ?? 'function'}:${one.name ?? ''}`),
      turnStarted: notifications.filter((one) => one.method === 'turn/started').length,
      turnCompleted: notifications.filter((one) => one.method === 'turn/completed').length,
      ok: result.ok,
      finalText: result.finalText,
      requests,
    };
  } finally {
    clearTimeout(timer);
    codexProvider.runtimeHooks = original;
    upstream.close();
  }
}

/** 跑一组：挂注入面那一臂 + 不挂那一臂（阴性对照），同一个临时根目录 */
export async function runCodexInjectionScenario(): Promise<CodexInjectionScenario> {
  const root = mkdtempSync(join(tmpdir(), 'codex-injection-'));
  try {
    const delivery = await runOnce(root, true);
    const control = await runOnce(root, false);
    return { delivery, control, root };
  } catch (error) {
    removeTreeWithRetry(root);
    throw error;
  }
}

/** 用例收尾删临时目录（与另两份真路径夹具同一个出口） */
export function cleanupCodexInjectionScenario(scenario: CodexInjectionScenario): void {
  removeTreeWithRetry(scenario.root);
}
