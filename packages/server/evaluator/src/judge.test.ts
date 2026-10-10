// @vitest-environment node
/**
 * 评分解析（纯函数）+ 一次评分调用（judgeRow，文本 API 用假实现）。
 * 判据已从「固定 5 维」换成「按用例的评分表逐项取」，四类处置各归其位：
 *   宽容（achieved 的字符串写法）、忽略（多余的判定 / 重复引用键取第一条）、
 *   占位（缺总评、缺理由）、失败（不是数字/布尔、缺项、顶层不是对象、非法 JSON）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JUDGE_OUTPUT_CONTRACT, ServiceError, composeTotalScore, type Rubric } from '@aieval/contracts';
import {
  JUDGE_REPAIR_ROUNDS,
  RAW_KEEP_CHARS,
  buildJudgeFeedback,
  finalizeScore,
  judgeRow,
  parseJudgeResponse,
  validateJudgeResponse,
  type JudgeInput,
} from './judge';
import { fakeTextApi, resetFakeTextApi } from './testing/fixtures';

vi.mock('./text-api', async () => {
  const { fakeTextApiModule } = await import('./testing/fixtures');
  return fakeTextApiModule();
});

beforeEach(() => {
  resetFakeTextApi();
});

/** 用例的评分表：两组三项，满分 45（刻意不是 100） */
function rubric(): Rubric {
  return {
    groups: [
      {
        name: '一、生产代码',
        items: [
          { id: 'A1', goal: '追加 agent 字段', weight: 18 },
          { id: 'A2', goal: '补 Javadoc', weight: 4 },
        ],
      },
      { name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 23 }] },
    ],
  };
}

/** 一份完全合法的模型返回（刻意让总分与权重之和不相等，便于看出是重算还是照抄） */
const VALID = {
  judgments: [
    { id: 'A1', achieved: true, reason: '字段进了契约' },
    { id: 'A2', achieved: false, reason: 'Javadoc 没补' },
    { id: 'D1', achieved: true, reason: '用例到位' },
  ],
  verdict: '大体完成',
};

/** 造一份「某一项不见」的返回：这是本任务最重要的一条守卫的输入 */
function withoutJudgment(id: string): string {
  return JSON.stringify({ ...VALID, judgments: VALID.judgments.filter((item) => item.id !== id) });
}

describe('parseJudgeResponse：合法输入', () => {
  it('按评分表的顺序返回逐项判定与总评', () => {
    const parsed = parseJudgeResponse(JSON.stringify(VALID), rubric());
    expect(parsed.judgments.map((item) => item.id)).toEqual(['A1', 'A2', 'D1']);
    expect(parsed.judgments.map((item) => item.achieved)).toEqual([true, false, true]);
    expect(parsed.verdict).toBe('大体完成');
  });

  it('空 id 的项用 #k 引用（模型照抄引用键即可，不需要我们改落盘数据）', () => {
    // `RubricItem.id` 在**解析后的类型**里是必填字符串（`RubricItemSchema` 的 `.default('')` 只在过 Zod 时补，
    // 内存里的字面量得自己写出来）——「没写 ID」在这把尺子上的表示就是空串，不是缺这一格
    const table: Rubric = { groups: [{ name: 'g', items: [{ id: '', goal: 'a', weight: 5 }, { id: '', goal: 'b', weight: 5 }] }] };
    const raw = JSON.stringify({ judgments: [{ id: '#1', achieved: true }, { id: '#2', achieved: false }], verdict: 'v' });
    expect(parseJudgeResponse(raw, table).judgments.map((item) => item.id)).toEqual(['#1', '#2']);
  });
});

