// @vitest-environment node
/**
 * classifyRemoteFailure
 *
 * 本文件是 `mirror.test.ts` 拆分后的一块：真实 git / 裸仓库 / 静默远端等夹具与 `waitForConnection` 都在 `./testing/mirror-harness`（那里也写明了钩子为什么必须是显式注册的函数）。
 */

import { describe, expect, it } from 'vitest';
import {
  makeTmp,
  git,
  makeOriginRepo,
  hashOf,
  gitFailure,
  FAST_FAILURE_PROBE_TIMEOUT_MS,
  caughtOf,
  existsSync,
  renameSync,
  writeFileSync,
  join,
  ServiceError,
  classifyRemoteFailure,
  defaultBranchName,
  ensureMirror,
  probeRemote,
  registerMirrorHooks,
} from './testing/mirror-harness';



registerMirrorHooks();

describe('classifyRemoteFailure', () => {
  interface FailureRow {
    name: string;
    /** 缺省用下面这条 https 地址 */
    url?: string;
    error: unknown;
    code: string;
    /** 文案里的区分性片段：每一类都要有自己的那一句，换错分支必然红 */
    fragment: string;
    /** 明确不该出现的片段（例：普通失败不能带上「超时」） */
    notFragment?: string;
    host?: string;
    /** 调用方的口径与生效上限（缺省 = 抓取 + 默认 600_000） */
    kind?: 'probe' | 'transfer';
    timeoutMs?: number;
  }

  const url = 'https://host.example/group/x.git';
  const timeoutKill = (): Error => Object.assign(new Error('spawnSync git ETIMEDOUT'), { signal: 'SIGTERM', status: null, stderr: '' });

  /** 合成错误：分类只读 stderr，够用且不依赖环境 */
  const rows: FailureRow[] = [
    {
      name: 'SSH 凭据不可用',
      url: 'git@github.com:FlowAI/rbac-server.git',
      error: gitFailure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'),
      code: 'AUTH_FAILED',
      fragment: '认证失败',
      host: 'github.com',
    },
    {
      name: 'DNS 解析失败',
      error: gitFailure('fatal: unable to access \'https://nope.invalid/group/x.git/\': Could not resolve host: nope.invalid'),
      code: 'REPO_UNREACHABLE',
      fragment: '无法解析远端主机',
    },
    {
      name: '连接被拒（本机 git 2.47 实测原文里没有 Connection refused 字样）',
      url: 'http://127.0.0.1:1/x.git',
      error: gitFailure(
        'fatal: unable to access \'http://127.0.0.1:1/x.git/\': Failed to connect to 127.0.0.1 port 1 after 0 ms: Could not connect to server',
      ),
      code: 'REPO_UNREACHABLE',
      fragment: '无法连接远端仓库',
    },
    {
      // 远端自己报的 timeout 长得像我们的墙钟超时，但它没有 signal/code，必须走「不可达」而不是超时分支
      name: '远端报的 curl 连接超时（不是我们杀的那次）',
      error: gitFailure(
        'fatal: unable to access \'https://slow.example/x.git/\': Failed to connect to slow.example port 443 after 130000 ms: Timeout was reached',
      ),
      code: 'REPO_UNREACHABLE',
      fragment: '无法连接远端仓库',
    },
    {
      name: 'SSH 主机指纹未信任',
      url: 'git@host.example:group/x.git',
      error: gitFailure('Host key verification failed.\nfatal: Could not read from remote repository.'),
      code: 'REPO_UNREACHABLE',
      fragment: 'SSH 主机指纹未信任',
    },
    {
      name: '远端报 not found（私有仓库无凭据时同形）',
      error: gitFailure('remote: Repository not found.\nfatal: repository \'https://host.example/group/x.git/\' not found'),
      code: 'NOT_A_GIT_REPO',
      fragment: '远端仓库不存在或无权访问',
    },
    {
      name: '路径不是 git 仓库',
      error: gitFailure('fatal: \'/tmp/nope.git\' does not appear to be a git repository'),
      code: 'NOT_A_GIT_REPO',
      fragment: '不是 git 仓库',
    },
    {
      name: '墙钟杀掉（signal=SIGTERM、stderr 为空）',
      error: timeoutKill(),
      code: 'REPO_UNREACHABLE',
      fragment: '超时',
    },
    {
      name: '墙钟杀掉（code=ETIMEDOUT）',
      error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      code: 'REPO_UNREACHABLE',
      fragment: '超时',
    },
    {
      // 探活的默认上限是 15s：文案要说「探活」与「秒」，不能说成「拉取」与「0 分钟」
      name: '探活墙钟杀掉（默认 15s 上限）',
      error: timeoutKill(),
      code: 'REPO_UNREACHABLE',
      fragment: '探活超时（超过 15 秒）',
      kind: 'probe',
    },
    {
      // 调用方注入的亚分钟上限按秒说（ensureMirror / fetchMirror 转发的是**生效**值）
      name: '抓取注入 3s 上限（文案按秒）',
      error: timeoutKill(),
      code: 'REPO_UNREACHABLE',
      fragment: '拉取超时（超过 3 秒）',
      timeoutMs: 3000,
    },
    {
      // 普通的非零退出绝不能落到超时分支——这是「超时靠信号、不靠关键词」的单元级证据
      name: '普通失败（退出码 1、无信号）',
      error: Object.assign(new Error('Command failed: git ls-remote'), {
        status: 1,
        code: 1,
        signal: null,
        stderr: 'fatal: unable to access \'https://host.example/group/x.git/\': The requested URL returned error: 503',
      }),
      code: 'NOT_A_GIT_REPO',
      fragment: '无法读取远端仓库',
      notFragment: '超时',
    },
  ];

  it.each(rows)('$name → $code，且文案含「$fragment」', (row) => {
    const classified = classifyRemoteFailure(row.error, {
      url: row.url ?? url,
      what: '读取远端仓库',
      kind: row.kind,
      timeoutMs: row.timeoutMs,
    });
    expect(classified.code).toBe(row.code);
    expect(classified.message).toContain(row.fragment);
    if (row.notFragment !== undefined) {
      expect(classified.message).not.toContain(row.notFragment);
    }
    if (row.host !== undefined) {
      expect((classified.context as { host?: string }).host).toBe(row.host);
    }
  });

  it('超时文案由分类层自己写：Node 的英文原文只进 context，不当原因', () => {
    const classified = classifyRemoteFailure(timeoutKill(), { url, what: '读取远端仓库' });
    // 逐字文案（未传 timeoutMs → 默认 600_000 ms → 10 分钟）
    expect(classified.message).toBe(`远端仓库拉取超时（超过 10 分钟）：${url}（已终止 git 进程）`);
    expect(classified.message).not.toContain('spawnSync');
    expect((classified.context as { gitMessage?: string }).gitMessage).toContain('ETIMEDOUT');
  });

  it('非正数超时按「没给」处理（0 / 负数 / NaN 都回落到默认，不是「0 分钟」）', () => {
    for (const timeoutMs of [0, -1, Number.NaN]) {
      const classified = classifyRemoteFailure(timeoutKill(), { url, what: '读取远端仓库', timeoutMs });
      // 写成 `timeoutMs ?? 默认值` 时这一格会变成「超过 0 分钟」（0）或「超过 NaN 分钟」——正是要拦住的静默失效
      expect(classified.message).toBe(`远端仓库拉取超时（超过 10 分钟）：${url}（已终止 git 进程）`);
      // 探活口径的回落也必须是它自己的默认（15s），不能借抓取的 10 分钟
      expect(classifyRemoteFailure(timeoutKill(), { url, what: '读取远端仓库', kind: 'probe', timeoutMs }).message).toBe(
        `远端仓库探活超时（超过 15 秒）：${url}（已终止 git 进程）`,
      );
    }
  });
});

