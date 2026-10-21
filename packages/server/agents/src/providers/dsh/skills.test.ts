// @vitest-environment node
/**
 * dsh 的**技能装入**接缝：`AgentRunInput.skills` → 候选配置目录里的那份副本。
 *
 * 这一家的时序是三家**最紧**的一条：dsh 在 `new DeepSeekHarness(...)` 那一刻组装 profile 与技能目录，
 * 写晚了这个候选照样「跑完」，**没有任何 skill、也没有任何报错**——日志里连线索都没有。
 * 故时序判据用夹具的 `onConstruct` 快照（构造那一刻读盘），而不是「run() 结束后文件在不在」：
 * 后者对「把物化挪到构造之后」这种改动**没有区分力**（挪了也照样绿）。
 *
 * 另三条与 claude / codex 两份同名守卫逐条同形：不传 ⇒ 一个字节都不写；
 * 传了 ⇒ 整目录落进 `<配置目录>/skills/<名称>`（含附属文件）；源目录读不到 ⇒
 * `AGENT_SKILLS_UNAVAILABLE` 点名到条（缺省那条路会归成 `AGENT_FAILED`，而它在自动重试表里）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import { createFakeDshSdk, createRecorder, createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { dshProvider } from './index';
import { DSH_PACKAGE_NAME } from './sdk';

let tempRoot: string;
let configHome: string;
let sourceDir: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'aieval-dsh-skills-'));
  // 候选配置目录刻意**不预建**：契约只说「该候选独立配置目录」，没说它一定存在
  configHome = join(tempRoot, 'candidates', 'row-1', '.agenthome');
  sourceDir = join(tempRoot, 'skills', 'alpha');
  mkdirSync(join(sourceDir, 'scripts'), { recursive: true });
  writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: alpha\ndescription: 示例\n---\n\n正文\n', 'utf8');
  writeFileSync(join(sourceDir, 'scripts', 'helper.sh'), '#!/bin/sh\necho hi\n', 'utf8');
});

afterEach(() => {
  setAgentRuntimeForTesting(null);
  removeTreeWithRetry(tempRoot);
});

/** 装一次假 SDK（`onConstruct` = 装配时刻的快照点），跑一遍适配器 */
async function runDsh(input: Parameters<typeof dshProvider.run>[0], onConstruct?: () => void) {
  setAgentRuntimeForTesting({
    sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: createRecorder(), events: [], ...(onConstruct === undefined ? {} : { onConstruct }) }) },
  });
  return dshProvider.run(input);
}

describe('dsh 装入技能', () => {
  it('不传 skills ⇒ 技能目录一个字节都不写（「只候选执行」由「不传」表达）', async () => {
    await runDsh(createRunInput({ configHome }));

    // 判据是技能落点本身：`skills/` 连建都不该建（overlay 与 npmrc 是另一回事，它们在 configHome 根下）
    expect(existsSync(join(configHome, 'skills'))).toBe(false);
  });

  it('传了 skills ⇒ 整目录落进 <候选配置目录>/skills/<名称>，附属文件一起过去', async () => {
    await runDsh(createRunInput({ configHome, skills: [{ name: 'alpha', sourceDir }] }));

    const installed = join(configHome, 'skills', 'alpha');
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(sourceDir, 'SKILL.md'), 'utf8'));
    expect(readFileSync(join(installed, 'scripts', 'helper.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
  });

  it('物化发生在 boot 之前：构造 DeepSeekHarness 那一刻文件已经在盘上', async () => {
    let seenAtBoot: boolean | null = null;

    const result = await runDsh(createRunInput({ configHome, skills: [{ name: 'alpha', sourceDir }] }), () => {
      // 装配时刻的快照点：dsh 在这一刻读技能目录，写晚了这个候选静默地一条 skill 都没有
      seenAtBoot = existsSync(join(configHome, 'skills', 'alpha', 'SKILL.md'));
    });

    expect(seenAtBoot).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('源目录读不到 ⇒ 该次运行的失败、码是 AGENT_SKILLS_UNAVAILABLE、文案点名哪一条', async () => {
    const result = await runDsh(
      createRunInput({ configHome, skills: [{ name: 'ghost', sourceDir: join(tempRoot, 'skills', 'ghost') }] }),
    );

    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('error');
    expect(result.error?.code).toBe('AGENT_SKILLS_UNAVAILABLE');
    expect(result.error?.message).toContain('ghost');
  });
});
