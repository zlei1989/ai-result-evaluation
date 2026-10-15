// @vitest-environment node
/**
 * 追问路由组：`POST /api/follow-up`（一句话 + 附件清单）与
 * `GET /api/follow-up/availability?runId=…`（这一轮每一行的可用性读侧）。
 *
 * 与既有路由用例同源：**只断路由层自己的东西**——状态码映射、zod 拦下的请求体 / 查询参数、
 * 出参形状、以及「中文原因原样透出」。判据与文案在契约里（`canFollowUpRow` 的真值表在
 * `@aieval/contracts`），编排层的同源在 `@aieval/evaluator` 自己的用例里，这里不重复。
 *
 * `@aieval/evaluator` 用 `importOriginal` **展开真身、只换两个成员**：本文件经 `@/app/api/follow-up`
 * 间接 import `@aieval/api` 的 index，而那份 index 会去碰 evaluator 的许多名字——
 * 手写键清单漏一个就要等某条用例在运行期红（既有路由用例踩过这个坑）。真身里那两个被换掉的
 * 入口都会真的起厂商子进程或读盘，故必须换：一条真跑得起来的追问会去 spawn 厂商 CLI，
 * 而「测试里绝不 spawn 真厂商进程」是硬口径。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_MAX_PER_MESSAGE, ServiceError, type EvalRun, type FollowUpAvailability } from '@aieval/contracts';
import { setCasesRootForTesting, setConfigDirForTesting } from '@aieval/core';
import { updateSettings } from '@aieval/api';
import { POST as postFollowUp } from '@/app/api/follow-up/route';
import { GET as getAvailability } from '@/app/api/follow-up/availability/route';
import { removeTreeWithRetry } from './testing/cleanup';

/** 编排层那两个入口的替身（`vi.hoisted` 让它们先于 import 求值） */
const orchestrator = vi.hoisted(() => ({ followUpRow: vi.fn(), followUpAvailability: vi.fn() }));
vi.mock('@aieval/evaluator', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  followUpRow: orchestrator.followUpRow,
  followUpAvailability: orchestrator.followUpAvailability,
}));

/**
 * 真身里的两格：`saveRun` 用来把夹具真落盘（api 层的存在性检查读的就是盘上那份快照），
 * 类型给 `Record<string, unknown>`——本应用没声明 `@aieval/evaluator`（方向表：web-next 只到
 * api / core / ui / client / contracts），`typeof import('@aieval/evaluator')` 连 tsc 都解析不到。
 */
const actualEvaluator = await vi.importActual<Record<string, unknown>>('@aieval/evaluator');
const saveRun = actualEvaluator.saveRun as (run: EvalRun) => void;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-follow-up-'));
  setConfigDirForTesting(dir);
  setCasesRootForTesting(join(dir, 'cases'));
  // 快照读侧只扫**当前设置里的根**，故它必须与夹具落盘的那棵树对上
  updateSettings({ workspaceRoot: dir });
  orchestrator.followUpRow.mockReset();
  orchestrator.followUpAvailability.mockReset();
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

/** 造一轮真落盘的单行评测（存在性检查读盘上那份快照，假的会让它走错分支） */
function seedRun(): EvalRun {
  const run: EvalRun = {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '为多协议入站补齐转换',
    note: '',
    repoPath: join(dir, 'repo'),
    commitHash: null,
    repoBranch: null,
    rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '补齐转换', weight: 20 }] }] },
    includeSteps: false,
    status: 'idle',
    executionMode: 'serial',
    useAgentJudge: false,
    askUser: false,
    injectMessages: true,
    rows: [
      {
        id: 'r-1',
        agentKind: 'cc',
        providerId: 'p-anthropic',
        providerName: 'Anthropic 网关',
        baseUrl: 'https://gw.example.com/anthropic',
        modelId: 'claude-opus-4-6',
        status: 'judged',
        branch: 'test/r-1',
        workspacePath: join(dir, 'run-1', 'rows', 'r-1', 'workspace'),
        baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
        tokens: null,
        turns: null,
        durationMs: null,
        diff: null,
        score: null,
        error: null,
        attempts: 1,
        sessionId: 'sess-1',
        followUps: 0,
        followUpRounds: 0,
      },
    ],
    workspaceBase: dir,
    createdAt: '2026-10-13T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  };
  saveRun(run);
  return run;
}

