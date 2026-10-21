/**
 * 附件上传：`POST /api/inject-messages/attachments`（`multipart/form-data`）。
 *
 * **为什么是 Route Handler 而不是 Server Action**：Server Action 的 `bodySizeLimit` 默认 1 MB，
 * 而 Route Handler 没有 body 上限——20 MB 的文件走 Server Action 要么被拦、要么要改配置。
 *
 * 表单四格：`runId` / `candidateId` / `messageId` 三个文本字段 + `file` 一份文件。三格先过
 * `InjectAttachmentUploadRequestSchema`（`messageId` 的形状就在里面：它会被拼进附件目录名），
 * 之后把文件名 / 类型 / 字节交给 api 层——上限（单文件 20 MB、单条消息 10 个）、文件名净化与
 * 落盘都在那边。**先上传拿到路径、再点发送**：登记那一刻正文与附件清单就是完整事实。
 *
 * 两道与内存有关的处置（见下）：`content-length` 粗筛在读进内存**之前**跑；`formData()` 的失败
 * 折成 400（客户端送了个不是 multipart 的正文时，不该得到一个 500 的内部错误）。
 */
import { InjectAttachmentUploadRequestSchema, ServiceError } from '@aieval/contracts';
import { assertUploadContentLength, saveInjectAttachment } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** 表单里的一个文本字段：缺席或不是字符串一律给 `undefined`，交给 zod 报 400（不自己编一句英文错误） */
function formField(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * 读 multipart 表单。`formData()` 对「不是 multipart 的正文」抛的是 `TypeError`，
 * 折成 `INVALID_QUERY` 才能让路由层给出 400——裸抛会被折成 INTERNAL，把客户端的入参问题
 * 说成服务端内部错误。
 */
async function readUploadForm(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch (error) {
    throw new ServiceError('INVALID_QUERY', '请求体不是合法的 multipart/form-data 表单', { cause: error });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    // 粗筛：`formData()` 会把整个请求体读进内存，这一步在它之前跑（缺席 / 脏值直接放行，由业务上限收口）
    assertUploadContentLength(req.headers.get('content-length'));
    const form = await readUploadForm(req);
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new ServiceError('INVALID_QUERY', '上传请求里没有文件（字段名应为 file）');
    }
    const ref = InjectAttachmentUploadRequestSchema.parse({
      runId: formField(form, 'runId'),
      candidateId: formField(form, 'candidateId'),
      messageId: formField(form, 'messageId'),
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    return Response.json(saveInjectAttachment({ ...ref, fileName: file.name, mimeType: file.type, bytes }));
  } catch (error) {
    return handleApiError(error);
  }
}
