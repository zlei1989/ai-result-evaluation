// @vitest-environment node
/**
 * createCase / listCases / getCase（切分后的第二块）
 *
 * 本文件是 `cases.test.ts` 拆分后的一块：共享夹具、真实 git 助手与两条 `vi.mock`（node:fs / node:child_process 的计数探针）都在 `./testing/cases-harness`，那里写明了为什么前导块必须在每个文件里逐字重复（vitest 的前置提升只作用于本文件）。
 */

import { vi, describe, expect, it } from 'vitest';
import {
  caseInput,
  legacyCaseShapes,
  seedLegacyCase,
  seedLegacyJudgeOverrideCase,
  seedRowWithoutItemId,
  ServiceError,
  listStoredCases,
  createCase,
  getCase,
  listCases,
  updateCase,
  registerCasesHooks,
} from './testing/cases-harness';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

registerCasesHooks();

describe('createCase / listCases / getCase', () => {
  it('标题全空白时按契约拒绝落盘（trim 之后不满足 min(1)）', () => {
    let caught: unknown;
    try {
      createCase(caseInput({ title: '   ' }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(listStoredCases().cases).toEqual([]);
  });
  // 成功日志只能在**真正落盘之后**打：被拒绝的保存留下「创建用例」的 INFO，等于在日志里把失败读成成功。
  it('保存被拒绝时不留「创建用例」成功日志（日志只在写盘成功后打）', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // 正向对照：同一探针下，真正落盘的创建必须留下这条 INFO（否则下面的 not.toContain 是空转）
      createCase(caseInput({ title: '正常用例' }));
      expect(logSpy.mock.calls.flat().join(' ')).toContain('创建用例');

      logSpy.mockClear();
      expect(() => createCase(caseInput({ title: '   ' }))).toThrow();
      expect(logSpy.mock.calls.flat().join(' ')).not.toContain('创建用例');
    } finally {
      logSpy.mockRestore();
    }
  });
  // 时间的分辨率是毫秒：两次操作之间必须隔开一格，否则 updatedAt 相同、排序落到 id 兜底上，测试会随机飘。
  // 改的必须是**后建**的那条：配置文件里的插入序是 [first, second]，而更新时间倒序是 [second, first]——
  // 两个顺序在这里必须不同，否则「整条 sort 删掉」也能让本用例通过（改 first 时它是空转的）。
  it('listCases 按更新时间倒序（最近动过的用例在最上面）', async () => {
    const first = createCase(caseInput({ title: '先建的' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = createCase(caseInput({ title: '后建的' }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    updateCase(second.id, { title: '后建的（刚改过）' });

    expect(listCases().cases.map((item) => item.id)).toEqual([second.id, first.id]);
  });
  /**
   * 用例级评分模型已经删除（只使用全局评分配置）：入参里多给这两个字段必须**被剥掉**。
   * 为什么这条是守卫而不是「多此一举」：`CaseCreateSchema` 是 zod 的 strip 模式，
   * 一旦有人把这两列加回契约，它们就会静默落盘，而「用例覆盖 > 全局默认」那条优先级会顺着
   * `resolveJudgeRoute` 的入参一起回来——那时界面上根本看不到、也改不掉它。
   */
  it('createCase 把多给的用例级评分模型字段剥掉，不落盘', () => {
    const created = createCase(
      caseInput({ judgeProviderId: 'provider-1', judgeModelId: 'deepseek-chat' } as Partial<
        Parameters<typeof createCase>[0]
      >),
    );

    expect(created).not.toHaveProperty('judgeProviderId');
    expect(created).not.toHaveProperty('judgeModelId');
    expect(listCases().cases[0]).not.toHaveProperty('judgeProviderId');
    // 落盘的那一份（绕开读侧归一直接看配置）同样不许有
    const stored = listStoredCases().cases[0] as unknown as Record<string, unknown>;
    expect(stored).not.toHaveProperty('judgeProviderId');
    expect(stored).not.toHaveProperty('judgeModelId');
  });
  /**
   * 读侧归一：旧 config.json 里残留的用例级覆盖必须**被丢掉**。
   * 不丢的话，裸 spread 会把它原样交给下游——契约上这两个字段已经不存在，
   * 拿到它们的人只能靠猜「这算不算数」，而其中一个猜法就是把「用例覆盖 > 全局默认」做回来。
   */
  it('listCases / getCase 丢掉历史残留的用例级评分模型字段', () => {
    const created = createCase(caseInput());
    seedLegacyJudgeOverrideCase(created.id, { providerId: 'provider-legacy', modelId: 'legacy-model' });
    // 先确认这份「历史数据」真的写进了盘上（否则下面两条断言测的是空气）
    expect((listStoredCases().cases[0] as unknown as Record<string, unknown>).judgeProviderId).toBe('provider-legacy');

    const fromList = listCases().cases[0] as unknown as Record<string, unknown>;
    expect(fromList).not.toHaveProperty('judgeProviderId');
    expect(fromList).not.toHaveProperty('judgeModelId');
    const fromGet = getCase(created.id) as unknown as Record<string, unknown>;
    expect(fromGet).not.toHaveProperty('judgeProviderId');
    expect(fromGet).not.toHaveProperty('judgeModelId');
  });
  /**
   * 读侧处置：旧用例
   * （重构前建的、只有一段 `judgePrompt` 而没有 `rubric`）被**使用**时显式抛中文 INTERNAL，
   * message 明写「这个用例是旧版数据，请删除它或重新创建：<caseId>」。
   *
   * 为什么不给它 `.default({ groups: [] })`：空表会被下游当成「还没配评分项」，用户会以为
   * 「补两格 / 重新生成一下就好了」——而那份 `judgePrompt` 已经失去了意义，他要做的是重建用例。
   * 实测过的症状链：对这样一条旧用例点「创建评测」，用户拿到的是一句指向我们内部形状的
   * 「运行快照不符合契约…rubric」，而不是能指导他行动的这一句。
   *
   * 守卫落在**取单个用例**（`getCase`）上，而不是列表共用的读侧归一上——对偶的那一条
   *（`listCases` 必须照常返回它）就在下面：那条路断了，用户连删掉这条用例的入口都没有。
   *
   * 两种坏数据都在这一条里（判据用的是 `RubricSchema.safeParse`，不是判 `=== undefined`）：
   * `config.json` 是手可编辑的，`rubric` 可能**存在但形状不对**（半截对象、`items` 写成字符串），
   * 而它对用户的处置与「整格不见」是同一句话——只判 undefined 就会漏掉后一种。
   */
  it('旧用例（有 judgePrompt、没有 rubric / rubric 形状不对）取详情时抛 INTERNAL 并点名「旧版数据」', () => {
    for (const { label, mangle } of legacyCaseShapes) {
      const created = seedLegacyCase(label, mangle);

      let caught: unknown;
      try {
        getCase(created.id);
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(ServiceError);
      expect((caught as ServiceError).code, label).toBe('INTERNAL');
      expect((caught as ServiceError).message, label).toContain('旧版数据');
      expect((caught as ServiceError).message, label).toContain(created.id);
    }
  });

  /**
   * 上面那条的**对偶**：列表**不能**抛。
   * 最初把守卫写在了 `listCases` 与 `getCase` 共用的归一函数里，于是一条旧用例就让 `GET /api/cases`
   * 变成 500——而那句 message 让用户「删除它」，偏偏能删它的那个页面渲染不出来（出路只剩手改
   * `config.json` 或直接打 DELETE）。列表照常返回这条用例，用户才拿得到那个删除按钮。
   *
   * 同时钉住「列表路径**不抛**、但也不是原样透传」，两种坏形状各跑一遍：
   *   · rubric 解析不过 ⇒ 这一格必须**整个不在**（`{ groups: '这不是数组' }` 原样透传就是把一个
   *     非 `Rubric` 的值交给下游——契约声明之外的第三态）；
   *   · rubric 合法但靠 schema 缺省值补齐（某一项没写 `id`）⇒ 必须是 `id: ''` 而不是 `id: undefined`
   *     （A10③ 的口径，与 `repoBranch` 的归一同一个理由）；
   *   · 契约上**已经删除的旧列**（`judgePrompt`）⇒ 列表里必须**根本没有这一格**，
   *     与 `judgeProviderId` / `judgeModelId` 同一处置：留着它就是给「按旧口径评分」留一扇暗门。
   */
  it('列表不抛：两种旧版形状都照常列出且**整格不带 rubric**；靠缺省值补齐的记录读回来是 `id: \'\'`', () => {
    for (const { label, mangle, carriesJudgePrompt } of legacyCaseShapes) {
      const legacy = seedLegacyCase(label, mangle);

      // 非空对照：盘上那一行**真的**带着旧字段时才断言列表里没有它（形状②不带，硬断言等于空转）
      const stored = listStoredCases().cases.find((item) => item.id === legacy.id) as unknown as Record<string, unknown>;
      expect('judgePrompt' in stored, label).toBe(carriesJudgePrompt);

      const listed = listCases().cases.find((item) => item.id === legacy.id) as unknown as Record<string, unknown>;

      expect(listed, label).toBeDefined();
      // 其余字段照常可读（归一不是「把整行换掉」）
      expect(listed.title, label).toBe(legacy.title);
      // 关键断言：**键不在**，而不是「键在、值是坏数据」
      expect('rubric' in listed, label).toBe(false);
      expect(listed.rubric, label).toBeUndefined();
      /**
       * `judgePrompt` 与上面那两列同一形状——契约上
       * `TestCase` 已经没有它了，读侧归一却只删了 `judgeProviderId` / `judgeModelId`，
       * 于是**一条旧用例会把一整段旧口径的评分标准从 `GET /api/cases` 原样发出去**：
       * 类型上说没有这一格、运行时却有，下游只能靠猜它算不算数。
       */
      expect('judgePrompt' in listed, label).toBe(false);
      expect(listed.judgePrompt, label).toBeUndefined();
    }

    // Fix A：缺省值必须在**列表**这条路上也补齐（此前只有 getCase 补，列表会把 undefined 发出去）
    const defaulted = seedRowWithoutItemId();
    const fromList = listCases().cases.find((item) => item.id === defaulted.id);
    expect(fromList?.rubric.groups[0]?.items[0]?.id).toBe('');
  });

  it('getCase 对不存在的 id 抛 NOT_FOUND', () => {
    let caught: unknown;
    try {
      getCase('missing');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });
});
