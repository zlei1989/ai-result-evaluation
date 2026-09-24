// @vitest-environment node
/** 统一错误模型：错误码集合、ServiceError 形状、code → HTTP 状态映射。 */
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ServiceError, httpStatusFor } from './errors';

describe('ERROR_CODES', () => {
  it('包含脚手架阶段全部错误码', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      ['AUTH_FAILED', 'CONFLICT', 'INTERNAL', 'INVALID_QUERY', 'NOT_FOUND', 'NOT_WRITABLE', 'RATE_LIMITED'].sort(),
    );
  });
});

describe('ServiceError', () => {
  it('保留 code / message / context', () => {
    const error = new ServiceError('NOT_WRITABLE', '目录不可写', { context: { path: 'D:/x' } });
    expect(error.code).toBe('NOT_WRITABLE');
    expect(error.message).toBe('目录不可写');
    expect(error.context).toEqual({ path: 'D:/x' });
    expect(error.name).toBe('ServiceError');
  });

  it('未传 context 时是 undefined（不引入空值语义）', () => {
    expect(new ServiceError('INTERNAL', '内部错误').context).toBeUndefined();
  });

  it('是 Error 的子类，可被 instanceof 捕获', () => {
    expect(new ServiceError('INTERNAL', 'x')).toBeInstanceOf(Error);
  });
});

describe('httpStatusFor', () => {
  it('每个错误码都映射到期望状态码', () => {
    expect(httpStatusFor('NOT_FOUND')).toBe(404);
    expect(httpStatusFor('INVALID_QUERY')).toBe(400);
    expect(httpStatusFor('NOT_WRITABLE')).toBe(400);
    expect(httpStatusFor('CONFLICT')).toBe(409);
    expect(httpStatusFor('AUTH_FAILED')).toBe(401);
    expect(httpStatusFor('RATE_LIMITED')).toBe(429);
    expect(httpStatusFor('INTERNAL')).toBe(500);
  });

  it('对每个错误码都有映射（无遗漏、无 undefined）', () => {
    for (const code of ERROR_CODES) {
      expect(typeof httpStatusFor(code)).toBe('number');
      expect(httpStatusFor(code)).toBeGreaterThanOrEqual(400);
    }
  });
});
