/**
 * 追问数据层：可用性读侧（整轮一行一条结论）+ 写侧（发一条、回写两个键）。
 *
 * 五条风险面（每一条坏掉的表现都是「界面照旧工作、只是说的不是真的」）：
 *   1. 闸门关着（抽屉没开 / 没选中轮次）时**一个请求都不发**；
 *   2. 读侧按**候选 id** 摊成一张表（界面按行取结论；漏一个候选就是那一候选的按钮没有判据）；
 *   3. `revision` 一变就**重读**（判据的前两档随候选状态翻转，而这一条读侧没有信号流），
 *      但**挂载那一拍不补读**（那是同一瞬间刚发出去的那一次请求）；
 *   4. 写侧发的是契约那一份请求体（`runId`/`candidateId`/`text`/`attachments`/`messageId` 一格不丢）；
 *   5. 写成功回写**详情键与列表键**（「立刻变成准备中」必须同时被两处看到），
 *      失败**抛 `ServiceError`**（中文原因由调用方直接展示，不在这一层吞掉）。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { ServiceError, type EvalRun, type FollowUpAvailability } from '@aieval/contracts';
import {
  FOLLOW_UP_AVAILABILITY_URL,
  FOLLOW_UP_URL,
  followUpAvailabilityUrl,
  postFollowUp,
  useFollowUpAvailability,
  useFollowUpCandidate,
} from './follow-up';

/** fetch 替身的签名显式写出来：`vi.fn(async () => …)` 会被推成零参函数，`mock.calls[0][0]` 报 TS2493 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const AVAILABILITY_URL = followUpAvailabilityUrl('run-1');

/** 读侧的替身：`reads` 记下每一次读的地址（重读与否靠它数） */
function stubReads(availability: FollowUpAvailability): { fetchMock: FetchMock; reads: string[] } {
  const reads: string[] = [];
  const fetchMock = vi.fn<FetchHandler>(async (url: string) => {
    const target = String(url);
    if (target === AVAILABILITY_URL) {
      reads.push(target);
      return json(availability);
    }
    throw new Error(`本 hook 不该请求这个地址：${target}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, reads };
}

/** 一轮的最小快照（写侧只把它原样回写两个键，故只给判等用的那几格） */
function runOf(): EvalRun {
  return { id: 'run-1' } as EvalRun;
}

/** SWR 的包裹层：每个用例一份独立缓存，免得键相同却串数据 */
function wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('useFollowUpAvailability', () => {
  it('挂载即读一轮的结论，并按候选 id 摊成一张表', async () => {
    const { reads } = stubReads({
      candidates: [
        { candidateId: 'r-1', verdict: { ok: true } },
        { candidateId: 'r-2', verdict: { ok: false, reason: '该候选上一次的运行还没收尾，请稍候再试' } },
      ],
    });
    const { result } = renderHook(() => useFollowUpAvailability({ runId: 'run-1', enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.verdictOf('r-1')).toEqual({ ok: true }));
    expect(result.current.verdictOf('r-2')).toEqual({ ok: false, reason: '该候选上一次的运行还没收尾，请稍候再试' });
    // 没有这个候选的判据（读侧漏了它 / 候选是刚加的）：`undefined`，由界面决定怎么说
    expect(result.current.verdictOf('r-3')).toBeUndefined();
    expect(reads).toEqual([AVAILABILITY_URL]);
  });

  it('闸门关着 / 没有轮次 ⇒ 一个请求都不发（判据缺席，界面不许编一个）', async () => {
    const { fetchMock } = stubReads({ candidates: [] });
    const disabled = renderHook(() => useFollowUpAvailability({ runId: 'run-1', enabled: false }), { wrapper });
    const empty = renderHook(() => useFollowUpAvailability({ runId: '', enabled: true }), { wrapper });
    await waitFor(() => expect(disabled.result.current.isLoading).toBe(false));
    expect(empty.result.current.verdictOf('r-1')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('`revision` 变了就重读；挂载那一拍不补读（那是同一瞬间刚发出去的那一次）', async () => {
    const { reads } = stubReads({ candidates: [{ candidateId: 'r-1', verdict: { ok: true } }] });
    const { result, rerender } = renderHook(
      ({ revision }: { revision: string }) => useFollowUpAvailability({ runId: 'run-1', enabled: true, revision }),
      { wrapper, initialProps: { revision: 'judged' } },
    );
    await waitFor(() => expect(reads).toHaveLength(1));

    // 候选状态没变（同一个 revision）⇒ 不重读
    rerender({ revision: 'judged' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(reads).toHaveLength(1);

    // 候选状态变了 ⇒ 重读一次，且旧结论在重读期间照旧可用（界面不闪回「没有判据」）
    rerender({ revision: 'running' });
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(result.current.verdictOf('r-1')).toEqual({ ok: true });
  });

  it('读失败时如实抛出（error 交回调用方），结论表为空而不是「都能追问」', async () => {
    const fetchMock = vi.fn<FetchHandler>(async () => json({ error: { code: 'NOT_FOUND', message: '评测不存在：run-1' } }, 404));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFollowUpAvailability({ runId: 'run-1', enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(ServiceError));
    expect(result.current.verdictOf('r-1')).toBeUndefined();
  });
});

describe('postFollowUp / useFollowUpCandidate', () => {
  it('请求体原样交给服务端（含 messageId 与附件清单）', async () => {
    const fetchMock = vi.fn<FetchHandler>(async () => json(runOf()));
    vi.stubGlobal('fetch', fetchMock);
    const attachments = [{ kind: 'image' as const, path: '/tmp/a.png', mimeType: 'image/png' }];
    await postFollowUp({ runId: 'run-1', candidateId: 'r-1', text: '接着干', attachments, messageId: 'm-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(FOLLOW_UP_URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      runId: 'run-1',
      candidateId: 'r-1',
      text: '接着干',
      attachments,
      messageId: 'm-1',
    });
  });

  it('写成功回写详情键与列表键（两处都要立刻看到「准备中」），且不动读侧的键', async () => {
    const run = runOf();
    const fetchMock = vi.fn<FetchHandler>(async () => json(run));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFollowUpCandidate(), { wrapper });
    await act(async () => {
      await result.current.followUpCandidate({ runId: 'run-1', candidateId: 'r-1', text: '接着干' });
    });
    // 回写两处 = 各一次 `mutate`，而不是再发两个 GET（`revalidate: false`）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.isFollowingUp).toBe(false);
  });

  it('拒绝原样抛 `ServiceError`（中文原因由调用方展示，不在数据层吞掉）', async () => {
    const fetchMock = vi.fn<FetchHandler>(async () =>
      json({ error: { code: 'CONFLICT', message: '这个候选没有可续接的会话（还没跑过，或是没有这一格的旧产物）' } }, 409),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFollowUpCandidate(), { wrapper });
    await expect(
      act(async () => {
        await result.current.followUpCandidate({ runId: 'run-1', candidateId: 'r-1', text: '在吗' });
      }),
    ).rejects.toThrow('没有可续接的会话');
    expect(result.current.isFollowingUp).toBe(false);
  });
});

// `FOLLOW_UP_AVAILABILITY_URL` 是拼地址用的基址：用例直接引它，免得字面量在断言里抄第二份
expect(FOLLOW_UP_AVAILABILITY_URL).toBe('/api/follow-up/availability');
