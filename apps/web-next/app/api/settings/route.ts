/**
 * 设置接口：GET 读当前设置，PUT 应用补丁。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 */
import { getSettings, updateSettings } from '@aieval/api';
import { SettingsPatchSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(getSettings());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(req: Request): Promise<Response> {
  try {
    const patch = SettingsPatchSchema.parse(await readJsonBody(req));
    return Response.json(updateSettings(patch));
  } catch (error) {
    return handleApiError(error);
  }
}
