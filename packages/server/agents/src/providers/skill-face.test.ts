// @vitest-environment node
/**
 * 三家的**技能面（L3）**采集接缝：厂商说了什么 → `vendor-system.skills` 那一格。
 *
 * 为什么这三条守卫必须落在适配器这一层：
 *   · **claude 的采集只能发生在流循环里**：`TurnStart.finalize` 是**同步**的（`turn.ts` 在
 *     `finally` 里调一次、不 await），而 `getContextUsage()` 是异步控制请求 ⇒ 写在 `finalize` 里
 *     要么拿不到值、要么把一个 promise 当成结果交出去。判据是「事件里真的有那一格」，
 *     而不是「代码里调了那个方法」；
 *   · **codex 的采集要走既有连接**（`skills/list` 是 app-server 的请求，不是通知）：写成通知
 *     那一套（`readNotification` 分支）在单测里绿、真机上永远收不到东西；
 *   · **dsh 的目录必须显式分流**：`user/message` 不认的形状走 `unknown(raw)` 兜底 ⇒
 *     一条几十 KB 的原始 JSON 日志，而「技能面采到了没有」这个事实一个字都不在。
 *     真机控制臂证明：按「正文里有没有 `<available_skills>` 这个词」判会得到纯噪声。
 *
 * 采不到的处置三家一致：**只落一条点名的 WARN**（判据降级成 `unverified`），
 * 绝不改本次运行的结论、也绝不写一个 `[]` 冒充「厂商说没有」。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { setAgentRuntimeForTesting } from '../runtime';
import { createFakeClaudeSdk, createFakeDshSdk, createRecorder, createRunInput } from '../testing/agent-fixtures';
import { removeTreeWithRetry } from '../testing/cleanup';
import { CLAUDE_PACKAGE_NAME } from './cc/sdk';
import { DSH_PACKAGE_NAME } from './dsh/sdk';
import { claudeCodeProvider } from './cc';
import { dshProvider } from './dsh';

let tempRoot: string;
let configHome: string;
let cwd: string;
let sourceDir: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'aieval-skill-face-'));
  configHome = join(tempRoot, 'candidates', 'row-1', '.agenthome');
  cwd = join(tempRoot, 'workspace');
  sourceDir = join(tempRoot, 'skills', 'alpha');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: alpha\ndescription: 示例\n---\n\n正文\n', 'utf8');
});

afterEach(() => {
  setAgentRuntimeForTesting(null);
  removeTreeWithRetry(tempRoot);
});

/** 只留带技能面的 `vendor-system` 事件（判别联合的窄化辅助：断言里直接读 `skills` 才过得了类型） */
function vendorEvents(events: readonly AgentEvent[]): Extract<AgentEvent, { type: 'vendor-system' }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: 'vendor-system' }> => event.type === 'vendor-system');
}

/** 一条最小可用的 `system/init`（会话已建的判据） */
const INIT = {
  type: 'system',
  subtype: 'init',
  uuid: 'init-1',
  session_id: 'session-1',
  tools: ['Task', 'Bash', 'Skill'],
  slash_commands: [],
  agents: [],
  mcp_servers: [],
  permissionMode: 'bypassPermissions',
  output_style: 'default',
};

/** 厂商真实返回的那一格（形状取自真机 dump，只留本仓消费的字段） */
function contextUsage(skills: { name: string; source: string }[]): unknown {
  return {
    categories: [],
    totalTokens: 100,
    maxTokens: 200_000,
    skills: { totalSkills: skills.length, includedSkills: skills.length, tokens: 42, skillFrontmatter: skills },
  };
}

