/**
 * 单条技能的正文：GET 回 `SKILL.md` 的 frontmatter（逐字）与正文（原文），供设置页的预览抽屉渲染。
 *
 * 为什么单开这一格而不是把正文塞进清单：清单要的是「有哪些、能不能用」，
 * 正文可能很大且只在点开某一行时才需要——塞进清单等于每次打开设置页都把每一条的正文读一遍。
 *
 * 名字先过 `SkillNameSchema`（非法名 400）：它是拼进文件路径的那一段，也是**路径穿越**的唯一一道门。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 */
import { readSkillFile } from '@aieval/core';
import { SkillNameSchema } from '@aieval/contracts';
import { handleApiError } from '@/src/server-context';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  try {
    const { name } = await params;
    return Response.json(readSkillFile(SkillNameSchema.parse(name)));
  } catch (error) {
    return handleApiError(error);
  }
}
