// @vitest-environment node
/**
 * codex 的**技能装入**接缝：`AgentRunInput.skills` → 候选配置目录里的那份副本。
 *
 * 与 claude 那份同名守卫（`providers/cc/skills.test.ts`）逐条同形，分开写是因为
 * **两家的 boot 点不是同一个符号**：这一家的时序判据挂在 `hooks.createClient(...)` 那一行
 * （真正的 `spawn` 在 `appserver/client.ts` 里），换家换点，合写一处反而会让「哪家钉在哪一步」变模糊。
 *
 * 三条判据都是静默失效型：
 *   · **不传 = 不装**：评分与用例同步两处不传这一格，适配器一旦「空清单也写一遍」，
 *     「只候选执行」这条口径就没了；
 *   · **落盘失败 ⇒ 带码失败**：`SkillMaterializeError` 必须归成 `AGENT_SKILLS_UNAVAILABLE`
 *     （缺省那条路会归成 `AGENT_FAILED`，而它在自动重试表里 ⇒ 装不进去会被静默重跑两遍）；
 *   · **时序**：app-server 起来的那一刻就会把 `<CODEX_HOME>/skills` 扫进清单，写晚了这一次
 *     spawn 就看不到它们，而它**不报错**（只是这个候选按「没有这条 skill」跑完）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { createFakeAppServer, threadListPages, turnCompleted } from './appserver-fixtures';
import { codexProvider, defaultCodexRuntimeHooks, type CodexRuntimeHooks } from './index';

let tempRoot: string;
let configHome: string;
let sourceDir: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'aieval-codex-skills-'));
  // 候选配置目录刻意**不预建**：契约只说「该候选独立配置目录」，没说它一定存在
  configHome = join(tempRoot, 'candidates', 'row-1', '.agenthome');
  sourceDir = join(tempRoot, 'skills', 'alpha');
  mkdirSync(join(sourceDir, 'scripts'), { recursive: true });
  writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: alpha\ndescription: 示例\n---\n\n正文\n', 'utf8');
  writeFileSync(join(sourceDir, 'scripts', 'helper.sh'), '#!/bin/sh\necho hi\n', 'utf8');
});

afterEach(() => {
  codexProvider.runtimeHooks = defaultCodexRuntimeHooks;
  removeTreeWithRetry(tempRoot);
});

/**
 * 装一次假 app-server：`createClient` 是这一家的 boot 点（真正的 `spawn` 在它下面一层），
 * `onCreate` 让用例在那一刻读盘，`onEnv` 让 L2 那组守卫拿到交出去的子进程环境。
 */
function wire(options: { onCreate?: () => void; onEnv?: (env: Record<string, string | undefined>) => void } = {}): void {
  const server = createFakeAppServer({
    notifications: [turnCompleted({ id: 'turn-1' }, { threadId: 'thread-main' })],
    // 收尾取数会枚举后代线程：不登记这一格夹具会响亮失败（本组用例不看它，登记成空表即可）
    respond: { 'thread/list': threadListPages([], 100) },
  });
  const hooks: CodexRuntimeHooks = {
    createClient: (input) => {
      options.onEnv?.(input.env);
      options.onCreate?.();
      return server.client;
    },
    resolveBinary: () => join(tempRoot, 'fake-codex'),
  };
  codexProvider.runtimeHooks = hooks;
}