describe('claude：技能面来自 getContextUsage（流循环里采一次、收尾同步交出）', () => {
  it('采到 ⇒ 收尾那条 vendor-system 带上那一格（名字 / 厂商原值 / 归一后的来源分档）', async () => {
    const events: AgentEvent[] = [];
    const calls = { count: 0 };
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder: createRecorder(),
          events: [INIT, { type: 'result', subtype: 'success', uuid: 'r-1', result: 'ok' }],
          contextUsage: contextUsage([
            { name: 'alpha', source: 'userSettings' },
            { name: 'repo-owned', source: 'projectSettings' },
            { name: 'dataviz', source: 'built-in' },
          ]),
          contextUsageCalls: calls,
        }),
      },
    });

    const result = await claudeCodeProvider.run(
      createRunInput({ cwd, configHome, skills: [{ name: 'alpha', sourceDir }], onEvent: (event) => events.push(event) }),
    );

    expect(result.ok).toBe(true);
    // 只有收尾那一条带技能面（`init` 那条早于采集，带的是 `null`）
    const withSkills = vendorEvents(events).filter((event) => (event.skills ?? null) !== null);
    expect(withSkills).toHaveLength(1);
    expect(withSkills[0]?.skills).toEqual([
      // 装在候选配置目录里 ⇒ 本机启用项；来源原值照抄
      { name: 'alpha', source: 'userSettings', path: null, origin: 'local-enabled' },
      // 被测仓库自带的（真机原值 `projectSettings`）⇒ 那句安全提示的计数就是它
      { name: 'repo-owned', source: 'projectSettings', path: null, origin: 'repo-provided' },
      { name: 'dataviz', source: 'built-in', path: null, origin: 'vendor-builtin' },
    ]);
    // **整份**厂商标称事实：六格与 init 那条逐字相同（消费方取最后一条读，缺格就等于抹掉）
    expect(withSkills[0]?.tools).toEqual(['Task', 'Bash', 'Skill']);
    expect(withSkills[0]?.mcpChannel).toBe('vendor-status');
    // 一行只采一次（控制请求有成本）
    expect(calls.count).toBe(1);
  });

  it('采不到（控制请求失败）⇒ 没有那一格的事件，只落一条点名的 WARN，行照常成功', async () => {
    const events: AgentEvent[] = [];
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder: createRecorder(),
          events: [INIT, { type: 'result', subtype: 'success', uuid: 'r-1', result: 'ok' }],
          contextUsage: 'reject',
        }),
      },
    });

    const result = await claudeCodeProvider.run(
      createRunInput({ cwd, configHome, skills: [{ name: 'alpha', sourceDir }], onEvent: (event) => events.push(event) }),
    );

    expect(result.ok).toBe(true);
    // `init` 那条照旧在（它是会话已建的证据），但**没有一条带技能面**
    /**
     * 判据是**键在不在**，不是「值是不是 `null`」：`null` 在这一格上的读数是
     * 「厂商投送了、清单是空的」，与我们没采到是两句相反的话（`?? null` 能通过 `!= null` 那种写法）。
     */
    expect(vendorEvents(events).every((event) => !('skills' in event))).toBe(true);
    const warn = events.find((event) => event.type === 'log' && event.text.includes('采不到 claude 的技能面'));
    expect(warn, '采不到必须留下自己的痕迹（否则读侧只能读成「厂商没投送」）').toBeDefined();
  });

  /**
   * 三态里的另外两态（采到了才有资格说话）：`[]` = 「厂商投送了、确实一条都没有」，
   * 非空 = 逐条清单。它与上面那条合起来才是完整判据——只有「采不到」那一半的话，
   * 把采到的清单也一并丢掉照样绿。
   */
  it('采到空清单 ⇒ 那一格是 `[]`（在场且为空，不是「没采到」）', async () => {
    const events: AgentEvent[] = [];
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder: createRecorder(),
          events: [INIT, { type: 'result', subtype: 'success', uuid: 'r-1', result: 'ok' }],
          contextUsage: contextUsage([]),
        }),
      },
    });

    await claudeCodeProvider.run(
      createRunInput({ cwd, configHome, skills: [{ name: 'alpha', sourceDir }], onEvent: (event) => events.push(event) }),
    );

    const carrying = vendorEvents(events).filter((event) => 'skills' in event);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.skills).toEqual([]);
  });

  it('候选没装技能（`skills` 缺席）⇒ 一次都不采（评分与用例同步两处不该付这个钱）', async () => {
    const calls = { count: 0 };
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder: createRecorder(),
          events: [INIT],
          contextUsage: contextUsage([{ name: 'alpha', source: 'userSettings' }]),
          contextUsageCalls: calls,
        }),
      },
    });

    await claudeCodeProvider.run(createRunInput({ cwd, configHome }));

    expect(calls.count).toBe(0);
  });
});

