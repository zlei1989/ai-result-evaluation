/**
 * codex **跨进程续接**的真路径驱动器：真 `codex app-server` + 本机假 `/v1/responses` 上游。
 *
 * 这一份存在的理由（与「假 app-server 顶替厂商」那一档的根本差别）：续接的全部意义是
 * 「**新进程**接上旧会话」——假件把厂商那一侧换掉之后，`thread/resume` 读的是夹具的内存，
 * 证不到「转录在盘上、新进程读得到」。这里厂商那一侧全是真的：真二进制起 app-server、
 * 真 JSON-RPC 管道、线程转录落在该行自己的 `$CODEX_HOME` 下；每一次运行都是**新的 app-server 进程**
 * （上一次运行收尾时整棵进程树已回收）。我们只换掉**上游那个模型**。
 *
 * 三段读数（与 `providers/pi` 的续接用例同形，判据也同源）：
 *   ① **机制**：续接那一轮的**出站请求体**里有没有上一轮写下的暗号（厂商把转录投影成了模型上下文）；
 *   ② **端到端**：脚本式上游按请求体作答 ⇒ 答复里有暗号；
 *   ③ **阴性对照**：同一个 `$CODEX_HOME`、同一个 cwd，只是**不传 `resume`** ⇒ 一个暗号都带不回来
 *      （没有它，「答对了」可能只是工作区泄漏）。
 *
 * 本模块只被 `*.test.ts` import（与另一份真路径夹具同一条口径）。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunResult } from '../types';
import type { AppServerClient } from '../providers/codex/appserver/client';
import { codexProvider, defaultCodexRuntimeHooks } from '../providers/codex';
import { createRunInput } from './agent-fixtures';
import { startCodexScriptedUpstream, type CodexScriptedUpstream } from './codex-real-path-fixture';
import { removeTreeWithRetry } from './cleanup';

/** 上游模型名：模型那一侧是假的，这个名字只决定请求体里的一个字符串 */
export const CODEX_RESUME_MODEL = 'codex-resume-probe-model';

/** 脚本式上游要的凭据：占位串即可（请求根本不出本机） */
const PLACEHOLDER_KEY = 'codex-resume-probe-placeholder-not-a-secret';

/** 单次运行的墙钟上限：真二进制冷启动 + 上游往返是秒级，带负载时慢一个数量级 ⇒ 宁可超时也不假红 */
const RUN_TIMEOUT_MS = 180_000;

/** 一次运行的读数 */
export interface CodexResumeRun {
  /** 这一次运行发出去的 wire 请求（方法名 + 入参）：判「续接用的是 resume 不是 start」 */
  requests: Array<{ method: string; params: unknown }>;
  /** 这一次运行的**出站请求体**（假上游收到的那些） */
  outboundBodies: Array<Record<string, unknown>>;
  ok: boolean;
  /** 适配器交回的会话身份（codex = `threadId`） */
  sessionId: string | null;
  /** 最终答复 */
  reply: string | null;
}

export interface CodexResumeScenario {
  nonceA: string;
  /** 进程 A：开新线程、写下暗号 */
  first: CodexResumeRun;
  /** 进程 B：只带 `resume{threadId}`、把暗号问回来 */
  resumed: CodexResumeRun;
  /** 进程 C：同 home / 同 cwd，只是不传 `resume`（阴性对照） */
  control: CodexResumeRun;
  /** 这一组读数落在哪个临时目录（用例收尾删它） */
  root: string;
  /** 三次运行共用的行配置目录（`$CODEX_HOME`）：线程转录落在它下面 */
  configHome: string;
  /** 三次运行共用的工作区 */
  cwd: string;
  /** 假上游收到的**全部**入站请求（跨三次运行；排障时看它） */
  upstream: CodexScriptedUpstream;
}

