// @vitest-environment node
/**
 * pi 的**跨进程续接**：能力声明（`metadata.turnInjection.resume`）与它的证据面在**同一个文件**里。
 *
 * 三段判据，逐段回答一个不同的问题：
 *  1. **机制**：续接那一轮的出站请求体里有没有上一轮的暗号（厂商把会话文件投影成了模型上下文）；
 *  2. **端到端**：脚本式上游按请求体作答 ⇒ 答复里有暗号；
 *  3. **两半的对照**：不传 `resume` 的阴性对照答不出、另一条候选目录只认得自己的暗号。
 *
 * 为什么这三段必须同时在：只判 ①（请求体）证明不了上下文走到了模型面前；只判 ②（答复）
 * 在真机上会抖（探针见过「投影里有暗号、模型仍答『不知道』」）——两条并行才分得清
 * 「没接」「接坏了」「上游没按规则答」。
 *
 * 最后一段是**声明与夹具互钉**：把这一格改成 `no` / 删掉夹具，都会在同一个文件里当场见红
 * （声明不许先于夹具，夹具也不许先于声明——两者同一次提交进来）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runPiResumeScenario } from '../../testing/pi-session-fixture';
import { piProvider, piSessionDir } from './index';

/** 一次场景跑得很贵（真包 + 五次完整运行），故整组共用一个读数 */
let scenarioPromise: ReturnType<typeof runPiResumeScenario> | null = null;
function scenario(): ReturnType<typeof runPiResumeScenario> {
  scenarioPromise ??= runPiResumeScenario();
  return scenarioPromise;
}

describe('pi 的跨进程续接（真包 + 脚本式上游，暗号回读）', () => {
  it('会话落在候选配置目录里那条 `.jsonl` 上，且落的是**路径**（结果那一格就是下次要打开的键）', async () => {
    const { first, candidateOne } = await scenario();
    expect(first.sessionFile).not.toBeNull();
    const sessionFile = first.sessionFile ?? '';
    expect(sessionFile.startsWith(piSessionDir(candidateOne.configHome))).toBe(true);
    expect(sessionFile.endsWith('.jsonl')).toBe(true);
    // 盘上真的有它（`result.sessionId` 不是编出来的字符串）
    expect(existsSync(sessionFile)).toBe(true);
    // 它就在会话落点里（那一格里还有别的会话：阴性对照自己也新开了一条）
    expect(readdirSync(piSessionDir(candidateOne.configHome))).toContain(
      sessionFile.slice(piSessionDir(candidateOne.configHome).length + 1),
    );
  });

  it('① 机制 + ② 端到端：续接那一轮把上一轮的暗号带回来了（请求体里在、答复里也在）', async () => {
    const { resumed, first, nonceA } = await scenario();
    // 机制：厂商自己把会话文件投影成了模型上下文
    expect(resumed.requestHasNonce).toBe(true);
    // 端到端：脚本式上游照请求体作答 ⇒ 暗号真的走到了模型面前
    expect(resumed.reply).toContain(nonceA);
    // 续接写在**同一条**会话文件上（追加，不是另起一条）
    expect(resumed.sessionFile).toBe(first.sessionFile);
  });

  it('③ 阴性对照：同一条候选目录、只是不传 resume ⇒ 一个暗号都带不回来', async () => {
    const { control, nonceA, nonceB } = await scenario();
    expect(control.requestHasNonce).toBe(false);
    expect(control.reply).not.toContain(nonceA);
    expect(control.reply).not.toContain(nonceB);
    // 阴性对照是**另一条**会话（新开的那条落在自己的文件上）
    expect(control.sessionFile).not.toBeNull();
  });

  it('④ 按行隔离：只换会话落点（cwd 刻意相同）⇒ 另一行只答得出自己的暗号', async () => {
    const { otherCandidateResumed, candidateOne, candidateTwo, nonceA, nonceB } = await scenario();
    // 自变量真的只有「会话落点」这一格
    expect(candidateTwo.cwd).toBe(candidateOne.cwd);
    expect(piSessionDir(candidateTwo.configHome)).not.toBe(piSessionDir(candidateOne.configHome));
    expect(otherCandidateResumed.requestHasNonce).toBe(true);
    expect(otherCandidateResumed.reply).toContain(nonceB);
    // 越界回读：candidate2 的会话里不该有 candidate1 的暗号
    expect(otherCandidateResumed.reply).not.toContain(nonceA);
  }, 60_000);
});

