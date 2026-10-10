// @vitest-environment node
/**
 * 真机冒烟：对**指定的一家**跑一次真实评测，四格断言（判据源见 `../conformance/kit.ts` 的同名方案）。
 *
 * 为什么必须存在这一层：一致性套件验的是**归一产物**，装载与传输两类缺陷在它那里原理上不可见——
 * codex 的 app-server 改造就是实例：单测 585 条全绿，真机上连挂「打包器把 createRequire 换掉」与
 * 「凭据/provider 没传到厂商进程」两类。**只有真跑一次才拦得住它们。**
 *
 * 开关（默认跳过，避免进内循环与 CI）：
 * ```
 * AIEVAL_LIVE_SMOKE=1 \
 * AIEVAL_LIVE_KIND=codex \
 * AIEVAL_LIVE_PROVIDER_ID=<provider uuid> \
 * AIEVAL_LIVE_MODEL_ID=<model id> \
 * [AIEVAL_LIVE_CASE_ID=<case uuid>] [AIEVAL_LIVE_BASE=http://localhost:3083] \
 * [AIEVAL_LIVE_TIMEOUT_MS=600000] \
 * pnpm vitest run packages/server/agents/src/providers/live-smoke.test.ts
 * ```
 *
 * 四格（每格一条用例，红在哪一格就指向哪一类）：
 *   ① 装载：行没有落到「厂商入口解析/加载」类失败（打包器改写、包形态、平台包布局都算这一类）；
 *   ② 传输：本次运行实际使用的 `providerId` / `baseUrl` / `modelId` 与服务端记录一致，
 *      且失败不是凭据类（401/403）——**这一格是「密钥与服务端选择真的传到了」的最小可判定事实**；
 *   ③ 产物：行跑到 `judged` 且有分数；
 *   ④ 形状：`messages` 接口返回的消息**逐个过契约 schema**（线上形态）。
 */
import { AgentMessageSchema, SubagentRecordSchema } from '@aieval/contracts';
import { beforeAll, describe, expect, it } from 'vitest';

const ENABLED = process.env.AIEVAL_LIVE_SMOKE === '1';
const BASE = process.env.AIEVAL_LIVE_BASE ?? 'http://localhost:3083';
const KIND = process.env.AIEVAL_LIVE_KIND ?? '';
const PROVIDER_ID = process.env.AIEVAL_LIVE_PROVIDER_ID ?? '';
const MODEL_ID = process.env.AIEVAL_LIVE_MODEL_ID ?? '';
const CASE_ID = process.env.AIEVAL_LIVE_CASE_ID ?? '';
/**
 * 用**智能体评分**跑这一轮（`AIEVAL_LIVE_AGENT_JUDGE=1`）。
 *
 * 为什么要这一档：确定性评分只读 diff，而「智能体评分」那条通路只读 `AgentRunResult.finalText`
 * ——它是这条产品通路的**唯一入口**（`finalText` 漏写这类缺陷只在这里发作：
 * `providers/codex/*` 全绿、真机上评分永远拿不到答复）。用确定性评分跑，那一格是否写对**看不见**。
 */
const AGENT_JUDGE = process.env.AIEVAL_LIVE_AGENT_JUDGE === '1';
const TIMEOUT_MS = Number(process.env.AIEVAL_LIVE_TIMEOUT_MS ?? '600000');
const POLL_MS = 2_000;

interface RunRow {
  id: string;
  agentKind: string;
  providerId: string;
  baseUrl: string;
  modelId: string;
  status: string;
  score: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

interface RunDetail {
  id: string;
  status: string;
  rows: RunRow[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → HTTP ${response.status}：${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** 终态：行不再变化（与 evaluator 的词表对齐，`judged` 是跑完且已评分） */
const TERMINAL = new Set(['judged', 'failed', 'canceled', 'interrupted']);

async function waitForRun(runId: string): Promise<RunDetail> {
  const deadline = Date.now() + TIMEOUT_MS;
  let detail = await api<RunDetail>(`/api/runs/${runId}`);
  while (!TERMINAL.has(detail.rows[0]?.status ?? 'pending') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    detail = await api<RunDetail>(`/api/runs/${runId}`);
  }
  return detail;
}

describe.skipIf(!ENABLED)(`真机冒烟：${KIND || '（未指定 AIEVAL_LIVE_KIND）'}`, () => {
  let detail: RunDetail;
  let row: RunRow;

  beforeAll(async () => {
    expect(KIND, 'AIEVAL_LIVE_KIND 必填——不给默认家，避免「默认跑的那家绿了就当四家都绿」').not.toBe('');
    expect(PROVIDER_ID, 'AIEVAL_LIVE_PROVIDER_ID 必填').not.toBe('');
    expect(MODEL_ID, 'AIEVAL_LIVE_MODEL_ID 必填').not.toBe('');
    const caseId = CASE_ID !== '' ? CASE_ID : (await api<Array<{ id: string }>>('/api/cases'))[0]?.id;
    expect(caseId, '至少要有一个用例（或用 AIEVAL_LIVE_CASE_ID 指定）').toBeTypeOf('string');

    const created = await api<RunDetail>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        caseId,
        executionMode: 'serial',
        useAgentJudge: AGENT_JUDGE,
        rows: [{ agentKind: KIND, providerId: PROVIDER_ID, modelId: MODEL_ID }],
      }),
    });
    await api(`/api/runs/${created.id}/start`, { method: 'POST', body: '{}' });
    detail = await waitForRun(created.id);
    const first = detail.rows[0];
    expect(first, '这一轮必须有且只有一行').toBeDefined();
    row = first!;
  }, TIMEOUT_MS + 60_000);

