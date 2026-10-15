/**
 * 客户端 HTTP：同源 /api，非 2xx 解析 {error:{code,message,context?}} → ServiceError。
 * 注意：错误路径**自己不能二次抛错**——响应体不是 JSON、或缺 error 字段时，
 * 一律兜底成 INTERNAL + HTTP 状态码，否则调用方收到的是 TypeError 而不是可展示的错误。
 */
import { ServiceError, type ErrorCode } from '@aieval/contracts';

/** 非 2xx 响应 → ServiceError */
async function toServiceError(res: Response): Promise<ServiceError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; context?: unknown };
  } | null;
  const code = (body?.error?.code ?? 'INTERNAL') as ErrorCode;
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  const context = body?.error?.context;
  // context 仅服务端携带时透传，保持 undefined 语义、不引入空值
  return context === undefined ? new ServiceError(code, message) : new ServiceError(code, message, { context });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw await toServiceError(res);
  return res.json() as Promise<T>;
}

export function getJson<T>(url: string): Promise<T> {
  return request<T>(url);
}

export function postJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function putJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** DELETE：无请求体 */
export function delJson<T>(url: string): Promise<T> {
  return request<T>(url, { method: 'DELETE' });
}

/**
 * `multipart/form-data` POST（附件上传）。
 *
 * **绝不自己写 `content-type`**：边界串（boundary）由运行时在序列化 `FormData` 时拼出来，
 * 手写一个不带 boundary 的头会让服务端的 `formData()` 解析出**零个字段**——那是一种静默失败
 * （服务端只会说「没有这个字段」），故这一格交给 `fetch` 自己填。
 */
export function postForm<T>(url: string, form: FormData): Promise<T> {
  return request<T>(url, { method: 'POST', body: form });
}