describe('远端调用的环境', () => {
  it('尊重用户自己的 GIT_SSH_COMMAND：只在他没设时才追加 BatchMode=yes', () => {
    const root = makeTmp('aieval-mirror-');
    const marker = join(root, 'ssh-ran.txt');
    const fakeSsh = join(root, 'fake-ssh.mjs');
    // 假 ssh：留个痕就退出（不必真的连谁）——它有没有被调用，就是「用户配置有没有被覆盖」的证据
    writeFileSync(fakeSsh, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'ran\\n');\nprocess.exit(1);\n`, 'utf8');

    const previous = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = `node "${fakeSsh}"`;
    let caught: unknown = null;
    try {
      // 墙钟给足：理由同 FAST_FAILURE_PROBE_TIMEOUT_MS（这里靠的是「git 会去起我们设的 ssh」，
      // 被 15s 截断时留痕缺失是环境噪声，会让这条断言红得没有归因价值）
      probeRemote('git@127.0.0.1:x.git', { cwd: root, timeoutMs: FAST_FAILURE_PROBE_TIMEOUT_MS });
    } catch (error) {
      caught = error;
    } finally {
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = previous;
    }

    // 假 ssh 一定失败（进程退出码 1），但失败也必须是折好的 ServiceError，不能是裸错
    expect(caught).toBeInstanceOf(ServiceError);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('defaultBranchName', () => {
  it('读的是镜像 HEAD，不联网：来源被移走也照样给出默认分支名', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    renameSync(origin.bareDir, `${origin.bareDir}.moved`);

    // 函数签名里根本没有 url：默认分支名是镜像 HEAD 已经记下的事实，不需要再问远端一次
    expect(defaultBranchName(dir)).toBe('main');
  });

  it('镜像 HEAD 不是符号引用（detached）→ NOT_A_GIT_REPO，中文原因 + git 原文 + context 点名镜像目录', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    // `--no-deref` 把 hash 直接写进 HEAD（HEAD 不再指向任何分支）：镜像 HEAD 被写坏的形态。
    // 此时 symbolic-ref 失败（ref HEAD is not a symbolic ref），rev-parse --abbrev-ref 只回 "HEAD"，
    // 两条读法都拿不到分支名——这正是要抛 NOT_A_GIT_REPO 的那一格。
    git(dir, ['update-ref', '--no-deref', 'HEAD', hashOf(origin, 'main')]);

    const caught = caughtOf(() => defaultBranchName(dir));
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    // 中文原因在前、git 原文在后；原文同时另放 context
    expect((caught as Error).message).toContain(dir);
    expect((caught as Error).message).toContain('not a symbolic ref');
    expect((caught as ServiceError).context).toMatchObject({ mirrorDir: dir });
    expect((caught as ServiceError).context).toHaveProperty('gitMessage');
  });
});
