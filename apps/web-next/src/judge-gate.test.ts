// @vitest-environment node
/**
 * 「AI 生成」可用性（`judgeConfigured`）的守卫。
 *
 * 为什么它必须是一个**纯函数**而不是页面里的一行布尔表达式：`apps/web-next` 保留 `jsx: preserve`，
 * 不能写 `.tsx` 测试，页面本身没有任何自动化测试面（建议就是把页面决策抽成 `.ts` 助手）。
 * 而这条判定正是页面里最容易退化的决策——它要同时看设置、供应商清单和模型清单三份数据。
 *
 * 守的是：**必须拿全局默认那一对 id 去 `providers` 里解析**，只判「非 null」会让
 * 删掉供应商 / 移除模型之后的悬空引用显示成「可用」，用户点下去才在服务端 `resolveJudgeRoute` 里拿到 409。
 *
 * 判定只看全局默认：用例级覆盖已删除（`resolveJudgeRoute()` 也是无参的），
 * 于是「界面承诺的那一对」与「服务端真正会走的那一对」同源——不再有第三态需要对口径。
 */
import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, type ProviderView, type Settings } from '@aieval/contracts';
import { isJudgeConfigured } from './judge-gate';

/** 一条可用的供应商：下面各用例只改自己关心的字段 */
const PROVIDER: ProviderView = {
  id: 'provider-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyMasked: 'sk-***test',
  models: [{ id: 'deepseek-chat', source: 'manual' }],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

/** 设置：只改 defaultJudge，其余取默认值 */
function settingsWith(defaultJudge: Settings['defaultJudge']): Settings {
  return { ...SETTINGS_DEFAULTS, defaultJudge };
}

describe('isJudgeConfigured', () => {
  it('设置还没加载出来（undefined）→ 不可用（未知不等于已配置）', () => {
    expect(isJudgeConfigured(undefined, [PROVIDER])).toBe(false);
  });

  it('供应商清单还没加载出来（undefined）→ 不可用', () => {
    expect(isJudgeConfigured(settingsWith({ providerId: PROVIDER.id, modelId: 'deepseek-chat' }), undefined)).toBe(false);
  });

  it('未配置默认评分模型（null）→ 不可用', () => {
    expect(isJudgeConfigured(settingsWith(null), [PROVIDER])).toBe(false);
  });

  it('默认评分模型能在供应商里解析出这一对 id → 可用', () => {
    expect(isJudgeConfigured(settingsWith({ providerId: PROVIDER.id, modelId: 'deepseek-chat' }), [PROVIDER])).toBe(true);
  });

  //  的核心：供应商被删除后 defaultJudge 成了悬空引用，只判非空会显示成「可用」
  it('供应商已被删除（悬空引用）→ 不可用', () => {
    expect(isJudgeConfigured(settingsWith({ providerId: 'provider-deleted', modelId: 'deepseek-chat' }), [PROVIDER])).toBe(
      false,
    );
  });

  it('供应商还在、但该模型已被移除 → 不可用', () => {
    expect(isJudgeConfigured(settingsWith({ providerId: PROVIDER.id, modelId: 'deepseek-reasoner' }), [PROVIDER])).toBe(
      false,
    );
  });

  // 「成对解析」的另一半：模型 id 相同但挂在别的供应商下不算命中（否则删了 A 供应商、
  // B 供应商恰好有同名模型，就会把 A 的悬空引用判成可用）。
  // 注意 other **必须带着同名模型**：给它空模型清单的话，「只按 modelId 匹配」的变异体也会返回 false，
  // 这条用例就变成空转的（变异验证实测：第一版就是这么写的，变异体存活）。
  it('同名模型挂在别的供应商下 → 不可用（必须成对解析）', () => {
    const other: ProviderView = { ...PROVIDER, id: 'provider-2' };
    expect(isJudgeConfigured(settingsWith({ providerId: 'provider-1', modelId: 'deepseek-chat' }), [other])).toBe(false);
    // 正向对照：同一个 other 换成它自己的 id 就该判为可用——证明上一条的 false 来自 id 不匹配，
    // 而不是因为别的什么原因（例如模型清单读不出来）恒为 false
    expect(isJudgeConfigured(settingsWith({ providerId: 'provider-2', modelId: 'deepseek-chat' }), [other])).toBe(true);
  });

  it('供应商清单为空数组 → 不可用', () => {
    expect(isJudgeConfigured(settingsWith({ providerId: PROVIDER.id, modelId: 'deepseek-chat' }), [])).toBe(false);
  });

  /**
   * 判定里**没有**「用例覆盖」这条支路：把一对用例级评分模型当作第三个实参塞进去，结论必须一个字节不变。
   *
   * 为什么用**行为探针**而不是 `isJudgeConfigured.length === 2`：`Function.length` 只数到第一个带默认值的
   * 形参为止，而当初那个 `caseOverride` 的签名正是 `caseOverride: CaseJudgeOverride | null = null`——
   * 也就是说 `.length` 在「有覆盖」的实现里**同样是 2**，那条断言对它是空转的（变异验证实测：把
   * `caseOverride = null` 加回来，`.length` 版守卫照旧全绿）。这里传的是一对**有效且能在 providers 里解析到**
   * 的 id，一旦有人把覆盖读回来，`settingsWith(null)` 下这个判定就会翻成 `true`，这条随即变红。
   */
  it('多塞第三个实参（一对用例级评分模型）也换不掉判定结果', () => {
    const hostile = { judgeProviderId: PROVIDER.id, judgeModelId: 'deepseek-chat' };
    const call = isJudgeConfigured as unknown as (...args: unknown[]) => boolean;

    // 全局默认是空的：哪怕第三个实参指向一对完全可用的模型，也必须判「不可用 = 去设置页配」
    expect(call(settingsWith(null), [PROVIDER], hostile)).toBe(false);
    // 反向对照：全局默认有效时同样只看全局默认（证明上一条的 false 来自「忽略第三个实参」，
    // 而不是这个探针本身恒为 false）
    expect(call(settingsWith({ providerId: PROVIDER.id, modelId: 'deepseek-chat' }), [PROVIDER], hostile)).toBe(true);
  });
});
