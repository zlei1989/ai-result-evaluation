// @vitest-environment node
/**
 * 真机守卫：**适配器自己**的回收能力。
 *
 * 为什么需要它，而不是只有单测：`process-tree.test.ts` / `client.test.ts` 验的是「按 pid 走了杀树
 * 那条路」这个**调用约定**，用的是假子进程；而真机上决定成败的是三件只有真跑才知道的事——
 *   ① codex 真的会 spawn 孙进程（插件同步的 `git` 链，`core-plugins/src/startup_sync.rs`）；
 *   ② 只杀直接子进程时，`$CODEX_HOME` **真的**删不掉（EPERM，与用户界面那条报错逐字同形）；
 *   ③ 走完 `close()` 之后，孙进程**真的**没了、目录**真的**能删。
 * 这三条都在厂商二进制与 Windows 内核的行为里，假夹具答不了（本仓的铁律：测试环境 ≠ 运行环境）。
 *
 * 开关（默认跳过：要 spawn 真 codex，不进内循环与 CI）：
 * ```
 * AIEVAL_LIVE_DISPOSE=1 pnpm vitest run packages/server/agents/src/providers/codex/lifecycle-live.test.ts
 * ```
 * 不需要网关凭据：只做 initialize + thread/start，不调 turn/start（不产生模型请求）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppServerClient } from './appserver/client';
import { resolveCodexBinary } from './appserver/binary';

const ENABLED = process.env.AIEVAL_LIVE_DISPOSE === '1';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从 `rootPid` 出发的全部后代（含孙），一行一个：`pid|Name|CommandLine`。
 *
 * 为什么按「记录下来的父 pid」递归而不是按存活与否过滤：Windows 上父进程死了以后，
 * 孤儿的 `ParentProcessId` **仍然是那个已死的 pid**——正是靠这一点才能把残留的孙进程揪出来。
 */
function descendants(rootPid: number): string[] {
  const script =
    '$all = Get-CimInstance Win32_Process; $byParent = @{};' +
    'foreach ($p in $all) { $k = [string]$p.ParentProcessId;' +
    '  if ($byParent.ContainsKey($k)) { $byParent[$k] = @($byParent[$k]) + @($p) } else { $byParent[$k] = @($p) } };' +
    'function Show($root, $depth) { foreach ($c in $byParent[[string]$root]) {' +
    '  "$($c.ProcessId)|$($c.Name)|$($c.CommandLine)"; Show $c.ProcessId ($depth + 1) } };' +
    `Show ${rootPid} 0`;
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|'));
}

/** 本进程这一棵树里第一个 codex 进程的 pid（测试进程 spawn 的，故从 `process.pid` 往下找） */
function findCodexPid(): number | null {
  const found = descendants(process.pid).find((line) => line.includes('codex.exe'));
  if (found === undefined) return null;
  return Number(found.split('|')[0]);
}

describe.skipIf(!ENABLED)('真机：codex 适配器的进程树回收', () => {
  it(
    'close() 之后没有残留的厂商进程，且该行的 CODEX_HOME 可以删掉',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'aieval-live-dispose-'));
      const env = { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, RUST_LOG: 'error' };
      const client = createAppServerClient({ binary: resolveCodexBinary(), env });

      await client.initialize();
      await client.request('thread/start', {
        model: 'deepseek-flash',
        cwd: home,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      });
      // 插件同步是**异步**的：给足窗口把 `git` 链拉起来（实测 1~3s 内出现）
      await sleep(4_000);

      const codexPid = findCodexPid();
      expect(codexPid, '这一轮没有观察到 codex 子进程：守卫失去意义，先查 spawn 是否成功').not.toBeNull();
      const during = descendants(codexPid as number);
      // 反空虚断言：真机上插件同步确实会拉起孙进程；一条都没有说明这个 case 没打到要防的那条路
      // （网络被墙/被代理拦下时它照样 spawn，只是 fetch 失败——所以这条断言不依赖网络可达）
      expect(
        during.some((line) => /git/i.test(line)),
        `没有观察到 git 孙进程，这一轮覆盖不到「孙进程持锁」那条路：\n${during.join('\n')}`,
      ).toBe(true);

      await client.close();
      await sleep(500);

      const survivors = descendants(codexPid as number).filter((line) => /codex|git/i.test(line));
      expect(survivors, `close() 之后仍有残留进程：\n${survivors.join('\n')}`).toEqual([]);

      // 产品级判据：这份目录就是下一轮 `clearRowArtifacts` 要删的那个（`.agenthome` / `.judgehome`）
      expect(() => rmSync(home, { recursive: true, force: true })).not.toThrow();
      expect(existsSync(home)).toBe(false);
    },
    120_000,
  );
});
