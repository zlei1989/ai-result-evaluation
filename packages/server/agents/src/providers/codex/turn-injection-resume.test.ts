// @vitest-environment node
/**
 * codex 的**跨进程续接**与 `turnInjection` 声明的证据面，两件事在同一个文件里。
 *
 * 前三段判据逐段回答一个不同的问题（驱动器见 `testing/codex-resume-fixture.ts`）：
 *   ① **机制**：续接那一轮的出站请求体里有没有上一轮写下的暗号；
 *   ② **端到端**：脚本式上游按请求体作答 ⇒ 答复里有暗号；
 *   ③ **阴性对照**：同一个 `$CODEX_HOME`、同一个 cwd，只是不传 `resume` ⇒ 一个暗号都带不回来。
 *
 * 最后一段是**声明与夹具互钉**：声明写 `yes` 的前提是上面那些判据真的成立；把夹具删掉、
 * 或把声明改成 `no`，都会在同一个文件里当场见红（声明不许先于夹具）。
 * 它还补上先例那个洞——`askUserProofDriver` 只核声明自身的 schema 合规性，
 * **没有人核对「这一家提交的驱动器真的是真路径」**：这里用静态判据核对驱动器文件里
 * 有没有在厂商边界上换假件。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupCodexResumeScenario,
  runCodexResumeScenario,
  type CodexResumeScenario,
} from '../../testing/codex-resume-fixture';
import { codexProvider } from './index';

/** 一次场景跑得很贵（真二进制 × 三次运行），故整组共用一个读数 */
let scenarioPromise: Promise<CodexResumeScenario> | null = null;
function scenario(): Promise<CodexResumeScenario> {
  scenarioPromise ??= runCodexResumeScenario();
  return scenarioPromise;
}

afterAll(async () => {
  if (scenarioPromise === null) return;
  cleanupCodexResumeScenario(await scenarioPromise);
});

/** 入站请求体里有没有这串暗号（判据只读「厂商交给模型的那一份」） */
const hasNonce = (bodies: ReadonlyArray<Record<string, unknown>>, nonce: string): boolean =>
  bodies.some((body) => JSON.stringify(body).includes(nonce));

describe('codex 的跨进程续接（真 app-server + 脚本式上游，暗号回读）', () => {
  it('线程身份落在结果里（第二期追问要拿它当键），且键只有 `threadId`', async () => {
    const { first } = await scenario();
    expect(first.ok).toBe(true);
    expect(first.sessionId).not.toBeNull();
  }, 200_000);

  it('① 机制 + ② 端到端：续接那一轮把上一轮的暗号带回来了（请求体里在、答复里也在）', async () => {
    const { resumed, nonceA, first } = await scenario();
    // 续接走的是 `thread/resume`，一条 `thread/start` 都不许有（静默开新会话是最坏的一种）
    expect(resumed.requests.map((one) => one.method)).toContain('thread/resume');
    expect(resumed.requests.map((one) => one.method)).not.toContain('thread/start');
    expect(resumed.requests.find((one) => one.method === 'thread/resume')?.params).toMatchObject({
      threadId: first.sessionId,
    });
    // ① 厂商把盘上的转录投影成了模型上下文
    expect(hasNonce(resumed.outboundBodies, nonceA)).toBe(true);
    // ② 脚本式上游照请求体作答 ⇒ 暗号真的走到了「模型」面前
    expect(resumed.reply).toContain(nonceA);
    // 续接落在**同一条**线程上（不是另起一条）
    expect(resumed.sessionId).toBe(first.sessionId);
  }, 200_000);

  it('③ 阴性对照：同一个 home / 同一个 cwd，只是不传 resume ⇒ 一个暗号都带不回来', async () => {
    const { control, first, nonceA } = await scenario();
    expect(control.requests.map((one) => one.method)).not.toContain('thread/resume');
    expect(hasNonce(control.outboundBodies, nonceA)).toBe(false);
    expect(control.reply).not.toContain(nonceA);
    // 对照新开了一条线程 ⇒ 它的 id 与续接那条不同（两臂的自变量真的只有 `resume` 这一格）
    expect(control.sessionId).not.toBeNull();
    expect(control.sessionId).not.toBe(first.sessionId);
  }, 200_000);
});

