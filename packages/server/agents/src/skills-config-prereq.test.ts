// @vitest-environment node
/**
 * 三家装入技能的**配置前提**（规格里的 L2）：不跑厂商、不问模型，只把「交出去的那一份配置」
 * 逐格钉住——技能能被发现，靠的就是这四格 + 一个 `settingSources`。它们全是**静默失效**型：
 * 某一格改了，行照样跑完，只是那一家再也看不到我们物化进去的 skill（dsh 尤其如此：连日志都没有）。
 *
 * 四格的口径（本文件是唯一的断言点，改任一处都必须先回答这里为什么还成立）：
 *   · `HOME` / `USERPROFILE`：厂商的 **user scope 发现根**挂在 `~` 下——codex 的
 *     `<home>/.agents/skills`、claude 的 `<home>/.claude/skills`、dsh 的 `<home>/.agents/skills`。
 *     只改厂商自己的变量（`CODEX_HOME` / `DSH_HOME` / `CLAUDE_CONFIG_DIR`）**挡不住**这些根：
 *     它们跟着 `HOME` 走，于是宿主家目录里那一批 skill 会漏进每一行，行与行之间也不再是同一起点。
 *   · `CODEX_HOME` / `DSH_HOME` / `CLAUDE_CONFIG_DIR`：各家**自己的**配置根，技能主落点在它下面
 *     （`<configHome>/skills/<名称>/SKILL.md`）。
 *   · claude 的 `settingSources` 含 `'user'`：CC 只装配它被允许读的那几层设置——少了 `'user'`，
 *     `<CLAUDE_CONFIG_DIR>/skills` 这一层整个不参与装配，而 `init` 事件**不会**因此报错。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setAgentRuntimeForTesting } from './runtime';
import { createFakeClaudeSdk, createFakeDshSdk, createRecorder, createRunInput, FIXTURE_CONFIG_HOME } from './testing/agent-fixtures';
import { claudeCodeProvider } from './providers/claude-code';
import { CLAUDE_PACKAGE_NAME } from './providers/claude-code/sdk';
import { createFakeAppServer, threadListPages, turnCompleted } from './providers/codex/appserver-fixtures';
import { codexProvider, defaultCodexRuntimeHooks, type CodexRuntimeHooks } from './providers/codex';
import { dshProvider } from './providers/dsh';
import { DSH_PACKAGE_NAME } from './providers/dsh/sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  codexProvider.runtimeHooks = defaultCodexRuntimeHooks;
});

/** 这一行自己的配置目录：三个断言组共用同一个「应该是多少」的锚点 */
const CONFIG_HOME = FIXTURE_CONFIG_HOME;

/** 一格里同时钉四个键：少一个都算没过（三家的变量名不同，但「都是 configHome」是同一条口径） */
function expectRowHomeEnv(env: Record<string, string | undefined> | null, keys: readonly string[]): void {
  expect(env).not.toBeNull();
  for (const key of [...keys, 'HOME', 'USERPROFILE']) {
    expect(env?.[key], `${key} 必须指向行配置目录`).toBe(CONFIG_HOME);
  }
}

describe('L2 配置前提：三家的技能发现面都指向行配置目录', () => {
  it('claude：`settingSources` 含 `user`，且 HOME / USERPROFILE / CLAUDE_CONFIG_DIR 三格都是行配置目录', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    const result = await claudeCodeProvider.run(createRunInput({ configHome: CONFIG_HOME }));

    expect(result.ok).toBe(true);
    // 少了 `user` 这一层，`<CLAUDE_CONFIG_DIR>/skills` 就不参与装配，而 init 事件不会报错
    expect(recorder.options?.['settingSources']).toContain('user');
    expectRowHomeEnv(recorder.env, ['CLAUDE_CONFIG_DIR']);
  });

  it('codex：HOME / USERPROFILE / CODEX_HOME 三格都是行配置目录（user scope 的 `~/.agents/skills` 跟着 HOME 走）', async () => {
    let spawned: Record<string, string | undefined> | null = null;
    const server = createFakeAppServer({
      notifications: [turnCompleted({ id: 'turn-1' }, { threadId: 'thread-main' })],
      respond: { 'thread/list': threadListPages([], 100) },
    });
    const hooks: CodexRuntimeHooks = {
      createClient: (input) => {
        spawned = input.env;
        return server.client;
      },
      resolveBinary: () => 'fake-codex',
    };
    codexProvider.runtimeHooks = hooks;

    const result = await codexProvider.run(createRunInput({ configHome: CONFIG_HOME }));

    expect(result.ok).toBe(true);
    expectRowHomeEnv(spawned, ['CODEX_HOME']);
  });

  it('dsh：HOME / USERPROFILE / DSH_HOME 三格都是行配置目录', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });

    const result = await dshProvider.run(createRunInput({ configHome: CONFIG_HOME }));

    expect(result.ok).toBe(true);
    expectRowHomeEnv(recorder.env, ['DSH_HOME']);
  });
});
