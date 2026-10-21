// @vitest-environment node
/**
 * 追问的传输面：**存在性检查在 api 层、可用性与拒绝原因在编排层**（与 `retryCandidate` / `rescoreCandidate`
 * 同一条分工）。本文件只钉 api 这一侧的四件事：行不存在 ⇒ 404、请求不合法 ⇒ 400（文案点名哪一条
 * 限制）、合法请求 ⇒ 原样交给编排层、编排层的拒绝 ⇒ 原样透出（不许在这里被改写或吞掉）。
 *
 * 编排层那一侧（七档拒绝、计量、自动重评、哨兵文件）在 `@aieval/evaluator` 自己的用例里；
 * 这里**刻意 mock 掉它**：一条真正跑得起来的追问会去起厂商 CLI（本层没有任何东西能拦住它，
 * 而「测试里绝不 spawn 真厂商进程」是硬口径），而本层的判据与它是否真跑无关。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_MAX_PER_MESSAGE, ServiceError, type EvalRun, type InjectAttachment } from '@aieval/contracts';
import { setCasesRootForTesting, setConfigDirForTesting } from '@aieval/core';
import { saveRun } from '@aieval/evaluator';
import { getFollowUpAvailability, followUpCandidate } from './follow-up';
import { getInjectMessages } from './inject-messages';
import { updateSettings } from './settings';
import { fixtureWorkspaceRoot, makeCandidate, makeRun } from './testing/run-fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

/**
 * 编排层那个入口的替身。`vi.hoisted` + 只换一个成员：本模块其余导出（本层与 `./runs` 都要用）
 * 保持真身——整模块替换会让它们变成 `undefined`，而那种崩会指向完全错误的方向。
 */
const orchestrator = vi.hoisted(() => ({ followUpCandidate: vi.fn() }));
vi.mock('@aieval/evaluator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aieval/evaluator')>()),
  followUpCandidate: orchestrator.followUpCandidate,
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-follow-up-'));
  setConfigDirForTesting(dir);
  setCasesRootForTesting(join(dir, 'cases'));
  // 快照读侧只扫**当前设置里的根**（`getRun` 的口径），故它必须与夹具那棵树的根对上
  updateSettings({ workspaceRoot: fixtureWorkspaceRoot() });
  orchestrator.followUpCandidate.mockReset();
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

/** 造一轮真落盘的单个候选评测（详情读侧按 `run.json` 解析，假的快照会让存在性检查走错分支） */
function seedRun(overrides: Partial<EvalRun> = {}): EvalRun {
  const run = makeRun({ candidates: [makeCandidate({ sessionId: 'sess-1' })], ...overrides });
  saveRun(run);
  return run;
}

const ATTACHMENT: InjectAttachment = { kind: 'image', path: '/tmp/shot.png', mimeType: 'image/png' };

/** 跑一次注定抛的动作，把它那句中文原因拿出来（两条路要摆在一起比，故不能在断言里就地比） */
function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return error.message;
    throw error;
  }
  throw new Error('这一步本该抛错');
}

describe('followUpCandidate（api）：存在性检查与请求校验', () => {
  it('这个候选不存在 ⇒ 404，且不去打扰编排层', () => {
    seedRun();
    expect(() => followUpCandidate({ runId: 'run-1', candidateId: 'r-missing', text: '在吗' })).toThrow(ServiceError);
    expect(() => followUpCandidate({ runId: 'run-1', candidateId: 'r-missing', text: '在吗' })).toThrow('没有这个候选');
    expect(orchestrator.followUpCandidate).not.toHaveBeenCalled();
  });

  /**
   * 那一句 404 与**人工消息那一面逐字相同**。
   *
   * 客户端会按文案给人看、也可能按它分支；两条路各写一份的结果是同一格给出两句不同的话——
   * 而这种漂没有运行期症状，只有把两份输出摆在一起才看得出来。
   */
  it('这个候选不存在的那句 404 与人工消息那一面逐字相同（判据与文案只有一处）', () => {
    seedRun();
    const followUpMessage = messageOf(() => followUpCandidate({ runId: 'run-1', candidateId: 'r-missing', text: '在吗' }));
    const injectMessage = messageOf(() => getInjectMessages('run-1', 'r-missing'));
    expect(followUpMessage).toBe(injectMessage);
    expect(followUpMessage).toBe('该评测里没有这个候选（r-missing）');
  });

  it('轮不存在 ⇒ 404（快照读侧自己抛）', () => {
    seedRun();
    expect(() => followUpCandidate({ runId: 'run-missing', candidateId: 'r-1', text: '在吗' })).toThrow(ServiceError);
    expect(orchestrator.followUpCandidate).not.toHaveBeenCalled();
  });

  it('一句话都没有、附件也没有 ⇒ 400（空消息交给模型只会得到一句「你发了什么」）', () => {
    seedRun();
    expect(() => followUpCandidate({ runId: 'run-1', candidateId: 'r-1', text: '   ' })).toThrow('至少要有一句话或一个附件');
    expect(orchestrator.followUpCandidate).not.toHaveBeenCalled();
  });

  it('附件超过上限 ⇒ 400，且中文原因点名是哪一条限制（界面能被绕开，服务端必须拦）', () => {
    seedRun();
    const attachments = Array.from({ length: ATTACHMENT_MAX_PER_MESSAGE + 1 }, () => ATTACHMENT);
    expect(() => followUpCandidate({ runId: 'run-1', candidateId: 'r-1', text: '带一堆图', attachments })).toThrow(
      `单条消息最多 ${String(ATTACHMENT_MAX_PER_MESSAGE)} 个附件`,
    );
    expect(orchestrator.followUpCandidate).not.toHaveBeenCalled();
  });
});