/**
 * **驱动器真伪**：声明里那几格说「我们做到了」，而做到的证据必须来自**真路径**驱动器。
 *
 * 为什么这条不能省：先例（`askUserProofDriver`）只由契约核对「声明 `yes` ⇒ 驱动器写 `real-path`」，
 * 于是「写 `real-path` 而实际在夹具里扮演厂商」这件事没有任何判据拦得住——而它正是把假绿
 * 写进声明的形态。这里的判据是**静态的**（照 `onboarding.test.ts` 的 `FAKE_SDK_MARKER`）：
 * 驱动器源码里出现假厂商那一侧的记号，这一格 `yes` 的前提当场作废。
 */
describe('codex 续接的驱动器是真路径（补先例那个「没人核驱动器真伪」的洞）', () => {
  /** 驱动器文件（相对仓库根）：本组判据的事实来源 */
  const DRIVER = 'packages/server/agents/src/testing/codex-resume-fixture.ts';

  /** 仓库根：从本文件往上找到带 `pnpm-workspace.yaml` 的那一级（不数层级，挪包也不会失效） */
  function repoRoot(): string {
    let dir = import.meta.dirname;
    for (let step = 0; step < 12; step += 1) {
      if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error('找不到仓库根（没有 pnpm-workspace.yaml 的祖先目录）');
  }

  it('夹具没有在厂商边界上换假件，且真的走厂商那一侧（真二进制 → 真 app-server）', () => {
    const source = readFileSync(join(repoRoot(), DRIVER), 'utf8');
    // 假厂商 / 假 app-server 的记号：出现任何一个，这一格就不是真路径，声明的那份 `yes` 作废
    expect(source).not.toContain('setAgentRuntimeForTesting');
    expect(source).not.toContain('createFakeAppServer');
    expect(source).not.toContain('createExplodingChild');
    // 反向判据：它必须**真的**走产品那条造客户端的路（真 spawn），而不是自己返回一个替身
    expect(source).toContain('defaultCodexRuntimeHooks');
    expect(source).toContain('codexProvider.run');
  });

  it('转录真的落在这一行的 `$CODEX_HOME` 下（新进程读得到才谈得上跨进程续接）', async () => {
    const { configHome, nonceA } = await scenario();
    // 行目录就在驱动器给的那一份里：转录落 `sessions/**/rollout-*.jsonl`（厂商自己的落点）
    const sessionsDir = join(configHome, 'sessions');
    expect(existsSync(sessionsDir)).toBe(true);
    const rollouts = readdirSync(sessionsDir, { recursive: true, encoding: 'utf8' })
      .filter((one) => one.endsWith('.jsonl'))
      .map((one) => join(sessionsDir, one));
    expect(rollouts.length).toBeGreaterThan(0);
    expect(rollouts.some((file) => readFileSync(file, 'utf8').includes(nonceA))).toBe(true);
  }, 200_000);
});

/**
 * **声明与夹具互钉**：这一段不判厂商，只判「我们写下的那几格」与上一条用例量到的事实一致。
 *
 * 三条口径：
 *   · 夹具**证得出**续接 ⇒ 声明必须写 `yes`（写成 `no` / `off-by-adapter` 都是把事实说小）；
 *   · **两档的证据强度不同，声明也照实分开**：`'idle'` 档走真路径（`probes/inject-idle-live.test.ts`
 *     量到「那句话进了厂商出站请求体、那一轮跑完、答复成为本行 finalText」）⇒ `yes` + `real-path`；
 *     `'round'` 档只有 wire 形状与假件（steer 落在哪一次模型往返之前没验）⇒ 仍 `unverified`。
 *     把 `'round'` 也写成 `yes` 必须同时给出它的真机读数，否则界面会说「能投」而消息静默消失；
 *   · 撤回按档分开：在途那一档 `none`（没有按身份收回的面）、耐久队列那一档 `by-id`
 *     （`thread/queue/delete` 按 `queuedSubmissionId`）——两档的判据都写在 `reason` 里。
 */
describe('turnInjection 声明与夹具互钉（codex）', () => {
  it('续接那一格：夹具证得出 ⇒ 声明写 yes，通道 wire，无版本门', async () => {
    const { resumed, nonceA } = await scenario();
    // 声明写 `yes` 的**前提**：上面那两条判据真的成立（读同一份读数，不另起一次运行）
    expect(resumed.requests.map((one) => one.method), '夹具没证出续接 ⇒ 这一格不许写 yes').toContain('thread/resume');
    expect(hasNonce(resumed.outboundBodies, nonceA)).toBe(true);
    const resume = codexProvider.metadata.turnInjection?.resume;
    expect(resume).toBeDefined();
    expect(resume?.state).toBe('yes');
    expect(resume?.reason).toBeNull();
    expect(resume?.channel).toBe('wire');
    expect(resume?.gate).toBeNull();
    expect(resume?.experimental).toBe(false);
    // 证据档位：驱动器 `testing/codex-resume-fixture.ts` 走真二进制 → 真 app-server（脚本式上游）
    expect(resume?.proofDriver).toBe('real-path');
    expect(resume?.proofDriverReason).toBeNull();
  }, 200_000);

  it('投递两档：`round` 未验 ⇒ `unverified`（假件）；`idle` 有真路径读数 ⇒ `yes`（真机）', () => {
    const delivery = codexProvider.metadata.turnInjection?.delivery;
    // `'round'`：`expectedTurnId` 自 0.156.1 起必填（本机那一版的生成物里它在 `required` 里）
    expect(delivery?.round).toMatchObject({
      state: 'unverified',
      reason: 'unverified',
      channel: 'wire',
      gate: { version: '0.156.1' },
      experimental: false,
      // 真机读数只证到 wire 上存在 `turn/steer`，我们这条投递路径没被验过 ⇒ 证据来自假 wire 夹具
      proofDriver: 'synthetic-fixture',
    });
    expect(delivery?.round.proofDriverReason ?? '').toContain('真机');
    /**
     * `'idle'`：**真路径**读数（`probes/inject-idle-live.test.ts`：真二进制 + 脚本式上游，
     * 哨兵文本进了厂商出站请求体、厂商投递起的那一轮跑完、它的答复成为本行 `finalText`）。
     * 契约对 `state: 'yes'` 的三条硬要求一并钉住：`reason` 为 null、`channel` 非空、
     * `proofDriver` 是 `real-path`（假件档必须给出原因，`yes` 拿假件是不允许的组合）。
     */
    expect(delivery?.idle).toMatchObject({
      state: 'yes',
      reason: null,
      channel: 'wire',
      gate: null,
      // `thread/queue/*` 逐方法带 `#[experimental(...)]` ⇒ 这一格是真
      experimental: true,
      proofDriver: 'real-path',
      proofDriverReason: null,
    });
    // `'round'` 那一族（`turn/steer` / `turn/interrupt` / `thread/resume`）在非实验面上就有
    expect(delivery?.round.experimental).toBe(false);
  });

  it('撤回按档分开：在途 `none`、耐久队列 `by-id`，两档的判据都写在 reason 里', () => {
    const retract = codexProvider.metadata.turnInjection?.retract;
    expect(retract?.round.state).toBe('none');
    expect(retract?.round.reason).toContain('turn/steer');
    expect(retract?.idle.state).toBe('by-id');
    // 判据要能让界面说出「撤回可能撤掉哪一条」：按厂商的提交 id，并且说清删不到时靠什么分清
    expect(retract?.idle.reason).toContain('queuedSubmissionId');
    expect(retract?.idle.reason).toContain('thread/queue/list');
  });
});
