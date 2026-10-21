// @vitest-environment node
/**
 * 技能装入的**编排层**闭环：设置页里的启用状态 + 技能根里的目录
 * → 扫描出来的清单（`AgentRunInput.skills`）→ 「装不进去」的候选级收口。
 *
 * 为什么这几条守卫必须落在编排层（而不是只测适配器与物化函数）：
 *   · **填在哪里**是核心裁定——「只候选执行阶段装入」这条口径由**调用点**保证。漏填是静默的：
 *     适配器那一侧没有清单就一条都不装，行照常跑完、分数照出，只是候选配置目录里空着；
 *   · **谁被剔掉**：停用的、扫描不合格的都不该进清单（前者是用户的意图，后者装上也白装：
 *     厂商侧要么启动前抛错、要么把整条静默丢弃）；
 *   · **评分那一次不许带**（口径的另一半）：评审者不该拿到候选的技能面，多传同样是静默的
 *     ——只有 `fakeAgents.calls` 这一格看得见；
 *   · **落盘失败 = 该候选失败且不自动重试**：装不进去是本次配置的直接后果，重试只会把同一个失败
 *     延后 `3s × N`（适配器那一次的错误码由 agents 包的用例钉住，这里钉的是候选级收口）。
 *
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { vi, describe, expect, it } from 'vitest';
import type { AgentEvent, EvalCandidate } from '@aieval/contracts';
import { AGENT_SKILLS_UNAVAILABLE } from './candidate-skill';
import {
  PRODUCTION_CANDIDATE_RETRIES,
  CANDIDATE_RETRY,
  drainRunningTasks,
  fakeAgents,
  getRun,
  home,
  join,
  judgeReplyJson,
  readEvents,
  registerOrchestratorHooks,
  candidateEventsFile,
  runCandidate,
  seedRunnableRun,
  TEST_TIMEOUT_MS,
  until,
} from './testing/orchestrator-harness';

vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock());
vi.mock('./judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./judge')>();
  return (await import('./testing/orchestrator-seams')).judgeMock(actual);
});
vi.mock('./run-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-store')>();
  return (await import('./testing/orchestrator-seams')).runStoreMock(actual);
});

registerOrchestratorHooks();

/** 技能根（跟着临时配置目录走，与 `getSkillsRoot()` 同一个落点） */
const skillsRoot = (): string => join(home.configDir, 'skills');

