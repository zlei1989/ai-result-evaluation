// @vitest-environment node
/**
 * 路由层共享的错误出口。
 * 关键回归点：**只有 InvalidRequestBodyError** 能映射成「请求体不是合法 JSON」的 400。
 * 若把任何 SyntaxError 都映射成它，「读配置文件失败」这类服务端内部异常会被伪装成
 * 客户端请求体问题——文案误导且排查方向被完全带偏。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { ZodError, z } from 'zod';
import { InvalidRequestBodyError, handleApiError, readJsonBody } from './server-context';

describe('readJsonBody', () => {
  it('合法 JSON 正常返回', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', body: '{"a":1}' });
    expect(await readJsonBody(req)).toEqual({ a: 1 });
  });

  it('非法 JSON 抛 InvalidRequestBodyError', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', body: '{oops' });
    await expect(readJsonBody(req)).rejects.toBeInstanceOf(InvalidRequestBodyError);
  });

  // `req.json()` 的失败**不止语法一种**：最典型的是请求体已被读过（`TypeError: Body is unusable`）。
  // 那是服务端自己的编程错误，若也被折成 InvalidRequestBodyError，就会以 400 让用户去改一个本来
  // 没问题的请求——正是本模块存在的理由所要防的事，只是低了一层。故 catch 必须按类型收窄。
  it('体已被读过（服务端编程错误）时抛原始 TypeError，不伪装成请求体问题', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', body: '{"a":1}' });
    await req.text(); // 先消费掉请求体

    let caught: unknown;
    try {
      await readJsonBody(req);
    } catch (error) {
      caught = error;
    }

    // 两件事都要钉：确实抛的是 TypeError（而不是被换成别的错误类型），且**没有**被标记成
    // InvalidRequestBodyError——后者才是这条用例真正的回归点。
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(InvalidRequestBodyError);
  });
});

describe('handleApiError', () => {
  // 日志级别是策略的一部分（见 server-context.ts 的注释）：4xx 是预期内的用户输入问题，
  // 不该打 ERROR；只有 5xx 才带堆栈进 ERROR。不装 spy 的话两边的输出都只是测试噪音，
  // `if (status >= 500)` 被整条删掉也没有任何守卫会响。
  let errorSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // 必须还原：spy 泄漏到别的用例（或别的文件）会把那边真正的错误输出吞掉。
    errorSpy.mockRestore();
  });

  it('ZodError → 400 INVALID_QUERY，并把 issues 放进 context', async () => {
    const schema = z.object({ theme: z.enum(['auto', 'light', 'dark']) });
    let zodError: ZodError | null = null;
    try {
      schema.parse({ theme: 'blue' });
    } catch (error) {
      zodError = error as ZodError;
    }

    const res = await handleApiError(zodError);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    // 断言 path 而不是 `Array.isArray(context)`：后者对 `context: []` 也成立，等于没断言，
    // 抓不到「issues 被换成空数组/别的形状」这类真实回归。path 只可能来自 zod 自己生成的 issue。
    expect(body.error.context[0].path).toEqual(['theme']);
    // 400 是预期内的输入问题，不打 ERROR（打堆栈只会淹没日志）
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('InvalidRequestBodyError → 400 且文案是「请求体不是合法 JSON」', async () => {
    const res = await handleApiError(new InvalidRequestBodyError());
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('请求体不是合法 JSON');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('普通 SyntaxError → 500，且文案**不得**是「请求体不是合法 JSON」', async () => {
    const res = await handleApiError(new SyntaxError('Unexpected token in config.json'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).not.toContain('请求体不是合法 JSON');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('ServiceError 按其 code 映射状态码，并透传 message 与 context', async () => {
    const res = await handleApiError(new ServiceError('NOT_WRITABLE', '目录不可写', { context: { path: 'D:/x' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('目录不可写');
    expect(body.error.context).toEqual({ path: 'D:/x' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('未知错误折叠成 INTERNAL，不泄漏原始 message 里的堆栈细节', async () => {
    const res = await handleApiError(new Error('boom'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL');
    // 对外文案必须是可直接展示的中文。只断言 code 是不够的：把折叠改成 `error.message`
    // 之后 code 仍是 INTERNAL、status 仍是 500，只有这一条会响——而漏掉它，服务端
    // 「读配置文件失败」的原始英文 SyntaxError 就会被原文发给用户。
    expect(body.error.message).toBe('服务端内部错误');
    expect(body.error.context).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('不存在的字段不会被凭空加进响应体（context 缺省时省略该键）', async () => {
    const res = await handleApiError(new ServiceError('INTERNAL', 'x'));
    expect('context' in (await res.json()).error).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
