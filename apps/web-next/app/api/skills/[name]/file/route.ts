/**
 * 单条技能里**任意一个文件**的原文：GET `?path=<技能内相对路径>`，供抽屉右侧预览渲染。
 *
 * 为什么是「任意一个文件」而不是只认 `SKILL.md`：树上有 `references/API.md` 这类附属文件，
 * 点开它们要能看——只认入口文件的话，那一栏点谁都是空的。
 *
 * 两道门都在下游：`SkillNameSchema`（名字）与 `SkillFilePathSchema`（相对路径，拒绝对 / `..` / 空段）
 * 在这里校验，core 再用 `realpath` 复核拼出来的真实路径没越出技能目录。
 * 本文件只做「zod 校验 → 调 core → 错误映射」，不含业务逻辑。
 */
import { readSkillFileText } from '@aieval/core';
import { ServiceError, SkillFilePathSchema, SkillNameSchema } from '@aieval/contracts';
import { handleApiError } from '@/src/server-context';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  try {
    const { name } = await params;
    const path = new URL(req.url).searchParams.get('path');
    // 缺这一格时显式给中文：zod 的「必填」默认英文，而这条 message 会直接显示在预览格里
    if (path === null) {
      throw new ServiceError('INVALID_QUERY', '缺少 path 参数（技能内相对路径，如 SKILL.md）');
    }
    return Response.json(readSkillFileText(SkillNameSchema.parse(name), SkillFilePathSchema.parse(path)));
  } catch (error) {
    return handleApiError(error);
  }
}
