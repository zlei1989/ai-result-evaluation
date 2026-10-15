/**
 * v11 探针 ③（Q3）：**子智能体发起的提问长什么样**，以及**不给批准面时回调会不会被调用**。
 *
 * 两条臂：
 *
 *  | 臂 | 怎么造 | 看什么 |
 *  |---|---|---|
 *  | `subagent` | 先用**入站工具表里真实存在的**那个派子智能体工具（`Agent` / `Task`，按工具表逐字选）起一个子智能体，再让**子会话**发一次提问 | 回调里那两格（`agentID` / `agent_type`）在不在；线级帧里的 `agent_id`；子智能体的提问能不能被答 |
 *  | `no-surface` | 主会话直接提问，但显式声明「没有批准面」（`permissionPrompts: 'none'`） | 回调到底会不会被调用；模型最终拿到什么（原文） |
 *
 * 为什么派子智能体的工具名要从工具表里选：本仓跨 CLI 版本跑（本机 SDK 自带 2.1.281、全局装 2.1.170），
 * 工具改名（`Task` → `Agent`）会让写死的名字变成「探测失败」。工具表是**入站请求体**里的一份原文，
 * 顺手取用比猜版本可靠。
 *
 * 用法：`node packages/server/agents/probe/v11/cc-ask-subagent.mjs [--arm=all|subagent|no-surface] [--mode=default|bypass] [--timeout-ms=60000] [--no-tee]`
 * 产物：`probe/dumps/v11/cc-ask-subagent-*.{jsonl,json}`
 */
import { note, parseFlags, preflightTee, readFrames, reportCallback, resolveClaudeBinary, runQuery, summarizeControlFrames, teeOptions, toolResultsFrom, writeDump, wrap, claudeOptions, makeWorkspace, scriptedEnv, startUpstream, PLACEHOLDER_KEY } from './lib/cc-ask.mjs';

const flags = parseFlags(process.argv.slice(2), {
  arm: 'all',
  mode: 'default',
  'timeout-ms': '60000',
  model: 'claude-sonnet-4-5',
});
const useTee = flags['no-tee'] !== true;

const ASK_INPUT = {
  questions: [
    {
      question: 'Should the sub-agent proceed with the rewrite?',
      header: 'Proceed',
      multiSelect: false,
      options: [
        { label: 'Yes', description: '继续' },
        { label: 'No', description: '停下' },
      ],
    },
  ],
};
const ASK_ANSWERS = { 'Should the sub-agent proceed with the rewrite?': 'Yes' };
const ANSWER_MARKERS = ['Yes'];
const SPAWN_ID = 'toolu_probe_agent_1';
const ASK_ID = 'toolu_probe_ask_child_1';

/** 子智能体那一臂的脚本：工具表里有谁就用谁，两者都没有就如实报「起不来」。 */
function makeSubagentDecide() {
  const state = { spawnTool: null, spawnMissing: false, childSeen: false, askIssued: false };
  const decide = (record, upstreamState) => {
    if (record.toolCount === 0) return { kind: 'text', text: 'ok' };
    const messages = JSON.stringify(record.messages ?? []);
    if (state.spawnTool === null && !state.spawnMissing) {
      state.spawnTool = record.toolNames.find((one) => one === 'Agent' || one === 'Task') ?? null;
      if (state.spawnTool === null) {
        state.spawnMissing = true;
        note(`⚠️ 入站工具表里既没有 Agent 也没有 Task ⇒ 子智能体臂起不来（工具表原文见产物）`);
        return { kind: 'text', text: '没有可用的派子智能体工具' };
      }
      return {
        kind: 'tool',
        id: SPAWN_ID,
        name: state.spawnTool,
        input: { description: '探针子智能体', prompt: '请让子智能体先问一句再动手。', subagent_type: 'general-purpose', run_in_background: false },
      };
    }
    if (state.askIssued && messages.includes(ASK_ID)) return { kind: 'text', text: '收尾（子会话已答）' };
    if (messages.includes(SPAWN_ID) && upstreamState.childSeen === 0) return { kind: 'text', text: '收尾（父会话）' };
    if (!state.askIssued && !messages.includes(SPAWN_ID)) {
      state.askIssued = true;
      return { kind: 'tool', id: ASK_ID, name: 'AskUserQuestion', input: ASK_INPUT };
    }
    return { kind: 'text', text: '收尾' };
  };
  return { decide, state };
}

