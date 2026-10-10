/**
 * 「dsh 派生面板的 `subagent/descriptor` —— 只见到事件名，未解析」这一格。
 *
 * 上一轮（probe/v4/dsh-subagent-failure.mjs，单前台子任务）已经拿到它的**载荷**：
 * `{"version":3,"mode":"one-shot","provider":"spawn","label":"Long essay"}`——
 * 里面**没有任何身份字段**。本轮要回答的是它到底**属于谁**：
 * 是"每次运行一条"的会话级描述符，还是"每个子任务一条"？
 *
 * 判据：一次运行里派**两个**子任务（一前台、一后台），数 `subagent/catalog` 与
 * `subagent/descriptor` 的条数，并把每条的**信封 `params.sessionId`** 逐字抄下来
 * （信封才是身份来源——`data` 里没有 childId）。
 * 顺带记录 `subagent/catalog.mode` 的**取值域**（上一轮见过 `one-shot` 与 `continuable` 两种）。
 *
 * 用法：node probe/v4/dsh-subagent-descriptor.mjs
 */
import { note, writeDump } from './lib/env.mjs';
import { runDshTurn } from './lib/dsh-harness.mjs';

const PROMPT = [
  '严格按顺序执行，不要跳过：',
  '1. 调用 subagent 工具（run_in_background = false）：',
  '   description = "Child one"',
  '   prompt = "只回复一个词：one"',
  '2. 调用 subagent 工具（run_in_background = true）：',
  '   description = "Child two"',
  '   prompt = "用 pwsh 执行 3 次 `Start-Sleep -Seconds 2; Write-Output tick`，然后只回复一个词：two"',
  '3. 等第 2 个子任务收场后（可用 job_output 或 list_agents 查看），只回复一个词：done',
].join('\n');

const run = await runDshTurn({
  label: 'subagent-descriptor',
  protocolType: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-chat',
  prompt: PROMPT,
  timeoutMs: 420_000,
  settleMs: 45_000,
});

/** 把 `subagent/catalog` 与 `subagent/descriptor` 连同**信封**一起抄下来。 */
const rows = [];
for (const one of run.notifications) {
  const type = one?.params?.event?.type;
  if (type === 'subagent/catalog' || type === 'subagent/descriptor') {
    rows.push({
      type,
      // 信封身份：这才是"这条是谁的"
      envelopeSessionId: one?.params?.sessionId ?? null,
      data: one?.params?.event?.data ?? null,
    });
  }
  if (typeof one?.method === 'string' && one.method.startsWith('subagent')) {
    rows.push({ type: one.method, envelopeSessionId: null, data: one.params });
  }
}

const catalogs = rows.filter((one) => one.type === 'subagent/catalog');
const descriptors = rows.filter((one) => one.type === 'subagent/descriptor');
const finished = rows.filter((one) => one.type === 'subagent.finished');

note('catalog 条数：', catalogs.length, JSON.stringify(catalogs));
note('descriptor 条数：', descriptors.length, JSON.stringify(descriptors));
note('finished 条数：', finished.length, JSON.stringify(finished.map((one) => one.data)));

const verdict = {
  catalogPerChild: `${catalogs.length} 条 catalog / 2 个子任务；它们的 childId = ${JSON.stringify(catalogs.map((one) => one.data?.childId))}`,
  descriptorPerChild: `${descriptors.length} 条 descriptor；信封 sessionId = ${JSON.stringify(descriptors.map((one) => one.envelopeSessionId))}`,
  modeValues: [...new Set(catalogs.map((one) => one.data?.mode))],
  conclusion: descriptors.length === catalogs.length
    ? 'descriptor 是**每个子会话一条**（与 catalog 同数），身份只在信封 `params.sessionId` 上——`data` 里没有 childId'
    : `descriptor 与 catalog **不同数**（${descriptors.length} vs ${catalogs.length}）⇒ 它不是逐子任务的，适配器不得把它当身份来源`,
};
note('判定：', JSON.stringify(verdict));

const file = writeDump('v4/dsh-subagent-descriptor', {
  at: new Date().toISOString(),
  prompt: PROMPT,
  runError: run.error,
  finalResponse: run.result?.finalResponse ?? null,
  distribution: run.summary,
  rows,
  verdict,
  dumpFile: run.dumpFile,
});
note('落盘：', file);
