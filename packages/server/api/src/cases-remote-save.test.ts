// @vitest-environment node
/**
 * 用例保存（远端来源）
 *
 * 本文件是从 `cases-remote.test.ts` 拆出来的一半（同前导块、同 harness）：
 * 一个文件里的用例是**顺序**跑的，拆开才能让两块并行。
 */
import { vi, describe, expect, it } from 'vitest';
import {
  dir,
  ws,
  repo,
  git,
  makeRemoteOrigin,
  REMOTE_FIXTURE_TIMEOUT_MS,
  caseInput,
  uiPatchOf,
  existsSync,
  readdirSync,
  renameSync,
  writeFileSync,
  join,
  listStoredCases,
  createCase,
  deleteCase,
  getCase,
  updateCase,
  registerCasesHooks,
} from './testing/cases-harness';
import { removeTreeWithRetry } from './testing/cleanup';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

registerCasesHooks();

/**
 * 保存侧的远端判定：落盘的是**归一后**的来源与分支，坏值一律在写入口拦下。
 * 三条口径都在这里钉住：远端 URL 去尾斜杠后落盘、分支归一（`'   '` 不能落成「有值」）、
 * 本地来源填分支按**值**判（UI 的补丁永远是全量的）。
 */
describe('用例保存（远端来源）', () => {
  it('远端用例落盘 URL 原文与归一后的分支；commit 留空即 null', () => {
    const origin = makeRemoteOrigin('remote-save', ['feat/x']);
    const created = createCase(caseInput({ repoPath: `  ${origin.url}/  `, repoBranch: ' feat/x ' }));

    expect(created.repoPath).toBe(origin.url);
    expect(created.repoBranch).toBe('feat/x');
    expect(listStoredCases().cases.find((item) => item.id === created.id)).toMatchObject({
      repoPath: origin.url,
      repoBranch: 'feat/x',
    });
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  it('坏值不在写入口放行：分支不存在 / commit 不存在都拒绝且不落盘', () => {
    const origin = makeRemoteOrigin('remote-save-bad');
    expect(() => createCase(caseInput({ repoPath: origin.url, repoBranch: 'feat/nope' }))).toThrow(/分支不存在/);
    expect(() => createCase(caseInput({ repoPath: origin.url, commitHash: '0'.repeat(40) }))).toThrow(/commit 不存在/);
    expect(listStoredCases().cases).toHaveLength(0);
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  /**
   * 镜像还没更新的分支不该被拒：先在镜像里判、判不过才抓一次再判（与 ensureCaseCache 同口径）。
   * 断言只覆盖**结果**（刚推上来的分支能存进去）——「只抓一次」是机制、不在本用例的观察范围内，
   * 所以标题不承诺 fetch 次数（「只 fetch 一次再判」是超出断言的承诺）。
   */
  it('远端刚推上来的分支仍能保存（镜像里此刻还没有它，判不过就再抓一次）', () => {
    const origin = makeRemoteOrigin('remote-save-fresh');
    // 先建用例把镜像建出来，再在「远端」新增分支——镜像里此刻还没有它
    createCase(caseInput({ repoPath: origin.url }));
    const work = join(dir, 'fresh-work');
    git(['clone', '-q', origin.url, work], dir);
    git(['checkout', '-q', '-b', 'feat/fresh'], work);
    writeFileSync(join(work, 'fresh.txt'), 'fresh\n', 'utf8');
    git(['add', '.'], work);
    git(['commit', '-q', '-m', 'fresh'], work);
    git(['push', '-q', 'origin', 'HEAD:feat/fresh'], work);

    const created = createCase(caseInput({ repoPath: origin.url, repoBranch: 'feat/fresh' }));
    expect(created.repoBranch).toBe('feat/fresh');
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  /**
   * A7 / 派发口径：路由的 zod 拦不住纯空白——`z.string().min(1)` 数的是**长度**，`'   '` 长度是 3、
   * 原样过关（它不会 trim，也就不会把它变成 null）；而 `validateRepo` 会把空白归一成「不指定分支」
   * 并回显默认分支。保存侧不归一就会出现「校验显示 main，落盘的用例写着 `'   '`」——
   * 两者说的是两个不同的来源，而且 `'   '` 还会被 `TestCaseSchema`（同样只有 `min(1)`）当成合法值收下。
   */
  it('分支是纯空白 → 落盘 null（与 validateRepo 的归一同一口径，不落成「有值」）', () => {
    // 夹具刻意**不经过路由的 zod**：那层只数长度、不做 trim，放过去的正是这个 `'   '`。
    // 服务层是来源形态的唯一判定点，它自己必须认空白（zod 在这里挡不住任何东西）。
    const origin = makeRemoteOrigin('remote-save-blank-branch');
    const created = createCase(caseInput({ repoPath: origin.url, repoBranch: '   ' }));

    expect(created.repoBranch).toBeNull();
    expect(listStoredCases().cases[0]?.repoBranch).toBeNull();
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  /**
   * **远端**路径上的另一半：来源的归一（去尾斜杠）是「到底改没改」的判据，
   * 而归一后**相等**就必须走「本次没改」那条路——一次仓库校验都不该跑。
   *
   * 构造上刻意把「改了没有」与「仓库还在不在」做成互斥的两件事：把远端整体改名、再把镜像删掉，
   * 然后回交一个只多一条尾斜杠的**同一个** URL。
   *   · 归一成立 ⇒ 判为没改 ⇒ 不碰仓库、不碰镜像 ⇒ 保存成功（本用例断言的就这一条）；
   *   · 归一旦被删掉 ⇒ 判为改了 ⇒ `resolveCaseSource` 去确保镜像，而远端已被改名
   *     ⇒ 当场 `NOT_A_GIT_REPO`。
   * 所以这条守卫证明的是「值没变就不校验仓库」在远端路径上同样成立，而不是「校验能过」。
   */
  it('远端来源只多一条尾斜杠时判为「没改」：远端被改名、镜像被删也照样保存（值没变就不校验仓库）', () => {
    const origin = makeRemoteOrigin('remote-save-normalized');
    const created = createCase(caseInput({ repoPath: origin.url }));
    // 把「改没改」与「仓库还在不在」分开：这两件事都在这里被拿掉
    renameSync(join(dir, 'remote-save-normalized.git'), join(dir, 'remote-save-normalized.git.moved'));
    removeTreeWithRetry(join(ws, 'remotes'));

    const next = updateCase(created.id, uiPatchOf(getCase(created.id), { repoPath: `${origin.url}/` }));

    expect(next.repoPath).toBe(origin.url);
    expect(getCase(created.id).repoPath).toBe(origin.url);
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  it('本地来源填分支 → INVALID_QUERY（按值判，不受全量补丁影响）', () => {
    const created = createCase(caseInput({ repoPath: repo }));
    expect(() => updateCase(created.id, { repoBranch: 'main' })).toThrow(/不支持分支/);
    // 值没变的「假改动」不该被拦（UI 发出来的补丁永远是全量的）
    expect(() => updateCase(created.id, { repoPath: repo, repoBranch: null })).not.toThrow();
  });

  /**
   * A10②：`updateCase` 必须**合并** `patch.repoBranch`。
   * 少了这条守卫，「切分支保存」是静默无操作——接口 200、界面显示成功、落盘还是旧分支，
   * 而那正是最坏的失败（用户以为生效了）。
   *
   * 本地来源的分支恒为 null，写不出「从 null 变成某个分支」这个形状，所以这条只能用远端用例：
   * 它是唯一能让「合没合」在落盘值上可观察的夹具。
   */
  it('updateCase 把空分支改成具体分支 → 落盘就是那个分支（patch.repoBranch 被合并）', () => {
    const origin = makeRemoteOrigin('remote-save-update', ['feat/y']);
    const created = createCase(caseInput({ repoPath: origin.url }));
    expect(created.repoBranch).toBeNull();

    const next = updateCase(created.id, { repoPath: origin.url, repoBranch: 'feat/y' });

    expect(next.repoBranch).toBe('feat/y');
    expect(getCase(created.id).repoBranch).toBe('feat/y');
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  it('删除用例只清用例缓存，不动镜像（镜像是跨用例复用的缓存）', () => {
    const origin = makeRemoteOrigin('remote-delete');
    const created = createCase(caseInput({ repoPath: origin.url }));
    expect(readdirSync(join(ws, 'remotes'))).toHaveLength(1);

    deleteCase(created.id);

    expect(existsSync(join(ws, 'cases', created.id))).toBe(false);
    expect(readdirSync(join(ws, 'remotes'))).toHaveLength(1);
  }, REMOTE_FIXTURE_TIMEOUT_MS);
});
