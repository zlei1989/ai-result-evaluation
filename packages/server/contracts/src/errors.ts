/**
 * 统一错误模型：错误码 + 可直接展示的中文 message + 可选 context。
 * 框架层按 httpStatusFor 把 code 映射为 HTTP 状态码，服务端与客户端共用同一张表。
 * 注意：错误码集合定义在脚手架阶段一次定稿——后续功能阶段只增不改，
 * 避免「同一种失败在两个域里叫不同名字」。
 */
export const ERROR_CODES = [
  'NOT_FOUND',        // 404  实体不存在
  'INVALID_QUERY',    // 400  请求参数 / 请求体不合法（context 带 zod issues）
  'NOT_WRITABLE',     // 400  目录不可写
  'CONFLICT',         // 409  状态冲突
  'AUTH_FAILED',      // 401  上游凭据无效（context 带 host）
  'RATE_LIMITED',     // 429  上游限流
  'INTERNAL',         // 500  其它内部错误
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 业务错误：message 必须是可直接展示给用户的中文描述，不要放堆栈或英文原文 */
export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly context?: unknown;

  constructor(code: ErrorCode, message: string, options?: { context?: unknown; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'ServiceError';
    this.code = code;
    this.context = options?.context;
  }
}

/** code → HTTP 状态码 */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_QUERY: 400,
  NOT_WRITABLE: 400,
  CONFLICT: 409,
  AUTH_FAILED: 401,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}