/** dsh 的 `user/message`（技能目录）真机形状：正文在 `data.content[].text` 里 */
function catalogNotification(names: readonly string[]): unknown {
  const lines = names.map((name) => `- \`${name}\`: probe skill ${name}`).join('\n');
  return {
    method: 'session.event',
    params: {
      // **不写 sessionId**：夹具把占位/缺省的那些改写成本次 run 的会话 id，而写死另一个 id
      // 会被适配器的会话放行规则挡掉（那不是适配器的缺陷，是夹具在这一点上不保真）
      event: {
        type: 'user/message',
        data: {
          source: { kind: 'skill-catalog' },
          content: [
            {
              type: 'text',
              text: `<system-reminder>\nThe following skills are available in this session:\n\n<available_skills>\n${lines}\n</available_skills>\n</system-reminder>`,
            },
          ],
        },
      },
    },
  };
}

describe('dsh：技能目录（user/message + skill-catalog）显式分流', () => {
  it('目录消息 ⇒ 一条带技能面的 vendor-system（工具表那一格一起带上）', async () => {
    const events: AgentEvent[] = [];
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder: createRecorder(),
          events: [
            catalogNotification(['alpha', 'builtin-skill']),
            {
              method: 'session.event',
              params: {
                event: { type: 'request/header', data: { header: { tools: [{ name: 'skill' }, { name: 'Bash' }] } } },
              },
            },
          ],
        }),
      },
    });

    await dshProvider.run(createRunInput({ cwd, configHome, skills: [{ name: 'alpha', sourceDir }], onEvent: (event) => events.push(event) }));

    const vendor = vendorEvents(events);
    expect(vendor.length).toBeGreaterThanOrEqual(1);
    // 最后一条必须自足：技能面 + 工具表都在（消费方取最后一条读）
    const last = vendor[vendor.length - 1];
    expect(last?.skills).toEqual([
      // 这一家的目录**只有名字** ⇒ 来源未证实（不许猜）
      { name: 'alpha', source: null, path: null, origin: 'unverified' },
      { name: 'builtin-skill', source: null, path: null, origin: 'unverified' },
    ]);
    expect(last?.tools).toEqual(['skill', 'Bash']);
    // **不落原始 JSON**：目录那条几十 KB 的负载一个字符都不该进「原始输出」
    expect(events.some((event) => event.type === 'log' && event.text.includes('skill-catalog'))).toBe(false);
  });

  /**
   * 目录**还没到**时先来的那一拍（真机顺序上工具表常先到）：这一条**不带** `skills` 那一格。
   * 写 `null` 会被读侧读成「厂商投送了、清单是空的」——而那时我们一个字都没读到，
   * 且消费方**取最后一条**读：真要是写了 `null`，它就会盖掉随后采到的那一份。
   */
  it('工具表先到、目录还没到 ⇒ 那一拍不带技能格（`null` 会冒充「厂商投送了空清单」）', async () => {
    const events: AgentEvent[] = [];
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder: createRecorder(),
          events: [
            {
              method: 'session.event',
              params: {
                event: { type: 'request/header', data: { header: { tools: [{ name: 'skill' }, { name: 'Bash' }] } } },
              },
            },
          ],
        }),
      },
    });

    await dshProvider.run(createRunInput({ cwd, configHome, skills: [{ name: 'alpha', sourceDir }], onEvent: (event) => events.push(event) }));

    const vendor = vendorEvents(events);
    expect(vendor).toHaveLength(1);
    expect(vendor[0]?.tools).toEqual(['skill', 'Bash']);
    expect('skills' in (vendor[0] ?? {})).toBe(false);
  });

  it('认不出的 `user/message` 照旧落原始 JSON（分流不是「静默丢掉不认识的消息」）', async () => {
    const events: AgentEvent[] = [];
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder: createRecorder(),
          events: [
            {
              method: 'session.event',
              params: {
                event: { type: 'user/message', data: { source: { kind: 'user-input' }, content: [{ type: 'text', text: '你好' }] } },
              },
            },
          ],
        }),
      },
    });

    await dshProvider.run(createRunInput({ cwd, configHome, skills: [{ name: 'alpha', sourceDir }], onEvent: (event) => events.push(event) }));

    expect(events.some((event) => event.type === 'log' && event.text.includes('user-input'))).toBe(true);
    expect(vendorEvents(events)).toHaveLength(0);
  });
});
