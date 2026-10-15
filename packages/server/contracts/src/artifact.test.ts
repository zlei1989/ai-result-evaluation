// @vitest-environment node
/**
 * 候选产物契约：名字识别（后缀白名单 + 大小写不敏感 + 只认一层文件名）、两个出口形状、
 * 两个上限的口径。
 *
 * 为什么值得一组守卫：这一份是**唯一一份**白名单真源——core 拿它扫盘与读盘、界面拿它分渲染档、
 * 占位文案拿它拼人话。识别放宽一格（例如收下 `RESULT.md.bak`、或把 `sub/RESULT.md` 也认了）的
 * 后果分别是「把备份文件当成交付物」与「路径穿越的第一道门失效」，而两者在界面上都只是多出一张卡。
 */
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_EXTENSIONS,
  ARTIFACT_FILE_HINT,
  ARTIFACT_READ_MAX_BYTES,
  ARTIFACT_TEXT_MAX_CHARS,
  RowArtifactFileSchema,
  RunArtifactIndexSchema,
  artifactKindOf,
} from './artifact';

describe('artifactKindOf', () => {
  it('大小写不敏感：四家智能体写文件名的大小写习惯不该决定「哪一份是产物」', () => {
    expect(artifactKindOf('RESULT.md')).toBe('md');
    expect(artifactKindOf('result.md')).toBe('md');
    expect(artifactKindOf('Result.Md')).toBe('md');
    expect(artifactKindOf('RESULT.MD')).toBe('md');
    expect(artifactKindOf('RESULT.html')).toBe('html');
    expect(artifactKindOf('result.HTML')).toBe('html');
    expect(artifactKindOf('RESULT.svg')).toBe('svg');
    expect(artifactKindOf('result.SVG')).toBe('svg');
  });

  it('白名单外的后缀一律不认（多认一格 = 多出一张渲染不出来的卡）', () => {
    expect(artifactKindOf('RESULT.txt')).toBeNull();
    expect(artifactKindOf('RESULT.json')).toBeNull();
    expect(artifactKindOf('RESULT.png')).toBeNull();
    expect(artifactKindOf('RESULT.markdown')).toBeNull();
    expect(artifactKindOf('RESULT')).toBeNull();
    expect(artifactKindOf('RESULT.')).toBeNull();
  });

  it('只认一层文件名：路径分隔符、多余的点、前后缀都不成立（这条是路径穿越的第一道门）', () => {
    // 中间多一截：备份文件不是交付物
    expect(artifactKindOf('RESULT.md.bak')).toBeNull();
    // 带目录：我们只扫工作区根目录第一层，认了它就会去拼子目录里的路径
    expect(artifactKindOf('sub/RESULT.md')).toBeNull();
    expect(artifactKindOf('sub\\RESULT.md')).toBeNull();
    expect(artifactKindOf('../RESULT.md')).toBeNull();
    // 前缀 / 后缀夹带：`RESULT.md/../x` 这类名字在拼接时才是真正危险的那一个
    expect(artifactKindOf('RESULT.md/../x')).toBeNull();
    expect(artifactKindOf('xRESULT.md')).toBeNull();
    expect(artifactKindOf('RESULT.md ')).toBeNull();
    expect(artifactKindOf('RESULT..md')).toBeNull();
    expect(artifactKindOf('')).toBeNull();
  });

  it('人话形态由白名单派生（加一档后缀时文案跟着变，不会留下一句旧话）', () => {
    for (const extension of ARTIFACT_EXTENSIONS) {
      expect(ARTIFACT_FILE_HINT).toContain(`RESULT.${extension}`);
    }
    expect(ARTIFACT_FILE_HINT).toBe('RESULT.md / RESULT.html / RESULT.svg');
  });

  it('两个上限是确定值：截断上限按字符、读取上限按字节（改它们等于改界面上那句说明）', () => {
    expect(ARTIFACT_TEXT_MAX_CHARS).toBe(100_000);
    expect(ARTIFACT_READ_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('RunArtifactIndexSchema / RowArtifactFileSchema', () => {
  const index = {
    rows: [
      { rowId: 'w-1', files: [{ name: 'RESULT.md', kind: 'md', bytes: 12 }] },
      // 没有产物的行**照样进索引**、files 是空数组：「这一行没有产出」是要显示出来的事实
      { rowId: 'w-2', files: [] },
    ],
    total: 1,
  };

  it('索引：每个候选一行（含没有产物的那一行）', () => {
    expect(RunArtifactIndexSchema.safeParse(index).success).toBe(true);
    expect(RunArtifactIndexSchema.safeParse(index).data?.rows).toHaveLength(2);
  });

  it('索引：三个键缺一不可（缺 kind / bytes / total 都失败）', () => {
    const [first, second] = index.rows;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const file = { ...first?.files[0] };
    expect(RunArtifactIndexSchema.safeParse({ ...index, rows: [{ rowId: 'w-1', files: [{ ...file, kind: undefined }] }] }).success).toBe(false);
    expect(RunArtifactIndexSchema.safeParse({ ...index, rows: [{ rowId: 'w-1', files: [{ ...file, bytes: undefined }] }] }).success).toBe(false);
    expect(RunArtifactIndexSchema.safeParse({ ...index, total: undefined }).success).toBe(false);
    expect(RunArtifactIndexSchema.safeParse({ ...index, rows: [{ rowId: '', files: [] }] }).success).toBe(false);
  });

  it('索引：白名单外的 kind 被拒（前端按 kind 分渲染档，多一个值就是一条渲染不出来的分支）', () => {
    expect(
      RunArtifactIndexSchema.safeParse({ ...index, rows: [{ rowId: 'w-1', files: [{ name: 'RESULT.txt', kind: 'txt', bytes: 1 }] }] }).success,
    ).toBe(false);
  });

  it('正文：四个键缺一不可，且 `text` 允许是空串（候选可以写一份空文件——那是事实，不是缺数据）', () => {
    expect(RowArtifactFileSchema.safeParse({ name: 'RESULT.md', kind: 'md', text: '# 标题', bytes: 7, truncated: false }).success).toBe(true);
    expect(RowArtifactFileSchema.safeParse({ name: 'RESULT.md', kind: 'md', text: '', bytes: 0, truncated: false }).success).toBe(true);
    expect(RowArtifactFileSchema.safeParse({ name: 'RESULT.md', kind: 'md', text: 'x', bytes: 1 }).success).toBe(false);
    expect(RowArtifactFileSchema.safeParse({ name: 'RESULT.md', kind: 'md', text: 'x', bytes: 1, truncated: undefined }).success).toBe(false);
    // `bytes` 是盘上那一份的**完整**字节数，与 `text` 的长度不是一回事：截断过的正文里两者必然不等，
    // 契约不能把这条关系写成 refine（那会让「截断」这个合法状态失败）
    expect(RowArtifactFileSchema.safeParse({ name: 'RESULT.md', kind: 'md', text: 'x', bytes: 999, truncated: true }).success).toBe(true);
  });
});