/** `no-surface` 那一臂：主会话直接提问。 */
function decideForNoSurface(record, state) {
  if (record.toolCount === 0) return { kind: 'text', text: 'ok' };
  if (state.mainSeen === 1) return { kind: 'tool', id: 'toolu_probe_ask_1', name: 'AskUserQuestion', input: ASK_INPUT };
  return { kind: 'text', text: '收尾' };
}

async function runArm({ arm, mode, tee, realBinary, timeoutMs }) {
  const label = `cc-ask-subagent-${arm}`;
  const workspace = makeWorkspace();
  const subagentScript = makeSubagentDecide();
  const upstream = await startUpstream({ decide: arm === 'no-surface' ? decideForNoSurface : subagentScript.decide });
  const calls = [];

  const options = claudeOptions({
    workspace,
    env: scriptedEnv({ upstreamUrl: upstream.url, model: flags.model }),
    model: flags.model,
    mode,
    extraOptions: {
      canUseTool: async (toolName, input, returnedOptions) => {
        calls.push({ ...reportCallback(label, toolName, input, returnedOptions), returned: 'allow + updatedInput(answers)' });
        return { behavior: 'allow', updatedInput: input === null || typeof input !== 'object' ? input : { ...input, answers: ASK_ANSWERS } };
      },
      // 「显式声明没有批准面」的那一档（SDK 的 `permissionPrompts: 'none'`）。
      ...(arm === 'no-surface' ? { permissionPrompts: 'none' } : {}),
      ...(tee ? teeOptions({ label, realBinary }) : {}),
    },
  });

  const run = await runQuery({ label, prompt: '请先派一个子智能体去做这件事，让子智能体先向我确认一句。', options, timeoutMs });
  upstream.close();

  const frames = tee ? readFrames(label) : null;
  const controlFrames = frames === null ? [] : summarizeControlFrames(frames.outgoing);
  const toolResults = toolResultsFrom(upstream.records);
  const requests = upstream.records.map((one) => ({
    index: one.index,
    path: one.path,
    toolCount: one.toolCount,
    spawnToolPresent: one.toolNames.includes('Agent') || one.toolNames.includes('Task'),
    containsSpawnId: JSON.stringify(one.messages ?? []).includes(SPAWN_ID),
    containsAskId: JSON.stringify(one.messages ?? []).includes(ASK_ID),
  }));
  const askFrameAgentId = controlFrames.filter((one) => one.toolName === 'AskUserQuestion').map((one) => ({ agentId: one.agentId, fieldNames: one.fieldNames, requiresUserInteraction: one.requiresUserInteraction }));
  const callbackAgentFields = calls.map((one) => ({
    toolName: one.toolName,
    agentID: one.optionFields?.agentID ?? null,
    agentType: one.optionFields?.agent_type ?? null,
    optionFieldNames: Object.keys(one.optionFields ?? {}),
  }));

  const reading = {
    label,
    arm,
    permissionMode: mode,
    permissionPrompts: arm === 'no-surface' ? 'none' : '(未显式声明)',
    tee: frames === null ? 'off' : { out: frames.outgoing.file, unparsed: frames.outgoing.unparsed },
    timedOut: run.timedOut,
    sdkError: run.error,
    spawnToolPicked: subagentScript.state.spawnTool,
    spawnToolMissing: subagentScript.state.spawnMissing,
    requests,
    callbackCount: calls.length,
    callbackAgentFields,
    askFrameAgentId,
    controlFrames,
    toolResults,
    markers: Object.fromEntries(ANSWER_MARKERS.map((marker) => [marker, JSON.stringify(toolResults.map((one) => one.content)).includes(marker)])),
  };

  note(`【${label}】入站请求 ${requests.length} 条；回调 ${calls.length} 次；工具结果 ${toolResults.length} 条；超时=${run.timedOut}`);
  if (arm === 'subagent') note(`  派子智能体用的工具名（从工具表逐字取）：${String(subagentScript.state.spawnTool)}`);
  for (const one of requests) note(`  请求#${one.index}：工具 ${one.toolCount} 项；含派发 id=${one.containsSpawnId}；含提问 id=${one.containsAskId}`);
  for (const one of callbackAgentFields) note(`  回调：toolName=${one.toolName}；agentID=${String(one.agentID)}；agent_type=${String(one.agentType)}；选项字段=${JSON.stringify(one.optionFieldNames)}`);
  for (const one of askFrameAgentId) note(`  提问帧：agent_id=${String(one.agentId)}；字段名=${JSON.stringify(one.fieldNames)}；requires_user_interaction=${String(one.requiresUserInteraction)}`);
  for (const result of toolResults) note(`  工具结果原文：${wrap(JSON.stringify(result.content))}`);
  return { reading, upstreamRecords: upstream.records };
}