describe('codex 装入技能', () => {
  it('不传 skills ⇒ 技能目录一个字节都不写（「只候选执行」由「不传」表达）', async () => {
    wire();

    await codexProvider.run(createRunInput({ configHome }));

    // 判据是技能落点本身：`skills/` 连建都不该建（建了就等于适配器在替调用方表「候选要装零条」）
    expect(existsSync(join(configHome, 'skills'))).toBe(false);
  });

  it('传了 skills ⇒ 整目录落进 <候选配置目录>/skills/<名称>，附属文件一起过去', async () => {
    wire();

    await codexProvider.run(createRunInput({ configHome, skills: [{ name: 'alpha', sourceDir }] }));

    const installed = join(configHome, 'skills', 'alpha');
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(sourceDir, 'SKILL.md'), 'utf8'));
    expect(readFileSync(join(installed, 'scripts', 'helper.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
  });

  it('物化发生在起进程之前：createClient() 那一刻文件已经在盘上', async () => {
    let seenAtSpawn: boolean | null = null;
    wire({
      onCreate: () => {
        // 装配时刻的快照点：app-server 起来之后扫的就是此刻的 skills/，写晚了这个候选白跑且不报错
        seenAtSpawn = existsSync(join(configHome, 'skills', 'alpha', 'SKILL.md'));
      },
    });

    const result = await codexProvider.run(createRunInput({ configHome, skills: [{ name: 'alpha', sourceDir }] }));

    expect(seenAtSpawn).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('源目录读不到 ⇒ 该次运行的失败、码是 AGENT_SKILLS_UNAVAILABLE、文案点名哪一条', async () => {
    wire();

    const result = await codexProvider.run(
      createRunInput({ configHome, skills: [{ name: 'ghost', sourceDir: join(tempRoot, 'skills', 'ghost') }] }),
    );

    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('error');
    expect(result.error?.code).toBe('AGENT_SKILLS_UNAVAILABLE');
    expect(result.error?.message).toContain('ghost');
  });
});

/**
 * **技能面（L3）**：`skills/list` 采到的清单要进 `vendor-system.skills` 那一格。
 *
 * 为什么落在这一层：`skills/list` 是 app-server 的**请求**（不是通知）——投影那一套
 * （`readNotification` 分支）对它无效；而收尾那条事件必须**自足**
 * （消费方取最后一条读：MCP 那一格也要一起带上，否则最后那条会把启动状态抹成「厂商没投送」）。
 * 采不到（老版本 / 响应形状不认识）时**这一条不发**、只落一条点名的 WARN；逐拍那条 MCP 事件也
 * **不带技能格**（`undefined`）：`skills: null` 在界面上的读数是「厂商投送了、清单是空的」，
 * 而那是替厂商说一句我们并不知道的话。
 */
/** 只留 `vendor-system` 事件（判别联合的窄化辅助：断言里直接读 `skills` 才过得了类型） */
function vendorEvents(events: readonly AgentEvent[]): Extract<AgentEvent, { type: 'vendor-system' }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: 'vendor-system' }> => event.type === 'vendor-system');
}

