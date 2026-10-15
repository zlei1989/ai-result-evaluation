// @vitest-environment node
/**
 * 真机冒烟四格判据的正反例——**这个文件是那四格「见过红」的唯一证据**。
 *
 * 判据原先住在 `live-smoke.test.ts` 里，而那个文件默认跳过：它们从没红过，装载那一格甚至因为
 * 读了行上不存在的 `errorCode`（契约里叫 `error.code`）而**不可能红**——文档却写着它是
 * 「装载缺陷的唯一拦法」。判据抽到 `live-smoke-checks.ts` 之后，这里给每条一个反例。
 *
 * 行的形状取**契约类型**（`EvalRow` 的 `Pick`）：判据读什么就声明什么，字段名写错时 `tsc`
 * 直接点名。本地影子接口配 `as T` 正是当初让①格恒绿的原因，这里不再重蹈。
 */
import { AGENT_KINDS, type AgentKind, type EvalRow } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import {
  LIVE_SMOKE_COVERAGE,
  checkAgentJudgeCell,
  checkDurationCell,
  checkLoadCell,
  checkProductCell,
  checkStructuredScoreCell,
  checkTransportCell,
  durationCeilingFor,
  scaleOf,
  waitBudgetFor,
} from './live-smoke-checks';
import { DEFAULT_TURN_WALL_CLOCK_MS } from '../turn';

/** 判据读的那几格（不伪造整行：读什么给什么） */
interface JudgedRow {
  providerId: string;
  modelId: string;
  baseUrl: string;
  status: EvalRow['status'];
  error: EvalRow['error'];
  score: { judgeProviderId: string; verdict: string; structuredOutput: boolean; raw: string } | null;
}

/** 一份四格都过的行 */
function judged(overrides: Partial<JudgedRow> = {}): JudgedRow {
  return {
    providerId: 'p-1',
    modelId: 'm-1',
    baseUrl: 'https://gw.example.com/anthropic',
    status: 'judged',
    error: null,
    score: { judgeProviderId: 'p-1', verdict: '还行', structuredOutput: true, raw: '{"judgments":[],"verdict":"还行"}' },
    ...overrides,
  };
}

/** 本次选择（②格拿来对账） */
const EXPECTED = { providerId: 'p-1', modelId: 'm-1' };

describe('① 装载格', () => {
  it('没有失败归因 ⇒ 过', () => {
    expect(checkLoadCell(judged())).toBeNull();
  });

  it('装载失败（`AGENT_LOAD_FAILED`）⇒ 红——这一格原先因为读错字段名而永不红', () => {
    const problem = checkLoadCell(
      judged({ status: 'failed', error: { code: 'AGENT_LOAD_FAILED', message: 'codex 可执行文件找不到' } }),
    );
    expect(problem).toMatch(/装载失败/);
  });

  it('入口解析失败的另一种文案（`Cannot find module`）也拦得住', () => {
    const problem = checkLoadCell(judged({ error: { code: 'AGENT_FAILED', message: 'Cannot find module @openai/codex' } }));
    expect(problem).toMatch(/装载失败/);
  });

  it('别的失败不冤枉成装载问题', () => {
    expect(checkLoadCell(judged({ status: 'timed-out', error: { code: 'AGENT_TIMED_OUT', message: '超时' } }))).toBeNull();
  });
});

describe('② 传输格', () => {
  it('路由一致、非凭据类失败 ⇒ 过', () => {
    expect(checkTransportCell(judged(), EXPECTED)).toBeNull();
  });

  it('行的 providerId 与本次选择不一致 ⇒ 红', () => {
    expect(checkTransportCell(judged({ providerId: 'other' }), EXPECTED)).toMatch(/providerId 与本次选择不一致/);
  });

  it('baseUrl 为空 ⇒ 红（凭据 / 网关地址没随行落下去）', () => {
    expect(checkTransportCell(judged({ baseUrl: '' }), EXPECTED)).toMatch(/baseUrl 为空/);
  });

  it('凭据类失败 ⇒ 红——这一格原先同样永不红', () => {
    const problem = checkTransportCell(judged({ error: { code: 'AUTH_FAILED', message: '401 Unauthorized' } }), EXPECTED);
    expect(problem).toMatch(/凭据类失败/);
  });
});

