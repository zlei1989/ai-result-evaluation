// @vitest-environment node
/**
 * git 进程封装：追加环境变量、墙钟超时、超时判定。
 * 与**真实进程**有关的那几条必须在真进程上验：错误的形状（Buffer / 乱码 / signal / code）是 Node 与
 * git 的实现细节，用 mock 验等于把自己的假设抄一遍。
 * `isTimeoutKill` 那组里的两条**合成错误**用例是例外：它们验的是「按形状判定」这条判据本身
 * （错误由夹具直接造出来），起进程既证明不了什么、也没法稳定构造出那两种形状。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execute, gitMessage, isTimeoutKill } from './git-exec';

const created: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aieval-exec-'));
  created.push(dir);
  return dir;
}

/** 临时仓库里的提交身份：CI / 新机器上没有全局身份，不给 `-c` 会直接以 Author identity unknown 失败 */
const IDENT = ['-c', 'user.email=test@aieval.local', '-c', 'user.name=aieval-test', '-c', 'commit.gpgsign=false'];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
});

describe('execute', () => {
  it('返回 stdout（是能直接匹配的字符串，不是 Buffer）', () => {
    expect(execute(makeTmp(), ['--version'])).toContain('git version');
  });

  it('追加的环境变量对子进程可见（远端调用靠它禁交互式提示）', () => {
    const dir = makeTmp();
    // 用 git 自己把环境变量读出来：`git var GIT_AUTHOR_IDENT` 会读 GIT_AUTHOR_NAME
    execute(dir, ['init', '-q']);
    const ident = execute(dir, ['var', 'GIT_AUTHOR_IDENT'], {
      env: { GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.com' },
    });
    expect(ident).toContain('probe');
  });

  it('env 是追加而不是替换：process.env 里已有的变量仍到得了子进程，同名时以 options.env 为准', () => {
    const dir = makeTmp();
    execute(dir, ['init', '-q']);
    const before = process.env.GIT_AUTHOR_NAME;
    try {
      // 父进程里先放一个值：合并正确的实现里它必须继续被子进程看到（不是「只传 options.env」）
      process.env.GIT_AUTHOR_NAME = 'from-parent-env';
      const inherited = execute(dir, ['var', 'GIT_AUTHOR_IDENT'], {
        env: { GIT_AUTHOR_EMAIL: 'probe@example.com' },
      });
      expect(inherited).toContain('from-parent-env');

      // 同名时 options.env 覆盖 process.env（远端要靠它盖掉用户自己的设置，如 GIT_TERMINAL_PROMPT）
      const overridden = execute(dir, ['var', 'GIT_AUTHOR_IDENT'], {
        env: { GIT_AUTHOR_NAME: 'from-options', GIT_AUTHOR_EMAIL: 'probe@example.com' },
      });
      expect(overridden).toContain('from-options');
      // 合并是「造一份副本」，绝不写回父进程的环境：否则注入的 GIT_TERMINAL_PROMPT=0 会长期留在本进程里
      expect(process.env.GIT_AUTHOR_NAME).toBe('from-parent-env');
    } finally {
      if (before === undefined) delete process.env.GIT_AUTHOR_NAME;
      else process.env.GIT_AUTHOR_NAME = before;
    }
  });

  it('utf8 真的生效：中文提交信息与中文路径都逐字回来（指定错编码时是字符串但是乱码）', () => {
    const dir = makeTmp();
    execute(dir, ['init', '-q']);
    writeFileSync(join(dir, '中文文件.txt'), '内容\n', 'utf8');
    execute(dir, [...IDENT, 'add', '中文文件.txt']);
    execute(dir, [...IDENT, 'commit', '-q', '-m', '修复中文提交信息与中文文件名']);

    // 这一条不只是「返回 string 而不是 Buffer」：encoding 换成 latin1 之类同样是 string，但中文会变乱码
    expect(execute(dir, ['log', '--format=%s', '-n', '1']).trim()).toBe('修复中文提交信息与中文文件名');
    // 路径同理：没有 `-c core.quotepath=false` 时非 ASCII 路径会被写成 "\344\270\255\346\226\207..." 八进制转义
    expect(execute(dir, ['ls-files'])).toContain('中文文件.txt');
  });

  it('超时被杀：isTimeoutKill 为真，且不是普通失败', () => {
    const dir = makeTmp();
    let caught: unknown = null;
    try {
      // 1ms 上限对一个真实的 git 进程必定超时（确定性，不依赖机器快慢）
      execute(dir, ['init', '-q'], { timeoutMs: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(isTimeoutKill(caught)).toBe(true);
    expect(gitMessage(caught)).not.toBe('');
  });
});

describe('isTimeoutKill', () => {
  it('普通失败不是超时：仓库还没有提交时 rev-parse HEAD 失败，判 false', () => {
    // 用「空的仓库」（unborn HEAD）而不是「不是仓库的目录」：前者的失败在**任何**机器上都确定发生，
    // 不依赖 tmpdir 是否恰好落在某个仓库里；两者都是货真价实的非超时失败。
    const dir = makeTmp();
    execute(dir, ['init', '-q']);
    let caught: unknown = null;
    try {
      execute(dir, ['rev-parse', 'HEAD']);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(isTimeoutKill(caught)).toBe(false);
    expect(gitMessage(caught)).not.toBe('');
  });

  it('文案里有 timed out / ETIMEDOUT 但没带 signal/code 的错误不算超时（判据是信号，不是文案）', () => {
    // 远端自己报超时（ssh / curl / 代理）的原文里这两种关键词都可能出现：按关键词判定会把
    // 「远端不可达」与我们杀掉的那次混成一类，正是 spec §8.2 末段禁止的。
    // 两个关键词都塞进 stderr，是为了让「把判据写在文案上」的任何写法（不管挑哪个词）都必然红。
    const fromRemote: unknown = Object.assign(new Error('git 进程以 128 退出'), {
      status: 128,
      signal: null,
      code: 128,
      stderr:
        'fatal: unable to access https://example.invalid/x.git/: ETIMEDOUT ' +
        '(Connection timed out after 30000 milliseconds)',
    });
    expect(isTimeoutKill(fromRemote)).toBe(false);
  });

  it('对任意抛出值都成立：null / undefined / 字符串都不抛 TypeError', () => {
    // JS 里可以 throw 任何东西；判定函数自己抛错会把「分类失败」变成新的失败点
    expect(isTimeoutKill(null)).toBe(false);
    expect(isTimeoutKill(undefined)).toBe(false);
    expect(isTimeoutKill('spawn git ENOENT')).toBe(false);
    expect(isTimeoutKill(new Error('随便一个错误'))).toBe(false);
  });
});
