// @vitest-environment node
/**
 * 用例同步服务：后台排队与合并、逐文件提交、智能体写提交信息、远端对齐与推送。
 *
 * 五条被测的承重口径（都是用户口径的直接后果）：
 *   1. **不阻塞保存**：自动触发要等满防抖窗口才跑，且连续两次变更合并成**一轮**（智能体只被调一次）；
 *   2. **逐文件提交**：N 个变更文件 → N 个提交，一个提交只含一个文件；
 *   3. **只提交用例文件**：`<casesRoot>` 下的 README / 笔记永不进历史，但要计数让用户看见；
 *   4. **智能体只写提交信息**：它失败 / 不答复时用确定性回退文案，**不让任何文件卡在未提交状态**；
 *   5. **绝不 force push**：分叉时合并智能体失败 ⇒ 报错 + 保留本地提交 + 远端历史一个字节不动。
 *
 * 智能体一律是**假的**（`vi.mock('@aieval/agents')` 的 `getProvider`）：真机 CLI 不在单测里起，
 * 这是本仓的硬规矩（`evaluator/src/static-assertions.test.ts` 盯着漏 mock 的那条路）。
 * git 与文件系统则一律是真的（mkdtemp 出来的仓库 + 本地裸远端），不 mock。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DEFAULTS, type Provider, type TestCase } from '@aieval/contracts';
import {
  commitFile,
  headCommit,
  listCommitsSince,
  saveConfig,
  setCasesRootForTesting,
  setConfigDirForTesting,
  writeCase,
} from '@aieval/core';
import { enqueueCaseSync, getCaseSyncStatus, resetCaseSyncForTesting, runCaseSync } from './case-sync';
import { removeTreeWithRetry } from './testing/cleanup';

/**
 * 假智能体的运行结果。`vi.mock` 的工厂是提升的，故替身必须用 `vi.hoisted` 提前建出来。
 */
const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock('@aieval/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/agents')>();
  return {
    ...actual,
    // 只替掉「怎么起智能体」这一件事：元数据（协议集合）留给真实注册表的口径，
    // `requireJudgeAgent` 会读它来判断 claude-code 能不能驱动 anthropic 路由
    getProvider: vi.fn(() => ({ metadata: { protocolTypes: ['anthropic'] }, run: runMock })),
  };
});

/** 一次假运行的结果（`ok: false` 走的是各家适配器失败时的同一个形状） */
function agentResult(finalText: string | null, ok = true): Record<string, unknown> {
  return {
    ok,
    exitReason: ok ? 'completed' : 'error',
    tokens: null,
    subagentTokens: null,
    subagentTurns: null,
    turns: null,
    durationMs: 5,
    finalText,
    applied: { structuredOutput: false },
  };
}

/** 智能体答复：为每个文件写一行提交信息 */
function messagesFor(entries: Array<[string, string]>): string {
  return JSON.stringify({ commits: entries.map(([file, message]) => ({ file, message })) });
}

/** 跑一条 git 命令：身份用 -c 显式给，不依赖宿主机的 user.name / user.email */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'c-1',
    title: 'LRU 缓存',
    repoPath: 'D:/repos/demo',
    commitHash: null,
    repoBranch: null,
    taskPrompt: '实现一个 LRU 缓存',
    rubric: { groups: [{ name: '一、功能实现', items: [{ id: 'A1', goal: '实现 LRU 缓存', weight: 20 }] }] },
    createdAt: '2026-09-22T10:30:00.000Z',
    updatedAt: '2026-09-22T10:30:00.000Z',
    ...overrides,
  };
}

function makeAnthropicProvider(): Provider {
  return {
    id: 'p-anthropic',
    name: 'Anthropic 网关',
    protocolType: 'anthropic',
    baseUrl: 'https://gw.example.com/anthropic',
    apiKey: 'sk-test',
    models: [{ id: 'claude-opus-4-6', source: 'manual' }],
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };
}

let dir: string;
/** 用例仓库（本地，origin 指向下面的裸仓库） */
let root: string;
/** 裸远端 */
let bare: string;

/** 经**真实存储层**写一个用例：文件与 git 看到的是同一份内容 */
function writeCaseFile(id: string, title: string): TestCase {
  const testCase = makeCase({ id, title });
  writeCase(testCase);
  return testCase;
}

