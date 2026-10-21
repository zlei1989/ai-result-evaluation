// @vitest-environment node
/**
 * **真机**：codex 候选的技能发现面**只在候选配置目录里**——宿主家目录 `~/.agents/skills` 里的那一条
 * 看不见。判据是厂商自己的 `skills/list`（app-server 的结构化应答，离线、不调模型、秒级），
 * 不是「文件在盘上」：`skills/list` 一次给回**全部已发现的根**，所以它同时能看见「多出来的根」。
 *
 * 为什么这条必须有：`CODEX_HOME` 只挡得住 `<CODEX_HOME>/skills` 这一个根，而 codex 的 user scope
 * 发现根里还有一个 **`<HOME>/.agents/skills`**（跟随 `HOME` / `USERPROFILE`，不是 `CODEX_HOME`）。
 * 只改 `CODEX_HOME` 的世界里，宿主家目录那一批 skill 会漏进**每个候选**——候选与候选不再是同一起点，
 * 而且候选会看到与被测任务无关的本机技能。本文件把这条后果**做成可复现的判据**：
 * 第二臂刻意把 `HOME` 指回「宿主家目录」，它必须**看得见**那一条（否则第一臂的绿色说明不了任何事）。
 *
 * 用的是**生产同一套**：`buildSubprocessEnv`（适配器构造子进程环境的唯一入口）+ `resolveCodexBinary`
 * + `createAppServerClient`。不额外拼一份 env，否则守卫会退化成「测我们自己拼的那份对不对」。
 *
 * 开关（默认跳过：它会真的起 codex app-server）：
 * ```
 * AIEVAL_LIVE_SKILLS=1 ./node_modules/.bin/vitest run packages/server/agents/src/providers/codex/live-skills.test.ts
 * ```
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSubprocessEnv } from '../../route';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { resolveCodexBinary } from './appserver/binary';
import { createAppServerClient, type AppServerEnv } from './appserver/client';

const ENABLED = process.env['AIEVAL_LIVE_SKILLS'] === '1';
/** app-server 冷启动 + 一条请求：给足余量，宁可超时也不假红 */
const TIMEOUT_MS = 120_000;

/** 「宿主家目录」里的那一条：`<home>/.agents/skills/<名称>/SKILL.md`（codex 的 user scope 发现根之一） */
const HOST_SKILL = 'host-home-only';
/** 候选内物化出来的那一条：`<CODEX_HOME>/skills/<名称>/SKILL.md` */
const CANDIDATE_SKILL = 'row-planted';

let root: string | null = null;
afterEach(() => {
  if (root !== null) removeTreeWithRetry(root);
  root = null;
});

/** 造一条 skill（目录 + `SKILL.md`：codex 只认这个形态） */
function seedSkill(skillsRoot: string, name: string): void {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}（真机探针）\n---\n\n正文\n`, 'utf8');
}

/** app-server 的 `skills/list` 应答 → 扁平的技能名清单 */
function skillNamesOf(response: unknown): string[] {
  const groups = (response as { data?: { skills?: { name?: unknown }[] }[] } | null)?.data ?? [];
  return groups.flatMap((group) => (group.skills ?? []).map((skill) => String(skill.name)));
}

/** 起一个真 app-server、握手、问一次 `skills/list`、收干净进程树 */
async function listSkillNames(env: AppServerEnv): Promise<string[]> {
  const client = createAppServerClient({ binary: resolveCodexBinary(), env });
  try {
    await client.initialize();
    return skillNamesOf(await client.request('skills/list', {}));
  } finally {
    await client.close();
  }
}

describe.skipIf(!ENABLED)('真机：codex 的技能发现面按行隔离', () => {
  it('HOME 指向候选配置目录 ⇒ 只看得到候选内那一条与厂商内置，宿主家目录那一条看不见', async () => {
    root = mkdtempSync(join(tmpdir(), 'aieval-codex-skills-live-'));
    const hostHome = join(root, 'host-home');
    const configHome = join(root, 'candidates', 'row-1', '.agenthome');
    seedSkill(join(hostHome, '.agents', 'skills'), HOST_SKILL);
    seedSkill(join(configHome, 'skills'), CANDIDATE_SKILL);

    // 生产同一套：适配器就是这么构造子进程环境的（候选配置目录同时是 HOME 与 CODEX_HOME）
    const env = buildSubprocessEnv({
      homeDir: configHome,
      injected: { CODEX_HOME: configHome, OPENAI_API_KEY: 'dummy' },
    });
    /**
     * 本臂的**前提**：交给 codex 的 `HOME` / `USERPROFILE` 就是候选配置目录。
     * 它一旦漂回宿主家目录，下面那条「看不见宿主 skill」的绿色就不再说明隔离生效，而只说明
     * 「我们恰好没在宿主家目录里造那一条」——两种解释必须在这里被分开。
     */
    expect(env.HOME).toBe(configHome);
    expect(env.USERPROFILE).toBe(configHome);
    const names = await listSkillNames(env);

    expect(names).toContain(CANDIDATE_SKILL);
    expect(names).not.toContain(HOST_SKILL);
    // 厂商内置的 6 条照样在（我们不压它们）：它们是 `skills/.system` 物化出来的
    expect(names.filter((name) => name === CANDIDATE_SKILL || name === HOST_SKILL)).toEqual([CANDIDATE_SKILL]);
  }, TIMEOUT_MS);

  /**
   * **反证臂**：`HOME` 一旦指回「宿主家目录」，那一条立刻漏进来——`CODEX_HOME` 一个字节都没变。
   * 没有这一臂，上面那条绿色既可能来自「隔离生效」，也可能来自「那条 skill 根本没被 codex 发现」
   * （比如名字写错、目录形态不对），两种解释在单臂下无法区分。
   */
  it('反证：只把 HOME 指回宿主家目录（CODEX_HOME 不变）⇒ 那一条立刻漏进来', async () => {
    root = mkdtempSync(join(tmpdir(), 'aieval-codex-skills-live-'));
    const hostHome = join(root, 'host-home');
    const configHome = join(root, 'candidates', 'row-1', '.agenthome');
    seedSkill(join(hostHome, '.agents', 'skills'), HOST_SKILL);
    seedSkill(join(configHome, 'skills'), CANDIDATE_SKILL);

    const env = buildSubprocessEnv({
      homeDir: configHome,
      injected: { CODEX_HOME: configHome, OPENAI_API_KEY: 'dummy' },
    });
    // 变异体的形状：把「行家目录」换回「宿主家目录」（`route.ts` 里那两行一旦被改回去就是这样）
    env.HOME = hostHome;
    env.USERPROFILE = hostHome;
    const names = await listSkillNames(env);

    expect(names).toContain(CANDIDATE_SKILL);
    expect(names).toContain(HOST_SKILL);
  }, TIMEOUT_MS);
});