describe('codex 技能面（skills/list）', () => {
  /**
   * 厂商真实的 `skills/list` 应答（`data` 按 cwd 分组，逐条带 scope/path）。
   * 路径由**本用例的两个目录**现拼：来源分档靠路径前缀判，写死绝对路径会让「本机启用项」那一档
   * 退回原值表（判据就废了）。
   */
  function skillsResponse(workspace: string): unknown {
    return {
      data: [
        {
          cwd: workspace,
          skills: [
            { name: 'alpha', description: '示例', path: join(configHome, 'skills', 'alpha', 'SKILL.md'), scope: 'user', enabled: true, pluginId: null },
            { name: 'imagegen', description: '内置', path: join(configHome, 'skills', '.system', 'imagegen', 'SKILL.md'), scope: 'system', enabled: true, pluginId: null },
            // `enabled: false` 的不在会话可用的技能面里：把它算进「厂商认了」就是一条假绿
            { name: 'disabled-one', description: '停用', path: join(configHome, 'skills', 'disabled-one', 'SKILL.md'), scope: 'user', enabled: false, pluginId: null },
            { name: 'repo-owned', description: '仓库自带', path: join(workspace, '.codex', 'skills', 'repo-owned', 'SKILL.md'), scope: 'user', enabled: true, pluginId: null },
          ],
          errors: [],
        },
      ],
    };
  }

  function wireSkills(server: ReturnType<typeof createFakeAppServer> = createFakeAppServer({
    notifications: [turnCompleted({ id: 'turn-1' }, { threadId: 'thread-main' })],
    respond: { 'thread/list': threadListPages([], 100) },
  })): ReturnType<typeof createFakeAppServer> {
    codexProvider.runtimeHooks = {
      createClient: () => server.client,
      resolveBinary: () => join(tempRoot, 'fake-codex'),
    };
    return server;
  }

  it('采到 ⇒ 收尾那条 vendor-system 带上技能面（来源按落点与原值归一）', async () => {
    const cwd = join(tempRoot, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const server = wireSkills(
      createFakeAppServer({
        notifications: [turnCompleted({ id: 'turn-1' }, { threadId: 'thread-main' })],
        respond: { 'thread/list': threadListPages([], 100), 'skills/list': () => skillsResponse(cwd) },
      }),
    );
    const events: AgentEvent[] = [];
    await codexProvider.run(
      createRunInput({ cwd, configHome, skills: [{ name: 'alpha', sourceDir }], onEvent: (event) => events.push(event) }),
    );

    // 请求参数带上 cwd：不带的话**项目级** skill 根压根不出现在清单里（那句安全提示就永远不出现）
    expect(server.stats.requests.find((one) => one.method === 'skills/list')?.params).toEqual({ cwds: [cwd] });
    const withSkills = vendorEvents(events).filter((event) => (event.skills ?? null) !== null);
    expect(withSkills).toHaveLength(1);
    expect(withSkills[0]?.skills).toEqual([
      // 落在候选配置目录之下 ⇒ 本机启用项
      { name: 'alpha', source: 'user', path: join(configHome, 'skills', 'alpha', 'SKILL.md'), origin: 'local-enabled' },
      // `.system/` 是 codex 自己的内置目录（与我们的那几条同居一个 `skills/`）⇒ 厂商内置
      { name: 'imagegen', source: 'system', path: join(configHome, 'skills', '.system', 'imagegen', 'SKILL.md'), origin: 'vendor-builtin' },
      // 落点在工作目录之下 ⇒ 被测仓库自带（安全提示的计数就是它）
      { name: 'repo-owned', source: 'user', path: join(cwd, '.codex', 'skills', 'repo-owned', 'SKILL.md'), origin: 'repo-provided' },
    ]);
  });

  it('响应形状不认识 ⇒ 不发那一条事件，只落一条点名的 WARN', async () => {
    const server = createFakeAppServer({
      notifications: [
        // 一条 MCP 启动状态通知：它自己就会发一条 `vendor-system`（技能格**一起带上**），
        // 少了它这条用例只剩「一条都不发」那种平凡情形，判据就落空了
        {
          method: 'mcpServer/startupStatus/updated',
          params: { threadId: 'thread-main', name: 'probe', status: 'ready', error: null, failureReason: null },
        },
        turnCompleted({ id: 'turn-1' }, { threadId: 'thread-main' }),
      ],
      respond: { 'thread/list': threadListPages([], 100), 'skills/list': () => ({ unexpected: true }) },
    });
    wireSkills(server);
    const events: AgentEvent[] = [];
    await codexProvider.run(
      createRunInput({ configHome, skills: [{ name: 'alpha', sourceDir }], onEvent: (event) => events.push(event) }),
    );

    // 前提：那一拍真的发了（否则下面的 `every` 在空数组上恒真，等于没判）
    const vendor = vendorEvents(events);
    expect(vendor.length).toBeGreaterThan(0);
    /**
     * 判据是**键在不在**，不是「值是不是 `null`」：MCP 启动状态那几拍也会发 `vendor-system`
     * （携带技能格），写 `?? null` 时 `skills` 这个键**每条都在**、读数却是「厂商投送了空清单」。
     * `!= null` 那种写法对这两种形状一视同仁，正是这条口径当初漏掉的原因。
     */
    expect(vendor.every((event) => !('skills' in event))).toBe(true);
    expect(events.some((event) => event.type === 'log' && event.text.includes('采不到 codex 的技能清单'))).toBe(true);
  });

  it('请求抛错（老版本没有这个方法）⇒ 同上：WARN + 不发事件，运行照常成功', async () => {
    const server = createFakeAppServer({
      notifications: [turnCompleted({ id: 'turn-1' }, { threadId: 'thread-main' })],
      respond: {
        'thread/list': threadListPages([], 100),
        'skills/list': () => {
          throw new Error('unknown method: skills/list');
        },
      },
    });
    wireSkills(server);
    const events: AgentEvent[] = [];
    const result = await codexProvider.run(
      createRunInput({ configHome, skills: [{ name: 'alpha', sourceDir }], onEvent: (event) => events.push(event) }),
    );

    expect(result.ok).toBe(true);
    expect(events.some((event) => event.type === 'log' && event.text.includes('采不到 codex 的技能清单'))).toBe(true);
  });

  it('候选没装技能 ⇒ 一次都不问（评分与用例同步两处不该付这次 RPC）', async () => {
    const server = wireSkills();
    await codexProvider.run(createRunInput({ configHome }));

    expect(server.stats.requests.some((one) => one.method === 'skills/list')).toBe(false);
  });
});
