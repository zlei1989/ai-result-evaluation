/**
 * 事件 → 日志行（纯函数）。
 * 7 种事件类型都要有一行可读文本：**任何一种被静默丢掉，排障时就少一条证据**
 * （spec §5.6.3：未识别的事件必须投影成保留原始负载的日志事件，不得静默丢弃）。
 *
 * 时间断言**不写死时钟**：`formatClock` 把 ISO 串转成**本机时区**的 `HH:mm:ss`
 * （与 `format.ts` 的 `formatDateTime` 同一口径），写死 `[08:03:04]` 会让这份用例
 * 只在 UTC 机器上通过。这里用 `expectedClock()` 独立算出同一时刻的本机时钟串
 * （它只用 `toTimeString()`，与本文件被测的 `pad(getHours())` 是两条独立路径），
 * 于是「原样返回 ISO 串」「丢掉时间戳」这两种坏实现照样会红。
 *
 * `score` 行有两条通路，行文必须分得开：智能体评分带上智能体名（`AGENT_LABELS`），
 * 文本 API 评分保持原样——同一行重跑后两次评分的日志混在一条流里，
 * 没有智能体名就分不出哪个分是哪条通路打的。
 */
import { describe, expect, it } from 'vitest';
import type { ScoreResult } from '@aieval/contracts';
import { formatEventLine, formatEventLog } from './log-format';

const at = '2026-09-22T08:03:04.000Z';

/** 期望的本机时钟串（HH:mm:ss）；与被测实现的取时路径不同，避免自证 */
function expectedClock(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 8);
}

/**
 * 评分事件里的 `ScoreResult` 夹具（默认值 = `score / error / end 各一行` 里那份 87 分记录）。
 * `judgeAgentKind` 默认 `null` ⇔ 文本 API 评分：契约里它是必填输出字段，老记录读盘后同样是
 * `null`；要造智能体评分的那一份由用例覆盖。两个用例共用这一个形状，契约再加字段时只改这里。
 */
function scoreFixture(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    // 逐项判定 + 满分（旧的 `dimensions: []` 已随重构删除）
    judgments: [],
    totalScore: 87,
    maxScore: 100,
    verdict: '可用',
    raw: '{}',
    judgeProviderId: 'p-1',
    judgeModelId: 'claude-opus-4-6',
    judgedAt: at,
    judgeAgentKind: null,
    // false ⇔ 这一分只靠提示词契约拿到；要造「被 schema 约束的那一份」就在用例里覆盖它
    structuredOutput: false,
    ...overrides,
  };
}

