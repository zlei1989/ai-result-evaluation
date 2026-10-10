// @vitest-environment node
/**
 * collectDiff —— 三样合并的四种组合（切分后的第二块）
 *
 * 本文件是 `git.diff.test.ts` 拆分后的一块：真实仓库模板、`git()` / `section()` 助手与清理钩子都在 `./testing/git-diff-harness`。
 */
import { describe, expect, it } from 'vitest';
import {
  git,
  makeRepo,
  section,
  COMMITTED,
  UNCOMMITTED,
  UNTRACKED,
  writeFileSync,
  join,
  collectDiff,
  registerGitDiffHooks,
} from './testing/git-diff-harness';



registerGitDiffHooks();

describe('collectDiff —— 三样合并的四种组合', () => {
  /**
   * 计数与正文是**一次** `git diff --numstat -p` 拿回来的（少一次进程创建，见 `splitNumstatPatch`）。
   * 这条守卫钉的是那个切分点**只看行首**：
   * 用例造一个**文件名里就含 `diff --git `** 的文件——计数行是 `2\t0\tdiff --git fake.txt`，
   * 那个子串出现在行中而不是行首。切分点改成按子串找（`indexOf('diff --git ')`）时会在这里提前切断：
   * 计数段只剩 `2\t0\t`（路径解析成空串）、正文段以一个不存在的文件名开头。
   * 变异验证：把切分改成 `indexOf` 后这条**确实红**。
   */
  it('被 gitignore 的新文件：**不得**进入 diff（正文尤其不能进——那是密钥泄漏路径）', () => {
    const { dir, base } = makeRepo('aieval-diff-ignored-');
    writeFileSync(join(dir, '.gitignore'), 'secret.log\n', 'utf8');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-q', '-m', '加入 gitignore');

    writeFileSync(join(dir, 'secret.log'), 'API_KEY=sk-live-should-never-reach-the-judge\n', 'utf8');
    const result = collectDiff(dir, base);
    // 第三个来源是「未跟踪的新文件」= `git status --porcelain` 的 `??`，
    // 而 `??` **不含**被 gitignore 的文件。忽略是有意的信号：构建产物、`node_modules`、
    // `.env` 都不该被当成候选的产出，更不该把 `.env` 的正文送进评分。
    expect(result.text).not.toContain('sk-live-should-never-reach-the-judge');
    expect(result.files.some((file) => file.path === 'secret.log')).toBe(false);

    // 顺带守 baseline 参数的语义：传入的是调用方给的基线，而不是内部偷偷用 HEAD 覆盖
    // （基线选在 `.gitignore` 提交之前，那份改动就该出现在「已提交改动」段里）
    // 复用第一次的结果：这里若再跑一次 collectDiff，一个用例就是 17 次 git 进程，
    // 全包并行时会撞 vitest 的默认 5s 超时——review 的 flake 项）
    expect(section(result.text, COMMITTED)).toContain('.gitignore');
  });
  it('三者都有：三段各自非空、计数是三者之和', () => {
    const { dir, base } = makeRepo('aieval-diff-all-');
    // ① 已提交：
    writeFileSync(join(dir, 'committed.ts'), 'export const committed = 1;\n', 'utf8');
    git(dir, 'add', 'committed.ts');
    git(dir, 'commit', '-q', '-m', '已提交的改动');
    // ② 未提交：
    writeFileSync(join(dir, 'a.txt'), 'hello\ndirty\n', 'utf8');
    // ③ 未跟踪：
    writeFileSync(join(dir, 'untracked.ts'), 'export const untracked = 2;\n', 'utf8');

    const result = collectDiff(dir, base);
    expect(section(result.text, COMMITTED)).toContain('+export const committed = 1;');
    expect(section(result.text, UNCOMMITTED)).toContain('+dirty');
    expect(section(result.text, UNTRACKED)).toContain('untracked.ts');
    expect(result.text).toContain('+export const untracked = 2;');
    expect(result.filesChanged).toBe(3);
    expect(result.files.map((file) => file.path).sort()).toEqual(['a.txt', 'committed.ts', 'untracked.ts']);
    expect(result.insertions).toBe(3);
    expect(result.deletions).toBe(0);
  });
  it('删除一个文件也算改动（计数是 0 增 1 删，不能因为 insertions 为 0 就漏掉它）', () => {
    const { dir, base } = makeRepo('aieval-diff-delete-');
    git(dir, 'rm', '-q', 'a.txt');
    const result = collectDiff(dir, base);
    expect(result.filesChanged).toBe(1);
    expect(result.files[0]?.deletions).toBe(1);
    expect(result.files[0]?.insertions).toBe(0);
  });
  it('中文文件名不被打成八进制转义（`core.quotepath=false` 的回归守卫）', () => {
    const { dir, base } = makeRepo('aieval-diff-cjk-');
    writeFileSync(join(dir, '中文文件.txt'), '内容\n', 'utf8');
    const result = collectDiff(dir, base);
    expect(result.text).toContain('中文文件.txt');
    expect(result.files.map((file) => file.path)).toContain('中文文件.txt');
  });
  it('未跟踪段的正文只是路径清单，不重复贴未提交的 diff 正文（钉死的格式）', () => {
    const { dir, base } = makeRepo('aieval-diff-shape-');
    writeFileSync(join(dir, 'new.ts'), 'export const answer = 42;\n', 'utf8');
    // 再改一个**受跟踪**文件：它出现在未跟踪段里才是真正的串段
    writeFileSync(join(dir, 'a.txt'), 'hello\ndirty\n', 'utf8');

    const result = collectDiff(dir, base);
    const body = section(result.text, UNTRACKED);
    expect(body).toContain('new.ts');
    // 界面直接渲染这段文本：串进来会让同一份 diff 在文本里出现两次，受跟踪文件的 hunk
    // 还会挂在「未跟踪文件」标题下面，并且让 truncateDiff 报「某文件被丢弃」而它的孪生正文仍在
    expect(body).not.toContain('diff --git');
    expect(body).not.toContain('+dirty');
    // 正文没有因此丢失：它经由未提交段到达文本（核心断言仍然成立）
    expect(section(result.text, UNCOMMITTED)).toContain('+export const answer = 42;');
    expect(section(result.text, UNCOMMITTED)).toContain('+dirty');
  });
  it('同一工作区里第二次调用仍把新文件列在未跟踪段（`-N` 之后状态是 ` A`，分类必须稳定）', () => {
    const { dir, base } = makeRepo('aieval-diff-idem-');
    writeFileSync(join(dir, 'new.ts'), 'export const answer = 42;\n', 'utf8');

    const first = collectDiff(dir, base);
    const second = collectDiff(dir, base);
    expect(section(first.text, UNTRACKED)).toContain('new.ts');
    // 第一次调用自己跑过 `-N`，第二次看到的 porcelain 已经是 ` A new.ts`：只认 `??` 的实现
    // 这里会变成「（无）」，同一个文件从「新文件」漂移成「已改文件」
    expect(section(second.text, UNTRACKED)).toContain('new.ts');
    expect(second.filesChanged).toBe(first.filesChanged);
    // 更强的一条：两次调用应当给出完全相同的文本（分类稳定 = 幂等）
    expect(second.text).toBe(first.text);
  });
});
