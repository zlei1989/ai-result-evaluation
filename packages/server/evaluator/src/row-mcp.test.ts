// @vitest-environment node
/**
 * 行级 **MCP 观测格**的推导。
 *
 * 这一格的全部价值在「**判据不许是模型答复**」这一条上：真机抓到过「MCP 派发失败、模型却把
 * 预期结果编出来」。所以每一条结论都必须能指回厂商事件侧的证据，而下面这些用例就是四档结论的
 * 判据表本身：
 *   · 工具表里有 `mcp__<name>__*` ⇒ `connected`（比厂商自报的 `status` **更硬**，故优先）；
 *   · `status: 'failed'` ⇒ `unavailable`；其余有状态（`pending` / `needs-auth`）⇒ `unverified`；
 *   · 厂商压根没报这一台 ⇒ `unverified` + `judgedBy: 'none'`（**既不写成已连上、也不写成没有**）；
 *   · 我们因 `${ENV}` 未设置而跳过 ⇒ `skipped`（厂商事件里根本没有它，这一档只能由我们写）。
 *
 * 还有两条边界各有一条守卫：**前缀必须精确匹配**（`mcp__playwright-extra__x` 不能给 `playwright`
 * 记账），以及**仓库自带那几台也在格里**（`source: 'project'`，它们不受压制）。
 */
import { describe, expect, it } from 'vitest';
import { deriveRowMcpServers, mcpUnavailableMessage, type RowMcpEvidence } from './row-mcp';

/** 一份最简证据：注入了 playwright、跳过了 context7、厂商报了 playwright 与一台仓库自带的 find */
function evidence(overrides: Partial<RowMcpEvidence> = {}): RowMcpEvidence {
  return {
    injected: ['playwright'],
    skipped: [],
    invalid: [],
    vendor: {
      servers: [{ name: 'playwright', status: 'connected', source: 'dynamic', error: null }],
      tools: ['Read', 'mcp__playwright__browser_navigate'],
    },
    ...overrides,
  };
}

