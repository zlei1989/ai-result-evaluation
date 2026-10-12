// @vitest-environment node
/**
 * cc 的**技能装入**接缝：`AgentRunInput.skills` → 行配置目录里的那份副本。
 *
 * 为什么这几条守卫落在适配器这一层：物化本体在 `core`（整目录复制、穿越拦截、幂等都在那边测），
 * 而这里要钉的是**谁来调、什么时候调、不传时写不写**——三者都是静默失效型：
 *   · **不传 = 不装**：评分与用例同步两处不传这一格，适配器一旦「读全局配置」或者「空清单也写一遍」，
 *     「只候选执行」这条口径就没了（多出文件的目录还是**跨轮共享**的那个）；
 *   · **落盘失败 ⇒ 带码失败**：抛出的 `SkillMaterializeError` 必须归成
 *     `AGENT_SKILLS_UNAVAILABLE`（而不是缺省那个 `AGENT_FAILED`——它在自动重试表里）；
 *   · **时序**：CC 在 `query()` 那一刻扫 `CLAUDE_CONFIG_DIR/skills`，写晚了它那一次启动就看不到，
 *     而这件事**不报错**（只是这一行白跑）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import { createFakeClaudeSdk, createRecorder, createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { claudeCodeProvider } from './index';
import { CLAUDE_PACKAGE_NAME } from './sdk';

let tempRoot: string;
let configHome: string;
let sourceDir: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'aieval-claude-skills-'));
  // 行配置目录刻意**不预建**：契约只说「该行独立配置目录」，没说它一定存在
  configHome = join(tempRoot, 'rows', 'row-1', '.agenthome');
  sourceDir = join(tempRoot, 'skills', 'alpha');
  mkdirSync(join(sourceDir, 'scripts'), { recursive: true });
  writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: alpha\ndescription: 示例\n---\n\n正文\n', 'utf8');
  writeFileSync(join(sourceDir, 'scripts', 'helper.sh'), '#!/bin/sh\necho hi\n', 'utf8');
});

afterEach(() => {
  setAgentRuntimeForTesting(null);
  removeTreeWithRetry(tempRoot);
});

/** 装一次假 SDK，跑一遍适配器；返回那次运行的结果 */
async function runClaude(input: Parameters<typeof claudeCodeProvider.run>[0]) {
  const recorder = createRecorder();
  setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
  const result = await claudeCodeProvider.run(input);
  return { result, recorder };
}

describe('cc 装入技能', () => {
  it('不传 skills ⇒ 技能目录一个字节都不写（「只候选执行」由「不传」表达）', async () => {
    await runClaude(createRunInput({ configHome }));

    // 判据是技能落点本身：`skills/` 连建都不该建（建了就等于适配器在替调用方表「本行要装零条」）
    expect(existsSync(join(configHome, 'skills'))).toBe(false);
    if (existsSync(configHome)) expect(readdirSync(configHome)).not.toContain('skills');
  });

  it('传了 skills ⇒ 整目录落进 <行配置目录>/skills/<名称>，附属文件一起过去', async () => {
    await runClaude(createRunInput({ configHome, skills: [{ name: 'alpha', sourceDir }] }));

    const installed = join(configHome, 'skills', 'alpha');
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(sourceDir, 'SKILL.md'), 'utf8'));
    expect(readFileSync(join(installed, 'scripts', 'helper.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
  });

  it('物化发生在起进程之前：query() 那一刻文件已经在盘上', async () => {
    let seenAtQuery: boolean | null = null;
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: {
          query: (params: { options: Record<string, unknown> }) => {
            // 装配时刻的快照点：CC 这一次启动扫的就是此刻的 skills/，写晚了这一行白跑且不报错
            seenAtQuery = existsSync(join(configHome, 'skills', 'alpha', 'SKILL.md'));
            void params;
            return { async *[Symbol.asyncIterator]() {} };
          },
        },
      },
    });

    const result = await claudeCodeProvider.run(createRunInput({ configHome, skills: [{ name: 'alpha', sourceDir }] }));

    expect(seenAtQuery).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('源目录读不到 ⇒ 该次运行失败、码是 AGENT_SKILLS_UNAVAILABLE、文案点名哪一条', async () => {
    const { result } = await runClaude(
      createRunInput({ configHome, skills: [{ name: 'ghost', sourceDir: join(tempRoot, 'skills', 'ghost') }] }),
    );

    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('error');
    expect(result.error?.code).toBe('AGENT_SKILLS_UNAVAILABLE');
    expect(result.error?.message).toContain('ghost');
  });
});