describe('parseJudgeResponse：第 1 类翻车点（不合法 JSON）', () => {
  it('散文返回 / 空返回 / 顶层不是对象 / 没有 judgments 数组 → JUDGE_PARSE_FAILED', () => {
    expect(() => parseJudgeResponse('这份代码整体不错，我给 4 分。', rubric())).toThrow(/不是合法 JSON/);
    expect(() => parseJudgeResponse('   \n  ', rubric())).toThrow(/空内容/);
    expect(() => parseJudgeResponse('[1,2,3]', rubric())).toThrow(/顶层不是对象/);
    expect(() => parseJudgeResponse(JSON.stringify({ verdict: '还行' }), rubric())).toThrow(/没有 judgments 数组/);
  });
});

describe('parseJudgeResponse：第 2 类翻车点（markdown 围栏）', () => {
  it('```json 围栏包裹 → 先剥围栏再解析；中间夹散文 → 失败（不从散文里抠 JSON）', () => {
    expect(parseJudgeResponse(`\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``, rubric()).judgments).toHaveLength(3);
    expect(() => parseJudgeResponse(`我的结论是：\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``, rubric())).toThrow(
      /不是合法 JSON/,
    );
  });
});

describe('parseJudgeResponse：第 3 类翻车点（缺项 / 多余 / 重复）', () => {
  /**
   * 本任务最承重的一条守卫：**缺一项就整行失败**，绝不把「模型没提」当成「未达成」。
   * 当成未达成看起来无害，实际是「模型漏答」与「确实没做」在分数上完全同形；
   * 而当送分更糟——白送一整项权重，分数看起来完全正常。
   */
  it('缺任何一项都失败，且报错点名是哪一项（引用键 + 目标）', () => {
    for (const id of ['A1', 'A2', 'D1']) {
      const error = (() => {
        try {
          parseJudgeResponse(withoutJudgment(id), rubric());
        } catch (caught) {
          return caught;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as Error).message).toContain(id);
      expect((error as Error).message).toContain('缺少');
    }
  });

  it('多余的判定被忽略（模型自造的第 4 项不影响结果）', () => {
    const raw = JSON.stringify({ ...VALID, judgments: [...VALID.judgments, { id: 'ZZ', achieved: true, reason: '自造' }] });
    expect(parseJudgeResponse(raw, rubric()).judgments).toHaveLength(3);
  });

  it('重复引用键取第一条（模型偶尔会把同一项说两遍）', () => {
    const raw = JSON.stringify({
      ...VALID,
      judgments: [{ id: 'A1', achieved: true, reason: '第一条' }, ...VALID.judgments.slice(1), { id: 'A1', achieved: false, reason: '重复的' }],
    });
    const parsed = parseJudgeResponse(raw, rubric());
    expect(parsed.judgments[0]?.achieved).toBe(true);
    expect(parsed.judgments[0]?.reason).toBe('第一条');
  });
});

describe('parseJudgeResponse：achieved 的宽容读', () => {
  /**
   * 模型很爱把布尔写成字符串或中文。schema 那一关只在**上游认了**的时候才拦得住
   * （网关不透传时它形同虚设），
   * 故解析侧必须宽容——否则一次「格式小毛病」会让整行失败。
   */
  it('接受布尔与两种语言的写法（大小写不敏感）："是"/"否"、"达成"/"未达成"、`True`；认不出的值才失败', () => {
    const cases: { given: unknown; expected: boolean }[] = [
      { given: true, expected: true },
      { given: false, expected: false },
      { given: 'true', expected: true },
      { given: 'false', expected: false },
      { given: '是', expected: true },
      { given: '否', expected: false },
      // 这两个词是本工具自己的词（评分口径、界面、输出契约都用它们），模型照题面用词回答必须收
      { given: '达成', expected: true },
      { given: '未达成', expected: false },
      // 大小写不敏感（`.toLowerCase()` 之后再比对）：`True` 与 `true` 没有语义差别
      { given: 'True', expected: true },
      { given: 'FALSE', expected: false },
    ];
    for (const { given, expected } of cases) {
      const raw = JSON.stringify({
        ...VALID,
        judgments: VALID.judgments.map((item) => (item.id === 'A1' ? { ...item, achieved: given } : item)),
      });
      expect(parseJudgeResponse(raw, rubric()).judgments[0]?.achieved).toBe(expected);
    }

    for (const given of ['优秀', 1, null, {}]) {
      const raw = JSON.stringify({
        ...VALID,
        judgments: VALID.judgments.map((item) => (item.id === 'A1' ? { ...item, achieved: given } : item)),
      });
      expect(() => parseJudgeResponse(raw, rubric())).toThrow(/achieved/);
    }
  });
});

describe('parseJudgeResponse：可容忍的缺失（占位而不是失败）', () => {
  it('缺总评 / 总评为空 → 占位文案（总评不是判据）', () => {
    expect(parseJudgeResponse(JSON.stringify({ ...VALID, verdict: undefined }), rubric()).verdict).toBe('（模型未给出总评）');
    expect(parseJudgeResponse(JSON.stringify({ ...VALID, verdict: '   ' }), rubric()).verdict).toBe('（模型未给出总评）');
  });

  it('某一项缺理由 → 占位文案（理由是展示项）', () => {
    const raw = JSON.stringify({
      ...VALID,
      judgments: VALID.judgments.map((item) => (item.id === 'A1' ? { id: 'A1', achieved: true } : item)),
    });
    expect(parseJudgeResponse(raw, rubric()).judgments[0]?.reason).toBe('（模型未给出理由）');
  });
});

describe('与 contracts 的输出契约对齐（跨包接缝）', () => {
  it('JUDGE_OUTPUT_CONTRACT 里出现解析器读的每个字段名', () => {
    for (const field of ['judgments', 'id', 'achieved', 'reason', 'verdict']) {
      expect(JUDGE_OUTPUT_CONTRACT).toContain(field);
    }
  });
});

/** 一次评分调用的标准输入（route 是假的，请求根本不会发出去） */
function judgeInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    rubric: rubric(),
    diffText: '### 未提交改动（工作区 vs HEAD）\n+ 中文标题\n',
    taskPrompt: '把 README 的标题改成中文',
    route: { protocolType: 'openai', baseUrl: 'https://fake.invalid/v1', apiKey: 'sk-test', modelId: 'judge-model' },
    judgeProviderId: 'judge-provider',
    ...overrides,
  };
}