describe('deriveRowMcpServers', () => {
  it('工具表里有 mcp__<name>__ ⇒ connected，判据记「厂商工具表」且比 status 更硬', () => {
    const [playwright] = deriveRowMcpServers(evidence());

    expect(playwright).toEqual({
      name: 'playwright',
      // 来源**采信厂商原值**（不翻成我们的词表）：`dynamic` = 本仓程序化注入
      source: 'dynamic',
      judgedBy: 'vendor-tool-table',
      verdict: 'connected',
    });
    // 工具表与 status 打架时以工具表为准（`pending` 但工具已在表里 = 确实连上了）
    const [pendingButLive] = deriveRowMcpServers(
      evidence({ vendor: { servers: [{ name: 'playwright', status: 'pending', source: 'dynamic', error: null }], tools: ['mcp__playwright__x'] } }),
    );
    expect(pendingButLive?.verdict).toBe('connected');
  });

  it('status 三档各自成像：failed ⇒ unavailable、pending ⇒ unverified、没有这一台 ⇒ unverified/none', () => {
    const of = (servers: RowMcpEvidence['vendor']): ReturnType<typeof deriveRowMcpServers> =>
      deriveRowMcpServers(evidence({ vendor: servers }));

    expect(of({ servers: [{ name: 'playwright', status: 'failed', source: 'dynamic', error: null }], tools: [] })[0]).toMatchObject({
      verdict: 'unavailable',
      judgedBy: 'vendor-status',
    });
    expect(of({ servers: [{ name: 'playwright', status: 'pending', source: 'dynamic', error: null }], tools: [] })[0]).toMatchObject({
      verdict: 'unverified',
      judgedBy: 'vendor-status',
    });
    // 厂商没报这一台（投送了、但它没说）：**不写成「没有」也不写成「已连上」**
    expect(of({ servers: [], tools: [] })[0]).toMatchObject({ verdict: 'unverified', judgedBy: 'none' });
    // 整条厂商事件都没来（codex / dsh 今天如此）：同上，且来源如实记 unknown
    expect(of(null)[0]).toEqual({ name: 'playwright', source: 'unknown', judgedBy: 'none', verdict: 'unverified' });
  });

  it('我们跳过的那台记 skipped（厂商事件里没有它，这一档只能由我们写）', () => {
    // 厂商这一侧什么都没有（跳过的那台压根没到它那儿）：格里只剩我们自己的交代
    const rows = deriveRowMcpServers(evidence({ injected: [], skipped: ['context7'], vendor: { servers: [], tools: [] } }));

    expect(rows).toEqual([{ name: 'context7', source: 'unknown', judgedBy: 'none', verdict: 'skipped' }]);
  });

  /**
   * **形状不对的那几条**：它们连解析都没进，自然没到厂商那儿。
   *
   * 结论必须是 `unverified` 而**不是** `unavailable`：后者会让整行失败（`mcpUnavailableMessage`
   * 只挑 `unavailable`），而「配置里有个手改坏的条目」是我方配置问题，处置是回设置页改它，
   * 不是把这一行判成「装不上」——那句话在界面上会被读成厂商侧的问题。
   */
  it('形状不对的那几台记 unverified（不是失败）：条目没投送，厂商侧一个字都没有', () => {
    const rows = deriveRowMcpServers(
      evidence({
        injected: [],
        skipped: [],
        invalid: ['broken', 'no-transport'],
        vendor: { servers: [], tools: [] },
      }),
    );

    expect(rows).toEqual([
      { name: 'broken', source: 'unknown', judgedBy: 'none', verdict: 'unverified' },
      { name: 'no-transport', source: 'unknown', judgedBy: 'none', verdict: 'unverified' },
    ]);
    // 「形状不对」不许升级成行失败：失败文案只认 `unavailable`
    expect(mcpUnavailableMessage(evidence({ injected: [], skipped: [], invalid: ['broken'], vendor: null }))).toBeNull();
  });

  it('三份名单去重口径一致：同名同时出现在注入集与 invalid 时，以「真的投送了」为准', () => {
    const rows = deriveRowMcpServers(
      evidence({ injected: ['playwright'], skipped: ['context7'], invalid: ['playwright', 'context7'] }),
    );

    expect(rows.map((row) => [row.name, row.verdict])).toEqual([
      ['playwright', 'connected'],
      ['context7', 'skipped'],
    ]);
  });

  it('仓库自带那几台也在格里（source 采信厂商原值 project），排在我们注入的后面', () => {
    const rows = deriveRowMcpServers(
      evidence({
        vendor: {
          servers: [
            { name: 'playwright', status: 'connected', source: 'dynamic', error: null },
            { name: 'find', status: 'connected', source: 'project', error: null },
          ],
          tools: ['mcp__playwright__x', 'mcp__find__getLibComponentDocs'],
        },
      }),
    );

    expect(rows.map((row) => [row.name, row.source, row.verdict])).toEqual([
      ['playwright', 'dynamic', 'connected'],
      ['find', 'project', 'connected'],
    ]);
  });

  it('前缀必须精确到 `mcp__<name>__`：相似名字不算证据', () => {
    const rows = deriveRowMcpServers(
      evidence({
        injected: ['play'],
        vendor: { servers: [{ name: 'play', status: 'pending', source: 'dynamic', error: null }], tools: ['mcp__playwright__x', 'mcp__play-extra__x'] },
      }),
    );

    // 两条相似前缀都不该给 `play` 记账（否则「隔壁那台连上了」会被读成「这一台连上了」）
    expect(rows[0]).toMatchObject({ verdict: 'unverified', judgedBy: 'vendor-status' });
  });

  it('厂商没报名字的那一条不进行级格（这一格的主键是名字），名字为空串的注入项也不重复出现', () => {
    const rows = deriveRowMcpServers(
      evidence({
        injected: [],
        vendor: { servers: [{ name: null, status: 'connected', source: 'project', error: null }], tools: ['mcp____x'] },
      }),
    );

    expect(rows).toEqual([]);
  });

  it('什么都没观测到 ⇒ 空数组（`[]` = 观测了、确实一台都没有，与「没观测」不是一回事）', () => {
    expect(deriveRowMcpServers({ injected: [], skipped: [], invalid: [], vendor: null })).toEqual([]);
    expect(deriveRowMcpServers({ injected: [], skipped: [], invalid: [], vendor: { servers: [], tools: [] } })).toEqual([]);
  });

  it('我们跳过、厂商却报着同名的一台 ⇒ 认我们的动作（`skipped`），同一条不重复出现', () => {
    // 这一格回答的是「**我们的注入**落地了没有」；仓库自带那条同名服务仍在环境抽屉里逐字可见
    const rows = deriveRowMcpServers(
      evidence({
        injected: [],
        skipped: ['playwright'],
        invalid: [],
        vendor: {
          servers: [{ name: 'playwright', status: 'connected', source: 'project', error: null }],
          tools: ['mcp__playwright__x'],
        },
      }),
    );

    expect(rows).toEqual([{ name: 'playwright', source: 'unknown', judgedBy: 'none', verdict: 'skipped' }]);
  });
});

