/**
 * commit 候选：POST { repoPath, repoBranch } → 最近 20 条提交（短哈希 + 提交说明）。
 * 入参带可选分支（`repoBranch`，缺省 null = 远端默认分支），与 validate-repo 共用同一份 schema：
 * 两个接口对同一个来源必须给出同一种解释。分支只对远端来源有意义——本地来源填了会被服务层拒绝。
 * 同样按仓库路径（R7）。用 POST 当读用：路径可能很长，塞进 URL query 既难看又有长度上限。
 */
import { listCommitCandidates } from '@aieval/api';
import { RepoCommitsInputSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const { repoPath, repoBranch } = RepoCommitsInputSchema.parse(await readJsonBody(req));
    return Response.json(listCommitCandidates({ repoPath, repoBranch }));
  } catch (error) {
    return handleApiError(error);
  }
}