function verdict(reading) {
  if (reading.arm === 'no-surface') {
    return reading.callbackCount === 0
      ? `✅ 没有批准面时回调未被调用；模型拿到：${JSON.stringify(reading.toolResults[0]?.content ?? null)}`
      : `⚠️ 声明了没有批准面但回调仍被调用 ${reading.callbackCount} 次`;
  }
  const withAgentId = reading.callbackAgentFields.filter((one) => one.agentID !== null && one.agentID !== undefined);
  const frameWithAgentId = reading.askFrameAgentId.filter((one) => one.agentId !== null && one.agentId !== undefined);
  if (reading.spawnToolMissing) return '⚠️ 入站工具表里没有派子智能体的工具 ⇒ 这一格没测到（原文见产物）';
  if (reading.callbackCount === 0) return '⚠️ 子会话的提问没到回调（看控制帧与工具结果原文）';
  return `子智能体提问回调 ${reading.callbackCount} 次；带 agentID 的 ${withAgentId.length} 次；控制帧带 agent_id 的 ${frameWithAgentId.length} 次`;
}

// ───────────────────────────── 主流程 ─────────────────────────────

const realBinary = resolveClaudeBinary();
let tee = useTee;
if (useTee) {
  const pre = await preflightTee(realBinary);
  if (pre.ok) note(`tee 预检通过：${pre.version}`);
  else {
    tee = false;
    note(`⚠️ tee 预检失败 ⇒ 不带线级帧继续：${pre.reason}`);
  }
} else {
  note('按 --no-tee 跑：没有线级控制帧');
}

const armList = String(flags.arm) === 'all' ? ['subagent', 'no-surface'] : [String(flags.arm)];
const runs = [];
for (const arm of armList) {
  runs.push(await runArm({
    arm,
    mode: flags.mode === 'bypass' ? 'bypassPermissions' : String(flags.mode),
    tee,
    realBinary,
    timeoutMs: Number(flags['timeout-ms']),
  }));
}

const summary = runs.map(({ reading }) => ({ ...reading, verdict: verdict(reading) }));
const file = writeDump('cc-ask-subagent-summary', {
  at: new Date().toISOString(),
  flags,
  tee,
  realBinary,
  placeholderKey: PLACEHOLDER_KEY,
  summary,
});

note('──────────────── 读数汇总 ────────────────');
for (const one of summary) note(`${one.arm}：${one.verdict}`);
note('判据：');
note('  · 子智能体提问：回调选项里的 `agentID`（与线级帧的 `agent_id`）只要有一格非空，本仓就能据此判「子智能体不能向用户提问」。');
note('  · 没有批准面：`permissionPrompts: "none"` 下回调**一次都没被调用**且模型拿到一条明确的拒绝原文 ⇒ 这一档如实落「无人应答」。');
note('落盘：', file);
