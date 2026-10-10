// @vitest-environment node
/**
 * createCase / listCases / getCase
 *
 * 本文件是 `cases.test.ts` 拆分后的一块：共享夹具、真实 git 助手与两条 `vi.mock`（node:fs / node:child_process 的计数探针）都在 `./testing/cases-harness`，那里写明了为什么前导块必须在每个文件里逐字重复（vitest 的前置提升只作用于本文件）。
 */

import { vi, describe, expect, it } from 'vitest';
import {
  dir,
  ws,
  repo,
  git,
  makeRepo,
  caseInput,
  makeRun,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  join,
  ServiceError,
  listStoredCases,
  getRun,
  saveRun,
  createCase,
  deleteCase,
  getCase,
  listCases,
  listCommitCandidates,
  registerCasesHooks,
  setCasesRootForTesting,
} from './testing/cases-harness';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

registerCasesHooks();

describe('createCase / listCases / getCase', () => {
  it('创建后落盘：时间戳是 ISO、id 是 UUID 形态、commitHash 为 null 表示默认 HEAD', () => {
    const created = createCase(caseInput());

    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(created.commitHash).toBeNull();
    // 落盘是它唯一的价值：重新读配置必须能拿到（响应体是内存对象，证明不了持久化）
    expect(listStoredCases().cases.map((item) => item.id)).toEqual([created.id]);
    expect(getCase(created.id)).toEqual(created);
  });

  it('commitHash 传空串时归一成 null（表单清空输入框拿到的是空串）', () => {
    const created = createCase(caseInput({ commitHash: '' }));

    expect(created.commitHash).toBeNull();
  });

  it('短哈希被解析成完整 40 位 hash 落盘（否则列表的 Tooltip 显不出全量）', () => {
    const fullHash = git(['rev-parse', 'HEAD'], repo).trim();

    const created = createCase(caseInput({ commitHash: fullHash.slice(0, 7) }));

    expect(created.commitHash).toBe(fullHash);
    expect(created.commitHash).toHaveLength(40);
  });

  it('仓库不是 git 仓库时抛 NOT_A_GIT_REPO，且不落盘', () => {
    const notRepo = join(dir, 'plain-dir');
    mkdirSync(notRepo, { recursive: true });

    let caught: unknown;
    try {
      createCase(caseInput({ repoPath: notRepo }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect(listStoredCases().cases).toEqual([]);
  });

  it('commit hash 不存在时抛 INVALID_REF，且不落盘', () => {
    let caught: unknown;
    try {
      createCase(caseInput({ commitHash: 'f'.repeat(40) }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect(listStoredCases().cases).toEqual([]);
  });

  // 服务端一侧：候选下拉只是便利，**不是白名单**。
  // 造 25 次提交，取最早那次（它必然不在「最近 20 条」里）——它必须能存进去。
  it('createCase 接受不在最近 20 条候选里的真实 commit（候选不是白名单）', () => {
    const { dir: manyRepo, hashes } = makeRepo('many-repo', 25);
    const oldest = hashes[0]!;

    const created = createCase(caseInput({ repoPath: manyRepo, commitHash: oldest }));

    expect(created.commitHash).toBe(oldest);
    // 顺带确认它确实不在候选里（否则这条用例等于没测到白名单这个风险）
    expect(listCommitCandidates({ repoPath: manyRepo, repoBranch: null }).map((commit) => commit.hash)).not.toContain(oldest);
  });






});

describe('deleteCase', () => {
  it('删除后列表里没有它，返回受影响评测数（数的是引用它的快照）', () => {
    const created = createCase(caseInput());
    const other = createCase(caseInput({ title: '另一个用例' }));
    saveRun(makeRun('run-1', created.id, created.title, created.repoPath, null));
    saveRun(makeRun('run-2', created.id, created.title, created.repoPath, null));
    saveRun(makeRun('run-3', other.id, other.title, other.repoPath, null));

    const result = deleteCase(created.id);

    expect(result.affectedRuns).toBe(2);
    expect(listCases().cases.map((item) => item.id)).toEqual([other.id]);
  });

  // 真实场景里缓存目录常常压根不存在（第一次评测还没跑）。它绝不能让「删用例」失败。
  it('缓存目录不存在时删除照样成功', () => {
    const created = createCase(caseInput());

    expect(deleteCase(created.id)).toEqual({ affectedRuns: 0 });
  });

  it('一并删除用例级缓存仓库 {workspaceRoot}/cases/{caseId}/cache', () => {
    const created = createCase(caseInput());
    const cacheDir = join(ws, 'cases', created.id, 'cache');
    mkdirSync(join(cacheDir, '.git'), { recursive: true });
    writeFileSync(join(cacheDir, 'README.md'), '缓存仓库内容', 'utf8');
    expect(existsSync(cacheDir)).toBe(true);

    deleteCase(created.id);

    expect(existsSync(cacheDir)).toBe(false);
  });

  // 缓存删不掉（Windows 上文件被占用、目录被别的进程锁住）不阻断删除本身。
  // 制造失败的方式是**把 rmSync 打挂一次**，而不是造一个「删不掉的目录」：
  // 后者在 CI 上不可靠（Node 的 rmSync 对文件路径会直接 unlink、对空目录总能删掉），
  // 断言会变成「删成功了也叫失败被容忍」的空转。
  //
  // 用例搬成一文件一落之后，`deleteCase` 里有两处 rmSync（先删用例文件、再清缓存目录），
  // 故失败必须精确打在**第二次**上：打错一次，被测的「删掉了没有」本身就没了。
  // 顺序由 `deleteCase` 定死（`deleteCaseFile` → `removeCaseCache`），这里顺带把它钉住。
  it('缓存删除失败不阻断删除（用例文件照样消失，只记一条 WARN）', () => {
    const created = createCase(caseInput());
    // 第一次（删用例文件）走真实实现：工厂里给的就是真 rmSync
    const realRmSync = vi.mocked(rmSync).getMockImplementation();
    vi.mocked(rmSync)
      .mockImplementationOnce((target, options) => realRmSync?.(target, options))
      .mockImplementationOnce(() => {
        throw new Error('EPERM: operation not permitted, rmdir');
      });

    const result = deleteCase(created.id);

    expect(result.affectedRuns).toBe(0);
    expect(listStoredCases().cases).toEqual([]);
  });

  // 守的是核心承诺：评测记录靠 EvalRun 的冗余快照继续可读。
  // 变异验证——把「顺手删掉相关运行目录」这种看似合理的实现制造回去，本用例必须失败。
  it('删除用例后，引用它的评测记录仍可读，且 caseTitle / repoPath / commitHash 快照仍在', () => {
    const created = createCase(caseInput({ commitHash: git(['rev-parse', 'HEAD'], repo).trim() }));
    saveRun(makeRun('run-1', created.id, created.title, created.repoPath, created.commitHash));

    deleteCase(created.id);

    const run = getRun('run-1');
    expect(run.caseId).toBe(created.id);
    expect(run.caseTitle).toBe(created.title);
    expect(run.repoPath).toBe(created.repoPath);
    expect(run.commitHash).toBe(created.commitHash);
    expect(run.status).toBe('done');
  });

  it('deleteCase 对不存在的 id 抛 NOT_FOUND', () => {
    expect(() => deleteCase('missing')).toThrow(ServiceError);
  });
});

/**
 * 保存失败的归因：对外必须是可直接展示的中文原因，而不是裸 errno。
 * 用例现在**一文件一落**（不再写 `config.json`），故制造失败的位置也换成了用例目录：
 * 把根目录换成一个被同名文件占住的路径，`mkdirSync(recursive)` 就会抛 ENOTDIR。
 */
describe('用例保存失败的错误信封', () => {
  it('用例文件写盘失败时折成带用例目录路径的中文 INTERNAL', () => {
    const occupied = join(dir, 'occupied-cases');
    writeFileSync(occupied, 'x', 'utf8');
    // 覆盖值就是存储层的根目录：写盘必然失败，且失败原因必须点名它落在哪
    setCasesRootForTesting(occupied);

    let caught: unknown;
    try {
      createCase(caseInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('用例保存失败');
    expect((caught as ServiceError).message).toContain(occupied);
  });
});