/** 一个 POST 请求：体是 JSON 文本（语法失败那一档要用原文，故这里收字符串） */
function request(body: unknown, raw = false): Request {
  return new Request('http://localhost/api/follow-up', {
    method: 'POST',
    body: raw ? String(body) : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/** 响应体（`ServiceError` 的线上形状：`{error:{code,message}}`） */
async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return body.error;
}

describe('POST /api/follow-up', () => {
  it('合法请求 ⇒ 200 + api 交回的那份快照（原样透出，不加工）', async () => {
    const run = seedRun();
    orchestrator.followUpRow.mockReturnValue(run);
    const response = await postFollowUp(request({ runId: run.id, rowId: 'r-1', text: '接着干' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(run);
    // 交给编排层的是**三个位置参数**（runId / rowId / 那一句话），与 `followUpRow` 的签名同形：
    // zod 没把字段丢掉（丢一格的表现是「追问发出去了、附件没了」），且附件那一格缺席时给的是空数组
    expect(orchestrator.followUpRow).toHaveBeenCalledWith(run.id, 'r-1', { text: '接着干', attachments: [] });
  });

  it('附件与 messageId 原样带过去（两格可选：给了才传）', async () => {
    const run = seedRun();
    orchestrator.followUpRow.mockReturnValue(run);
    const attachments = [{ kind: 'image', path: '/tmp/a.png', mimeType: 'image/png' }];
    await postFollowUp(request({ runId: run.id, rowId: 'r-1', text: '', attachments, messageId: 'm-9' }));
    expect(orchestrator.followUpRow).toHaveBeenCalledWith(run.id, 'r-1', { text: '', attachments, messageId: 'm-9' });
  });

  it('缺 runId / rowId ⇒ 400（zod 拦下，不进服务层）', async () => {
    const run = seedRun();
    const missingRow = await postFollowUp(request({ runId: run.id, text: '在吗' }));
    expect(missingRow.status).toBe(400);
    expect((await errorOf(missingRow)).code).toBe('INVALID_QUERY');
    expect(orchestrator.followUpRow).not.toHaveBeenCalled();
  });

  it('附件超过条数上限 ⇒ 400（上限在契约里，路由这一层就拦下，不进服务层）', async () => {
    const run = seedRun();
    const attachments = Array.from({ length: ATTACHMENT_MAX_PER_MESSAGE + 1 }, (_, index) => ({
      kind: 'file' as const,
      path: `/tmp/${String(index)}.txt`,
      mimeType: null,
    }));
    const response = await postFollowUp(request({ runId: run.id, rowId: 'r-1', text: '带一堆附件', attachments }));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('INVALID_QUERY');
    expect(orchestrator.followUpRow).not.toHaveBeenCalled();
  });

  it('请求体不是合法 JSON ⇒ 400「请求体不是合法 JSON」（不许让别的 SyntaxError 冒充它）', async () => {
    const response = await postFollowUp(request('{ 不是 JSON', true));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe('请求体不是合法 JSON');
  });

  it('编排层的拒绝原样透出：409 + 中文原因一个字都不改写（界面按它给 Tooltip）', async () => {
    const run = seedRun();
    orchestrator.followUpRow.mockImplementation(() => {
      throw new ServiceError('CONFLICT', '该行上一次的运行还没收尾，请稍候再试');
    });
    const response = await postFollowUp(request({ runId: run.id, rowId: 'r-1', text: '再试一次' }));
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toBe('该行上一次的运行还没收尾，请稍候再试');
  });

  it('这一行不存在 ⇒ 404（api 层的存在性检查，不打扰编排层）', async () => {
    const run = seedRun();
    const response = await postFollowUp(request({ runId: run.id, rowId: 'r-missing', text: '在吗' }));
    expect(response.status).toBe(404);
    expect(orchestrator.followUpRow).not.toHaveBeenCalled();
  });
});

describe('GET /api/follow-up/availability', () => {
  /** 带查询参数的请求 */
  function availabilityRequest(query: string): Request {
    return new Request(`http://localhost/api/follow-up/availability${query}`, { method: 'GET' });
  }

  it('给这一轮每一行的结论 ⇒ 200（出参过 schema，顺序原样）', async () => {
    const run = seedRun();
    const availability = {
      rows: [
        { rowId: 'r-1', verdict: { ok: false as const, reason: '这一行的工作区已被删除（/gone）：追问要在原工作区上继续' } },
      ],
    };
    orchestrator.followUpAvailability.mockReturnValue(availability);
    const response = await getAvailability(availabilityRequest(`?runId=${run.id}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(availability);
    expect(orchestrator.followUpAvailability).toHaveBeenCalledWith(run.id);
  });

  it('缺 runId / 空 runId ⇒ 400（空串不许一路走到「评测不存在」——那是两件事）', async () => {
    seedRun();
    for (const query of ['', '?runId=']) {
      const response = await getAvailability(availabilityRequest(query));
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('INVALID_QUERY');
    }
    expect(orchestrator.followUpAvailability).not.toHaveBeenCalled();
  });

  /**
   * **端到端那一条**：这一格不换实现，让请求真的走
   * 路由 → api → evaluator → contracts（`canFollowUpRow`），判据链一节都不缺。
   *
   * 为什么值得单开一条：上面几条把编排层换成替身，证的是「形状与状态码」；而
   * 「盘上的事实最终变成哪一句中文」只有在真链路上才看得见——把 `canFollowUpRow` 短路成
   * 「永远可行」，上面那些形状断言照样全绿，这一条会红。
   */
  it('端到端：盘上真没了工作区 ⇒ 200 + 契约那一句原因（判据链一路到 contracts）', async () => {
    const run = seedRun();
    const real = actualEvaluator.followUpAvailability as (runId: string) => FollowUpAvailability;
    orchestrator.followUpAvailability.mockImplementation(real);

    const response = await getAvailability(availabilityRequest(`?runId=${run.id}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as FollowUpAvailability;
    const verdict = body.rows[0]?.verdict;
    expect(verdict?.ok).toBe(false);
    expect(verdict?.ok === false ? verdict.reason : '').toContain('工作区已被删除');
  });

  it('这一轮不存在 ⇒ 404', async () => {
    seedRun();
    const response = await getAvailability(availabilityRequest('?runId=run-missing'));
    expect(response.status).toBe(404);
  });

  it('出参不合契约 ⇒ 400（畸形出参在这里就响，不让界面拿到一个没有原因的 verdict）', async () => {
    const run = seedRun();
    orchestrator.followUpAvailability.mockReturnValue({ rows: [{ rowId: 'r-1', verdict: { ok: false, reason: '' } }] });
    const response = await getAvailability(availabilityRequest(`?runId=${run.id}`));
    expect(response.status).toBe(400);
  });
});
