/**
 * 单条技能的**目录树**：GET 回这条技能里有什么（递归全列），供抽屉左树那一栏渲染。
 *
 * 为什么单开这一格而不是把树塞进清单：树要递归整目录，而清单每开一次设置页就扫一遍；
 * 何况树只在**点开某一行**之后才需要。
 *
 * 名字先过 `SkillNameSchema`（非法名 400）：它是拼进文件路径的那一段，也是**路径穿越**的第一道门。
 * 本文件只做「zod 校验 → 调 core → 错误映射」，不含业务逻辑。
 */
import { readSkillTree } from '@aieval/core';
import { SkillNameSchema } from '@aieval/contracts';
import { handleApiError } from '@/src/server-context';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  try {
    const { name } = await params;
    return Response.json(readSkillTree(SkillNameSchema.parse(name)));
  } catch (error) {
    return handleApiError(error);
  }
}