describe('formatEventLine', () => {
  it('log：带流别与正文', () => {
    expect(formatEventLine({ seq: 1, at, type: 'log', stream: 'stderr', text: '警告：未找到配置' })).toBe(
      `[${expectedClock(at)}] stderr 警告：未找到配置`,
    );
  });

  it('status：用 contracts 的中文文案', () => {
    expect(formatEventLine({ seq: 2, at, type: 'status', status: 'judging' })).toBe(
      `[${expectedClock(at)}] 状态 评分中`,
    );
  });

  it('usage：三项用量、命中率与轮次（`timing` 缺 ⇒ 明说「耗时未采集」，不写 0s）', () => {
    expect(
      formatEventLine({ seq: 3, at, type: 'usage', tokens: { input: 1000, cached: 200, output: 500 }, turns: 3 }),
    ).toBe(`[${expectedClock(at)}] 用量 输入 1000 · 缓存 200 · 命中 17% · 输出 500 · 轮次 3 · 耗时未采集`);
  });

  /**
   * 时间格（2026-10-XX 新增）：`cost/s` 是**派生**的，原料是 `output` 与 `timing`。
   * 三个断言分别钉三件事：① 时长/首字按秒显示；② tok/s 用 `apiMs − ttftMs`（**纯生成**那段）；
   * ③ **来源必须标出来**——`'vendor'` 是纯模型时间，与另两家的墙钟不可直接比。
   * 数值口径：`output 200 / ((apiMs 60_000 − ttftMs 5_000) / 1000) = 200 / 55 = 3.6 tok/s`。
   */
  it('usage：带 timing 时给出耗时 / 首字 / tok/s，并标出时间来源', () => {
    const line = formatEventLine({
      seq: 3,
      at,
      type: 'usage',
      tokens: { input: 100, cached: 900, output: 200 },
      timing: { totalMs: 166_712, apiMs: 60_000, ttftMs: 5_000, source: 'vendor' },
      turns: 2,
    });

    expect(line).toBe(
      `[${expectedClock(at)}] 用量 输入 100 · 缓存 900 · 命中 90% · 输出 200 · 轮次 2`
      + ' · 耗时 166.7s · 首字 5.0s · 生成 3.6 tok/s · （厂商自报（纯模型时间，不含工具执行））',
    );
  });

  /**
   * `source: 'events'`（codex / dsh）= 我们按事件或行时间戳算的**墙钟**，含工具执行
   * ⇒ 那一行必须带上「含工具执行」的警示，否则使用者会把两个不同口径的 tok/s 放进同一张表。
   * 这里没有 `apiMs` / `ttftMs`（两家都采不到）⇒ 分母退化成 `totalMs`：
   * `output 90 / (30_000 / 1000) = 3.0 tok/s`。
   */
  it('usage：events 来源的时长标成墙钟，且缺 apiMs 时退化成 totalMs 做分母', () => {
    const line = formatEventLine({
      seq: 4,
      at,
      type: 'usage',
      tokens: { input: 0, cached: 0, output: 90 },
      timing: { totalMs: 30_000, apiMs: null, ttftMs: null, source: 'events' },
      turns: 1,
    });

    expect(line).toContain('生成 3.0 tok/s');
    // 来源那一截是独立的一个片段（` · ` 分隔），所以断言它整段出现——口径说明一个字都不能少
    expect(line).toContain('· （按事件时间戳算（墙钟，含工具执行））');
    // 首字延迟采不到就**整段不出现**（不是「首字 0.0s」——那是编数）
    expect(line).not.toContain('首字');
  });

  /**
   * 分母算不出来时（时长缺失 / 为 0）**不给数**：`0.0 tok/s` 与「未采集」含义相反，
   * 而 `Infinity` / `NaN` 更是本仓明令不许出现在界面上的两种值。
   */
  it('usage：分母为 0（totalMs: 0）或算不出时写「生成速率未采集」，绝不出现 NaN / Infinity', () => {
    const zero = formatEventLine({
      seq: 5,
      at,
      type: 'usage',
      tokens: { input: 1, cached: 1, output: 10 },
      timing: { totalMs: 0, apiMs: null, ttftMs: null, source: 'events' },
      turns: 1,
    });
    expect(zero).toContain('生成速率未采集');
    expect(zero).not.toContain('Infinity');
    expect(zero).not.toContain('NaN');

    // 只有首字延迟、没有总时长：算不出来 ⇒ 未采集（那一格是**半边数据**，不该硬凑）
    const half = formatEventLine({
      seq: 6,
      at,
      type: 'usage',
      tokens: { input: 1, cached: 1, output: 10 },
      timing: { totalMs: null, apiMs: null, ttftMs: 5_000, source: 'vendor' },
      turns: 1,
    });
    expect(half).toContain('生成速率未采集');
  });

  /**
   * 两个可选格（思考 token / 厂商自报总量）**有值才显示**：`null` 是「这一家不报」，
   * 显示成 `思考 0` 会让人得出「这家不做推理」——与「0 与没采到含义相反」是同一条口径。
   */
  it('usage：思考 token 与厂商总量有值才显示（null 不出现）', () => {
    const withExtras = formatEventLine({
      seq: 7,
      at,
      type: 'usage',
      tokens: { input: 10, cached: 0, output: 20, reasoningOutput: 30, total: 1050 },
      turns: 1,
    });
    expect(withExtras).toContain('思考 30');
    expect(withExtras).toContain('厂商总量 1050');

    const withoutExtras = formatEventLine({
      seq: 8,
      at,
      type: 'usage',
      tokens: { input: 10, cached: 0, output: 20, reasoningOutput: null, total: null },
      turns: 1,
    });
    expect(withoutExtras).not.toContain('思考');
    expect(withoutExtras).not.toContain('厂商总量');
  });

  // 只带轮次的 usage 是常态（2026-09-28）：说轮次就好，**不写三个 0**（那会让人以为「这家很省」）。
  it('usage：只带轮次（tokens 为 null）时只渲染轮次与时间那一截', () => {
    expect(formatEventLine({ seq: 3, at, type: 'usage', tokens: null, turns: 7 })).toBe(
      `[${expectedClock(at)}] 轮次 7 · 耗时未采集`,
    );
  });

  it('diff-summary：计数 + 截断标记', () => {
    expect(
      formatEventLine({ seq: 4, at, type: 'diff-summary', filesChanged: 3, insertions: 25, deletions: 7, truncated: false }),
    ).toBe(`[${expectedClock(at)}] 改动 3 个文件 +25 −7`);
    expect(
      formatEventLine({ seq: 5, at, type: 'diff-summary', filesChanged: 3, insertions: 25, deletions: 7, truncated: true }),
    ).toBe(`[${expectedClock(at)}] 改动 3 个文件 +25 −7（已截断）`);
  });

  it('score / error / end 各一行', () => {
    expect(formatEventLine({ seq: 6, at, type: 'score', score: scoreFixture() })).toBe(
      `[${expectedClock(at)}] 评分 总分 87 · claude-opus-4-6`,
    );
    expect(formatEventLine({ seq: 7, at, type: 'error', message: 'spawn claude ENOENT' })).toBe(
      `[${expectedClock(at)}] 错误 spawn claude ENOENT`,
    );
    expect(formatEventLine({ seq: 8, at, type: 'end', exitReason: 'timed-out' })).toBe(`[${expectedClock(at)}] 结束 timed-out`);
  });

  it('评分事件行在智能体评分时带上智能体名，两次评分才区分得开', () => {
    const line = formatEventLine({
      seq: 1,
      at,
      type: 'score',
      score: scoreFixture({ judgeAgentKind: 'claude-code' }),
    });

    expect(line).toContain('Claude Code');
    // 整行形状一并钉死：智能体名 +「（智能体）」+ 模型名，少任何一项都答不了「谁打的这一分」
    expect(line).toBe(`[${expectedClock(at)}] 评分 总分 87 · Claude Code（智能体）· claude-opus-4-6`);
  });

  it('时间戳非法时原样保留，不显示 Invalid Date', () => {
    expect(formatEventLine({ seq: 9, at: '不是时间', type: 'end', exitReason: 'error' })).toBe('[不是时间] 结束 error');
  });

  it('7 种类型全部有非空文本（没有任何一种被静默丢掉）', () => {
    // 每条的 `seq` 不同，但这里只关心「有没有一行文本」，故用最小载荷
    const lines = [
      formatEventLine({ seq: 1, at, type: 'status', status: 'running' }),
      formatEventLine({ seq: 2, at, type: 'log', stream: 'stdout', text: '' }),
      formatEventLine({ seq: 3, at, type: 'usage', tokens: { input: 0, cached: 0, output: 0 }, turns: 0 }),
      formatEventLine({ seq: 4, at, type: 'diff-summary', filesChanged: 0, insertions: 0, deletions: 0, truncated: false }),
      formatEventLine({ seq: 5, at, type: 'score', score: scoreFixture({ totalScore: 0, verdict: '', raw: '', judgeModelId: 'm' }) }),
      formatEventLine({ seq: 6, at, type: 'error', message: '' }),
      formatEventLine({ seq: 7, at, type: 'end', exitReason: 'completed' }),
    ];

    expect(lines).toHaveLength(7);
    // 每条都以 `[时间] ` 开头：少了这个前缀就是「有时间戳没内容」或「没时间戳」的形状
    for (const line of lines) expect(line.startsWith(`[${expectedClock(at)}] `)).toBe(true);
    // 真正的 0 照常显示 0，不是「未采集」（与 null ≠ 0 同一条口径）
    expect(lines[2]).toContain('输入 0 · 缓存 0 · 命中 0% · 输出 0 · 轮次 0');
  });
});

describe('formatEventLog', () => {
  it('按行拼接，空数组得到空串', () => {
    expect(formatEventLog([])).toBe('');
    expect(formatEventLog([{ seq: 1, at, type: 'end', exitReason: 'completed' }])).toBe(
      `[${expectedClock(at)}] 结束 completed`,
    );
  });

  it('多事件按 seq 升序各占一行（下载内容与抽屉正文共用这个出口）', () => {
    const text = formatEventLog([
      { seq: 1, at, type: 'status', status: 'running' },
      { seq: 2, at, type: 'log', stream: 'stdout', text: '改文件' },
    ]);

    expect(text.split('\n')).toEqual([
      `[${expectedClock(at)}] 状态 执行中`,
      `[${expectedClock(at)}] stdout 改文件`,
    ]);
  });
});
