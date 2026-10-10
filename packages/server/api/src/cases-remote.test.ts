// @vitest-environment node
/**
 * validateRepo（远端来源）
 *
 * 本文件是 `cases.test.ts` 拆分后的一块：共享夹具、真实 git 助手与两条 `vi.mock`（node:fs / node:child_process 的计数探针）都在 `./testing/cases-harness`，那里写明了为什么前导块必须在每个文件里逐字重复（vitest 的前置提升只作用于本文件）。
 */

import { vi, describe, expect, it } from 'vitest';
import {
  ws,
  repo,
  git,
  makeRemoteOrigin,
  REMOTE_FIXTURE_TIMEOUT_MS,
  renameRemoteDefaultBranch,
  gitCommands,
  execFileSync,
  existsSync,
  join,
  ServiceError,
  mirrorDir,
  normalizeBranch,
  validateRepo,
  registerCasesHooks,
} from './testing/cases-harness';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

registerCasesHooks();

describe('validateRepo（远端来源）', () => {
  it('回显远端三件套：仓库名 / 分支 / tip / 镜像路径与更新时间，并把镜像建在工作区根下', () => {
    const origin = makeRemoteOrigin('remote-validate');
    const info = validateRepo({ repoPath: origin.url, repoBranch: null });

    expect(info).toMatchObject({
      repoPath: origin.url,
      repoName: 'remote-validate',
      branch: 'main',
      kind: 'remote',
      mirrorReady: true,
      tip: origin.hashes.main!.slice(0, 7),
    });
    // 期望值由 core 的 mirrorDir 现算（不必照抄 `split('-').at(-1)` 那种自指写法）：
    // 这样钉住的是「工作区根/remotes/<slug>-<hash>」这个完整身份，而不是只钉 slug 前缀
    expect(info.mirrorPath).toBe(mirrorDir(ws, origin.url));
    expect(info.mirrorFetchedAt).not.toBeNull();
    expect(existsSync(join(info.mirrorPath!, 'HEAD'))).toBe(true);
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  it('填了分支：回显该分支与它的 tip', () => {
    const origin = makeRemoteOrigin('remote-branch', ['feat/x']);
    expect(validateRepo({ repoPath: origin.url, repoBranch: 'feat/x' })).toMatchObject({
      branch: 'feat/x',
      tip: origin.hashes['feat/x']!.slice(0, 7),
    });
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  // 与上一条分开（派发说明允许的写法调整）：合并成一条时，变异「分支没转发下去」只让 tip 那条断言红，
  // 「分支不存在必须 INVALID_REF」这半句的区分力就被前一条断言的失败吞掉了，看不到它自己会不会红
  it('分支不存在 → INVALID_REF（不静默回落到默认分支）', () => {
    const origin = makeRemoteOrigin('remote-branch-missing');

    let caught: unknown;
    try {
      validateRepo({ repoPath: origin.url, repoBranch: 'feat/nope' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect((caught as ServiceError).message).toContain('分支不存在');
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  it('URL 填进「本地路径」的位置也按形态判定成远端（界面的态不影响服务端判定）', () => {
    const origin = makeRemoteOrigin('remote-shape');
    // 尾斜杠一起带上：既证明形态判定只看字符串，也钉住回显的是**归一后**的串
    // （它就是镜像 key 与后续落盘要用的那个身份，见 repo-source.ts 的 normalizeRemoteUrl）
    const info = validateRepo({ repoPath: `${origin.url}/`, repoBranch: null });

    expect(info.kind).toBe('remote');
    expect(info.repoPath).toBe(origin.url);
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  // 校验只读镜像。造一份工作树（甚至行工作区）在这里是错的：
  // 镜像跨用例复用、评测准备才 checkout，校验多克隆一份既是浪费也是「两个来源」的入口
  it('远端校验只读镜像：镜像本身是裸仓库，工作区里不冒出 cases 这类行级目录', () => {
    const origin = makeRemoteOrigin('remote-readonly');
    const info = validateRepo({ repoPath: origin.url, repoBranch: null });

    expect(git(['rev-parse', '--is-bare-repository'], info.mirrorPath!).trim()).toBe('true');
    expect(existsSync(join(ws, 'cases'))).toBe(false);
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  /**
   * 远端把默认分支改名（main → trunk）并删掉旧分支之后，校验必须报**新**默认分支。
   *
   * 修复前的形状：镜像 HEAD 停在 main（`fetch --prune` 只剪 ref、不刷新 HEAD，本机 git 2.47 实测），
   * 而 main 已经被剪掉 ⇒ 校验以「无法解析远端默认分支：main」失败——一份完好的仓库被判成不可用，
   * 而且产品里没有任何出路（见 core 的 `mirror-ref.test.ts` 里那条自愈用例）。
   */
  it('远端默认分支改名（旧分支被删）后校验照样通过：报出新默认分支与它的 tip', () => {
    const origin = makeRemoteOrigin('remote-default-renamed');
    // 先校验一次把镜像建出来：第二次走的才是「既有镜像 → fetch → 对齐 HEAD」那条路
    expect(validateRepo({ repoPath: origin.url, repoBranch: null }).branch).toBe('main');

    const trunkTip = renameRemoteDefaultBranch('remote-default-renamed', 'trunk');

    const info = validateRepo({ repoPath: origin.url, repoBranch: null });

    expect(info.branch).toBe('trunk');
    expect(info.tip).toBe(trunkTip.slice(0, 7));
    // 对齐发生在**镜像**上，不是只在这一次的回显里换个名字：后续评测准备读的是同一个 HEAD
    expect(git(['symbolic-ref', '--short', 'HEAD'], info.mirrorPath!).trim()).toBe('trunk');
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  /**
   * 首次校验是「探活 → 克隆」，紧接着再 `fetch` 一次是白等一个往返
   * （克隆本身就是这一次从远端取回；大仓库的首次校验是**分钟级**的）。
   * 判据取**命令行**而不是耗时：clone 与 fetch 是两条不同的命令，数得清、也不受机器快慢影响。
   * 同一条用例里的反向对照是第二次校验：镜像已在，必须真的抓一次——否则「永远不 fetch」也能过。
   */
  it('首次校验只克隆、不再补一次 fetch；第二次校验（镜像已在）必须 fetch', () => {
    const origin = makeRemoteOrigin('remote-first-fetch');
    const spy = vi.mocked(execFileSync);

    spy.mockClear();
    validateRepo({ repoPath: origin.url, repoBranch: null });
    const first = gitCommands();
    expect(first.filter((args) => args.includes('fetch'))).toEqual([]);
    // 正向对照：这一次确实克隆了。少了它，上面那条「没有 fetch」可能只是「什么都没跑」
    expect(first.some((args) => args.includes('clone'))).toBe(true);

    spy.mockClear();
    validateRepo({ repoPath: origin.url, repoBranch: null });
    expect(gitCommands().filter((args) => args.includes('fetch'))).toHaveLength(1);
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  it('本地来源仍然照旧：kind=local、mirrorPath=null、tip=null，且填分支被拒', () => {
    expect(validateRepo({ repoPath: repo, repoBranch: null })).toMatchObject({
      kind: 'local',
      mirrorPath: null,
      mirrorFetchedAt: null,
      tip: null,
    });

    let caught: unknown;
    try {
      validateRepo({ repoPath: repo, repoBranch: 'main' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_QUERY');
    expect((caught as ServiceError).message).toContain('本地目录来源不支持分支');
    expect((caught as ServiceError).message).toContain(repo);
  });

  it('不支持的协议在 api 层就拦下（INVALID_QUERY）', () => {
    let caught: unknown;
    try {
      validateRepo({ repoPath: 'ftp://host/x.git', repoBranch: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_QUERY');
    expect((caught as ServiceError).message).toContain('不支持的 git 地址协议');
  });

  // 表单清空输入框拿到的是空串（不是 null），故「不指定分支」有三种写法都要归一成 null
  it('normalizeBranch：null / undefined / 纯空白都归一成 null，其余 trim 后原样', () => {
    expect(normalizeBranch(null)).toBeNull();
    expect(normalizeBranch(undefined)).toBeNull();
    expect(normalizeBranch('   ')).toBeNull();
    expect(normalizeBranch(' feat/x ')).toBe('feat/x');
  });
});