/** 写设置：默认评分模型 + 默认评分智能体就是同步智能体的来源（用户口径 Q19 不新增配置面） */
function seedSettings(options: { judge?: boolean } = {}): void {
  saveConfig({
    settings: {
      ...SETTINGS_DEFAULTS,
      workspaceRoot: join(dir, 'runs'),
      casesRoot: root,
      casesAutoCommit: false,
      defaultJudge: options.judge === false ? null : { providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
      defaultJudgeAgent: options.judge === false ? null : 'claude-code',
    },
    providers: [makeAnthropicProvider()],
  });
}

/** 在另一个克隆里往远端推一个提交（模拟「同事也改了用例」） */
function pushFromOtherClone(file: string, message: string): void {
  const other = join(dir, `other-${file}`);
  git(dir, ['clone', '-q', bare, other]);
  writeFileSync(join(other, file), `${JSON.stringify({ id: file, title: message })}\n`, 'utf8');
  git(other, ['add', '.']);
  git(other, ['commit', '-q', '-m', message]);
  git(other, ['push', '-q', 'origin', 'main']);
}

/** 轮询等待（后台同步是 fire-and-forget，没有 await 的入口） */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待用例同步结束超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  runMock.mockReset();
  runMock.mockResolvedValue(agentResult(messagesFor([])));
  resetCaseSyncForTesting();

  dir = mkdtempSync(join(tmpdir(), 'aieval-case-sync-'));
  setConfigDirForTesting(join(dir, 'config'));
  root = join(dir, 'cases');
  setCasesRootForTesting(root);
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'README.md'), '# 用例仓库\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', '初始提交']);
  bare = join(dir, 'origin.git');
  git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  seedSettings();
});

afterEach(() => {
  resetCaseSyncForTesting();
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

describe('状态快照', () => {
  it('仓库 / 远端 / 待提交 / 被忽略 / 领先数都照实说，且 blockedReason 为 null', () => {
    writeCaseFile('c-1', '本地未提交的');
    writeFileSync(join(root, 'note.txt'), '笔记\n', 'utf8');

    const status = getCaseSyncStatus();

    expect(status).toMatchObject({
      isRepo: true,
      hasRemote: true,
      blockedReason: null,
      running: false,
      pendingCount: 1,
      localAhead: 0,
      // 探到了且相等 ⇒ 0（不是 null）：界面据此**不**显示「拉取」按钮
      remoteAhead: 0,
    });
    expect(status.ignoredCount).toBeGreaterThanOrEqual(1);
  });

  it('不是 git 仓库：状态写明原因，动作也不报错（没有可同步的东西）', async () => {
    const plain = join(dir, 'plain');
    setCasesRootForTesting(plain);
    writeCase(makeCase());

    const before = getCaseSyncStatus();
    expect(before.isRepo).toBe(false);
    expect(before.blockedReason).toContain('不是 git 仓库');

    const after = await runCaseSync('commit');
    expect(after.isRepo).toBe(false);
    // 一个提交都没产生（那个目录压根不是仓库）
    expect(headCommit(root)).toBe(git(root, ['rev-parse', 'HEAD']).trim());
  });
});

describe('提交：逐文件、智能体写信息、失败回退', () => {
  it('两个文件两条提交，提交信息来自智能体，并且推到了远端', async () => {
    const base = headCommit(root)!;
    writeCaseFile('c-1', '用例一');
    writeCaseFile('c-2', '用例二');
    runMock.mockResolvedValue(
      agentResult(
        messagesFor([
          ['c-1.json', '补充缓存失效的评分标准项'],
          ['c-2.json', '新增并发安全的评分项'],
        ]),
      ),
    );

    const status = await runCaseSync('commit');

    expect(status.lastError).toBeNull();
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.pendingCount).toBe(0);

    const commits = listCommitsSince(root, base);
    expect(commits).toHaveLength(2);
    for (const commit of commits) expect(commit.files).toHaveLength(1);
    const messages = git(root, ['log', '--format=%s', '-2']).trim().split('\n');
    expect(messages).toEqual(['新增并发安全的评分项', '补充缓存失效的评分标准项']);
    // 推送也是真的：裸远端拿到同样的两条
    expect(git(bare, ['log', '--format=%s', '-2']).trim().split('\n')).toEqual(messages);

    // 智能体只被调一次（一轮同步一次），且跑在用例目录里、给的是可写档
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]?.[0]).toMatchObject({ cwd: root, permission: 'full' });
  });

  it('智能体失败 → 用确定性回退文案，文件照样提交（不卡在未提交状态）', async () => {
    writeCaseFile('c-1', '回退文案的用例');
    runMock.mockResolvedValue(agentResult(null, false));

    await runCaseSync('commit');

    expect(git(root, ['log', '--format=%s', '-1']).trim()).toBe('新增用例「回退文案的用例」');
    expect(getCaseSyncStatus().pendingCount).toBe(0);
  });

  it('只提交用例文件：README / 笔记留在工作区，只计数', async () => {
    const base = headCommit(root)!;
    writeFileSync(join(root, 'README.md'), '# 改过\n', 'utf8');
    writeFileSync(join(root, 'note.txt'), '笔记\n', 'utf8');
    writeCaseFile('c-1', '用例一');

    const status = await runCaseSync('commit');

    const commits = listCommitsSince(root, base);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toEqual(['c-1.json']);
    expect(git(root, ['status', '--porcelain'])).toContain('README.md');
    expect(status.ignoredCount).toBeGreaterThanOrEqual(2);
  });

  it('没有待提交的用例文件时「提交」不产生空提交', async () => {
    const base = headCommit(root)!;

    await runCaseSync('commit');

    expect(listCommitsSince(root, base)).toEqual([]);
    // 一轮「无事可做」不算一次成功（lastSuccessAt 留给真的落了提交的那轮）
    expect(getCaseSyncStatus().lastAttemptAt).not.toBeNull();
    expect(getCaseSyncStatus().lastSuccessAt).toBeNull();
  });
});

