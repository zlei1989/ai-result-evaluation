// @vitest-environment node
/**
 * dsh **会话日志落点**的真机判据：`dshProjectKeyOf` 算出的目录名必须**逐字等于磁盘上那个**。
 *
 * 为什么非真机不可：这一格是「我们按厂商规则推路径」，而规则的每一档（`~XXXX` 转义、分隔符折叠、
 * 251 截断、`resolve` 归一化）都只有厂商的**落盘行为**能证。纯函数守卫的期望值再准也是我们抄的，
 * 抄错一次就永远是绿的——`session-log.test.ts` 的夹具因此另抄了一份厂商规则做对照，而这里更直接：
 * **判据读的是厂商写出来的目录名本身**。
 *
 * 两档 cwd 各跑一次真机运行：
 *   · 含空格、汉字与 emoji——三个都落在「不安全码元」那一档，emoji 还额外压住「按 UTF-16 码元
 *     迭代而不是按码点」（代理对的两半各自转义）；
 *   · 可读部分超过 251 个字符——只有厂商的截断规则对得上。
 * 同一轮里再拿**带尾随斜杠**的 cwd 调一次 `countSessionSteps`：厂商落盘用的是 `resolve()` 之后的
 * 路径（SDK 与 jsonrpc-server 各 resolve 一次），这一格少了就恒定位不到日志。
 */
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { createRunInput, collectEvents } from '../../testing/agent-fixtures';
import { startDshScriptedUpstream } from '../../testing/dsh-real-path-fixture';
import { setAgentRuntimeForTesting } from '../../runtime';
import { dshProvider } from './index';
import { countSessionSteps, dshProjectKeyOf } from './session-log';

/** 含空格、汉字与 emoji：三个都在「不安全码元走 `~XXXX`」那一档 */
const AWKWARD_LEAF = '工作 区 😀';
/** 可读部分远超 251：只有厂商的截断规则对得上 */
const LONG_LEAF = join('a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80), '工作 区');

interface DiskObservation {
  /** `<DSH_HOME>/sessions/` 下的项目目录名（**厂商写出来的那一份**） */
  diskDirs: string[];
  /** 我们按厂商规则推出来的目录名 */
  ours: string;
  /** 每一档 cwd 写法各调一次 `countSessionSteps` 的读数（键是 cwd 的写法） */
  counts: Array<{ cwd: string; value: number | null }>;
  /** 磁盘上真实存在的会话 id */
  sessionIds: string[];
}

/** 跑一次真机运行，回读磁盘上厂商写出来的 projectKey 目录名 */
async function runAndReadDiskDir(leaf: string): Promise<DiskObservation> {
  const root = mkdtempSync(join(tmpdir(), 'aieval-dsh-log-path-'));
  const cwd = join(root, leaf);
  const configHome = join(root, '.dshhome');
  mkdirSync(cwd, { recursive: true });
  // 工具名给一个永远不会出现在工具表里的字面量 ⇒ 每一轮都回纯文本（这一档不关心工具）
  const upstream = await startDshScriptedUpstream({
    callId: 'call_log_path_unused',
    toolName: 'aieval-log-path-never-matches',
    args: {},
    finalText: '好。',
  });
  setAgentRuntimeForTesting(null);
  try {
    const events: AgentEvent[] = [];
    await dshProvider.run({
      ...createRunInput({
        cwd,
        configHome,
        permission: 'full',
        prompt: '回一句话就好。',
        route: {
          protocolType: 'anthropic',
          baseUrl: upstream.url,
          apiKey: 'probe-placeholder',
          modelId: 'probe-model',
        },
        onEvent: collectEvents(events),
      }),
    });
    const sessionsRoot = join(configHome, 'sessions');
    const diskDirs = readdirSync(sessionsRoot);
    const sessionIds = diskDirs.flatMap((dir) => readdirSync(join(sessionsRoot, dir)));
    // 原样 / 规范化 / 带尾随斜杠：三种写法厂商都当同一条（它自己 resolve 过）
    const counts = [cwd, resolve(cwd), `${cwd}/`].map((written) => ({
      cwd: written,
      value: sessionIds.length === 0 ? null : countSessionSteps({ configHome, cwd: written, sessionId: sessionIds[0]! }),
    }));
    return { diskDirs, ours: dshProjectKeyOf(resolve(cwd)), counts, sessionIds };
  } finally {
    upstream.close();
    setAgentRuntimeForTesting(null);
    removeTreeWithRetry(root);
  }
}

let awkward: DiskObservation;
let long: DiskObservation;

beforeAll(async () => {
  awkward = await runAndReadDiskDir(AWKWARD_LEAF);
  long = await runAndReadDiskDir(LONG_LEAF);
});

afterAll(() => {
  setAgentRuntimeForTesting(null);
});

describe('dsh 会话日志落点（真机）', () => {
  it('cwd 含空格 / 汉字 / emoji：磁盘目录名与我们的推导逐字相同', () => {
    expect(awkward.diskDirs, '厂商没在 sessions/ 下落任何项目目录').not.toHaveLength(0);
    expect(awkward.diskDirs).toContain(awkward.ours);
  });

  it('可读部分超过 251 个字符：截断规则也对得上', () => {
    expect(long.diskDirs).toContain(long.ours);
  });

  it('三种 cwd 写法（原样 / 规范化 / 尾随斜杠）都定位得到同一条会话', () => {
    expect(awkward.sessionIds, '这一次运行没落会话目录').not.toHaveLength(0);
    for (const { cwd, value } of awkward.counts) {
      // 定位不到就是 `null`（播种静默失效、续接段号从 1 重发并与上一段撞号的根源）
      expect(value, `cwd 写法 ${cwd} 定位不到日志`).toBeGreaterThan(0);
    }
  });
});
