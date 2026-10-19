// @vitest-environment node
/**
 * 测试结果路由：只读投影的 HTTP 出口。
 *
 * 这里 mock 掉 `@aieval/api`（投影本身有自己的纯函数用例）：路由只负责
 * 「把 runId 交给服务层 / 错误交给统一映射」，把整条评测编排拉进来反而会盖住这两件事。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type RunTestResults } from '@aieval/contracts';

const api = vi.hoisted(() => ({ getRunTestResults: vi.fn() }));
vi.mock('@aieval/api', () => api);

import { GET } from '@/app/api/runs/[runId]/test-results/route';

afterEach(() => {
  vi.clearAllMocks();
});

function context(runId: string): { params: Promise<{ runId: string }> } {
  return { params: Promise.resolve({ runId }) };
}

describe('GET /api/runs/[runId]/test-results', () => {
  it('把服务层的三态原样返回（unparsed 不被折成 0）', async () => {
    const payload: RunTestResults = {
      rows: [
        {
          rowId: 'r1',
          status: 'collected',
          framework: 'vitest',
          command: 'pnpm test',
          passed: 1,
          failed: 1,
          skipped: 0,
          total: 2,
        },
        {
          rowId: 'r2',
          status: 'unparsed',
          framework: 'pytest',
          command: 'pytest',
          reason: '只读到汇总',
        },
        { rowId: 'r3', status: 'not-collected' },
      ],
    };
    api.getRunTestResults.mockReturnValue(payload);

    const res = await GET(new Request('http://localhost/api/runs/run-1/test-results'), context('run-1'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(payload);
    expect(api.getRunTestResults).toHaveBeenCalledWith('run-1');
  });

  it('服务层的 NOT_FOUND 走统一映射（路由不自己编错误体）', async () => {
    api.getRunTestResults.mockImplementation(() => {
      throw new ServiceError('NOT_FOUND', '评测不存在：run-x');
    });
    const res = await GET(new Request('http://localhost/api/runs/run-x/test-results'), context('run-x'));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND', message: '评测不存在：run-x' } });
  });
});