  it('① 装载：没有落到「厂商入口解析/加载」类失败', () => {
    const message = `${row.errorCode ?? ''} ${row.errorMessage ?? ''}`;
    // 这一类在实现里统一走 AgentLoadError：包没装、平台包缺 vendor、解析链断在哪一级都会带这些字样
    expect(message, `装载失败：${message}`).not.toMatch(/AGENT_LOAD_FAILED|找不到 .*可执行文件|Cannot find module/i);
  });

  it('② 传输：服务端记录的路由与本次选择一致，且不是凭据类失败', () => {
    expect(row.providerId, '行的 providerId 与本次选择不一致——说明行没拿到我们给的那条路由').toBe(PROVIDER_ID);
    expect(row.modelId, '行的 modelId 与本次选择不一致').toBe(MODEL_ID);
    expect(row.baseUrl, '行的 baseUrl 为空——凭据/网关地址没有随行落下去').toBeTruthy();
    expect(`${row.errorCode ?? ''} ${row.errorMessage ?? ''}`).not.toMatch(/AUTH_FAILED|401|403|Unauthorized/i);
  });

  it('③ 产物：跑完并拿到分数', () => {
    expect(row.status, `行没跑完（${row.status}）：${row.errorMessage ?? ''}`).toBe('judged');
    expect(row.score, '跑完了但没有分数').not.toBeNull();
  });

  it('④ 形状：消息与子任务行逐个过契约 schema', async () => {
    // 该端点的信封是 `{ messages, subagents }`（不是 `RowRecord[]`）——首次跑冒烟时
    // 按后者写、红在这一格，说明这一格确实在按**线上真实返回**判，而不是按实现者的记忆判。
    const payload = await api<{ messages: unknown[]; subagents: unknown[] }>(
      `/api/runs/${detail.id}/rows/${row.id}/messages`,
    );
    expect(payload.messages.length, '一次真实运行不该一条消息都没有').toBeGreaterThan(0);
    for (const message of payload.messages) {
      const parsed = AgentMessageSchema.safeParse(message);
      expect(parsed.success, `消息不合规：${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
    }
    for (const subagent of payload.subagents) {
      const parsed = SubagentRecordSchema.safeParse(subagent);
      expect(parsed.success, `子任务行不合规：${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
    }
  });

  /**
   * ⑤ 只有 `AIEVAL_LIVE_AGENT_JUDGE=1` 时有意义：**评分智能体真的拿到了答复**。
   *
   * 这一格钉的是 `AgentRunResult.finalText` 这条通路——它不落事件、也不出内容块，只在运行结果里，
   * 而「智能体评分」是它唯一的消费方。漏写它时：本包的 provider 用例全绿（消息与子任务都对），
   * 真机上评分却恒失败（`JUDGE_PARSE_FAILED`）。**确定性评分档看不见这一格**，所以必须单开一档真跑。
   */
  it.skipIf(!AGENT_JUDGE)('⑤ 智能体评分拿到了答复并给出结论（finalText 通路的真机判据）', () => {
    const message = `${row.errorCode ?? ''} ${row.errorMessage ?? ''}`;
    expect(message, `评分阶段失败：${message}`).not.toMatch(/JUDGE_|PARSE_FAILED/i);
    expect(row.score, '智能体评分档下必须落一份评分').not.toBeNull();
    expect(row.score?.judgeProviderId, '评分记录里没有 judgeProviderId——说明评分不是由智能体给出的').toBeTruthy();
    const verdict = row.score?.verdict;
    expect(typeof verdict === 'string' && verdict.length > 0, '评分结论为空——评分智能体没拿到答复').toBe(true);
  });

  /**
   * ⑥ 结构化输出通路（评分者按 schema 作答）。
   *
   * 为什么单列一格：评分通路只读 `AgentRunResult.finalText` 并要求它是**可解析的 JSON**。
   * 「结构化输出」把这一步从「靠模型自觉吐 JSON」变成「厂商保证形状」，而**两条通路都必须能 parse**
   * ——不支持结构化（或重试用尽）时必须走文本提取的降级路径，不能让那一家永远评不了分。
   *
   * 判据分三段，且**不假设一定走结构化**（实测本环境那一轮 `structuredOutput` 为 `false`：
   * 走的是文本降级，`raw` 仍是可解析 JSON ⇒ 断言必须对两条通路都成立）：
   *   1. 评分记录里 `structuredOutput` **必须是 boolean**（不是缺席/undefined）——界面「输出约束」
   *      那一格与排障都靠它回答「这一轮到底有没有按 schema 作答」；
   *   2. `raw` 必须是**可解析 JSON**，且解析出 `judgments` 与 `verdict`（这是 `finalizeScore` 的输入形态）；
   *   3. 不得出现解析失败码——**解析失败必须可见**，不许静默落成空评分。
   */
  it.skipIf(!AGENT_JUDGE)('⑥ 评分者的产出可解析，且记录里带「输出约束」那一格（结构化与文本降级两条通路都要过）', () => {
    expect(row.score, '智能体评分档下必须落一份评分').not.toBeNull();
    expect(typeof row.score?.structuredOutput, '评分记录缺少 `structuredOutput` 这一格（无法回答「有没有按 schema 作答」）').toBe(
      'boolean',
    );
    const raw = row.score?.raw;
    expect(typeof raw === 'string' && raw.length > 0, '评分记录里没有 `raw` 原文').toBe(true);
    const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
    expect(Array.isArray(parsed.judgments), '`raw` 解析出来没有 `judgments`').toBe(true);
    expect(String(parsed.verdict ?? ''), '`raw` 解析出来没有 `verdict`').not.toBe('');
    expect(`${row.errorCode ?? ''} ${row.errorMessage ?? ''}`, '出现解析失败码').not.toMatch(/PARSE_FAILED/i);
  });
});