describe('finalizeScore：两条通路共用的收口', () => {
  it('总分 = 达成项权重之和；maxScore = 评分表满分（两条通路同一把尺子）', () => {
    const parsed = { judgments: parseJudgeResponse(JSON.stringify(VALID), rubric()).judgments, verdict: '总评' };
    const result = finalizeScore({
      parsed,
      rubric: rubric(),
      raw: '{}',
      judgeProviderId: 'p1',
      judgeModelId: 'm1',
      judgeAgentKind: null,
      judgeEffort: null,
      structuredOutput: false,
      judgeTokens: null,
      judgeDurationMs: null,
    });
    expect(result.totalScore).toBe(composeTotalScore(rubric(), parsed.judgments));
    expect(result.totalScore).toBe(41); // 18 + 23
    expect(result.maxScore).toBe(45);
    expect(result.judgeAgentKind).toBeNull();
  });

  it('structuredOutput 原样进结果（判据由两条通路各自给：文本侧恒 false，智能体侧取适配器报回的 applied）', () => {
    const parsed = { judgments: parseJudgeResponse(JSON.stringify(VALID), rubric()).judgments, verdict: '总评' };
    const base = { parsed, rubric: rubric(), raw: '{}', judgeProviderId: 'p1', judgeModelId: 'm1', judgeAgentKind: null, judgeEffort: null, judgeTokens: null, judgeDurationMs: null } as const;
    expect(finalizeScore({ ...base, structuredOutput: true }).structuredOutput).toBe(true);
    expect(finalizeScore({ ...base, structuredOutput: false }).structuredOutput).toBe(false);
  });

  /**
   * `judgeEffort` 与 `structuredOutput` 同一条处置：**必填**，两条通路各自表一次态。
   * 为什么不能给默认值：`null` 与档名都是合法值，一个「谁也没选过」的缺省会让
   * 「忘了把入参传下来」与「确实没指定强度」在数据上完全同形——而后者正是本任务要区分的。
   */
  it('judgeEffort 原样进结果（null = 未指定，不是「关闭」，也不是「两边等强」）', () => {
    const parsed = { judgments: parseJudgeResponse(JSON.stringify(VALID), rubric()).judgments, verdict: '总评' };
    const base = { parsed, rubric: rubric(), raw: '{}', judgeProviderId: 'p1', judgeModelId: 'm1', judgeAgentKind: null, structuredOutput: false, judgeTokens: null, judgeDurationMs: null } as const;
    expect(finalizeScore({ ...base, judgeEffort: 'max' }).judgeEffort).toBe('max');
    expect(finalizeScore({ ...base, judgeEffort: null }).judgeEffort).toBeNull();
  });

  /**
   * 评分**自己**的用量与耗时：与 `judgeEffort` / `structuredOutput` 同一条处置
   * ——**必填**，两条通路各自表一次态。给缺省会让「忘了把入参传下来」与「确实没采到」在数据上同形，
   * 而界面那两格正是拿它判「用量未采集」的（`null` 与 `{0,0,0}` 是两件事）。
   */
  it('judgeTokens / judgeDurationMs 原样进结果（null = 没采到，不是 0）', () => {
    const parsed = { judgments: parseJudgeResponse(JSON.stringify(VALID), rubric()).judgments, verdict: '总评' };
    const base = { parsed, rubric: rubric(), raw: '{}', judgeProviderId: 'p1', judgeModelId: 'm1', judgeAgentKind: null, judgeEffort: null, structuredOutput: false, judgeTokens: null, judgeDurationMs: null } as const;
    const measured = finalizeScore({ ...base, judgeTokens: { input: 3, cached: 4, output: 5 }, judgeDurationMs: 1_200 });
    expect(measured.judgeTokens).toEqual({ input: 3, cached: 4, output: 5 });
    expect(measured.judgeDurationMs).toBe(1_200);
    const missing = finalizeScore({ ...base, judgeTokens: null, judgeDurationMs: null });
    expect(missing.judgeTokens).toBeNull();
    expect(missing.judgeDurationMs).toBeNull();
  });

  it('两个端点：一项都没达成 ⇒ 0 分；全部达成 ⇒ 满分（总分恒按权重加总，没有部分分）', () => {
    const base = { rubric: rubric(), raw: '{}', judgeProviderId: 'p1', judgeModelId: 'm1', judgeAgentKind: null, judgeEffort: null, structuredOutput: false, judgeTokens: null, judgeDurationMs: null } as const;
    /** 把每一项的判定都换成 `achieved`，其余字段照抄合法样例 */
    const parsedWith = (achieved: boolean) =>
      parseJudgeResponse(
        JSON.stringify({ ...VALID, judgments: VALID.judgments.map((item) => ({ ...item, achieved })) }),
        rubric(),
      );
    // 下界：一项都没达成 ⇒ 0（旧体系的百分制下限是 48 分，这里的 0 是「一分权重都没拿到」）
    expect(finalizeScore({ ...base, parsed: parsedWith(false) }).totalScore).toBe(0);
    // 上界：全部达成 ⇒ 满分（18 + 4 + 23 = 45），不是常量 100
    const all = finalizeScore({ ...base, parsed: parsedWith(true) });
    expect(all.totalScore).toBe(45);
    expect(all.totalScore).toBe(all.maxScore);
  });

  it('形状漂移 → 中文 INTERNAL，不是裸 ZodError', () => {
    const parsed = { judgments: parseJudgeResponse(JSON.stringify(VALID), rubric()).judgments, verdict: '总评' };
    const error = (() => {
      try {
        finalizeScore({
          parsed,
          rubric: rubric(),
          raw: '{}',
          judgeProviderId: undefined as unknown as string,
          judgeModelId: 'm1',
          judgeAgentKind: null,
          judgeEffort: null,
          structuredOutput: false,
          judgeTokens: null,
          judgeDurationMs: null,
        });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('INTERNAL');
    expect((error as Error).message).toContain('评分结果不符合契约');
    expect((error as Error).message).toContain('judgeProviderId');
  });
});

describe('judgeRow：成功路径', () => {
  it('把模型返回解析成 ScoreResult，总分按权重加总而不是照抄模型（模型根本不给总分）', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    const score = await judgeRow(judgeInput());
    expect(score.judgments.map((item) => item.achieved)).toEqual([true, false, true]);
    expect(score.totalScore).toBe(41);
    expect(score.maxScore).toBe(45);
    expect(score.judgeProviderId).toBe('judge-provider');
    expect(score.judgeModelId).toBe('judge-model');
  });

  it('system 用 contracts 的输出契约，prompt 里带题面、评分表（组名/引用键/权重）与 diff', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    await judgeRow(judgeInput());
    expect(fakeTextApi.calls[0]?.system).toBe(JUDGE_OUTPUT_CONTRACT);
    const prompt = fakeTextApi.calls[0]?.messages[0]?.content ?? '';
    expect(prompt).toContain('把 README 的标题改成中文');
    expect(prompt).toContain('一、生产代码');
    expect(prompt).toContain('A1');
    expect(prompt).toContain('| 18 |');
    expect(prompt).toContain('满分 45 分');
    expect(prompt).toContain('+ 中文标题');

    await judgeRow(judgeInput({ diffText: '   ' }));
    expect(fakeTextApi.calls[1]?.messages[0]?.content).toContain('（无改动）');
  });

  it('文本通路本期不开 schema：structuredOutput 记 false', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    expect((await judgeRow(judgeInput())).structuredOutput).toBe(false);
  });

  /**
   * 思考强度：**请求参数**，由调用方从配置读出来传进 `judgeEffort`——
   * 本模块不读配置、不碰落盘（它今天是纯入参的）。
   * 为什么正反两条都要：只钉「给了会透」看不出「没给会不会凭空塞一个缺省档」（那会让「未指定」
   * 在网关上变成一次显式要求，而记账那一格照样写它）；只钉「没给是 undefined」则看不出这一格
   * 根本没接线（`judgeEffort` 收下了却忘了往下递）。记账那两格同理：`null` 与档名都是合法值，
   * 留一个 `null` 占位不会被任何别的断言发现。
   */
  it('给了 judgeEffort ⇒ 原样交给文本 API（多轮入口）并记进 ScoreResult', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    const score = await judgeRow(judgeInput({ judgeEffort: 'max' }));
    expect(fakeTextApi.calls[0]?.effort).toBe('max');
    expect(score.judgeEffort).toBe('max');
  });

  it('没给 judgeEffort ⇒ 透给文本 API 的 effort 是 undefined（未指定，不是关闭），记账为 null', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    const score = await judgeRow(judgeInput());
    // 判据是**值**：`reasoningFields(protocol, undefined)` 展开成 `{}`（一个强度键都不发），
    // 而「键在不在」这一层形状没有消费者——多轮入口按值分支，两个协议各自负责自己的线上字段
    expect(fakeTextApi.calls[0]?.effort).toBeUndefined();
    expect(score.judgeEffort).toBeNull();
  });

  /**
   * 评分自己的用量与耗时（用户口径：评分详情里那一段说的必须是**评分的花销**）。
   *
   * 三条判据一条都不能省：
   *   · **跨轮累计**——结构修复是额外请求，两轮的数**不同**才测得出「累计」与「只记最后一轮」的差别；
   *   · **上游没报就是 `null`**——写成 `?? {0,0,0}` 会让界面把「这家不报」显示成「一分钱没花」；
   *   · **耗时是掐表**（文本通路没有适配器自报值），判据用假时钟钉住，否则「恒返回 0」也全绿。
   */
  it('用量跨结构修复的每一轮累计', async () => {
    fakeTextApi.replies = ['不是 JSON，我随便说说', JSON.stringify(VALID)];
    fakeTextApi.usages = [
      { input: 10, cached: 0, output: 2 },
      { input: 30, cached: 4, output: 8 },
    ];
    // 两轮的数**不同**才测得出「累计」与「只记最后一轮」的差别
    expect((await judgeRow(judgeInput())).judgeTokens).toEqual({ input: 40, cached: 4, output: 10 });
  });

  it('上游没报用量 ⇒ judgeTokens 为 null（绝不填 0）', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    fakeTextApi.usage = null;
    expect((await judgeRow(judgeInput())).judgeTokens).toBeNull();
  });

  it('judgeDurationMs 是这一次评分（含修复轮）的掐表值', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    // 首尾各取一次当前时间：文本通路没有适配器自报的耗时，这一格只能是掐表值
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_750);
    const score = await judgeRow(judgeInput());
    now.mockRestore();
    expect(score.judgeDurationMs).toBe(750);
  });

  /**
   * 成功路径的 `raw` 是**唯一**能回答「模型到底说了什么」的地方：分数看起来不对时，要靠它区分
   * 「提示词没说清」与「模型答歪了」。被加工过（重新序列化 / 截头去尾 / 换成 verdict）就再也回答不了。
   */
  it('成功路径的 raw 原样透传模型返回；超长时截断并留「此处截断」标记（与失败路径同一口径）', async () => {
    const reply = JSON.stringify(VALID);
    fakeTextApi.reply = reply;
    expect((await judgeRow(judgeInput())).raw).toBe(reply);

    // 合法但超长的返回（长总评）：解析照常成功，只有 `raw` 被上限截断。
    // 断言写成「比原文短 + 带总字符数」，不去抄 `RAW_MAX_CHARS` 那个私有常量——
    // 抄一份常量只是把实现复述一遍，上限调整时那条断言会以「与行为无关」的方式红
    const huge = JSON.stringify({ ...VALID, verdict: `很长的总评：${'z'.repeat(30_000)}` });
    fakeTextApi.reply = huge;
    const truncated = (await judgeRow(judgeInput())).raw;
    expect(truncated).toContain('此处截断');
    expect(truncated).toContain(`共 ${huge.length} 字符`);
    expect(truncated.length).toBeLessThan(huge.length);
  });
});