/**
 * **三家各自的判据通道**：同一份推导，按 `channel` 分三种读法。
 *
 * 为什么必须由证据自报通道、而不能按厂商名硬编码：**同一个形状在不同通道上读法相反**——
 * 「工具表里没有这一台」在 claude / codex 上是「判据不足」（不判失败），在 dsh 上**就是失败**
 * （它起不来时工具静默消失、会话照常跑完、没有结构化错误，这是唯一判据）。
 */
describe('deriveRowMcpServers：三家判据通道', () => {
  const probe = { name: 'probe', status: 'ready', source: null, error: null };

  it('codex（`vendor-startup-status`）：`ready` ⇒ connected、`starting` ⇒ unverified、`failed` ⇒ unavailable', () => {
    const of = (status: string, error: string | null = null): ReturnType<typeof deriveRowMcpServers> =>
      deriveRowMcpServers({
        injected: ['probe'],
        skipped: [],
        invalid: [],
        vendor: { servers: [{ ...probe, status, error }], tools: null, channel: 'vendor-startup-status' },
      });

    // `ready` = 装上了（启动状态这一档的硬判据）；「调得动吗」是另一回事（上游缺口）
    expect(of('ready')[0]).toEqual({
      name: 'probe',
      source: 'unknown',
      judgedBy: 'vendor-startup-status',
      verdict: 'connected',
    });
    // `starting` = 还在起：既不写已连上，也不写没有
    expect(of('starting')[0]).toMatchObject({ verdict: 'unverified', judgedBy: 'vendor-startup-status' });
    // `failed` + 厂商原文：结论是 unavailable，原文由 `mcpUnavailableMessage` 取
    expect(of('failed', 'MCP client for `probe` failed to start: No such file or directory (os error 2)')[0]).toMatchObject({
      verdict: 'unavailable',
      judgedBy: 'vendor-startup-status',
    });
    // 厂商压根没报这一台 ⇒ 判据不足（**不判失败**：拿不到工具表就证不了「它没起来」）
    expect(
      deriveRowMcpServers({
        injected: ['probe'],
        skipped: [],
        invalid: [],
        vendor: { servers: [], tools: null, channel: 'vendor-startup-status' },
      })[0],
    ).toMatchObject({ verdict: 'unverified', judgedBy: 'none' });
  });

  it('dsh（`vendor-tool-table`）：工具表在、里面没有它 ⇒ **unavailable**（这一家的唯一判据）', () => {
    const of = (tools: string[] | null): ReturnType<typeof deriveRowMcpServers> =>
      deriveRowMcpServers({ injected: ['probe'], skipped: [], invalid: [], vendor: { servers: null, tools, channel: 'vendor-tool-table' } });

    expect(of(['bash', 'mcp__probe__probe_echo'])[0]).toEqual({
      name: 'probe',
      source: 'unknown',
      judgedBy: 'vendor-tool-table',
      verdict: 'connected',
    });
    // 表在、没有它的工具 = 这一台**没起来**（dsh 的失败是静默的，只能从工具面读出来）
    expect(of(['bash', 'edit'])[0]).toEqual({
      name: 'probe',
      source: 'unknown',
      judgedBy: 'vendor-tool-table',
      verdict: 'unavailable',
    });
    // 表**没投送**（读不动 / 这一行压根没有 request/header）⇒ 没有证据 ⇒ 不判失败
    expect(of(null)[0]).toMatchObject({ verdict: 'unverified', judgedBy: 'none' });
  });

  it('claude 那条通道缺省即 `vendor-status`（缺格 = 老事件）', () => {
    const legacy = deriveRowMcpServers({
      injected: ['playwright'],
      skipped: [],
      invalid: [],
      vendor: { servers: [{ name: 'playwright', status: 'failed', source: 'dynamic', error: null }], tools: [] },
    });

    expect(legacy[0]).toMatchObject({ verdict: 'unavailable', judgedBy: 'vendor-status' });
  });
});

