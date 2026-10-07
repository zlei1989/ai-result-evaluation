/**
 * 仓库校验：POST { repoPath, repoBranch } → RepoInfo。
 * 入参带可选分支（`repoBranch`，缺省 null = 远端默认分支），分支只对远端来源有意义——本地来源填了会被服务层拒绝。
 * 路径形态是**按仓库路径**而不是按 caseId（接口契约 §11 R7）：新建用例时还没有 caseId，
 * 而这件事的输入本来就是路径。
 */
import { validateRepo } from '@aieval/api';
import { RepoValidateInputSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const { repoPath, repoBranch } = RepoValidateInputSchema.parse(await readJsonBody(req));
    return Response.json(validateRepo({ repoPath, repoBranch }));
  } catch (error) {
    return handleApiError(error);
  }
}
