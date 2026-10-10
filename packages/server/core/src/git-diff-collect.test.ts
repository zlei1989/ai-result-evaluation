// @vitest-environment node
/**
 * collectDiff —— 三样合并的四种组合
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
  it('文件名里含 `diff --git ` 时计数段与正文都不被截断（切分点只看行首）', () => {
    const { dir, base } = makeRepo('aieval-diff-odd-name-');
    const oddName = 'diff --git fake.txt';
    writeFileSync(join(dir, oddName), 'hello\nworld\n', 'utf8');
    const result = collectDiff(dir, base);
    expect(result.files.map((file) => file.path)).toEqual([oddName]);
    expect(result.filesChanged).toBe(1);
    expect(result.insertions).toBe(2);
    // 正文也必须完整：被提前切断时「未提交」段里读不到 hunk 正文
    expect(section(result.text, UNCOMMITTED)).toContain('hello');
  });

  it('全空：三段都在、都写「（无）」、计数全 0', () => {
    const { dir, base } = makeRepo('aieval-diff-empty-');
    const result = collectDiff(dir, base);
    expect(result.text).toContain(COMMITTED);
    expect(result.text).toContain(UNCOMMITTED);
    expect(result.text).toContain(UNTRACKED);
    expect(section(result.text, COMMITTED)).toContain('（无）');
    expect(result.filesChanged).toBe(0);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('只有已提交改动：出现在第一段，第二段为空', () => {
    const { dir, base } = makeRepo('aieval-diff-commit-');
    writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n', 'utf8');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'agent 提交了改动');

    const result = collectDiff(dir, base);
    expect(section(result.text, COMMITTED)).toContain('+world');
    expect(section(result.text, UNCOMMITTED)).toContain('（无）');
    expect(result.insertions).toBe(1);
    expect(result.filesChanged).toBe(1);
    expect(result.files[0]?.path).toBe('a.txt');
  });

  it('只有未提交改动：出现在第二段，第一段为空（**专门用例**：只取 commit..HEAD 会给出空 diff 却照样打分）', () => {
    const { dir, base } = makeRepo('aieval-diff-dirty-');
    writeFileSync(join(dir, 'a.txt'), 'hello\nuncommitted\n', 'utf8');

    const result = collectDiff(dir, base);
    // ① 第一段必须是空的——这正是「只取 commit..HEAD」的实现会看到的世界
    expect(section(result.text, COMMITTED)).toContain('（无）');
    expect(section(result.text, COMMITTED)).not.toContain('+uncommitted');
    // ② 未提交的改动必须出现在第二段（这条就是回归守卫本体）
    expect(section(result.text, UNCOMMITTED)).toContain('+uncommitted');
    // ③ 未跟踪段此时应为空：改动的是**已跟踪**文件，不该被算成「未跟踪」
    expect(section(result.text, UNTRACKED)).toContain('（无）');
    expect(result.filesChanged).toBe(1);
    expect(result.insertions).toBe(1);
    expect(result.files[0]?.path).toBe('a.txt');
  });

  it('只有未跟踪新文件：**正文**必须出现在 diff 文本里（**专门用例**，核心）', () => {
    const { dir, base } = makeRepo('aieval-diff-untracked-');
    writeFileSync(join(dir, 'new.ts'), 'export const answer = 42;\n', 'utf8');

    const result = collectDiff(dir, base);
    // 未跟踪清单里要有它：不做 `git add --intent-to-add` 的实现，文本里连文件名都没有
    expect(section(result.text, UNTRACKED)).toContain('new.ts');
    // 核心断言：正文逐字在文本里。不登记的实现只能给出文件名，
    // 评分模型看不见新文件写了什么，会把「看不到的改动」当成「没改」。
    expect(result.text).toContain('+export const answer = 42;');
    expect(result.filesChanged).toBe(1);
    expect(result.insertions).toBe(1);
    expect(result.files[0]?.path).toBe('new.ts');
  });

  it('未跟踪的新文件必须被**列出**、且**正文**出现在未提交段（读序已不可分辨，见注释）', () => {
    const { dir, base } = makeRepo('aieval-diff-order-');
    writeFileSync(join(dir, 'late.ts'), 'export const late = 1;\n', 'utf8');

    const result = collectDiff(dir, base);
    // 本条守的是「未跟踪段必须列出这个文件名」+「它的正文必须出现在未提交段里」，
    // **不守读取顺序**：`parseUntracked` 同时接受 `?? `（登记前）与 ` A `（`-N` 登记后），
    // 两种读序得到同一份路径清单，因此没有任何断言能区分它们（把这一步挪到
    // `-N` 之后，全套仍 20/20 绿）。放宽成接受 ` A ` 是**必需**的——`collectDiff` 自己会跑
    // `-N`，同一工作区的第二次调用看到的就是 ` A`（见 git.ts 的 parseUntracked JSDoc）。
    // 计划原文那句「挪到 `-N` 之后这条会失败」在出货文本上不成立，已撤下；
    // 读序是**冗余保险**，不是被钉住的守卫。
    expect(section(result.text, UNTRACKED)).toContain('late.ts');
    // 且登记确实发生了：文件的**正文**出现在未提交段里（`-N` 之后 `git diff HEAD` 才带它）
    expect(section(result.text, UNCOMMITTED)).toContain('+export const late = 1;');
    expect(result.filesChanged).toBe(1);
  });












});