/**
 * 失败文案的**唯一来源**（模板）：`MCP「<name>」未能启动：<厂商原文首行>`。
 *
 * 为什么它必须与结论推导同处一份实现：编排层据它落行失败、界面据它显示那一行字，两处各写一遍
 * 必然漂移（漂移的表现是「快照里说 probe 没起来、卡片上说 context7」）。
 * 厂商原文**照抄**（FAQ 按报错原文索引）——只有首行，多行原文会把界面那一格撑成一段。
 */
describe('mcpUnavailableMessage（行失败文案）', () => {
  it('模板逐字；厂商原文取**首行**（多行原文只留第一行）', () => {
    const message = mcpUnavailableMessage({
      injected: ['probe'],
      skipped: [],
      invalid: [],
      vendor: {
        servers: [
          {
            name: 'probe',
            status: 'failed',
            source: null,
            error: 'MCP client for `probe` failed to start: No such file or directory (os error 2)\n第二行是堆栈细节\n第三行也是',
          },
        ],
        tools: null,
        channel: 'vendor-startup-status',
      },
    });

    expect(message).toBe(
      'MCP「probe」未能启动：MCP client for `probe` failed to start: No such file or directory (os error 2)',
    );
  });

  it('多台同时没起来 ⇒ 一段里逐台点名（每台都逐字符合模板），顺序与注入集一致', () => {
    const message = mcpUnavailableMessage({
      injected: ['a', 'b'],
      skipped: [],
      invalid: [],
      vendor: {
        servers: [
          { name: 'a', status: 'failed', source: null, error: 'a 起不来' },
          { name: 'b', status: 'failed', source: null, error: 'b 起不来' },
        ],
        tools: null,
        channel: 'vendor-status',
      },
    });

    expect(message).toBe('MCP「a」未能启动：a 起不来；MCP「b」未能启动：b 起不来');
  });

  it('dsh 没有厂商原文 ⇒ 文案如实说「凭什么这么判」（不许留一个空冒号）', () => {
    const message = mcpUnavailableMessage({
      injected: ['probe'],
      skipped: [],
      invalid: [],
      vendor: { servers: null, tools: ['bash'], channel: 'vendor-tool-table' },
    });

    expect(message).toContain('MCP「probe」未能启动：');
    expect(message).toContain('工具表');
    // 冒号后面必须有字（空尾巴在界面上读起来像被截断了）
    expect(message?.split('：')[1]?.length ?? 0).toBeGreaterThan(0);
  });

  it('一台都没失败 ⇒ `null`（不许为了「总得说点什么」编一条失败文案）', () => {
    expect(
      mcpUnavailableMessage({
        injected: ['probe'],
        skipped: [],
        invalid: [],
        vendor: { servers: [{ name: 'probe', status: 'ready', source: null, error: null }], tools: null, channel: 'vendor-startup-status' },
      }),
    ).toBeNull();
    // 厂商没投送、我们也没跳过 ⇒ 同样什么都不说
    expect(mcpUnavailableMessage({ injected: ['probe'], skipped: [], invalid: [], vendor: null })).toBeNull();
    expect(
      mcpUnavailableMessage({
        injected: ['probe'],
        skipped: ['context7'],
        invalid: [],
        vendor: { servers: [], tools: null, channel: 'vendor-status' },
      }),
    ).toBeNull();
  });
});
