// @vitest-environment node
/** 统一错误模型：错误码集合、ServiceError 形状、code → HTTP 状态映射。 */
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ServiceError, httpStatusFor } from './errors';

describe('ERROR_CODES', () => {
  it('包含脚手架阶段与功能阶段的全部错误码（顺序：4xx 在前、5xx 在后）', () => {
    expect([...ERROR_CODES]).toEqual([
      'NOT_FOUND',
      'INVALID_QUERY',
      'NOT_WRITABLE',
      'NOT_A_GIT_REPO',
      'REPO_UNREACHABLE',
      'INVALID_REF',
      'CONFLICT',
      'AUTH_FAILED',
      'RATE_LIMITED',
      'JUDGE_PARSE_FAILED',
      'INTERNAL',
    ]);
  });

  it('AgentErrorCode 不进 ERROR_CODES（§5.6.6：它没有对应的 HTTP 状态）', () => {
    // 这两个名字是 agents 包的领域归因，与接口层的 AUTH_FAILED / RATE_LIMITED 只是重名。
    // 一旦有人把它们并进 ERROR_CODES，STATUS_BY_CODE 就要为它们编造状态码。
    expect(ERROR_CODES).not.toContain('AGENT_FAILED');
    expect(ERROR_CODES).not.toContain('AGENT_LOAD_FAILED');
    expect(ERROR_CODES).not.toContain('AGENT_TIMED_OUT');
    expect(ERROR_CODES).not.toContain('AGENT_CANCELED');
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
    expect(httpStatusFor('NOT_A_GIT_REPO')).toBe(400);
    expect(httpStatusFor('REPO_UNREACHABLE')).toBe(400);
    expect(httpStatusFor('INVALID_REF')).toBe(400);
    expect(httpStatusFor('CONFLICT')).toBe(409);
    expect(httpStatusFor('AUTH_FAILED')).toBe(401);
    expect(httpStatusFor('RATE_LIMITED')).toBe(429);
    expect(httpStatusFor('JUDGE_PARSE_FAILED')).toBe(500);
    expect(httpStatusFor('INTERNAL')).toBe(500);
  });

  it('对每个错误码都有映射（无遗漏、无 undefined）', () => {
    for (const code of ERROR_CODES) {
      expect(typeof httpStatusFor(code)).toBe('number');
      expect(httpStatusFor(code)).toBeGreaterThanOrEqual(400);
    }
  });
});