describe('③ 产物格', () => {
  it('跑完且有分数 ⇒ 过', () => {
    expect(checkProductCell(judged())).toBeNull();
  });

  it('没跑完 ⇒ 红（装载与凭据失败都落在这里）', () => {
    expect(checkProductCell(judged({ status: 'failed' }))).toMatch(/行没跑完/);
  });

  it('跑完了但没分数 ⇒ 红', () => {
    expect(checkProductCell(judged({ score: null }))).toMatch(/score 为 null/);
  });
});

describe('⑤ 智能体评分格', () => {
  it('有 judgeProviderId 与结论 ⇒ 过', () => {
    expect(checkAgentJudgeCell(judged())).toBeNull();
  });

  it('评分阶段失败码 ⇒ 红', () => {
    const problem = checkAgentJudgeCell(judged({ error: { code: 'JUDGE_PARSE_FAILED', message: '答复不是 JSON' } }));
    expect(problem).toMatch(/出现了 JUDGE_\* \/ PARSE_FAILED 类失败/);
  });

  it('没有 judgeProviderId ⇒ 红（评分不是智能体给的）', () => {
    expect(checkAgentJudgeCell(judged({ score: { ...judged().score!, judgeProviderId: '' } }))).toMatch(/没有 judgeProviderId/);
  });

  it('结论为空 ⇒ 红（评分智能体没拿到答复）', () => {
    expect(checkAgentJudgeCell(judged({ score: { ...judged().score!, verdict: '' } }))).toMatch(/verdict 为空/);
  });
});

describe('⑥ 评分产出格', () => {
  it('`structuredOutput` 是 boolean、`raw` 可解析 ⇒ 过', () => {
    expect(checkStructuredScoreCell(judged())).toBeNull();
  });

  it('`structuredOutput` 缺席 ⇒ 红（这一格要能回答「有没有按 schema 作答」）', () => {
    // 强转是**故意的**：这里模拟的正是畸形数据（落盘时缺了这一格），类型上本来就构造不出来
    const missing = { ...judged().score!, structuredOutput: undefined as unknown as boolean };
    expect(checkStructuredScoreCell(judged({ score: missing }))).toMatch(/缺少 structuredOutput/);
  });

  it('`raw` 不是 JSON ⇒ 红', () => {
    expect(checkStructuredScoreCell(judged({ score: { ...judged().score!, raw: '不是 JSON' } }))).toMatch(/不是可解析的 JSON/);
  });

  it('`raw` 里没有 `judgments` ⇒ 红', () => {
    expect(checkStructuredScoreCell(judged({ score: { ...judged().score!, raw: '{"verdict":"还行"}' } }))).toMatch(/没有 judgments/);
  });

  it('出现解析失败码 ⇒ 红', () => {
    const problem = checkStructuredScoreCell(judged({ error: { code: 'PARSE_FAILED', message: 'x' } }));
    expect(problem).toMatch(/类失败码/);
  });
});

