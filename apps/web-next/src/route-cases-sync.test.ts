// @vitest-environment node
/**
 * 用例同步两条路由的端到端：`GET /api/cases/sync-status` 与 `POST /api/cases/sync`。
 *
 * 为什么单独一份而不并进 `route-cases.test.ts`：那份文件的夹具与「用例改成一文件一落」的迁移绑在一起，
 * 而这里要钉的是另一条链——「路由把动作原样转给服务层，并把服务层的中文原因折成 409」。
 * 分开之后，这一层的失败一眼可辨（是本层坏了，还是迁移波次还没收尾）。
 *
 * 这一层要挡的三件事：
 *   ① 状态路由**永不 500**：用例目录不是 git 仓库、没配远端都是快照里的一格事实（用户据此知道
 *      整块功能为什么不可用）。把它做成错误响应，设置页那一格就只能显示一个红条，原因反而丢了；
 *   ② 动作用的是 **contracts 导出的那一份 zod**：复制出来的第二份只会以 `instanceof ZodError` 为假
 *      落到 500，而 400 与 500 在修复方向上完全不是一回事；
 *   ③ 动作的真实失败（这里用「未配置评分智能体」触发）折成 ServiceError 的**中文原因 + 409**，
 *      而不是笼统的「服务端内部错误」——后者用户没法据此做任何事。
 *
 * 配置目录与用例目录一律是 `mkdtempSync` 出来的临时目录：绝不碰真实的 `~/.aieval` / `~/.aieval-cases`。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, type CaseSyncStatus } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { resetCaseSyncForTesting } from '@aieval/api';
import { GET as getSyncStatus } from '@/app/api/cases/sync-status/route';
import { POST as runSync } from '@/app/api/cases/sync/route';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;
/** 当前用例目录（非 git 仓库那一份）：断言里要拿它比对服务端回显的路径 */
let casesDir: string;
/**
 * git 仓库模板：`beforeAll` 里建**一次**，用例按需 `cpSync` 一份。
 * 本机的进程创建约 250–400ms（企业杀软在 CreateProcess 上收税），每个用例各 `git init` 一次是白付这几百毫秒。
 */
let fixtureRepo: string;

beforeAll(() => {
  fixtureRepo = mkdtempSync(join(tmpdir(), 'aieval-route-cases-sync-fixture-'));
  execFileSync('git', ['init', '-q'], { cwd: fixtureRepo });
});

afterAll(() => {
  removeTreeWithRetry(fixtureRepo);
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-cases-sync-'));
  setConfigDirForTesting(dir);
  // 同步状态是**模块级内存状态**（上次成功时间、上次提交…）：不归零，用例之间会互相看见对方的历史
  resetCaseSyncForTesting();
  casesDir = join(dir, 'cases');
  mkdirSync(casesDir, { recursive: true });
  saveConfig({
    ...loadConfig(),
    settings: { ...SETTINGS_DEFAULTS, workspaceRoot: join(dir, 'runs'), casesRoot: casesDir },
  });
});

afterEach(() => {
  resetCaseSyncForTesting();
  // 顺序要紧：先复位再删目录，否则万一删目录抛错，覆盖值会漏给下一个文件
  setConfigDirForTesting(null);
  removeTreeWithRetry(dir);
});

/** 造一个请求：与 Next 交给路由的入参同形（原生 Request） */
function jsonRequest(url: string, method: string, body: string): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/** 把用例目录改到另一处（同步的每个判定都以它为准，改完要经路由读回来验证） */
function saveCasesRoot(root: string): void {
  saveConfig({ ...loadConfig(), settings: { ...loadConfig().settings, casesRoot: root } });
}

/** 用例目录 = 一个真的 git 仓库（没有远端、也没有配评分智能体） */
function useGitCasesRoot(): string {
  const repo = join(dir, 'cases-repo');
  cpSync(fixtureRepo, repo, { recursive: true });
  saveCasesRoot(repo);
  return repo;
}

describe('GET /api/cases/sync-status', () => {
  it('用例目录不是 git 仓库 → 200，isRepo=false 且原因里带着路径（不是 500）', async () => {
    const res = await getSyncStatus();

    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseSyncStatus;
    expect(body.isRepo).toBe(false);
    expect(body.hasRemote).toBe(false);
    expect(body.blockedReason).toContain(casesDir);
    expect(body.blockedReason).toContain('不是 git 仓库');
  });

  it('是 git 仓库但没有远端、也没配评分智能体 → isRepo=true，原因指向「评分配置」', async () => {
    useGitCasesRoot();

    const res = await getSyncStatus();

    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseSyncStatus;
    expect(body.isRepo).toBe(true);
    // 「没有远端」不写进 blockedReason：它挡不住本地提交，是另一格事实（界面自己说「只提交到本地」）
    expect(body.hasRemote).toBe(false);
    expect(body.blockedReason).toContain('评分配置');
    // 没探到远端时是 null 而不是 0：把「没探到」写成 0，界面会把一次离线说成「远端没有新提交」
    expect(body.remoteAhead).toBeNull();
  });
});

describe('POST /api/cases/sync', () => {
  it('action 非法 → 400，且 context 是真 zod 的 issues（path 指向 action）', async () => {
    const res = await runSync(jsonRequest('/api/cases/sync', 'POST', '{"action":"force-push"}'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    // 断言 path 而不是 `Array.isArray(context)`：后者对 `context: []` 也成立，抓不到「zod 被装了两份」
    expect(body.error.context[0].path).toEqual(['action']);
  });

  it('缺少 action → 400（zod 校验在路由层，不落进服务层）', async () => {
    const res = await runSync(jsonRequest('/api/cases/sync', 'POST', '{}'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_QUERY');
  });

  it('请求体不是合法 JSON → 400「请求体不是合法 JSON」（不是 500）', async () => {
    const res = await runSync(jsonRequest('/api/cases/sync', 'POST', '{坏 JSON'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('请求体不是合法 JSON');
  });

  /**
   * 不是 git 仓库时点「提交」**不是失败**：服务端这轮什么都不做（`performSync` 直接返回），
   * 状态照实回答 isRepo=false + 原因。把它折成 4xx/5xx 的话，用户会以为「点了但报错了」，
   * 而真正该看到的是「这个目录还不是 git 仓库」。
   */
  it('用例目录不是 git 仓库时点「提交」→ 200，状态如实回答', async () => {
    const res = await runSync(jsonRequest('/api/cases/sync', 'POST', JSON.stringify({ action: 'commit' })));

    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseSyncStatus;
    expect(body.isRepo).toBe(false);
    expect(body.blockedReason).toContain('不是 git 仓库');
  });

  it('动作真失败（未配置评分智能体）→ 409 CONFLICT + 中文原因，不是 500「服务端内部错误」', async () => {
    useGitCasesRoot();

    const res = await runSync(jsonRequest('/api/cases/sync', 'POST', JSON.stringify({ action: 'pull' })));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('同步需要一个智能体');
    // 4xx 是预期内的用户输入 / 配置问题：不带堆栈，也不把它伪装成内部错误
    expect(body.error.message).not.toContain('服务端内部错误');
  });
});
