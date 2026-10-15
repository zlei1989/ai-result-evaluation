// @vitest-environment node
/**
 * 候选产物（`RESULT.*`）的扫盘与读取。
 *
 * 判据都落在**磁盘上的事实**（哪个名字被认了、顺序是什么、读出的是不是原文），
 * 不落在返回值的措辞上。临时目录一律 `mkdtempSync`，真实工作区与配置文件一个都不碰。
 *
 * 三处刻意钉住的口径（都是「放宽一格就静默出错」的那类）：
 *   · 同名**目录**与**软链**都不算产物——前者会让「读一份产物」变成「读一个目录」，
 *     后者是路径穿越的入口；
 *   · 排序由白名单定（md → html → svg），不跟 `readdir` 的顺序走；
 *   · 超读取上限⇒拒绝、超正文上限⇒截断 + `truncated`，两条处置**不一样**。
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARTIFACT_READ_MAX_BYTES, ARTIFACT_TEXT_MAX_CHARS, ServiceError } from '@aieval/contracts';
import { readWorkspaceArtifact, scanWorkspaceArtifacts } from './artifact-store';
import { removeTreeWithRetry } from './remove-tree';

let dir: string;
/** 假的候选工作区（一个临时目录就是「工作区根」） */
let workspace: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-artifact-store-'));
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

describe('scanWorkspaceArtifacts', () => {
  it('认根目录下的三种后缀，且按白名单顺序排（不跟 readdir 的顺序走）', () => {
    // 故意反着写盘：svg → md → html
    writeFileSync(join(workspace, 'RESULT.svg'), '<svg/>', 'utf8');
    writeFileSync(join(workspace, 'RESULT.md'), '# 标题', 'utf8');
    writeFileSync(join(workspace, 'RESULT.html'), '<p>正文</p>', 'utf8');

    expect(scanWorkspaceArtifacts(workspace)).toEqual([
      { name: 'RESULT.md', kind: 'md', bytes: 8 },
      { name: 'RESULT.html', kind: 'html', bytes: 13 },
      { name: 'RESULT.svg', kind: 'svg', bytes: 6 },
    ]);
  });

  it('大小写不敏感：全小写的名字照样进清单，且报出的是**盘上那个名字**', () => {
    // 同一档里出现两份只在大小写上不同的文件，只在区分大小写的文件系统上可能（macOS 默认不区分）
    // ⇒ 那条排序 tiebreak 由下面的三档顺序用例与源码注释覆盖，这里只钉「识别不挑大小写」
    writeFileSync(join(workspace, 'result.svg'), '<svg/>', 'utf8');

    expect(scanWorkspaceArtifacts(workspace)).toEqual([{ name: 'result.svg', kind: 'svg', bytes: 6 }]);
  });

  it('不认的东西一律不列：其它后缀、子目录、同名目录、软链、无后缀', () => {
    writeFileSync(join(workspace, 'RESULT.txt'), 'x', 'utf8');
    writeFileSync(join(workspace, 'readme.md'), 'x', 'utf8');
    mkdirSync(join(workspace, 'sub'));
    writeFileSync(join(workspace, 'sub', 'RESULT.html'), '<p>子目录里的</p>', 'utf8');
    // 同名目录：有人真会把 `RESULT.md` 建成目录
    mkdirSync(join(workspace, 'RESULT.md'));
    // 软链：不算产物（这一步也把「产物指向工作区之外」挡在扫描阶段）
    symlinkSync(join(dir, 'outside.md'), join(workspace, 'RESULT.svg'));

    expect(scanWorkspaceArtifacts(workspace)).toEqual([]);
  });

  it('工作区不存在 / 空路径 / 不是目录 ⇒ 空清单（不是错误）', () => {
    expect(scanWorkspaceArtifacts(join(dir, 'nope'))).toEqual([]);
    expect(scanWorkspaceArtifacts('')).toEqual([]);
    writeFileSync(join(dir, 'a-file'), 'x', 'utf8');
    expect(scanWorkspaceArtifacts(join(dir, 'a-file'))).toEqual([]);
  });
});

