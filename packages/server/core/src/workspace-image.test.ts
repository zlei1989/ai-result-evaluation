// @vitest-environment node
/**
 * 工作区图片的读取（`image-view` 块预览的唯一取数口）。
 *
 * 判据落在磁盘事实上：读出的字节、响应类型、以及**四类拒绝各自的 code**。临时目录一律
 * `mkdtempSync`，真实工作区与配置文件一个都不碰。
 *
 * 三处刻意钉住的口径：
 *   · **只认工作区内的相对路径**：绝对路径与 `..` 越界都必须拒绝（第二道 `realpath` 复核兜住软链）；
 *   · **后缀白名单**：不是图片就拒绝，且文案里点名允许哪些后缀；
 *   · **超上限连读都不读**：与「读进来再截断」是两条处置。
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { readWorkspaceImage, WORKSPACE_IMAGE_MAX_BYTES } from './workspace-image';
import { removeTreeWithRetry } from './remove-tree';

let dir: string;
/** 假的候选工作区（一个临时目录就是「工作区根」） */
let workspace: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-workspace-image-'));
  workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  removeTreeWithRetry(dir);
});

/** 取一条 ServiceError 的 code；没抛就抛出去（比在每条用例里写 try/catch 短） */
function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    return (error as ServiceError).code;
  }
  throw new Error('这条调用应当抛 ServiceError，却没有抛');
}

describe('readWorkspaceImage', () => {
  it('读出字节与响应类型（png 与 svg 两张，后缀大小写不敏感）', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    writeFileSync(join(workspace, 'shot.png'), png);
    writeFileSync(join(workspace, 'RESULT.SVG'), '<svg/>', 'utf8');

    expect(readWorkspaceImage(workspace, 'shot.png')).toEqual({ bytes: png, mimeType: 'image/png' });
    expect(readWorkspaceImage(workspace, 'RESULT.SVG')).toEqual({
      bytes: Buffer.from('<svg/>', 'utf8'),
      mimeType: 'image/svg+xml',
    });
  });

  it('子目录里的图片照读（相对路径是工作区内的任意一层）', () => {
    mkdirSync(join(workspace, 'shots'));
    writeFileSync(join(workspace, 'shots', 'a.webp'), 'x');

    expect(readWorkspaceImage(workspace, 'shots/a.webp').mimeType).toBe('image/webp');
  });

  it('绝对路径与空路径 ⇒ INVALID_QUERY（URL 只收相对路径）', () => {
    writeFileSync(join(workspace, 'shot.png'), 'x');

    expect(codeOf(() => readWorkspaceImage(workspace, join(workspace, 'shot.png')))).toBe('INVALID_QUERY');
    expect(codeOf(() => readWorkspaceImage(workspace, ''))).toBe('INVALID_QUERY');
  });

  it('`..` 越界与软链越界 ⇒ INVALID_QUERY（第二道 realpath 复核）', () => {
    const outside = join(dir, 'outside.png');
    writeFileSync(outside, 'x');
    writeFileSync(join(workspace, 'shot.png'), 'x');

    expect(codeOf(() => readWorkspaceImage(workspace, '../outside.png'))).toBe('INVALID_QUERY');
    if (process.platform !== 'win32') {
      symlinkSync(outside, join(workspace, 'link.png'));
      expect(codeOf(() => readWorkspaceImage(workspace, 'link.png'))).toBe('INVALID_QUERY');
    }
  });

  it('不是图片后缀 ⇒ INVALID_QUERY，且文案点名允许的后缀', () => {
    writeFileSync(join(workspace, 'notes.txt'), 'x');

    try {
      readWorkspaceImage(workspace, 'notes.txt');
      throw new Error('应当抛 ServiceError');
    } catch (error) {
      expect((error as ServiceError).code).toBe('INVALID_QUERY');
      expect((error as ServiceError).message).toContain('png');
    }
  });

  it('文件不在 ⇒ NOT_FOUND（工作区在运行结束后会被改写，这是常见情形）', () => {
    expect(codeOf(() => readWorkspaceImage(workspace, 'gone.png'))).toBe('NOT_FOUND');
  });

  it('同名是目录 ⇒ INVALID_QUERY（一句不同的话）', () => {
    mkdirSync(join(workspace, 'dir.png'));

    expect(codeOf(() => readWorkspaceImage(workspace, 'dir.png'))).toBe('INVALID_QUERY');
  });

  it('超过读取上限 ⇒ INVALID_QUERY（连读都不读），正好等于上限的那一张照读', () => {
    writeFileSync(join(workspace, 'big.png'), Buffer.alloc(WORKSPACE_IMAGE_MAX_BYTES + 1));
    writeFileSync(join(workspace, 'edge.png'), Buffer.alloc(WORKSPACE_IMAGE_MAX_BYTES));

    expect(codeOf(() => readWorkspaceImage(workspace, 'big.png'))).toBe('INVALID_QUERY');
    expect(readWorkspaceImage(workspace, 'edge.png').bytes).toHaveLength(WORKSPACE_IMAGE_MAX_BYTES);
  });
});