/** 造一条扫描得过的 skill：`<技能根>/<名称>/SKILL.md`（含一个附属文件） */
function seedSkill(name: string): string {
  const dir = join(skillsRoot(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 示例技能\n---\n\n正文\n`, 'utf8');
  return dir;
}

/** 这个候选的快照 */
function candidateOf(runId: string, index = 0): EvalCandidate {
  const candidate = getRun(runId).candidates[index];
  if (candidate === undefined) throw new Error('快照里没有这个候选');
  return candidate;
}

describe('编排层填技能清单', { timeout: TEST_TIMEOUT_MS }, () => {
  it('只有「扫描合格 + 没停用」的条目进 run() 入参，源目录指回技能根', async () => {
    const alpha = seedSkill('alpha');
    seedSkill('beta');
    // 停用 beta；另外造一条扫描不合格的（缺 SKILL.md）：它在设置页里显示成「不可用」，装不了
    mkdirSync(join(skillsRoot(), 'broken'), { recursive: true });
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', skills: { beta: { disabled: true } } });

    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    // 逐字：停用的 `beta` 不在、`broken` 不在、剩下那一条带上它的源目录（物化按它整目录复制）
    expect(fakeAgents.calls[0]?.skills).toEqual([{ name: 'alpha', sourceDir: alpha }]);
  });

  it('技能根不存在 ⇒ 不给这一格（`undefined` 不是 `[]`），行照常跑完', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';

    await runCandidate(run.id, candidateId);
    await drainRunningTasks();
    await until(() => candidateOf(run.id).status === 'judged', '这个候选照常跑完', TEST_TIMEOUT_MS);

    // 「一条都没启用」与「本次没有程序化装入」在落盘侧是两件事 ⇒ 空集不给键（与 mcpServers 同口径）
    expect(fakeAgents.calls[0]?.skills).toBeUndefined();
    expect(candidateOf(run.id).status).toBe('judged');
  });

  it('一条都被停用 ⇒ 同样不给这一格（不替调用方声明「候选要装零条」）', async () => {
    seedSkill('alpha');
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', skills: { alpha: { disabled: true } } });

    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    expect(fakeAgents.calls[0]?.skills).toBeUndefined();
  });

  it('评分那一次**不带**技能（口径的另一半：只有候选执行阶段装入）', async () => {
    // 候选走默认的 codex（夹具的默认供应商是 openai），**评审者**用 cc：
    // 于是「同一次 runCandidate 里的两次 run，只有候选那一次带技能」在一个用例里就能对上。
    // 假适配器要回一份能解析的评分答复，否则评审那一段会以解析失败收场（与本题无关的噪声）。
    fakeAgents.scripts.set('cc', { finalText: judgeReplyJson() });
    seedSkill('alpha');
    const { run } = seedRunnableRun({
      candidateCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'cc',
    });

    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    // 两次 run：候选一次、评审一次（同一格入参，只有这一处能分开它们）
    expect(fakeAgents.calls.length).toBe(2);
    expect(fakeAgents.calls.map((call) => call.skills === undefined)).toEqual([false, true]);
  });
});

/**
 * **装不进去 ⇒ 该候选失败**。
 *
 * 四件事缺一不可：
 *   ① 行**失败**、归因码 `AGENT_SKILLS_UNAVAILABLE`（候选环境残缺时产出的分数不能当数）；
 *   ② 文案**点名到条**（源目录读不到时用户要回设置页改哪一条，全在这句话里）；
 *   ③ **不自动重试**（归因码刻意不进 `TRANSIENT_CANDIDATE_RETRY_CODES`：重试只会把同一个失败延后 3 秒）；
 *   ④ 评分**不跑**（白花一次评分调用，且会给一个环境残缺的产出打分）。
 */
describe('技能装不进去 ⇒ 候选失败且不自动重试', () => {
  /** 适配器那一侧真实会给出的那条消息（`core` 的物化错误原文，见 skill-materialize.ts） */
  const MESSAGE = '装入技能「alpha」失败：源目录读不到 /nonexistent/skills/alpha（ENOENT: no such file or directory）';

  it('行 failed + 码与文案照传 + attempts 停在 1 + 没有评分', async () => {
    const retries = CANDIDATE_RETRY.maxRetries;
    const delay = CANDIDATE_RETRY.delayMs;
    // 打开产品默认的重试预算（harness 的 beforeEach 把它关成 0）：这一条要同时证「判定失败」与
    // 「失败之后**没有被**自动重跑」——不打开预算的话，重试表里有没有这个码在用例面前没有区别。
    CANDIDATE_RETRY.maxRetries = PRODUCTION_CANDIDATE_RETRIES;
    CANDIDATE_RETRY.delayMs = 1;
    try {
      // 假适配器只负责那一份「适配器交回来的失败」：真实的物化失败在 agents 包的用例里逐条钉住
      // （`providers/cc/skills.test.ts`），这里钉的是编排层拿到它之后怎么收口
      fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AGENT_SKILLS_UNAVAILABLE' });
      const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
      const candidateId = run.candidates[0]?.id ?? '';

      await runCandidate(run.id, candidateId);
      await drainRunningTasks();

      const candidate = candidateOf(run.id);
      expect(candidate.status).toBe('failed');
      expect(candidate.error?.code).toBe('AGENT_SKILLS_UNAVAILABLE');
      expect(candidate.error?.stage).toBe('agent');
      expect(candidate.error?.code).not.toBe('AGENT_FAILED');
      // ③ 没有第二次尝试（候选只跑了一次、attempts 停在 1）
      expect(fakeAgents.calls).toHaveLength(1);
      expect(candidate.attempts).toBe(1);
      // ④ 评分那一段没有跑：没有 score 事件
      const events = readEvents(candidateEventsFile(run.workspaceBase, run.id, candidateId));
      expect(events.some((event) => event.type === 'score')).toBe(false);
      // ① 失败也落一条 error 事件（日志抽屉是唯一回答「为什么」的地方）
      expect(events.some((event) => event.type === 'error' && event.message.includes('AGENT_SKILLS_UNAVAILABLE'))).toBe(true);
    } finally {
      CANDIDATE_RETRY.maxRetries = retries;
      CANDIDATE_RETRY.delayMs = delay;
    }
  });

  it('文案逐字照传（点名的条名与路径一个字符都不改）', async () => {
    fakeAgents.scripts.set('codex', {
      mode: 'error',
      errorCode: 'AGENT_SKILLS_UNAVAILABLE',
      errorMessage: MESSAGE,
    });
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });

    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    // 候选失败的文案就是适配器交回来的那一条（编排层不重写、不截断、不加前缀）
    expect(candidateOf(run.id).error?.message).toBe(MESSAGE);
  });
});

/**
 * **厂商没认 ⇒ 该候选失败**（判据三态里的 `missing`）。
 *
 * 与「装不进去」那一路的分工：那一路是**适配器**报的（源目录读不到 / 复制失败），
 * 这一路是**编排层**判的——厂商清单采到了、里面没有它。两者共用一个归因码字符串，
 * 但判定点不同（这条不对称是刻意的：归因码同名，判定层不同）。
 *
 * 三条守卫缺一不可：
 *   ① 行 failed + 归因码 `AGENT_SKILLS_UNAVAILABLE` + 文案点名哪家哪条；
 *   ② **不自动重试**（同一个码刻意不进 `TRANSIENT_CANDIDATE_RETRY_CODES`）；
 *   ③ 评分**不跑**（带着残缺的技能面出的分不算数）；
 * 另一侧同样要钉：**采不到清单时不许判失败**（那是 `unverified`，行照常跑完）。
 */
describe('厂商没认技能 ⇒ 候选失败且不自动重试', () => {
  /** 适配器侧投一条带技能面的 `vendor-system`（真机形状：最后一条自带全量） */
  function vendorSkills(names: string[]): AgentEvent {
    return {
      seq: 1,
      at: new Date().toISOString(),
      type: 'vendor-system',
      tools: ['Skill'],
      slashCommands: null,
      agents: null,
      mcpServers: null,
      mcpChannel: 'vendor-status',
      permissionMode: null,
      outputStyle: null,
      skills: names.map((name) => ({ name, source: 'userSettings', path: null, origin: 'local-enabled' })),
    } as AgentEvent;
  }

  it('清单里没有它 ⇒ 行 failed、点名、attempts 停在 1、没有评分', async () => {
    const retries = CANDIDATE_RETRY.maxRetries;
    const delay = CANDIDATE_RETRY.delayMs;
    CANDIDATE_RETRY.maxRetries = PRODUCTION_CANDIDATE_RETRIES;
    CANDIDATE_RETRY.delayMs = 1;
    try {
      seedSkill('alpha');
      // 造一个「厂商不认」的用例：清单采到了，但里面是别家的名字
      fakeAgents.scripts.set('codex', { rawEvents: [vendorSkills(['builtin-skill'])] });
      const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
      const candidateId = run.candidates[0]?.id ?? '';

      await runCandidate(run.id, candidateId);
      await drainRunningTasks();

      const candidate = candidateOf(run.id);
      expect(candidate.status).toBe('failed');
      expect(candidate.error?.code).toBe(AGENT_SKILLS_UNAVAILABLE);
      expect(candidate.error?.stage).toBe('agent');
      // 点名哪家哪条（同一份配置在三家上可能只有一家不认，不点名就不知道该查哪一家）
      expect(candidate.error?.message).toContain('技能「alpha」');
      expect(candidate.error?.message).toContain('Codex');
      // ② 不自动重试
      expect(fakeAgents.calls).toHaveLength(1);
      expect(candidate.attempts).toBe(1);
      // ③ 评分没跑
      const events = readEvents(candidateEventsFile(run.workspaceBase, run.id, candidateId));
      expect(events.some((event) => event.type === 'score')).toBe(false);
    } finally {
      CANDIDATE_RETRY.maxRetries = retries;
      CANDIDATE_RETRY.delayMs = delay;
    }
  });

  it('清单里有它 ⇒ 行照常跑完，「候选技能」那格逐条四格落盘', async () => {
    seedSkill('alpha');
    fakeAgents.scripts.set('codex', { rawEvents: [vendorSkills(['alpha', 'builtin-skill'])] });
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';

    await runCandidate(run.id, candidateId);
    await drainRunningTasks();
    await until(() => candidateOf(run.id).status === 'judged', '这个候选照常跑完', TEST_TIMEOUT_MS);

    // 四格：名称 / 来源（厂商原值照抄）/ 判据来源 / 结论
    expect(candidateOf(run.id).skillInstall).toEqual([
      { name: 'alpha', source: 'userSettings', judgedBy: 'vendor-skill-list', verdict: 'installed' },
    ]);
  });

  it('清单采不到 ⇒ 不判失败，如实记 `unverified · 仅落盘`，行照常跑完', async () => {
    seedSkill('alpha');
    // 适配器一条 vendor-system 都不投（真机里对应「这一家没投这一格」）
    fakeAgents.scripts.set('codex', {});
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';

    await runCandidate(run.id, candidateId);
    await drainRunningTasks();
    await until(() => candidateOf(run.id).status === 'judged', '这个候选照常跑完', TEST_TIMEOUT_MS);

    expect(candidateOf(run.id).skillInstall).toEqual([
      { name: 'alpha', source: 'unknown', judgedBy: 'local-materialized', verdict: 'unverified' },
    ]);
  });

  it('一条都没装 ⇒ 落 `[]`（观测到零条，不是「没观测」）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';

    await runCandidate(run.id, candidateId);
    await drainRunningTasks();
    await until(() => candidateOf(run.id).status === 'judged', '这个候选照常跑完', TEST_TIMEOUT_MS);

    expect(candidateOf(run.id).skillInstall).toEqual([]);
  });
});