describe('readWorkspaceArtifact', () => {
  it('读出原文与盘上字节数（BOM 在原文前剥掉，markdown 的第一行不会多一个不可见字符）', () => {
    const text = '# 标题\n正文\n';
    writeFileSync(join(workspace, 'RESULT.md'), `\uFEFF${text}`, 'utf8');

    const file = readWorkspaceArtifact(workspace, 'RESULT.md');

    expect(file.text).toBe(text);
    expect(file.kind).toBe('md');
    expect(file.truncated).toBe(false);
    // `bytes` 是盘上那一份的完整字节数（含 BOM），与 text 的长度不是一回事
    expect(file.bytes).toBe(Buffer.byteLength(`\uFEFF${text}`, 'utf8'));
  });

  it('大小写不同的名字也读得到（识别与读取走同一份白名单）', () => {
    writeFileSync(join(workspace, 'Result.HTML'), '<p>hi</p>', 'utf8');
    expect(readWorkspaceArtifact(workspace, 'RESULT.html').text).toBe('<p>hi</p>');
  });

  it('超过正文上限 ⇒ 截断 + truncated:true（可见的降级，不是静默）', () => {
    const text = 'A'.repeat(ARTIFACT_TEXT_MAX_CHARS + 10);
    writeFileSync(join(workspace, 'RESULT.md'), text, 'utf8');

    const file = readWorkspaceArtifact(workspace, 'RESULT.md');

    expect(file.text).toHaveLength(ARTIFACT_TEXT_MAX_CHARS);
    expect(file.truncated).toBe(true);
    expect(file.bytes).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('超过**读取**上限 ⇒ 拒绝并给中文原因（连读都不读，与截断是两条处置）', () => {
    // 判据是 `>`：正好等于上限的那一份照常读得出来
    writeFileSync(join(workspace, 'RESULT.md'), 'x'.repeat(ARTIFACT_READ_MAX_BYTES), 'utf8');
    writeFileSync(join(workspace, 'RESULT.svg'), 'x'.repeat(ARTIFACT_READ_MAX_BYTES + 1), 'utf8');

    expect(codeOf(() => readWorkspaceArtifact(workspace, 'RESULT.svg'))).toBe('INVALID_QUERY');
    expect(readWorkspaceArtifact(workspace, 'RESULT.md').bytes).toBe(ARTIFACT_READ_MAX_BYTES);
  });

  it('名字不是本仓认的产物 ⇒ INVALID_QUERY（`RESULT.txt` / 带目录 / 备份文件都走这一条）', () => {
    writeFileSync(join(workspace, 'RESULT.txt'), 'x', 'utf8');

    for (const name of ['RESULT.txt', 'sub/RESULT.md', '../RESULT.md', 'RESULT.md.bak', '', 'RESULT']) {
      expect(codeOf(() => readWorkspaceArtifact(workspace, name)), name).toBe('INVALID_QUERY');
    }
  });

  it('文件不在 ⇒ NOT_FOUND；同名是目录 ⇒ INVALID_QUERY（两句不同的话）', () => {
    mkdirSync(join(workspace, 'RESULT.svg'));

    expect(codeOf(() => readWorkspaceArtifact(workspace, 'RESULT.md'))).toBe('NOT_FOUND');
    expect(codeOf(() => readWorkspaceArtifact(workspace, 'RESULT.svg'))).toBe('INVALID_QUERY');
  });

  it('内容不是 UTF-8 文本 ⇒ INVALID_QUERY（替换字符是二进制留在解码结果里的痕迹）', () => {
    writeFileSync(join(workspace, 'RESULT.html'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    expect(codeOf(() => readWorkspaceArtifact(workspace, 'RESULT.html'))).toBe('INVALID_QUERY');
  });

  it.skipIf(process.platform === 'win32')('软链指到工作区之外 ⇒ INVALID_QUERY（realpath 复核那道门）', () => {
    const outside = join(dir, 'outside.md');
    writeFileSync(outside, '# 工作区外', 'utf8');
    symlinkSync(outside, join(workspace, 'RESULT.md'));

    // 扫描阶段就不列它（软链不是普通文件），直接调读取也必须被第二道门拦住
    expect(scanWorkspaceArtifacts(workspace)).toEqual([]);
    expect(codeOf(() => readWorkspaceArtifact(workspace, 'RESULT.md'))).toBe('INVALID_QUERY');
  });
});
