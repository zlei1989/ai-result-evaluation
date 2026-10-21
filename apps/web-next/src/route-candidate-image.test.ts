// @vitest-environment node
/**
 * 图片路由：`GET /api/runs/[runId]/candidates/[candidateId]/image?path=…`。
 *
 * 只钉**路由层**自己的三件事（字节读取与路径判据由 api / core 的用例钉住）：
 *   ① 响应是**原始字节** + 对应的 `content-type`，且 `cache-control: no-store`
 *      （工作区在运行结束后会被改写，缓存一张已经删掉的图会让界面显示「还在」）；
 *   ② 缺 `path` 走 400 + 中文原因，**不调 api**；
 *   ③ 查询串只解一次码：`searchParams.get` 已经解过，路由再解一次会让含 `%` 的真实文件名抛
 *      `URIError` ⇒ 500（与产物、变更详情两条路由同一条坑）。
 *
 * `@aieval/api` 整块 mock：本文件只验路由的接线，不建真实运行。（不 mock 的话 import 会拉起
 * `@aieval/evaluator`，而本应用没有声明那个包，`tsc` 会红。）
 */
import { describe, expect, it, vi } from 'vitest';
import { ServiceError } from '@aieval/contracts';

/** mock 句柄（本应用其它路由用例的 `vi.hoisted` 同款理由：工厂在 import 之前求值） */
const api = vi.hoisted(() => ({ getCandidateWorkspaceImage: vi.fn() }));
vi.mock('@aieval/api', () => api);

import { GET } from '@/app/api/runs/[runId]/candidates/[candidateId]/image/route';

/** Next 16 的 `params` 是 Promise */
function candidateContext(params: { runId: string; candidateId: string }): { params: Promise<typeof params> } {
  return { params: Promise.resolve(params) };
}

function imageRequest(query: string): Request {
  return new Request(`http://localhost/api/runs/run-1/candidates/r-1/image${query}`);
}

describe('GET 图片路由', () => {
  it('回原始字节 + content-type，且 `cache-control: no-store`（位置参数原样转给 api）', async () => {
    api.getCandidateWorkspaceImage.mockReturnValue({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' });

    const res = await GET(imageRequest('?path=shots%2Fa.png'), candidateContext({ runId: 'run-1', candidateId: 'r-1' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // SVG 是模型写的：直接打开这个 URL 时不许它当同源文档跑脚本（`<img>` 那条路本来就不跑）
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-length')).toBe('4');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(api.getCandidateWorkspaceImage).toHaveBeenCalledWith('run-1', 'r-1', 'shots/a.png');
  });

  it('查询串只解一次码：文件名里的 `%`（`50%25.png` ⇒ `50%.png`）不会让路由 500', async () => {
    api.getCandidateWorkspaceImage.mockReturnValue({ bytes: Buffer.from([0x01]), mimeType: 'image/png' });

    const res = await GET(imageRequest('?path=50%25.png'), candidateContext({ runId: 'run-1', candidateId: 'r-1' }));

    expect(res.status).toBe(200);
    expect(api.getCandidateWorkspaceImage).toHaveBeenCalledWith('run-1', 'r-1', '50%.png');
  });

  it('缺 `path` ⇒ 400 + 中文原因，且不调 api', async () => {
    api.getCandidateWorkspaceImage.mockClear();

    const res = await GET(imageRequest(''), candidateContext({ runId: 'run-1', candidateId: 'r-1' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toContain('缺少 path');
    expect(api.getCandidateWorkspaceImage).not.toHaveBeenCalled();
  });

  it('api 抛 NOT_FOUND ⇒ 404 + 同一条中文原因（图片已被删掉是常见情形）', async () => {
    api.getCandidateWorkspaceImage.mockImplementation(() => {
      throw new ServiceError('NOT_FOUND', '这张图片已经不在了：shot.png');
    });

    const res = await GET(imageRequest('?path=shot.png'), candidateContext({ runId: 'run-1', candidateId: 'r-1' }));

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain('这张图片已经不在了');
  });
});