describe('judgeRow：失败面与修复循环', () => {
  it('每一轮都缺项 → JUDGE_PARSE_FAILED，文案带回问轮数，context.raw 是最后一轮的原文', async () => {
    const missing = withoutJudgment('D1');
    fakeTextApi.reply = missing;
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    expect((error as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
    expect((error as Error).message).toContain('缺少');
    expect((error as Error).message).toContain(`回问模型 ${JUDGE_REPAIR_ROUNDS} 轮`);
    expect((error as ServiceError).context).toMatchObject({ raw: missing, repairs: JUDGE_REPAIR_ROUNDS });
    expect(fakeTextApi.calls).toHaveLength(1 + JUDGE_REPAIR_ROUNDS);
  });

  it('第一次回散文、第二次回合法 JSON → 正常出分，且第二轮带上了原文与纠错要求', async () => {
    fakeTextApi.replies = ['这份改动整体不错。', JSON.stringify(VALID)];
    const progress: { round: number; message: string }[] = [];
    const score = await judgeRow(judgeInput({ onProgress: (item) => progress.push(item) }));
    expect(score.totalScore).toBe(41);
    expect(fakeTextApi.calls).toHaveLength(2);
    const second = fakeTextApi.calls[1]?.messages ?? [];
    expect(second.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2]?.content).toContain('不是合法 JSON');
    expect(progress).toHaveLength(1);
    expect(progress[0]?.round).toBe(1);
  });

  it('调用失败（鉴权）透传原错误码，且一次都不回问（密钥错了，再问一百次也一样）', async () => {
    fakeTextApi.failure = new ServiceError('AUTH_FAILED', '供应商密钥无效：去设置页检查');
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    expect((error as ServiceError).code).toBe('AUTH_FAILED');
    expect(fakeTextApi.calls).toHaveLength(1);
  });

  /**
   * 真实网络栈抛的是**裸 Error**（`fetch failed` / socket hang up / DNS），不是契约的 `ServiceError`。
   * 它们必须折成中文 `INTERNAL`：裸异常冒到路由层等于给使用者一段英文堆栈，而这里连归因码都没有
   * （不像 AUTH_FAILED / RATE_LIMITED —— 那些是「问到了答案」的失败面，要原样透传）。
   * 原文必须保留在 message 里：排障时要能看出是网络、是超时、还是适配器违约。
   */
  it('调用抛出非 ServiceError（真实网络栈的裸 Error）→ 折成中文 INTERNAL，原文不丢', async () => {
    fakeTextApi.failure = new Error('fetch failed：socket hang up');
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('INTERNAL');
    expect((error as Error).message).toContain('调用评分模型失败');
    expect((error as Error).message).toContain('socket hang up');
    // 不是「答错了」而是「没问到」：折错会让使用者去改提示词，所以也不该白回问一轮
    expect(fakeTextApi.calls).toHaveLength(1);
  });

  it('超长坏返回：context.raw 被截断并带「此处截断」标记', async () => {
    fakeTextApi.reply = 'x'.repeat(5_000);
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    const context = (error as ServiceError).context as { raw: string };
    expect(context.raw).toContain('此处截断');
    expect(context.raw).toContain('5000 字符');
  });
});

describe('validateJudgeResponse 与 parseJudgeResponse 是同一个判据', () => {
  it('合格时两者给出的解析结果逐字段一致；不合格时原因同源', () => {
    const good = JSON.stringify(VALID);
    const checked = validateJudgeResponse(good, rubric());
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.parsed).toEqual(parseJudgeResponse(good, rubric()));

    const bad = '这份代码不错，我给 4 分。';
    const failed = validateJudgeResponse(bad, rubric());
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(() => parseJudgeResponse(bad, rubric())).toThrow(failed.message);
  });
});

describe('buildJudgeFeedback：纠错提示（纯函数）', () => {
  it('点名原因、附上它自己的原文、并把评分表的引用键与目标再列一遍', () => {
    const feedback = buildJudgeFeedback({
      message: '缺少对 A2（补 Javadoc）的判定',
      raw: '{"judgments":[{"id":"A1","achieved":true}]}',
      rubric: rubric(),
    });
    expect(feedback).toContain('缺少对 A2（补 Javadoc）的判定');
    expect(feedback).toContain('{"judgments":[{"id":"A1","achieved":true}]}');
    expect(feedback).toContain('不要输出 JSON 以外的任何文字');
    for (const key of ['A1', 'A2', 'D1']) expect(feedback).toContain(key);
    expect(feedback).toContain('补 Javadoc');
  });

  it('原文超长时按 RAW_KEEP_CHARS 截断（与失败路径的 context.raw 同一个上限）', () => {
    const feedback = buildJudgeFeedback({
      message: '不是合法 JSON',
      raw: 'y'.repeat(RAW_KEEP_CHARS + 500),
      rubric: rubric(),
    });
    expect(feedback).toContain('此处截断');
    expect(feedback).toContain(String(RAW_KEEP_CHARS + 500));
  });
});
