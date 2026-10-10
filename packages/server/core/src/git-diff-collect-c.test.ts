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
  mkdirSync,
  writeFileSync,
  join,
  ServiceError,
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
  it('二进制文件的两列是 `-`：按 0/0 计，绝不把 NaN 带进三个计数', () => {
    const { dir, base } = makeRepo('aieval-diff-binary-');
    // 含 NUL 字节 → git 判定为二进制，numstat 的两列都是 `-`
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f]));
    git(dir, 'add', 'blob.bin');
    git(dir, 'commit', '-q', '-m', '加一个二进制文件');

    const result = collectDiff(dir, base);
    expect(result.files.map((file) => file.path)).toContain('blob.bin');
    expect(result.files[0]?.insertions).toBe(0);
    expect(result.files[0]?.deletions).toBe(0);
    // 关键：不能是 NaN——NaN 会污染界面的展示与落盘 JSON，三个计数一起废
    expect(Number.isNaN(result.insertions)).toBe(false);
    expect(Number.isNaN(result.deletions)).toBe(false);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
  });
  it('重命名的路径是「改完之后叫什么」，不是 `old => new` 的花括号形式', () => {
    const { dir } = makeRepo('aieval-diff-rename-');
    // 把重命名检测钉死在仓库级配置上，不依赖跑测试那台机器的 diff.renames
    git(dir, 'config', 'diff.renames', 'true');
    writeFileSync(join(dir, 'old-name.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n', 'utf8');
    git(dir, 'add', 'old-name.ts');
    git(dir, 'commit', '-q', '-m', '先加旧名字的文件');
    const renameBase = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'mv', 'old-name.ts', 'new-name.ts');
    git(dir, 'commit', '-q', '-m', '重命名');

    const result = collectDiff(dir, renameBase);
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('new-name.ts');
    expect(paths.some((path) => path.includes('=>'))).toBe(false);
    expect(paths.some((path) => path.includes('{') || path.includes('}'))).toBe(false);
  });
  it('子目录里的重命名：`packages/{old => new}/x.ts` 的**前缀必须保留**（只换花括号那一段）', () => {
    // git 只在两条路径没有公共前后缀时才写 `old => new`；有公共前后缀时写成 `prefix/{old => new}/suffix`
    // （本机实测于 git 2.47：`0\t0\tpackages/{old => new}/x.ts`）。
    // 切掉最后一个 `=>` 之前的全部内容的实现会得到 `new/x.ts`——一个根本不存在的路径：
    // 界面的文件树会渲染出幽灵条目，两个不同目录下的同名重命名还会在按路径去重里撞成一个键。
    const { dir } = makeRepo('aieval-diff-rename-sub-');
    git(dir, 'config', 'diff.renames', 'true');
    mkdirSync(join(dir, 'packages', 'old'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'old', 'x.ts'),
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
      'utf8',
    );
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', '先加 packages/old/x.ts');
    const renameBase = git(dir, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(dir, 'packages', 'new'), { recursive: true });
    git(dir, 'mv', 'packages/old/x.ts', 'packages/new/x.ts');
    git(dir, 'commit', '-q', '-m', '子目录里重命名');

    const result = collectDiff(dir, renameBase);
    expect(result.files.map((file) => file.path)).toEqual(['packages/new/x.ts']);
    expect(result.filesChanged).toBe(1);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
  });
  it('同一路径既已提交又未提交：只算一行，行数是两段之和', () => {
    const { dir, base } = makeRepo('aieval-diff-same-path-');
    writeFileSync(join(dir, 'a.txt'), 'hello\ncommitted\n', 'utf8');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', '先提交一次改动');
    writeFileSync(join(dir, 'a.txt'), 'hello\ncommitted\ndirty\n', 'utf8');

    const result = collectDiff(dir, base);
    // 两段 hunk 都要在文本里：那是评分模型的真相，不做任何合并
    expect(section(result.text, COMMITTED)).toContain('+committed');
    expect(section(result.text, UNCOMMITTED)).toContain('+dirty');
    // 但文件清单只出现一次，行数是两段之和（这条路径相对 baseline 一共变了多少）
    expect(result.filesChanged).toBe(1);
    expect(result.files).toEqual([{ path: 'a.txt', insertions: 2, deletions: 0 }]);
    expect(result.insertions).toBe(2);
    expect(result.deletions).toBe(0);
  });
  it('基线 commit 不存在时报 ServiceError（中文原因 + git 原文留在 context），不让英文 fatal 冒到界面', () => {
    const { dir } = makeRepo('aieval-diff-badbase-');
    let caught: unknown;
    try {
      collectDiff(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    // 用户文案必须是中文的（不允许把 git 的英文原文当用户文案）
    expect((caught as Error).message).toContain('读取已提交改动失败');
    // 但 git 的原文必须留在 context 里供排查
    expect((caught as ServiceError).context).toMatchObject({
      gitMessage: expect.stringContaining('deadbeef') as unknown as string,
    });
  });
  it('空基线（空串 = 尚未准备）直接抛中文 INTERNAL，绝不降级成 `HEAD..HEAD` 的空 diff', () => {
    // `git diff ..HEAD` 是合法的：git 把它当成 `HEAD..HEAD`，退出码 0、输出为空（本机实测 git 2.47）。
    // 于是「准备阶段失败、baselineCommit 还空着」的行会拿到一份**看起来没改动**的 diff 并照常打分——
    // 最坏的那类失败（静默给出错误的高分），而调用方从返回值里看不出基线是空的。
    const { dir } = makeRepo('aieval-diff-emptybase-');
    writeFileSync(join(dir, 'a.txt'), 'hello\nagent 的改动\n', 'utf8');

    let caught: unknown;
    try {
      collectDiff(dir, '');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as Error).message).toContain('基线');
    // 纯空白同样不是合法基线（只有 `''` 是「尚未准备」，空白串连语义都没有）
    expect(() => collectDiff(dir, '   ')).toThrow(ServiceError);
  });
});
