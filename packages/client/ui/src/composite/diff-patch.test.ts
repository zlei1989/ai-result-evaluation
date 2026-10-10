/**
 * diff 段落 → 两侧正文。
 *
 * 本文件是整个重设计里最容易写错、且写错了**不会报错只会显示错**的一处：
 * 组件拿两个字符串按行号对位比较，行号对不上就会把不相邻的改动画成相邻。
 */
import { describe, expect, it } from 'vitest';
import { languageOf, reconstructSides } from './diff-patch';

/** 把还原结果切成行，方便按下标断言 */
function lines(patch: string): { old: string[]; next: string[] } {
  const { oldValue, newValue } = reconstructSides(patch);
  return { old: oldValue.split('\n'), next: newValue.split('\n') };
}

const TWO_HUNKS = [
  'diff --git a/f.ts b/f.ts',
  '--- a/f.ts',
  '+++ b/f.ts',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+b2',
  ' c',
  '@@ -27,3 +27,3 @@',
  ' y',
  '-z',
  '+z2',
  ' w',
  '',
].join('\n');

describe('reconstructSides', () => {
  it('相隔很远的两个 hunk 落在各自真实的下标上，中间的未修改行保留为空行', () => {
    const { old, next } = lines(TWO_HUNKS);

    // 第一处 hunk 从文件第 1 行开始：'a' 在下标 0、改动行 'b'/'b2' 在下标 1。
    expect(old[0]).toBe('a');
    expect(old[1]).toBe('b');
    expect(next[1]).toBe('b2');
    // 第二处 hunk 头写的是第 27 行，末尾还有 'y'/'z'/'w' 三行 ⇒ 它们落在下标 26/27/28。
    // **关键是它们在下标 26 附近，而不是紧挨着下标 3**：origin 只做整体平移，
    // 两处 hunk 之间的真实间距（20 多行）被如实保留，不会被画成相邻的两行。
    expect(old[26]).toBe('y');
    expect(old[27]).toBe('z');
    expect(next[27]).toBe('z2');
    expect(old[28]).toBe('w');
    // 中间是未修改行（diff 里不存在，只能用空行占位）
    expect(old[10]).toBe('');
    expect(next[10]).toBe('');
  });

  it('远离文件开头的改动不会带一大堆前导空行（origin 平移到第一处 hunk）', () => {
    const deep = [
      'diff --git a/big.ts b/big.ts',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -498,3 +498,3 @@',
      ' x',
      '-y',
      '+y2',
      ' z',
      '',
    ].join('\n');

    const { old, next } = lines(deep);

    // 只有 3 行（x/y/z，改动在中间的 y），**不是** 497 行空白加 3 行：
    // origin 把整段平移到第一处 hunk 的位置，深处的改动用不着滚几百行才看得见。
    expect(old).toHaveLength(3);
    expect(old[0]).toBe('x');
    expect(old[1]).toBe('y');
    expect(next[1]).toBe('y2');
    expect(old[2]).toBe('z');
  });

  it('正文里含 `diff --git` 字样的行不被当成新文件（按 hunk 内数据行处理）', () => {
    const evil = [
      'diff --git a/d.ts b/d.ts',
      '--- a/d.ts',
      '+++ b/d.ts',
      '@@ -1,2 +1,2 @@',
      ' context',
      '+diff --git a/evil b/evil',
      ' more',
      '',
    ].join('\n');

    const { next } = lines(evil);

    expect(next).toContain('diff --git a/evil b/evil');
  });

  it('"\\ No newline at end of file" 标记不进入正文', () => {
    const noEol = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    const { old, next } = lines(noEol);

    expect(old).toEqual(['old']);
    expect(next).toEqual(['new']);
  });

  it('纯新增文件（@@ -0,0 +1,N @@）：old 全空、new 是全部内容，两侧等长且没有越界写入', () => {
    const added = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,3 @@',
      '+a',
      '+b',
      '+c',
      '',
    ].join('\n');

    const { old, next } = lines(added);

    expect(old.every((line) => line === '')).toBe(true);
    expect(next).toContain('a');
    expect(next).toContain('c');
  });

  it('纯删除文件（@@ -1,N +0,0 @@）：new 全空、old 是全部内容', () => {
    const deleted = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      '',
    ].join('\n');

    const { old, next } = lines(deleted);

    expect(next.every((line) => line === '')).toBe(true);
    expect(old).toContain('a');
  });

  it('纯插入（hunk 两侧行数不同）也能对齐', () => {
    const insert = [
      'diff --git a/m.ts b/m.ts',
      '--- a/m.ts',
      '+++ b/m.ts',
      '@@ -5,3 +5,4 @@',
      ' a',
      '+inserted',
      ' b',
      ' c',
      '',
    ].join('\n');

    const { old, next } = lines(insert);

    // 两侧行数**可以不同**（组件是把两个字符串重新 diff，不是按下标逐行比）：
    // 新侧多一行，旧侧没有补空串
    expect(old).toHaveLength(3);
    expect(next).toHaveLength(4);
    // 新增的那一行出现在新侧下标 1，而旧侧同一格是紧随其后的 'b'
    expect(old[1]).toBe('b');
    expect(next[1]).toBe('inserted');
    expect(old[2]).toBe('c');
    expect(next[2]).toBe('b');
    expect(next[3]).toBe('c');
  });

  /**   * **本文件最重要的一条**。
   *
   * 把短的一侧补空串到等长，理由是「行数不同会让组件按序比较时错位」——
   * 这个理由是**错的**：组件不按下标比较，而是把两个字符串**重新做一次 diff**。
   * 补空串会让两侧**结尾不同**（一侧以 `\n` 收尾、另一侧以内容收尾），jsdiff 于是重新配对尾部，
   * 把**未修改的行也画成改动**。
   *
   * 症状是「看起来对、其实多了几行红绿」——只有断言最终 diff 的行数才能发现，
   * 所以这里直接用**组件所用的同一次调用**来钉：真实补丁 +3/−1 就必须得到 removed=1 added=3。
   */
  it('还原出的两侧喂给组件真正用的那次 diff，得到的增删行数必须与补丁完全一致（不许有假红绿行）', async () => {
    const { diffLines } = await import('diff');
    // 这是一次真实改动（`FileChangeLogItemDTO.java` 补一个 agent 字段）的补丁，真值 +3 / −1
    const patch = [
      'diff --git a/x/FileChangeLogItemDTO.java b/x/FileChangeLogItemDTO.java',
      '--- a/x/FileChangeLogItemDTO.java',
      '+++ b/x/FileChangeLogItemDTO.java',
      '@@ -12,6 +12,7 @@ package com.likecode.example.export.dto;',
      '  * @param lineTotalNum 文件总行数',
      '  * @param lineGenNum   AI 生成行数',
      '  * @param aiCodeRatio  AI 代码占比，百分比字符串，两位小数',
      '+ * @param agent        Agent 标识（ES agent）；旧文档可能为 null',
      '  */',
      ' public record FileChangeLogItemDTO(',
      '   String erp,',
      '@@ -22,5 +23,6 @@ public record FileChangeLogItemDTO(',
      '   String lang,',
      '   int lineTotalNum,',
      '   int lineGenNum,',
      '-  String aiCodeRatio',
      '+  String aiCodeRatio,',
      '+  String agent',
      ' ) {}',
      '',
    ].join('\n');

    const { oldValue, newValue } = reconstructSides(patch);
    const parts = diffLines(oldValue, newValue, { newlineIsToken: false });

    let removed = 0;
    let added = 0;
    for (const part of parts) {
      const count = part.count ?? (part.value.split('\n').length - (part.value.endsWith('\n') ? 1 : 0));
      if (part.removed === true) removed += count;
      else if (part.added === true) added += count;
    }

    expect({ removed, added }).toEqual({ removed: 1, added: 3 });
  });

  it('没有 hunk（二进制改动）返回两个空串，而不是抛错', () => {
    const binary = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');

    expect(reconstructSides(binary)).toEqual({ oldValue: '', newValue: '' });
  });

  it('空 patch 返回两个空串', () => {
    expect(reconstructSides('')).toEqual({ oldValue: '', newValue: '' });
  });
});

describe('languageOf', () => {
  it('认识的扩展名给语言名', () => {
    expect(languageOf('src/a.ts')).toBe('typescript');
    expect(languageOf('a.json')).toBe('json');
  });

  it('不认识的后缀返回 undefined（组件会优雅退化成不高亮）', () => {
    expect(languageOf('Makefile')).toBeUndefined();
    expect(languageOf('a.unknownext')).toBeUndefined();
  });
});