describe('followUpCandidate（api）：把请求交给编排层、把拒绝原样透出', () => {
  it('合法请求原样交给编排层，并把「已经在准备中」的快照交回调用方', () => {
    const run = seedRun();
    const preparing: EvalRun = { ...run, candidates: run.candidates.map((candidate) => ({ ...candidate, status: 'preparing' })) };
    orchestrator.followUpCandidate.mockReturnValue(preparing);

    const returned = followUpCandidate({
      runId: 'run-1',
      candidateId: 'r-1',
      text: '接着把第二段也写了',
      attachments: [ATTACHMENT],
      messageId: 'draft-7',
    });

    expect(orchestrator.followUpCandidate).toHaveBeenCalledWith('run-1', 'r-1', {
      text: '接着把第二段也写了',
      attachments: [ATTACHMENT],
      messageId: 'draft-7',
    });
    expect(returned).toBe(preparing);
  });

  it('没给 messageId 就不传那一格（编排层现铸一个，而不是收到一个 undefined 的键）', () => {
    seedRun();
    orchestrator.followUpCandidate.mockReturnValue(seedRun());
    followUpCandidate({ runId: 'run-1', candidateId: 'r-1', text: '没有草稿 id' });
    expect(orchestrator.followUpCandidate).toHaveBeenCalledWith('run-1', 'r-1', { text: '没有草稿 id', attachments: [] });
  });

  it('编排层的拒绝原样透出：中文原因一个字都不改写（界面按它给 Tooltip）', () => {
    seedRun();
    orchestrator.followUpCandidate.mockImplementation(() => {
      throw new ServiceError('CONFLICT', '这个候选没有可续接的会话（还没跑过，或是没有这一格的旧产物）');
    });
    expect(() => followUpCandidate({ runId: 'run-1', candidateId: 'r-1', text: '追问一句' })).toThrow(
      '这个候选没有可续接的会话（还没跑过，或是没有这一格的旧产物）',
    );
  });
});

/**
 * 追问可用性的**读侧**（界面入口靠它给按钮的 `disabled` 与 Tooltip 文案）。
 *
 * 本组**不 mock 编排层**：这条读侧的全部价值就是「界面看到的判据与真追问那一份逐字相同」，
 * 把它换成一个固定返回值就什么也证不到。判据与文案在契约里（`canFollowUpCandidate` 的真值表在
 * `@aieval/contracts`），编排层那一侧的同源在 `@aieval/evaluator` 自己的用例里；
 * 这里只钉 api 层这三件事：那一轮不存在 ⇒ 404、每个候选都有一条结论、原因原样透出（不改写）。
 */
describe('getFollowUpAvailability（api）：存在性检查与透出', () => {
  it('轮不存在 ⇒ 404（快照读侧自己抛），不是一条空结论', () => {
    seedRun();
    expect(() => getFollowUpAvailability('run-missing')).toThrow(ServiceError);
    expect(() => getFollowUpAvailability('run-missing')).toThrow('评测不存在');
  });

  it('每个候选都有结论，顺序即 `run.candidates` 的顺序（界面按候选 id 取，漏一个候选就是按钮没有判据）', () => {
    // 夹具用「跑过、但没采到会话 id」那一档：`pending` 的候选落在「此刻不是时机」那一档
    // （它该去输入区排队），而这里要打的是「这个候选接不上」的第 ③ 档
    const run = seedRun({ candidates: [makeCandidate({ id: 'r-1', status: 'judged' }), makeCandidate({ id: 'r-2', status: 'judged' })] });
    const availability = getFollowUpAvailability(run.id);
    expect(availability.candidates.map((candidate) => candidate.candidateId)).toEqual(['r-1', 'r-2']);
    for (const { verdict } of availability.candidates) {
      // 夹具里的两个候选都还没有会话 ⇒ 不可追问，且原因就是契约那一句（不是「false」）
      expect(verdict.ok).toBe(false);
      expect(verdict.ok ? '' : verdict.reason).toContain('没有可续接的会话');
    }
  });

  it('盘上真没了工作区 ⇒ 原因点名那一条路径（这一档浏览器本来就看不到，才需要读侧）', () => {
    // 第 ④ 档要求行**有会话**：`pending` 的候选在它之前就被第 ① 档拦下了
    const candidate = makeCandidate({ id: 'r-1', status: 'judged', sessionId: 'sess-1' });
    seedRun({ candidates: [candidate] });
    const verdict = getFollowUpAvailability('run-1').candidates[0]?.verdict;
    expect(verdict?.ok).toBe(false);
    expect(verdict?.ok === false ? verdict.reason : '').toContain(candidate.workspacePath);
  });

  it('读侧说可行的候选，`followUpCandidate` 那一侧也放行（同一条判据、同一批事实）', () => {
    // 夹具的工作区确实不存在 ⇒ 这一条只证「不可行时两侧一致」；可行的那一侧在 evaluator 的用例里
    const run = seedRun({ candidates: [makeCandidate({ id: 'r-1', sessionId: 'sess-1' })] });
    const verdict = getFollowUpAvailability(run.id).candidates[0]?.verdict;
    expect(verdict?.ok).toBe(false);
  });
});
