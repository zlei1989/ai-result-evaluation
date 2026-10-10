// @vitest-environment node
/**
 * truncateDiff
 *
 * 本文件是 `git.diff.test.ts` 拆分后的一块：真实仓库模板、`git()` / `section()` 助手与清理钩子都在 `./testing/git-diff-harness`。
 */
import { describe, expect, it } from 'vitest';
import { truncateDiff, registerGitDiffHooks } from './testing/git-diff-harness';



registerGitDiffHooks();

describe('truncateDiff', () => {
  /** 造一段含 n 个文件的 diff 文本，每个文件正文 bodySize 字节 */
  function makeDiffText(fileCount: number, bodySize: number): string {
    const parts: string[] = ['### 已提交改动（base..HEAD）\n'];
    for (let index = 1; index <= fileCount; index += 1) {
      parts.push(
        `diff --git a/file${index}.ts b/file${index}.ts\n` +
          'index 1111111..2222222 100644\n' +
          `--- a/file${index}.ts\n` +
          `+++ b/file${index}.ts\n` +
          '@@ -1 +1 @@\n' +
          `+${'x'.repeat(bodySize)}\n`,
      );
    }
    return parts.join('');
  }

  it('预算充足时原样返回，truncated 为 false 且不丢文件', () => {
    const text = makeDiffText(2, 10);
    const result = truncateDiff(text, 64 * 1024);
    expect(result.truncated).toBe(false);
    expect(result.droppedFiles).toEqual([]);
    expect(result.text).toBe(text);
  });

  it('超预算时按文件裁剪：保留前面的文件、丢掉后面的，并列出被丢文件名', () => {
    const text = makeDiffText(4, 400);
    // 预算只够段落头 + 一个文件：先量一个文件的真实大小，再给一个「刚够一个」的预算
    const oneFile = truncateDiff(makeDiffText(1, 400), 64 * 1024).text.length;
    const result = truncateDiff(text, oneFile + 10);

    expect(result.truncated).toBe(true);
    expect(result.droppedFiles.length).toBeGreaterThan(0);
    expect(result.text).toContain('已截断');
    // 被丢的文件名必须逐个出现在正文里（否则界面/评分模型不知道漏了什么）
    for (const dropped of result.droppedFiles) {
      expect(result.text).toContain(dropped);
    }
    // 保留的文件正文仍在
    expect(result.text).toContain('diff --git a/file1.ts b/file1.ts');
    // 最后一个文件被丢掉了（按文件顺序从后往前丢）
    expect(result.droppedFiles).toContain('file4.ts');
  });

  it('预算小于单个文件时也绝不产出「看起来没改动」的空文本', () => {
    const text = makeDiffText(1, 4096);
    const result = truncateDiff(text, 64);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('已截断');
    expect(result.droppedFiles).toEqual(['file1.ts']);
    // 段落头必须留着：只留一句「已截断」而丢掉段标题，读者不知道这是哪一段
    expect(result.text).toContain('### 已提交改动');
  });

  it('没有 `diff --git` 的文本（空 diff / 只有段落头）原样返回', () => {
    const text = '### 已提交改动（base..HEAD）\n（无）\n### 未提交改动（工作区 vs HEAD）\n（无）\n### 未跟踪文件\n（无）\n';
    const result = truncateDiff(text, 8);
    expect(result.truncated).toBe(false);
    expect(result.droppedFiles).toEqual([]);
    expect(result.text).toBe(text);
  });

  it('预算按**字节**算：中文正文的字节数大于字符数，按字符算会静默超预算', () => {
    // 40 个汉字 = 40 字符 / 120 字节
    const body = '中'.repeat(40);
    const text =
      '### 已提交改动（base..HEAD）\n' +
      'diff --git a/cjk.ts b/cjk.ts\n' +
      'index 1111111..2222222 100644\n' +
      '--- a/cjk.ts\n' +
      '+++ b/cjk.ts\n' +
      '@@ -1 +1 @@\n' +
      `+${body}\n`;
    const piece = text.slice(text.indexOf('diff --git'));
    const pieceChars = piece.length;
    const pieceBytes = Buffer.byteLength(piece, 'utf8');
    expect(pieceBytes).toBeGreaterThan(pieceChars);
    // 预算卡在「字符数够、字节数不够」之间：只有按字节算才会丢这个文件
    const budget = pieceChars + 5;
    expect(pieceBytes).toBeGreaterThan(budget);

    const result = truncateDiff(text, budget);
    expect(result.truncated).toBe(true);
    expect(result.droppedFiles).toEqual(['cjk.ts']);
    // 段落头仍然保留（预算再小也不能产出「看起来没改动」的文本）
    expect(result.text).toContain('### 已提交改动');
  });
});