/**
 * **声明与夹具互钉**：这一段不判厂商，只判「我们写下的那一格」与「上一条用例量到的事实」一致。
 *
 * 三条口径：
 *   · 夹具**证得出**续接 ⇒ 声明必须写 `yes`（写成 `no` / `off-by-adapter` 都是把事实说小）；
 *   · 通道写 `in-process-sdk`：续接走的是进程内 SDK 的 `SessionManager.open`，不是 wire、也不是插件；
 *   · 投递两档写 `off-by-adapter`：窄壳声明了 `steer` / `followUp`（声明面），但适配器今天
 *     **一格都不挂**（事实面，见 `index.test.ts` 那条「端口挂着也不投」）——把这两档改成 `yes`
 *     就必须同时给出投递面的正面夹具，否则界面会说「能投」而消息静默消失。
 */
describe('turnInjection 声明与夹具互钉', () => {
  it('续接那一格：夹具证得出 ⇒ 声明写 yes，通道写进程内 SDK，无版本门', async () => {
    const { resumed, nonceA } = await scenario();
    // 声明写 `yes` 的**前提**：上面那两条判据真的成立（读同一份读数，不另起一次运行）
    expect(resumed.requestHasNonce, '夹具没证出续接 ⇒ 这一格不许写 yes').toBe(true);
    expect(resumed.reply).toContain(nonceA);
    const resume = piProvider.metadata.turnInjection?.resume;
    expect(resume).toBeDefined();
    expect(resume?.state).toBe('yes');
    expect(resume?.reason).toBeNull();
    expect(resume?.channel).toBe('in-process-sdk');
    expect(resume?.gate).toBeNull();
    expect(resume?.experimental).toBe(false);
    // 证据档位：真包 + 脚本式上游（假网关只扮演上游模型）⇒ 这一格是拿真路径证出来的
    expect(resume?.proofDriver).toBe('real-path');
    expect(resume?.proofDriverReason).toBeNull();
  });

  it('投递两档：窄壳有落点、适配器还没接 ⇒ 声明写 off-by-adapter + not-observed', () => {
    const delivery = piProvider.metadata.turnInjection?.delivery;
    for (const boundary of ['round', 'idle'] as const) {
      expect(delivery?.[boundary].state, boundary).toBe('off-by-adapter');
      expect(delivery?.[boundary].reason, boundary).toBe('not-observed');
      expect(delivery?.[boundary].channel, boundary).toBe('in-process-sdk');
      expect(delivery?.[boundary].gate, boundary).toBeNull();
      expect(delivery?.[boundary].experimental, boundary).toBe(false);
      // 适配器一格端口都没挂 ⇒ 这一格的证据来自假 SDK 夹具（临时档，理由必须能被读到）
      expect(delivery?.[boundary].proofDriver, boundary).toBe('synthetic-fixture');
      expect(delivery?.[boundary].proofDriverReason ?? '', boundary).toContain('真机');
    }
  });

  it('撤回两档：只有整条清空（`clearQueue()`，两档一起清）⇒ flush-only 且判据写在 reason 里', () => {
    const retract = piProvider.metadata.turnInjection?.retract;
    for (const boundary of ['round', 'idle'] as const) {
      expect(retract?.[boundary].state, boundary).toBe('flush-only');
      expect(retract?.[boundary].reason, boundary).toContain('清空');
    }
  });
});
