// @vitest-environment node
/**
 * extractDiffFile：按路径取单文件 diff 正文。
 *
 * 两个来源的路径键必须能对上，这是本文件存在的理由：
 * 索引里的 path 来自 `--numstat`（经 rewriteRenamePath 归一），
 * 正文段的 path 来自 `diff --git` 头（原样）——重命名时两者不相等，
 * 不过同一份归一函数就会出现「索引里有的文件，正文永远取不到」。
 */
import { describe, expect, it } from 'vitest';
import { extractDiffFile } from './git';

/** 一段含两个文件的 diff（第二段在「未提交」段里） */
const TEXT = [
  '### 已提交改动（base..HEAD）',
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  '### 未提交改动（工作区 vs HEAD）',
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1,1 +1,1 @@',
  '-x',
  '+y',
  '### 未跟踪文件',
  '（无）',
  '',
].join('\n');

describe('extractDiffFile', () => {
  it('按路径取出那一段原文，且不含别的文件', () => {
    const patch = extractDiffFile(TEXT, 'a.ts');

    expect(patch).toContain('diff --git a/a.ts b/a.ts');
    expect(patch).toContain('+new');
    expect(patch).not.toContain('b.ts');
  });

  it('取不到时返回 undefined，而不是空串（空串会让界面显示一个空 diff）', () => {
    expect(extractDiffFile(TEXT, 'nope.ts')).toBeUndefined();
  });

  it('同一文件在「已提交」与「未提交」两段都出现时，取未提交段（当前状态）', () => {
    const both = [
      '### 已提交改动（base..HEAD）',
      'diff --git a/x.ts b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-committed',
      '+committed-new',
      '### 未提交改动（工作区 vs HEAD）',
      'diff --git a/x.ts b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-working',
      '+working-new',
      '',
    ].join('\n');

    const patch = extractDiffFile(both, 'x.ts');

    // 未提交段反映工作区**当前**状态，是用户打开抽屉想看的那个
    expect(patch).toContain('+working-new');
    expect(patch).not.toContain('+committed-new');
  });

  it('花括号重命名：索引里的归一路径能找到原文（两个路径键必须对上）', () => {
    // numstat 给的是归一后的 `packages/new/x.ts`，而 diff 头里是 `packages/{old => new}/x.ts`
    const renamed = [
      '### 未提交改动（工作区 vs HEAD）',
      'diff --git a/packages/{old => new}/x.ts b/packages/{old => new}/x.ts',
      'rename from packages/old/x.ts',
      'rename to packages/new/x.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    expect(extractDiffFile(renamed, 'packages/new/x.ts')).toContain('+b');
  });

  it('无花括号重命名（old => new）也能对上', () => {
    // 首行必须是段落头：`collectDiff` 产出的文本恒以 `### …` 开头，
    // 且 `splitDiffFiles` 用 `(?=^diff --git )` 切分——`diff --git` 落在**位置 0** 时
    // 它属于 chunks[0]（段落头那份），一个文件段都切不出来。夹具必须与真实形态一致。
    const renamed = [
      '### 未提交改动（工作区 vs HEAD）',
      'diff --git a/old.ts b/new.ts',
      'rename from old.ts',
      'rename to new.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    expect(extractDiffFile(renamed, 'new.ts')).toContain('+b');
  });

  it('路径含空格照样能取到', () => {
    // 同样是真实形态：段落头在首行
    const spaced = [
      '### 未提交改动（工作区 vs HEAD）',
      'diff --git a/my dir/my file.ts b/my dir/my file.ts',
      '--- a/my dir/my file.ts',
      '+++ b/my dir/my file.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    expect(extractDiffFile(spaced, 'my dir/my file.ts')).toContain('+b');
  });
});
