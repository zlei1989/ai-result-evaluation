// @vitest-environment node
/**
 * **真进程组**守卫：直接子进程先死时，整棵回收仍然要把同组的孙进程带走。
 *
 * 要拦的缺陷：`terminateProcessTree` 曾把「直接子进程已退出」当成「树已经回收干净」而整条短路
 * （`if (hasExited(child)) return { via: 'direct', … }`）——`kill(-pid)` 根本不发，而同进程组的
 * 孙进程原样存活。真机读数（真进程组 + `pgrep -g`）：组长先 `SIGKILL` 再调产品函数 ⇒
 * `{via:'direct', exited:true, waitedMs:0}` 而组内 **2 个成员仍活**；对照臂（组长活着）⇒
 * `via:'tree'`、组内清零；事后手工 `kill(-pid)` 也能清零 ⇒ 原因唯一地是那条短路。
 *
 * 为什么这条必须用**真进程组**：命令序列可以用假件钉（`process-tree.test.ts` 已经在钉），
 * 但「组长没了组还在不在」「`kill(-pid)` 还灵不灵」是**内核语义**，假件回放的是我们自己写进去的
 * 假设。codex 那条 `codex → git → git → git-remote-https` 的插件同步链正是组长先死的形状
 * （`features.plugins` 的 startup sync，见《Codex 接入》的已知边界）。
 *
 * 两臂唯一自变量是**组长死没死**，其余逐字相同；判据是「调完之后组内还剩几个成员」。
 */
import { execFileSync, spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { terminateProcessTree, type ProcessTreeChild } from './process-tree';

/** 组内成员（含组长）。`[]` = 组已清空；`null` = **采不到**（不许把采不到读成「清空了」） */
function groupMembers(pgid: number): number[] | null {
  try {
    const text = execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' });
    return text.split('\n').map((one) => Number(one.trim())).filter((one) => Number.isFinite(one) && one > 0);
  } catch (error) {
    // `pgrep` 无匹配时退出码 1 —— 那是「一个都没有」这条读数；其它情况（没装 / 被沙箱禁）是采不到
    return (error as { status?: number }).status === 1 ? [] : null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 起一个自成进程组的组长，组内再挂两个成员（`sleep 120` 不会自己退出，读数窗口内稳定） */
function startGroup(): { leader: ReturnType<typeof spawn>; pgid: number } {
  const leader = spawn('/bin/sh', ['-c', 'sleep 120 & sleep 120 & wait'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return { leader, pgid: leader.pid ?? 0 };
}

describe.skipIf(process.platform === 'win32')('真机：组长先死时的整树回收（POSIX 进程组）', () => {
  it('组长先 SIGKILL ⇒ 同组孙进程也必须被清掉（对照臂：组长活着时本来就清零）', async () => {
    const readings: Array<{ arm: string; before: number[] | null; outcome: unknown; aliveAfter: number | null }> = [];

    for (const arm of ['E1-leader-prekilled', 'E2-leader-alive'] as const) {
      const { leader, pgid } = startGroup();
      // 等组内成员真的起来；采不到就跳过（不把「没有观测手段」读成「清空了」）
      let before = groupMembers(pgid);
      const deadline = Date.now() + 10_000;
      while ((before?.length ?? 0) < 2 && Date.now() < deadline) {
        await sleep(50);
        before = groupMembers(pgid);
      }
      if (before === null || before.length < 2) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          /* 已经没了 */
        }
        return; // 这台机器上 `pgrep -g` 不可用 ⇒ 本条无判据可言
      }

      if (arm === 'E1-leader-prekilled') {
        leader.kill('SIGKILL');
        // 等组长真的死透：`hasExited` 读的就是这两格，不落定就测不到那条短路
        const exitDeadline = Date.now() + 5_000;
        while (Date.now() < exitDeadline && leader.exitCode === null && leader.signalCode === null) await sleep(20);
      }

      const outcome = await terminateProcessTree(leader as unknown as ProcessTreeChild, { graceMs: 1_000 });
      await sleep(200);
      readings.push({ arm, before, outcome, aliveAfter: groupMembers(pgid)?.length ?? null });

      // 收尾：无论哪一臂都把组清干净，别给下一条用例留孤儿
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* 已经没了 */
      }
      await sleep(100);
    }

    const control = readings.find((one) => one.arm === 'E2-leader-alive');
    const subject = readings.find((one) => one.arm === 'E1-leader-prekilled');
    // 对照臂先立判据：组长活着时本来就清零 ⇒ 证明这套读数有效
    expect(control?.aliveAfter, '对照臂（组长活着）必须清零').toBe(0);
    // 被测臂：组长先死也必须清零（红 = 孙进程泄漏）
    expect(subject?.aliveAfter, '组长先死时同组孙进程必须被清掉').toBe(0);
    // 已退出那一档不该凭空记一条 `error`（组与 pid 都没了 = 回收想要的结果，不是失败）
    expect((subject?.outcome as { error?: string | null } | undefined)?.error ?? null, '回收干净就不该有 error').toBeNull();
  }, 120_000);
});
