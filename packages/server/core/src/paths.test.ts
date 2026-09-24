// @vitest-environment node
/**
 * 路径工具与工作区根目录校验。
 * 注意：校验必须「真写一次再删」——只检查父目录是否存在不够，
 * 磁盘满、无权限、路径过长都会在真正写入时才失败。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, SETTINGS_DEFAULTS } from '@aieval/contracts';
import { defaultWorkspaceRoot, expandHome, resolveRootForRead, validateWorkspaceRoot } from './paths';

const created: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aieval-paths-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('expandHome', () => {
  it('把开头的 ~ 展开为家目录', () => {
    expect(expandHome('~/.runs')).toBe(join(homedir(), '.runs'));
  });

  it('只替换开头的 ~，不动路径中间的 ~', () => {
    expect(expandHome('/tmp/~x')).toBe('/tmp/~x');
  });

  it('没有 ~ 时原样返回', () => {
    expect(expandHome('D:/a/b')).toBe('D:/a/b');
  });

  it('把相对路径解析为绝对路径（避免 CWD 漂移导致产物散落）', () => {
    expect(expandHome('rel/dir')).toBe(resolve('rel/dir'));
  });
});

describe('defaultWorkspaceRoot', () => {
  it('解析到家目录下的 .runs（与设置默认值一致）', () => {
    expect(defaultWorkspaceRoot()).toBe(join(homedir(), '.runs'));
  });

  // 跨包默认值不能各写一份：contracts 的 SETTINGS_DEFAULTS.workspaceRoot 是 `~/.runs`，
  // core 的 defaultWorkspaceRoot() 是它的展开结果。两处若漂移，设置页显示的默认路径
  // 与实际落盘位置会不一致——用这条断言把二者钉在一起（core 可以 import contracts，反向不行）。
  it('展开结果等于 SETTINGS_DEFAULTS.workspaceRoot 的展开值（防两处默认值漂移）', () => {
    expect(defaultWorkspaceRoot()).toBe(expandHome(SETTINGS_DEFAULTS.workspaceRoot));
  });
});

describe('resolveRootForRead', () => {
  it('把开头的 ~ 展开为绝对路径', () => {
    expect(resolveRootForRead('~/.runs')).toBe(join(homedir(), '.runs'));
  });

  it('空串回落到默认工作区根目录', () => {
    expect(resolveRootForRead('')).toBe(defaultWorkspaceRoot());
  });

  // 与 validateWorkspaceRoot 的唯一区别就是**不碰磁盘**——读取路径上绝不能校验可写性
  // （目录可能正被临时卸载，抛错会让用户连设置页都打不开）。所以拿一个「mkdir 必失败」的路径
  // （被同名文件占住）来钉：实现一旦改成走校验，这里会直接抛 NOT_WRITABLE。
  it('不校验可写性：路径被文件占住也照样原样返回', () => {
    const occupied = join(makeTmp(), 'occupied');
    writeFileSync(occupied, 'x');
    expect(resolveRootForRead(occupied)).toBe(occupied);
  });
});

describe('validateWorkspaceRoot', () => {
  it('可用目录：返回展开后的绝对路径', () => {
    const dir = makeTmp();
    expect(validateWorkspaceRoot(dir)).toEqual({ resolved: dir });
  });

  it('不存在的目录会被创建（父级也一起建）', () => {
    const nested = join(makeTmp(), 'x', 'y');
    expect(validateWorkspaceRoot(nested).resolved).toBe(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it('支持 ~ 开头的路径', () => {
    const result = validateWorkspaceRoot('~/.runs-test-should-not-exist');
    expect(result.resolved).toBe(join(homedir(), '.runs-test-should-not-exist'));
    // 清理，别在开发者家目录留垃圾
    rmSync(result.resolved, { recursive: true, force: true });
  });

  it('校验时会真写一个探针文件并删掉，不留残留文件', () => {
    const dir = makeTmp();
    validateWorkspaceRoot(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  // 上一条只断言「不留残留」，对「压根不写探针」的实现没有区分力——实测把探针整段删掉、
  // 只留 mkdir，12 条测试全绿。而「真写一次」正是这个函数存在的理由（只查父目录存在与否，
  // 磁盘满 / 无权限 / 路径过长都发现不了），所以必须直接盯着系统调用：
  // 写过**一个**随机名探针、探针落在被校验目录里、并且把它删掉。
  it('真的写过一个随机名探针再删掉（只 mkdir 的实现过不了这条）', async () => {
    const dir = makeTmp();
    vi.resetModules();
    const writes: string[] = [];
    const removals: string[] = [];
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        writeFileSync: (path: unknown, ...rest: unknown[]) => {
          const name = String(path);
          if (name.includes('.aieval-probe-')) writes.push(name);
          return (actual.writeFileSync as (...a: unknown[]) => void)(path, ...rest);
        },
        rmSync: (path: unknown, ...rest: unknown[]) => {
          removals.push(String(path));
          return (actual.rmSync as (...a: unknown[]) => void)(path, ...rest);
        },
      };
    });

    const { validateWorkspaceRoot: validateMocked } = await import('./paths');
    try {
      validateMocked(dir);
    } finally {
      // 断言失败或调用抛错都不能把 mock 泄漏给后面的用例，所以 un-mock 必须走 finally
      vi.doUnmock('node:fs');
      vi.resetModules();
    }

    expect(writes).toHaveLength(1);
    const probe = writes[0] ?? '';
    expect(probe.startsWith(join(dir, '.aieval-probe-'))).toBe(true);
    expect(removals).toContain(probe);
  });

  // 探针**写**不进去（磁盘满 / 无权限 / 路径过长）才是这个函数真正要拦的那类失败，
  // 但用真文件系统在 Windows 上造不出来（目录的只读属性拦不住创建文件），只能把 writeFileSync 打挂。
  // 注意断言方式：resetModules 后动态 import 的 ./paths 会连同 @aieval/contracts 一起重新求值，
  // 拿到的 ServiceError 与文件顶部静态导入的**不是同一个类**，instanceof 会假失败，故按契约字段断言。
  it('探针写入失败时抛 NOT_WRITABLE 且 message 含路径', async () => {
    const dir = makeTmp();
    vi.resetModules();
    const writes: string[] = [];
    const removals: string[] = [];
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        writeFileSync: (path: unknown) => {
          writes.push(String(path));
          throw new Error('EACCES: permission denied');
        },
        rmSync: (path: unknown, ...rest: unknown[]) => {
          removals.push(String(path));
          return (actual.rmSync as (...a: unknown[]) => void)(path, ...rest);
        },
      };
    });

    const { validateWorkspaceRoot: validateMocked } = await import('./paths');
    let caught: unknown;
    try {
      validateMocked(dir);
    } catch (error) {
      caught = error;
    } finally {
      // 调用抛错也不能把 mock 泄漏给后面的用例
      vi.doUnmock('node:fs');
      vi.resetModules();
    }

    expect(caught instanceof Error ? caught.name : '').toBe('ServiceError');
    expect((caught as { code?: unknown }).code).toBe('NOT_WRITABLE');
    expect((caught as Error).message).toContain(dir);
    // 两种失败同为 NOT_WRITABLE、同带路径，措辞是唯一能区分「建目录失败」与「写入失败」的信号：
    // 少了这条，把 mkdir 那句文案挪给写失败（或反过来）都不会被现有断言发现。
    expect((caught as Error).message).toContain('不可写');
    // 失败路径同样必须清理。`rmSync` 一旦从 `finally` 挪到 try/catch 之后，
    // 成功路径照删、失败路径漏删，上面那条 happy-path 守卫（只走成功路径）看不出来——
    // 这里直接盯住这次删除调用，并对齐写入时用的那个探针名。
    expect(writes.some((p) => p.includes('.aieval-probe-'))).toBe(true);
    expect(removals.some((p) => p.includes('.aieval-probe-'))).toBe(true);
  });

  it('路径被一个同名文件占住时抛 NOT_WRITABLE 且 message 含路径', () => {
    const base = makeTmp();
    const filePath = join(base, 'occupied');
    // 建一个同名文件，让 mkdir 失败
    writeFileSync(filePath, 'x');
    let caught: unknown;
    try {
      validateWorkspaceRoot(filePath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_WRITABLE');
    expect((caught as ServiceError).message).toContain(filePath);
    // 与上面「写入失败」的措辞成对：两条失败路径的唯一可区分信号就是文案，
    // 只钉住一边的话，把两句文案对调的实现依然全绿。
    expect((caught as ServiceError).message).toContain('无法创建');
  });

  it('空字符串抛 NOT_WRITABLE（不静默回落到 CWD）', () => {
    let caught: unknown;
    try {
      validateWorkspaceRoot('   ');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_WRITABLE');
  });
});
