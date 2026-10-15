// @vitest-environment node
/**
 * 附件的落盘原语：文件名净化、重名排序、原子写、清点。
 *
 * 判据都落在**磁盘上的事实**（目录里到底多了哪个名字、内容对不对），不落在返回值的措辞上——
 * 「返回了安全的名字」与「盘上真的只写出这一个文件」是两件事，中间隔着一句 `join`。
 * 临时目录一律 `mkdtempSync`，真实工作区与配置文件一个都不碰。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { assertInjectMessageId, listAttachmentFileNames, sanitizeAttachmentName, writeAttachmentFile } from './attachment-store';
import { removeTreeWithRetry } from './remove-tree';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-attachment-store-'));
});

afterEach(() => {
  removeTreeWithRetry(dir);
});

const BYTES = new TextEncoder().encode('report body');

describe('assertInjectMessageId（拼路径前的那一道门）', () => {
  it('合法 id 原样返回', () => {
    expect(assertInjectMessageId('0f5b6c1e-1a2b-4c3d-8e9f-0123456789ab')).toBe('0f5b6c1e-1a2b-4c3d-8e9f-0123456789ab');
  });

  it('`..` / 分隔符 / 空串一律 INVALID_QUERY（不是 INTERNAL：它是入参问题）', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '']) {
      try {
        assertInjectMessageId(bad);
        throw new Error(`应当拒绝：${bad}`);
      } catch (error) {
        expect(error, bad).toBeInstanceOf(ServiceError);
        expect((error as ServiceError).code, bad).toBe('INVALID_QUERY');
      }
    }
  });
});

describe('sanitizeAttachmentName（纯函数：名字来自用户）', () => {
  it('取最后一段，去掉路径分隔符（`..\\a/b.png` 归到 `b.png`）', () => {
    expect(sanitizeAttachmentName('a/b.png')).toBe('b.png');
    expect(sanitizeAttachmentName('..\\a/b.png')).toBe('b.png');
    expect(sanitizeAttachmentName('C:\\tmp\\shot 1.PNG')).toBe('shot 1.PNG');
  });

  it('删控制字符、折叠空白、去前导点', () => {
    expect(sanitizeAttachmentName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeAttachmentName('  spaced   name .txt ')).toBe('spaced name .txt');
    expect(sanitizeAttachmentName('.hidden')).toBe('hidden');
    expect(sanitizeAttachmentName('..')).toBe('attachment');
    expect(sanitizeAttachmentName('   ')).toBe('attachment');
  });

  it('超长时保扩展名、截断主干（模型认扩展名判断值不值得读）', () => {
    const long = `${'x'.repeat(300)}.png`;
    const sanitized = sanitizeAttachmentName(long);
    expect(sanitized.length).toBeLessThanOrEqual(120);
    expect(sanitized.endsWith('.png')).toBe(true);
    // 没有扩展名时就是硬截断，不会把结尾当扩展名留下
    expect(sanitizeAttachmentName('y'.repeat(300))).toBe('y'.repeat(120));
  });

  it('留下的名字不会以点开头（临时文件的那一档只属于我们自己）', () => {
    for (const name of ['...a.txt', '..', '.', '../.hidden']) {
      expect(sanitizeAttachmentName(name).startsWith('.'), name).toBe(false);
    }
  });
});

describe('writeAttachmentFile（原子写 + 重名并存）', () => {
  it('目录不存在则建出来，内容逐字节落盘，返回绝对路径', () => {
    const target = join(dir, 'attachments', 'm-1');
    const written = writeAttachmentFile({ dir: target, name: 'a.png', bytes: BYTES });

    expect(written.name).toBe('a.png');
    expect(written.path).toBe(join(target, 'a.png'));
    expect(readFileSync(written.path)).toEqual(Buffer.from(BYTES));
    // 半成品不留痕：临时文件已经 rename 掉了
    expect(readdirSync(target)).toEqual(['a.png']);
  });

  it('同名两次 ⇒ 并存，第二份前加序号（覆盖会让第一份无声消失）', () => {
    const target = join(dir, 'attachments', 'm-1');
    const first = writeAttachmentFile({ dir: target, name: 'a.png', bytes: BYTES });
    const second = writeAttachmentFile({ dir: target, name: 'a.png', bytes: new TextEncoder().encode('v2') });

    expect(first.name).toBe('a.png');
    expect(second.name).toBe('1-a.png');
    expect(readdirSync(target).sort()).toEqual(['1-a.png', 'a.png']);
    expect(readFileSync(second.path, 'utf8')).toBe('v2');
  });

  it('用户上传的名字正好以 `.part` 结尾时也照常并存（临时文件用点前缀，不吃自己的清点规则）', () => {
    const target = join(dir, 'attachments', 'm-1');
    const first = writeAttachmentFile({ dir: target, name: 'x.part', bytes: BYTES });
    const second = writeAttachmentFile({ dir: target, name: 'x.part', bytes: new TextEncoder().encode('v2') });

    expect(first.name).toBe('x.part');
    expect(second.name).toBe('1-x.part');
    expect(listAttachmentFileNames(target).sort()).toEqual(['1-x.part', 'x.part']);
  });

  it('名字净化后才落盘：越界的那一段不会真的写到目录之外', () => {
    const target = join(dir, 'attachments', 'm-1');
    const written = writeAttachmentFile({ dir: target, name: '../../escape.txt', bytes: BYTES });

    expect(written.name).toBe('escape.txt');
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
    expect(readdirSync(target)).toEqual(['escape.txt']);
  });
});

describe('listAttachmentFileNames（上限判据靠它）', () => {
  it('目录不存在 = 一个附件都没有（首次上传不是错误）', () => {
    expect(listAttachmentFileNames(join(dir, 'never'))).toEqual([]);
  });

  it('只算真正落盘的文件：点开头的临时文件与子目录都不算', () => {
    const target = join(dir, 'attachments', 'm-1');
    writeAttachmentFile({ dir: target, name: 'a.txt', bytes: BYTES });
    // 半途失败留下的临时文件（我们自己的命名规则）+ 一个不该出现的子目录（它会让「还能传几个」提前触顶）
    writeFileSync(join(target, '.b.txt.part'), 'half');
    mkdirSync(join(target, 'sub'), { recursive: true });
    writeFileSync(join(target, 'sub', 'inner.txt'), 'x');

    expect(listAttachmentFileNames(target)).toEqual(['a.txt']);
  });
});
