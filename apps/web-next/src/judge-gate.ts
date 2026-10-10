/**
 * 「AI 生成」可用性判定（`judgeConfigured`）。
 *
 * 为什么单独成文件：`apps/web-next` 保留 `jsx: preserve`、不能写 `.tsx` 测试，
 * 用例页本身没有任何自动化测试面（建议就是把页面的决策抽成 `.ts` 助手 + `.test.ts`）。
 * 这条判定是页面里最容易退化的一处——它要同时看设置、供应商清单、模型清单三份数据。
 *
 * 判的是「有没有**可用**的评分模型」，而不是「有没有供应商」，也不只是「`defaultJudge` 非空」：
 * 删掉供应商、或在供应商里移除某个模型之后，`defaultJudge` 会变成**悬空引用**——
 * 只判非空会让「AI 生成」显示为可用，点下去才在服务端 `resolveJudgeRoute` 里抛 CONFLICT。
 * 所以这里必须拿 `defaultJudge` 那一对 id 去 `providers` 里解析：供应商与模型都要对上才算数。
 *
 * 这里**只看全局默认**：用例上不再有评分模型覆盖（用列表单里那一格已删除），
 * 而服务端 `resolveJudgeRoute()` 也是无参的——判定与实际会走的那一对 id 天然同源，不再有第三态要对齐。
 */
import type { ProviderView, SettingsView } from '@aieval/contracts';

/** 一对评分模型 id */
interface JudgePair {
  providerId: string;
  modelId: string;
}

/**
 * 「AI 生成」是否可用。`settings` / `providers` 未加载时一律返回 false：
 * 未知不等于已配置，宁可先禁用（SWR 拿到数据后自会重算）。
 */
export function isJudgeConfigured(settings: SettingsView | undefined, providers: ProviderView[] | undefined): boolean {
  const judge: JudgePair | null = settings?.defaultJudge ?? null;
  if (judge === null) return false;
  return (providers ?? []).some(
    (provider) => provider.id === judge.providerId && provider.models.some((model) => model.id === judge.modelId),
  );
}