/** 一次运行的装配：真二进制 + 脚本式上游 + 请求台账 */
async function runOnce(options: {
  cwd: string;
  configHome: string;
  prompt: string;
  upstreamUrl: string;
  nonce: string;
  resumeThreadId?: string;
}): Promise<CodexResumeRun> {
  const requests: Array<{ method: string; params: unknown }> = [];
  const originalHooks = codexProvider.runtimeHooks;
  /**
   * 客户端由**产品那一侧**建（连 spawn 都是真的），驱动器只包一层记下每一次请求：
   * 判据是「我们真的发出了 `thread/resume`」，而这件事只有请求台账看得见。
   */
  codexProvider.runtimeHooks = {
    resolveBinary: defaultCodexRuntimeHooks.resolveBinary,
    createClient: (clientInput) => {
      const client = defaultCodexRuntimeHooks.createClient(clientInput);
      const request = client.request.bind(client) as AppServerClient['request'];
      client.request = (async (method: string, params?: unknown) => {
        requests.push({ method, params });
        return await request(method, params);
      }) as AppServerClient['request'];
      return client;
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  try {
    const result: AgentRunResult = await codexProvider.run(
      createRunInput({
        cwd: options.cwd,
        configHome: options.configHome,
        permission: 'full',
        prompt: options.prompt,
        route: {
          protocolType: 'openai',
          baseUrl: options.upstreamUrl,
          apiKey: PLACEHOLDER_KEY,
          modelId: CODEX_RESUME_MODEL,
        },
        signal: controller.signal,
        ...(options.resumeThreadId === undefined ? {} : { resume: { sessionId: options.resumeThreadId } }),
      }),
    );
    return {
      requests,
      outboundBodies: [],
      ok: result.ok,
      sessionId: result.sessionId,
      reply: result.finalText,
    };
  } finally {
    clearTimeout(timer);
    codexProvider.runtimeHooks = originalHooks;
  }
}

/** 入站请求体里有没有这串暗号（判据只扫 `/v1/responses` 那些 JSON 体） */
function bodyHasNonce(body: Record<string, unknown>, nonce: string): boolean {
  return JSON.stringify(body).includes(nonce);
}

/**
 * 跑完整的一圈：写 → 续接问回 → 阴性对照。
 *
 * 三次运行共用**同一个** cwd 与 `$CODEX_HOME`（那是「同一行」的形状）；自变量只有
 * 「传不传 `resume`」与提示词。调用方负责删 `root`。
 */
export async function runCodexResumeScenario(): Promise<CodexResumeScenario> {
  const root = mkdtempSync(join(tmpdir(), 'codex-resume-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  const nonceA = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  /**
   * 脚本式「模型」读一眼请求体再作答：上下文里没有暗号时答「不知道」——
   * 阴性对照因此**可判**（否则它会照剧本背出暗号，把泄漏读成续接成功）。
   */
  const upstream = await startCodexScriptedUpstream({
    // 这一份剧本不带提问：工具名给一个 codex 表里不存在的字符串，第一次带它的请求永远不会出现
    callId: 'resume-probe-no-call',
    toolName: '__codex_resume_probe_never__',
    args: {},
    finalText: '不知道',
    finalTextOf: (body) => (bodyHasNonce(body, nonceA) ? `暗号是 ${nonceA}` : '不知道'),
  });

  const mark = (): number => upstream.records.length;
  const bodiesSince = (from: number): Array<Record<string, unknown>> =>
    upstream.records.slice(from).map((one) => one['body'] as Record<string, unknown>);

  try {
    const firstMark = mark();
    const first = await runOnce({
      cwd,
      configHome,
      upstreamUrl: upstream.url,
      nonce: nonceA,
      prompt: `请记住这串暗号：${nonceA}。只回复「记住了」，不要复述暗号，也不要调用任何工具。`,
    });
    const threadId = first.sessionId;
    if (threadId === null) throw new Error('第一次运行没有交回 threadId：续接没有键可指');

    const resumedMark = mark();
    const resumed = await runOnce({
      cwd,
      configHome,
      upstreamUrl: upstream.url,
      nonce: nonceA,
      resumeThreadId: threadId,
      prompt: '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。不要调用任何工具。',
    });

    const controlMark = mark();
    const control = await runOnce({
      cwd,
      configHome,
      upstreamUrl: upstream.url,
      nonce: nonceA,
      prompt: '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。不要调用任何工具。',
    });

    return {
      nonceA,
      root,
      configHome,
      cwd,
      upstream,
      first: { ...first, outboundBodies: bodiesSince(firstMark) },
      resumed: { ...resumed, outboundBodies: bodiesSince(resumedMark) },
      control: { ...control, outboundBodies: bodiesSince(controlMark) },
    };
  } finally {
    upstream.close();
  }
}

/** 删掉一次场景的临时目录（调用方在 `afterAll` 里用） */
export function cleanupCodexResumeScenario(scenario: CodexResumeScenario): void {
  removeTreeWithRetry(scenario.root);
}
