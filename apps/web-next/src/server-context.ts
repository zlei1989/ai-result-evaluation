/**
 * 路由层共享：请求体解析 + 统一错误出口。
 * 路由只做三件事——zod 校验、调 api、错误映射；本文件承载第三件。
 */
import { ServiceError, httpStatusFor } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { ZodError } from 'zod';

const log = createLogger('route');

/**
 * 请求体解析失败的**唯一**标记类型：只有它映射为 400「请求体不是合法 JSON」。
 * 绝不允许把任何 SyntaxError 都映射成它——否则「读配置文件失败」这类服务端内部解析异常
 * 会被伪装成客户端请求体问题（文案误导 + 排查方向被带偏）。
 */
export class InvalidRequestBodyError extends SyntaxError {
  constructor(cause?: unknown) {
    super('请求体不是合法 JSON');
    this.name = 'InvalidRequestBodyError';
    this.cause = cause;
  }
}

/** 读 JSON 请求体：只把 `req.json()` 的**语法**失败标记成 InvalidRequestBodyError */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch (error) {
    // 只把**语法**失败当作「请求体不是合法 JSON」。`req.json()` 还能因为别的原因失败——
    // 最典型的是体已被读过（`TypeError: Body is unusable`），那是服务端自己的编程错误，
    // 伪装成客户端请求体问题正是本模块存在的理由所要防的事（见 handleApiError 的注释）。
    if (!(error instanceof SyntaxError)) throw error;
    throw new InvalidRequestBodyError(error);
  }
}

/** 出参形状：错误码 + 可直接展示的中文 message + 可选 context */
interface ApiErrorBody {
  error: { code: string; message: string; context?: unknown };
}

/**
 * 统一错误出口：zod 校验失败与请求体语法失败映射 400，其余按 ServiceError 折叠。
 * context 仅在存在时携带，保持 undefined 语义、不向响应里塞空键。
 */
export async function handleApiError(error: unknown, init?: ResponseInit): Promise<Response> {
  if (error instanceof ZodError) {
    log.warn('请求参数校验失败', { issues: error.issues.length });
    const body: ApiErrorBody = {
      error: { code: 'INVALID_QUERY', message: '查询参数不合法', context: error.issues },
    };
    return Response.json(body, { ...init, status: httpStatusFor('INVALID_QUERY') });
  }
  if (error instanceof InvalidRequestBodyError) {
    log.warn('请求体不是合法 JSON');
    const body: ApiErrorBody = { error: { code: 'INVALID_QUERY', message: '请求体不是合法 JSON' } };
    return Response.json(body, { ...init, status: httpStatusFor('INVALID_QUERY') });
  }

  const serviceError = toServiceError(error);
  // 5xx 才需要堆栈；4xx 是预期内的用户输入问题，打堆栈只会淹没日志
  const status = httpStatusFor(serviceError.code);
  if (status >= 500) {
    log.error('请求处理失败', { code: serviceError.code, message: serviceError.message, cause: error });
  }
  const body: ApiErrorBody = {
    error: {
      code: serviceError.code,
      message: serviceError.message,
      ...(serviceError.context === undefined ? {} : { context: serviceError.context }),
    },
  };
  return Response.json(body, { ...init, status });
}

/** 任意抛出物 → ServiceError：已是 ServiceError 则原样，其余折叠为 INTERNAL */
function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  return new ServiceError('INTERNAL', '服务端内部错误', { cause: error });
}
