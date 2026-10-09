/**
 * 设置接口：GET 读当前设置，PUT 应用补丁。
 * 本路由同时承担三块设置：界面主题、评分配置（defaultJudge / defaultJudgeAgent / diffBudgetBytes）
 * 与工作区根目录 —— 它们同属一份 Settings、同一次原子落盘，不为其中任一块单开路由。
 * 工作区的「校验并保存」就是 PUT { workspaceRoot }：服务端 validateWorkspaceRoot 通过才落盘。
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