describe('真机冒烟覆盖台账', () => {
  it('每一家都有登记，且写的是**证据**（点名这一家怎么跑的），不是「已跑」这种没有信息量的字', () => {
    for (const [kind, evidence] of Object.entries(LIVE_SMOKE_COVERAGE)) {
      expect(evidence, `${kind} 的覆盖证据里没点名这一家的跑法——很可能是复制粘贴来的`).toContain(
        `AIEVAL_LIVE_KIND=${kind}`,
      );
    }
  });

  /**
   * 台账只有两种合法形状：**跑过**（带日期、provider / 模型与墙钟）或**未跑**（逐字以「未跑」开头）。
   *
   * 为什么值得单钉：这一格谁也拦不住随手填一句，而它唯一的失败模式是「没跑过却写得像跑过」
   * ——新家接入时最容易发生（适配器还没接上，台账先抄了别家那一行）。判据取**形状**而不是内容：
   * 跑过的行必须给出日期与墙钟，未跑的行必须逐字点明「未跑」。
   */
  it('每条登记要么是跑过的实证（日期 + 墙钟），要么逐字写明「未跑」', () => {
    for (const kind of AGENT_KINDS) {
      const evidence = LIVE_SMOKE_COVERAGE[kind];
      if (evidence.startsWith('未跑')) continue;
      expect(evidence, `${kind} 写了跑过，却没有日期`).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(evidence, `${kind} 写了跑过，却没有墙钟`).toMatch(/墙钟/);
    }
  });
});

describe('⑦ 耗时格与等待预算（声明驱动消费方）', () => {
  it('秒级：45 秒不判违规', () => {
    expect(checkDurationCell(45_000, 'seconds')).toBeNull();
  });

  it('秒级却跑了 5 分钟 ⇒ 红——声明的量级与事实不符', () => {
    const problem = checkDurationCell(300_000, 'seconds');
    expect(problem).toMatch(/超出声明量级/);
    // 报错要给出两条出路：要么改适配器，要么改声明
    expect(problem).toMatch(/改声明/);
  });

  it('分钟级：5 分钟不判违规', () => {
    expect(checkDurationCell(300_000, 'minutes')).toBeNull();
  });

  it('没采到耗时（`null`）不判违规——「没采到」不是「超了」', () => {
    expect(checkDurationCell(null, 'seconds')).toBeNull();
  });

  it('等待预算按声明的量级派生：秒级 1 分钟、分钟级 11 分钟', () => {
    expect(waitBudgetFor('seconds')).toBe(60_000);
    expect(waitBudgetFor('minutes')).toBe(660_000);
  });

  it('分钟级的等待预算**严宽于**骨架的单轮墙钟看门狗上限——不然那一档必抖', () => {
    // 「上游整机不可达」会正好走到看门狗上限才收场（真机：600.103 s）⇒ 预算若与之相等
    // （曾经就是 600_000 == 600_000），收场比预算晚约 100 ms 就成假红。
    expect(waitBudgetFor('minutes')).toBeGreaterThan(DEFAULT_TURN_WALL_CLOCK_MS);
  });

  it('实测上限比等待预算宽一档——判的是「不符」而不是「卡点」', () => {
    expect(durationCeilingFor('seconds')).toBeGreaterThan(waitBudgetFor('seconds'));
    expect(durationCeilingFor('minutes')).toBeGreaterThan(waitBudgetFor('minutes'));
  });

  it('每一家的量级都解析成**它自己声明的**那一档（真值来自注册表，不是本地常量）', () => {
    // 逐家写死而不是「全都是分钟级」：量级是**声明**，pi 的 in-process SDK 声明的就是秒级，
    // 把它当异常改掉等于用一句旧文案覆盖掉新家的真值。等待预算按这一档派生，写错了会掐掉自己那一轮。
    // `Record<AgentKind, …>` 而不是 `Record<string, …>`：新家接进来时这一格必须有人表态。
    const declared: Record<AgentKind, 'seconds' | 'minutes'> = {
      cc: 'minutes',
      codex: 'minutes',
      dsh: 'minutes',
      pi: 'seconds',
    };
    for (const kind of AGENT_KINDS) expect(scaleOf(kind), `${kind} 的耗时量级`).toBe(declared[kind]);
  });

  it('没给或给了不认识的家 ⇒ 按最宽的一档，不把等待预算压到 1 分钟', () => {
    expect(scaleOf('')).toBe('minutes');
    expect(scaleOf('gemini')).toBe('minutes');
  });
});
