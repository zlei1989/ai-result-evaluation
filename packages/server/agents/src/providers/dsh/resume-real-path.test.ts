// @vitest-environment node
/**
 * dsh 续接的**真路径**判据：真运行时 + 脚本式上游，跨**三个独立运行**（写 / adopt / 阴性对照）。
 *
 * 为什么必须落在这里（而不是假 SDK 那一档）：`session/resume` 是厂商 wire 上的能力，假件把 SDK
 * 换掉之后「这一版认不认得这个名字」「adopt 之后历史有没有真的带回来」两件事都无从观察——
 * 而能力声明里写 `state: 'yes'` 就要求证据是**真路径**（契约层的硬规则，见
 * `packages/server/contracts/src/agent-message.ts` 的 `TurnInjectionCellSchema`）。
 *
 * 三条判据缺一不可：
 *   ① adopt 那一轮的身份与第一轮**同值**（续接落在同一条会话上）；
 *   ② 第一轮的暗号出现在第二轮的**入站请求体**里（前一轮的历史真的进了模型上下文）；
 *   ③ 阴性对照（同 `DSH_HOME`、同 cwd、**不** resume）里暗号**一次都不出现**
 *      —— 少了它，「请求体里有暗号」可能只是工作区或别处的泄漏。
 */
import { describe, expect, it } from 'vitest';
import { runDshRealPathResume } from '../../testing/dsh-real-path-fixture';

/** 随机暗号：写死一个常见词会被「模型猜中」或工作区内容污染判据 */
const NONCE = 'aieval-resume-nonce-4d7c19b2';

const run = await runDshRealPathResume(NONCE);

describe('续接真路径（dsh）', () => {
  it('adopt 落在同一条会话上：身份与第一轮同值', () => {
    expect(run.sessionId, '第一轮没铸出会话 id').not.toBeNull();
    expect(run.resumedSessionId, 'adopt 那一轮的身份与第一轮不同 ⇒ 续接没落到同一条上').toBe(run.sessionId);
    expect(run.controlSessionId, '阴性对照与第一轮撞了同一个 id').not.toBe(run.sessionId);
  });

  it('adopt 之后第一轮的历史真的进了模型上下文（读入站请求体）', () => {
    expect(run.resumeRequests, 'adopt 那一轮一条请求都没发出去').toBeGreaterThan(0);
    expect(
      run.nonceInResumeRequests,
      '第一轮的暗号没出现在第二轮的请求体里 ⇒ 前一轮的历史没被带回来',
    ).toBeGreaterThan(0);
  });

  it('阴性对照：不 resume 的那一轮里暗号一次都不出现', () => {
    expect(
      run.nonceInControlRequests,
      '不 resume 也看到了暗号 ⇒ 判据可能被工作区或别处的泄漏污染（这一格会假绿）',
    ).toBe(0);
  });
});
