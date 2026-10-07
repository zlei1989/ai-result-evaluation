/**
 * 评分标准项的两个动作共用一个入口：POST { rubric, taskPrompt, prompt, repoPath }。
 * `prompt` 为空 ⇒「智能生成」（按题面 + 当前表格补充条目）；非空 ⇒「智能识别」（把用户粘贴的要求解析成表格）。
 * 路径不变：界面上的两个按钮打的是同一个接口，由 `prompt` 是否为空分派。
 * 评分模型不在入参里——服务端按设置页「评分配置」的全局默认解析（`resolveJudgeRoute()`）；
 * 非流式（spec §4.3）；未配置评分模型时由 api 层抛 CONFLICT，映射成 409 并在 message 里指向设置页。
 */
import { generateRubric } from '@aieval/api';
import { GenerateRubricSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const input = GenerateRubricSchema.parse(await readJsonBody(req));
    return Response.json(await generateRubric(input));
  } catch (error) {
    return handleApiError(error);
  }
}
