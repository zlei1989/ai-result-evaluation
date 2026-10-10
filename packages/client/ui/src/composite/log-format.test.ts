/**
 * 事件 → 日志行（纯函数）。
 * 八种事件类型都要有一行可读文本：**任何一种被静默丢掉，排障时就少一条证据**
 * （未识别的事件必须投影成保留原始负载的日志事件，不得静默丢弃）。
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
import type { AgentEvent, ScoreResult } from '@aieval/contracts';
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
    // 强度未指定（一个强度键都没发）；要造「带档位的那一份」就在用例里覆盖它
    judgeEffort: null,
    // false ⇔ 这一分只靠提示词契约拿到；要造「被 schema 约束的那一份」就在用例里覆盖它
    structuredOutput: false,
    // 评分自己的花销：日志行不展示这两格，夹具给 null 即可
    judgeTokens: null,
    judgeDurationMs: null,
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

  it('usage：三项用量（千分位 + `tok`）、命中率与轮次（`timing` 缺 ⇒ 明说「耗时未采集」，不写 0s）', () => {
    expect(
      formatEventLine({ seq: 3, at, type: 'usage', tokens: { input: 1000, cached: 200, output: 500 }, turns: 3 }),
    ).toBe(`[${expectedClock(at)}] 用量 输入 1,000 tok · 缓存 200 tok · 命中 17% · 输出 500 tok · 轮次 3 · 耗时未采集`);
  });

  /**
   * `vendor-system`：厂商系统层事实也必须**有一行可读文本**。
   *
   * 为什么它不是「多一条噪声」：台账与抽屉正文是排障的第一现场，而这一格回答的是
   * 「这一次被下发了哪些工具 / 什么权限档」——不落成一行，这份事实在日志里就只剩那条
   * 原始 JSON（而认 JSON 正是本仓明令不许让使用者做的事）。
   *
   * 三条口径：① 计数写「N 项」而不是把 21 个工具名铺开（抽屉正文一屏只有几十行）；
   * ② 缺的格**整段不出现**（不写「斜杠命令 0 项」——那与「没投送」含义相反）；
   * ③ 全空时如实写「未采集」，不留一行光秃秃的前缀。
   */
  it('vendor-system：六格按「N 项 / 原值」写一行，缺的格整段不出现', () => {
    expect(
      formatEventLine({
        seq: 2,
        at,
        type: 'vendor-system',
        tools: ['Task', 'Bash', 'Read', 'Write'],
        slashCommands: ['design', 'verify'],
        agents: ['claude', 'Explore'],
        mcpServers: [],
        permissionMode: 'bypassPermissions',
        outputStyle: 'default',
      }),
    ).toBe(
      `[${expectedClock(at)}] 系统层 工具 4 项 · 斜杠命令 2 项 · 子智能体定义 2 项 · MCP 0 项`
      + ' · 权限档 bypassPermissions · 输出风格 default',
    );
  });

  it('vendor-system：采不到的格不写「0 项」；六格全空时写「未采集」', () => {
    const partial = formatEventLine({
      seq: 2,
      at,
      type: 'vendor-system',
      tools: ['Read'],
      slashCommands: null,
      agents: null,
      mcpServers: null,
      permissionMode: null,
      outputStyle: null,
    });
    expect(partial).toBe(`[${expectedClock(at)}] 系统层 工具 1 项`);
    expect(partial).not.toContain('斜杠命令');

    const empty = formatEventLine({
      seq: 2,
      at,
      type: 'vendor-system',
      tools: null,
      slashCommands: null,
      agents: null,
      mcpServers: null,
      permissionMode: null,
      outputStyle: null,
    });
    expect(empty).toBe(`[${expectedClock(at)}] 系统层 未采集`);
  });

  /**
   * `mcpServers` 那一格是**对象数组**（`{name, status, source}`），
   * 而历史 `events.jsonl` 里是字符串数组——**两种形态都必须渲染出同一句话**。
   *
   * 判据是「**归一到几台服务**」，不是「数组有几个槽位」：这一格只按台数写「MCP N 项」，
   * 只要归一那一支把字符串项丢掉，老事件就会渲染成「MCP 0 项」——那正是本仓反复强调的那句假话
   * （`[]` 是「投送了，确实是空的」，而厂商当时真的下发了那几台）；
   * 反过来，把认不出的项（数字）或「根本不是数组」的脏值也数成服务，同样是编出来的台数。
   */
  it('vendor-system：MCP 台数按「归一到几台服务」计——对象 / 历史字符串 / 脏数据三种形态各自如实', () => {
    // 用 `as unknown as AgentEvent`：`normalizeMcpServers` 的入参是 `unknown`，而这一格
    // 真实存在多种输入（`/log` 是 `getJson<AgentEvent[]>`，**没有运行时校验**，抓回来的
    // 可能正是历史形状）——用类型系统把它们挡住，这条守卫就测不到了。
    const line = (mcpServers: unknown): string =>
      formatEventLine({
        seq: 2,
        at,
        type: 'vendor-system',
        tools: null,
        slashCommands: null,
        agents: null,
        mcpServers,
        permissionMode: null,
        outputStyle: null,
      } as unknown as AgentEvent);

    const realShape = [
      { name: 'context7', status: 'pending', source: 'project' },
      { name: 'find', status: 'connected', source: 'project' },
    ];
    expect(line(realShape)).toBe(`[${expectedClock(at)}] 系统层 MCP 2 项`);
    // 历史形态（早期落盘的就是它）：照样 2 项，绝不是「MCP 0 项」
    expect(line(['context7', 'find'])).toBe(`[${expectedClock(at)}] 系统层 MCP 2 项`);
    // 认不出的项不是一台服务；「整格不是数组」是「没投送」，不是「8 个字符 = 8 台」
    expect(line([42, 'find'])).toBe(`[${expectedClock(at)}] 系统层 MCP 1 项`);
    expect(line('context7')).toBe(`[${expectedClock(at)}] 系统层 未采集`);
    // `null` 是「没投送」：整段不出现（不写「0 项」）；`[]` 才是「投送了确实是空的」
    expect(line(null)).toBe(`[${expectedClock(at)}] 系统层 未采集`);
    expect(line([])).toBe(`[${expectedClock(at)}] 系统层 MCP 0 项`);
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
      `[${expectedClock(at)}] 用量 输入 100 tok · 缓存 900 tok · 命中 90% · 输出 200 tok · 轮次 2`
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
    expect(withExtras).toContain('思考 30 tok');
    expect(withExtras).toContain('厂商总量 1,050 tok');

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

  // 只带轮次的 usage 是常态：说轮次就好，**不写三个 0**（那会让人以为「这家很省」）。
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

  it('本表列出的类型全部有非空文本（没有任何一种被静默丢掉）', () => {
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
    // 真正的 0 照常显示 0，不是「未采集」（与 null ≠ 0 同一条口径）；单位不因 0 而省掉
    expect(lines[2]).toContain('输入 0 tok · 缓存 0 tok · 命中 0% · 输出 0 tok · 轮次 0');
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