describe('拉取与分叉', () => {
  it('远端领先且本地干净 → 快进对齐（本地没有领先提交时不产生推送）', async () => {
    pushFromOtherClone('c-9.json', '别人加的用例');

    await runCaseSync('pull');

    expect(headCommit(root)).toBe(git(bare, ['rev-parse', 'HEAD']).trim());
    expect(getCaseSyncStatus().lastError).toBeNull();
  });

  it('工作区还有未提交的用例文件 → 拒绝拉取并说清先做什么，一个字节都不动', async () => {
    writeCaseFile('c-1', '本地未提交的');
    const before = headCommit(root);

    await expect(runCaseSync('pull')).rejects.toThrow(/先点「提交」/);

    expect(headCommit(root)).toBe(before);
    expect(getCaseSyncStatus().pendingCount).toBe(1);
  });

  /**
   * **「绝不 force push」在编排层的那一条**：本地有未推送提交、远端也被别人推过（分叉），
   * 合并智能体又失败 ⇒ 必须报错、保留本地提交、远端历史一个字节不动。
   * 变异体：给 `pushRemote` 加上 `--force` 之后，这条会以「远端历史被改写」失败。
   */
  it('分叉且合并智能体失败：不推送、远端不动、本地提交保留', async () => {
    writeCaseFile('c-1', '我的用例');
    commitFile(root, 'c-1.json', '我的用例'); // 只提交、不推送 ⇒ 本地领先 1
    const localHead = headCommit(root)!;
    pushFromOtherClone('c-2.json', '别人的用例');
    const remoteHead = git(bare, ['rev-parse', 'HEAD']).trim();

    // 只有合并这一次会起智能体（没有待提交文件，故不会问提交信息），让它失败
    runMock.mockResolvedValue(agentResult(null, false));

    await expect(runCaseSync('pull')).rejects.toThrow(/分叉|合并/);

    expect(git(bare, ['rev-parse', 'HEAD']).trim()).toBe(remoteHead);
    expect(headCommit(root)).toBe(localHead);
    expect(getCaseSyncStatus().lastError).toContain('合并');
  });
});

describe('自动触发：防抖 + 合并', () => {
  it('连续两次变更合并成一轮同步（智能体只被调一次，两个文件各一条提交）', async () => {
    const base = headCommit(root)!;
    writeCaseFile('c-1', '用例一');
    writeCaseFile('c-2', '用例二');

    vi.useFakeTimers();
    try {
      enqueueCaseSync('第一次变更');
      enqueueCaseSync('第二次变更');
      // 防抖窗口没过完之前**一次都不该跑**（这正是「不阻塞保存」的代价与收益）
      vi.advanceTimersByTime(999);
      expect(runMock).not.toHaveBeenCalled();
      // 满窗点火；之后切回真实事件循环等它排空（排空本身不依赖定时器）
      vi.advanceTimersByTime(1);
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => getCaseSyncStatus().lastAttemptAt !== null && !getCaseSyncStatus().running);

    // 两次变更合并成**一轮**：智能体只被叫一次，而两个文件各拿到一条提交
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(listCommitsSince(root, base)).toHaveLength(2);
  });
});
