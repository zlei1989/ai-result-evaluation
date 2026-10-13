/**
 * v11 探针 ①（06 号票 Q1）：**`AskUserQuestion` 经哪条控制请求到达宿主**。
 *
 * 三条臂，每条都在「脚本式上游」下跑（本机假 `/v1/messages` 主动回一帧 `AskUserQuestion`
 * 的 `tool_use`，所以「模型愿不愿意问」不是自变量）：
 *
 *  | 臂 | 回调面 | 看什么 |
 *  |---|---|---|
 *  | `both` | `canUseTool` + `onUserDialog`（并声明已知 dialog kinds） | 哪个回调被调用；线级帧里是哪种 `control_request` |
 *  | `none` | 一个都不挂 | 当场被拒还是挂住 |
 *  | `null` | 挂了但 `canUseTool` 返回 `null` | 与「不挂」是不是同一种收场（厂商文档说返回 null 是 fail-closed ⇒ 挂住） |
 *  | `hold` | 挂了但回调永不 resolve | 同上的另一条实现路径（用来互证） |
 *  | `auq-timeout` | 挂住不答 + `askUserQuestionTimeout: '60s'` | 厂商侧那条「空闲自动续跑」救不救得了一个没人答的提问（默认 `never`） |
 *  | `shadow-ab` | 先调一个**普通工具**（`Read`）再调提问工具，回调都挂着 | 「`bypassPermissions` 会遮蔽 `canUseTool`」这条警告管到谁（决定权限档要不要长第三维） |
 *  | `live` | **真网关真模型**（`--arm=live`，要两个环境变量） | 模型看不看得见这个工具、会不会真的问；顺带把入站工具表那一格钉死 |
 *
 * 前六臂各跑 `bypassPermissions`（本仓适配器的全权档）与 `default`（默认档）两遍——
 * 「全权绕过批准时还能不能被问」正是本仓要付出的代价，**不测就写不出权限档表的那一维**。
 * `live` 臂不参与矩阵（它要真凭据），单独点名跑。
 *
 * 用法：`node packages/server/agents/probe/v11/cc-ask-channel.mjs [--arm=all|both|none|null|hold|auq-timeout|shadow-ab|live] [--mode=both|bypass|default] [--timeout-ms=45000] [--live-tools=listed|none] [--no-tee]`
 * 产物：`probe/dumps/v11/cc-ask-channel-*.{jsonl,json}`（jsonl 是 SDK 消息原文，json 是读数）
 */
import { join } from 'node:path';
import { note, parseFlags, preflightTee, readFrames, reportCallback, requireGatewayCredential, resolveClaudeBinary, runQuery, summarizeControlFrames, teeOptions, toolResultsFrom, toolResultsFromMessages, writeDump, wrap, claudeOptions, makeWorkspace, scriptedEnv, startUpstream, PLACEHOLDER_KEY } from './lib/cc-ask.mjs';

const flags = parseFlags(process.argv.slice(2), {
  arm: 'all',
  mode: 'both',
  'timeout-ms': '45000',
  'auq-timeout-ms': '100000',
  model: 'claude-sonnet-4-5',
});
/** `--no-tee` 是逃生口：包装脚本起不来时用它跑一遍不带线级帧的版本。 */
const useTee = flags['no-tee'] !== true;

/** 探针里的问题：一单一多，选项两两互斥（与厂商 schema 的下限一致）。 */
const ASK_INPUT = {
  questions: [
    {
      question: 'Which approach should the probe take?',
      header: 'Approach',
      multiSelect: false,
      options: [
        { label: 'Alpha', description: '答案随权限应答的改写入参递回去' },
        { label: 'Beta', description: '提问本身走另一条对话框通道' },
      ],
    },
    {
      question: 'Which paths may I touch?',
      header: 'Scope',
      multiSelect: true,
      options: [
        { label: 'workspace', description: '只动工作区' },
        { label: 'system', description: '也可以动系统文件' },
      ],
    },
  ],
};
const ASK_ANSWERS = {
  'Which approach should the probe take?': 'Alpha',
  'Which paths may I touch?': ['workspace'],
};
/** 我们递回去的那份答案（判据：工具结果里能不能看到这几串）。 */
const ANSWER_MARKERS = ['Alpha', 'workspace'];

const MODES = { bypass: 'bypassPermissions', default: 'default', both: 'both' };

function modesToRun(mode) {
  const wanted = MODES[mode];
  if (wanted === undefined) throw new Error(`--mode 只认 both / bypass / default，收到 ${mode}`);
  return wanted === 'both' ? ['bypassPermissions', 'default'] : [wanted];
}

function armsToRun(arm) {
  const all = ['both', 'none', 'null', 'hold', 'auq-timeout', 'shadow-ab'];
  if (arm === 'all') return all;
  if (arm === 'live') return ['live'];
  if (!all.includes(arm)) throw new Error(`--arm 只认 ${[...all, 'live'].join(' / ')}，收到 ${arm}`);
  return [arm];
}

/** 脚本式上游的决策：主循环第一条请求回 `AskUserQuestion`，之后一律收尾文本。 */
function decideForAsk(record, state) {
  if (record.isChild) return { kind: 'text', text: 'child ok' };
  if (state.mainSeen === 1) return { kind: 'tool', id: 'toolu_probe_ask_1', name: 'AskUserQuestion', input: ASK_INPUT };
  return { kind: 'text', text: '收尾' };
}

/**
 * `shadow-ab` 臂的脚本：先让客户端执行一个**普通工具**（`Read`，全权档下本来不需要批准），
 * 再执行提问工具。两帧都过同一个 `canUseTool` 记录器 ⇒ 一眼看出遮蔽警告管到谁。
 */
function decideForShadowAb(workspace) {
  return (record, state) => {
    if (record.isChild) return { kind: 'text', text: 'child ok' };
    if (state.mainSeen === 1) {
      return { kind: 'tool', id: 'toolu_probe_read_1', name: 'Read', input: { file_path: join(workspace.root, 'notes.txt') } };
    }
    if (state.mainSeen === 2) return { kind: 'tool', id: 'toolu_probe_ask_1', name: 'AskUserQuestion', input: ASK_INPUT };
    return { kind: 'text', text: '收尾' };
  };
}

/** 一个臂的完整跑法与读数。 */
async function runArm({ arm, mode, tee, realBinary, timeoutMs }) {
  const isLive = arm === 'live';
  const label = `cc-ask-channel-${arm}${isLive ? '' : `-${mode === 'bypassPermissions' ? 'bypass' : 'default'}`}`;
  const workspace = makeWorkspace();
  // live 档没有假上游：请求打到真网关，工具表只能从 `system/init` 读。
  const upstream = isLive ? null : await startUpstream({ decide: arm === 'shadow-ab' ? decideForShadowAb(workspace) : decideForAsk });
  const calls = { canUseTool: [], onUserDialog: [] };

  /** 回调面：按臂给，互不影响。live 档按 `both` 给（能问才有读数）。 */
  const callbacks = {};
  if (arm === 'both' || arm === 'shadow-ab' || isLive) {
    callbacks.canUseTool = async (toolName, input, options) => {
      calls.canUseTool.push({ ...reportCallback(label, toolName, input, options), returned: 'allow+updatedInput(answers)' });
      return { behavior: 'allow', updatedInput: input !== null && typeof input === 'object' ? { ...input, answers: ASK_ANSWERS } : input };
    };
  }
  if (arm === 'null') {
    // 厂商文档（`CanUseTool` 的 JSDoc）：返回 null = 不替宿主发 control_response，工具一直阻塞。
    callbacks.canUseTool = async (toolName, input, options) => {
      calls.canUseTool.push({ ...reportCallback(label, toolName, input, options), returned: 'null（fail-closed）' });
      return null;
    };
  }
  if (arm === 'hold' || arm === 'auq-timeout') {
    // 「挂住不答」是这一档的**自变量**：全权档与默认档都一样挂住，只有厂商侧的空闲续跑能不能救它。
    callbacks.canUseTool = async (toolName, input, options) => {
      calls.canUseTool.push({ ...reportCallback(label, toolName, input, options), returned: '永不 resolve 的 promise' });
      return await new Promise(() => {});
    };
  }
  if (arm !== 'none') {
    callbacks.onUserDialog = async (request, options) => {
      calls.onUserDialog.push({
        request,
        requestId: options?.requestId ?? null,
        fieldNames: Object.keys(request ?? {}),
        returned: 'cancelled（只记录）',
      });
      note(`【${label}】onUserDialog 被调用：dialogKind=${String(request?.dialogKind)}；字段=${JSON.stringify(Object.keys(request ?? {}))}`);
      note(`  载荷原文：${wrap(JSON.stringify(request?.payload ?? null))}`);
      return { behavior: 'cancelled' };
    };
    // 已知的 dialog kind 只有这两个（CLI 侧 `Xat` 处理器表的两项）；不声明就**根本不下发**，
    // 所以「公平地测 dialog 通道」= 把它们声明上。
    callbacks.supportedDialogKinds = ['refusal_fallback_prompt', 'auto_mode_server_fallback'];
  }

  // live 档的凭据**只从环境变量读**（缺哪个就打印哪个并退出，见 requireGatewayCredential）。
  const live = isLive ? requireGatewayCredential() : null;
  const budget = arm === 'auq-timeout' ? Number(flags['auq-timeout-ms']) : timeoutMs;
  const options = claudeOptions({
    workspace,
    env: isLive
      ? { ANTHROPIC_BASE_URL: live.baseUrl, ANTHROPIC_API_KEY: live.key, ANTHROPIC_AUTH_TOKEN: live.key }
      : scriptedEnv({ upstreamUrl: upstream.url, model: flags.model }),
    model: flags.model,
    mode,
    extraOptions: {
      ...callbacks,
      ...(arm === 'auq-timeout' ? { askUserQuestionTimeout: '60s' } : {}),
      // live 档的 A/B：显式列进 `tools` 到底有没有用（v4 探针留的那条假设）。
      ...(isLive && flags['live-tools'] !== 'none' ? { tools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'] } : {}),
      ...(tee ? teeOptions({ label, realBinary }) : {}),
    },
  });

  const prompt = isLive
    ? '在动手之前，请先用 AskUserQuestion 工具问我一个问题：这次改动用哪个方案？给我两个选项。只问这一件事，然后停下等我回答。'
    : '请先用 AskUserQuestion 工具向我确认两件事，再继续。';
  const run = await runQuery({ label, prompt, options, timeoutMs: budget });
  if (upstream !== null) upstream.close();

  const frames = tee ? readFrames(label) : null;
  const controlFrames = frames === null ? [] : summarizeControlFrames(frames.outgoing);
  // 两条来源互证：脚本式上游读「下一条请求体」，live 档只能读 SDK 消息流。
  const toolResults = upstream === null ? toolResultsFromMessages(run.messages) : toolResultsFrom(upstream.records);
  const fromMessages = toolResultsFromMessages(run.messages);
  const firstMain = upstream === null ? null : upstream.records.find((one) => one.toolCount > 0) ?? null;
  const initTools = Array.isArray(run.init?.tools) ? run.init.tools : null;
  const laterMainRequests = upstream === null ? [] : upstream.records.filter((one) => one.index > (firstMain?.index ?? -1) && one.toolCount > 0);

  const reading = {
    label,
    arm,
    permissionMode: mode,
    upstream: isLive ? 'live（真网关）' : 'script（本机假上游）',
    liveToolsOption: isLive ? String(flags['live-tools'] ?? 'listed') : null,
    askedForAskUserQuestionTimeout: arm === 'auq-timeout' ? '60s' : null,
    tee: frames === null ? 'off' : { out: frames.outgoing.file, unparsed: frames.outgoing.unparsed, incomingUnparsed: frames.incoming.unparsed },
    timeoutMs: budget,
    timedOut: run.timedOut,
    sdkError: run.error,
    stderrTail: run.stderr.slice(-2000),
    // ① 模型那一侧的工具表：脚本档读入站请求体（逐字原文），live 档读 `system/init`
    inboundFirstMain: firstMain === null
      ? { source: isLive ? 'system/init' : '无入站主请求', toolCount: initTools?.length ?? null, hasAskUserQuestion: initTools === null ? null : initTools.includes('AskUserQuestion'), toolNames: initTools }
      : { source: '入站请求体', toolCount: firstMain.toolCount, hasAskUserQuestion: firstMain.hasAskUserQuestion, toolNames: firstMain.toolNames },
    // ② 宿主这一侧的回调面
    callbacksFired: { canUseTool: calls.canUseTool.length, onUserDialog: calls.onUserDialog.length },
    callbackDetails: calls,
    // ③ 线级控制帧（回调之外的第二条证据；tee 才有）
    controlFrames,
    // ④ 工具结果：模型最终看到了什么（两条来源）
    toolResults,
    toolResultsFromMessages: fromMessages,
    laterMainRequestCount: laterMainRequests.length,
  };

  note(`【${label}】判定输入：回调 canUseTool=${reading.callbacksFired.canUseTool} / onUserDialog=${reading.callbacksFired.onUserDialog}；` +
    `工具表来源=${reading.inboundFirstMain.source}；含 AskUserQuestion=${String(reading.inboundFirstMain.hasAskUserQuestion)}；` +
    `工具结果 ${toolResults.length} 条；超时=${run.timedOut}；控制帧 ${controlFrames.length} 条`);
  for (const frame of controlFrames) note(`  控制帧：${JSON.stringify(frame)}`);
  for (const result of toolResults) note(`  工具结果[${result.toolUseId}] isError=${result.isError} 原文=${wrap(JSON.stringify(result.content))}`);

  return { reading, upstreamRecords: upstream === null ? [] : upstream.records };
}

/** 每臂的结论提示（判据写死在这里，人跑完照着对）——只描述「看到什么算哪种结论」，不做产品判断。 */
function verdict(reading) {
  if (reading.arm === 'shadow-ab') {
    const hit = reading.callbackDetails.canUseTool.map((one) => one.toolName);
    return {
      channel: `回调命中过的工具 = ${JSON.stringify(hit)}`,
      settled: `普通工具（Read）是否也过回调 = ${String(hit.includes('Read'))}；提问工具是否过回调 = ${String(hit.includes('AskUserQuestion'))}`,
      toolOfferedToModel: reading.inboundFirstMain?.hasAskUserQuestion ?? null,
    };
  }
  const controls = reading.controlFrames.map((one) => one.subtype);
  const channel = reading.callbacksFired.canUseTool > 0 || controls.includes('can_use_tool')
    ? 'can_use_tool（权限通道）'
    : reading.callbacksFired.onUserDialog > 0 || controls.includes('request_user_dialog')
      ? 'request_user_dialog（对话框通道）'
      : '两条都没看到（看 tool_result 与入站工具表）';
  const settled = reading.toolResults.length > 0
    ? `当场返回：${JSON.stringify(reading.toolResults[0]?.content)?.slice(0, 200)}`
    : reading.timedOut
      ? `挂住：${reading.timeoutMs}ms 预算内既没有工具结果也没有后续请求`
      : '没有工具结果，但也没到预算（看 SDK 消息流收场方式）';
  return { channel, settled, toolOfferedToModel: reading.inboundFirstMain?.hasAskUserQuestion ?? null };
}

// ───────────────────────────── 主流程 ─────────────────────────────

const realBinary = resolveClaudeBinary();
let tee = useTee;
if (useTee) {
  const pre = await preflightTee(realBinary);
  if (pre.ok) note(`tee 预检通过：${pre.version}（真实二进制 ${realBinary}）`);
  else {
    tee = false;
    note(`⚠️ tee 预检失败 ⇒ 本轮不带线级帧继续：${pre.reason}`);
  }
} else {
  note('按 --no-tee 跑：没有线级控制帧，只有回调与工具结果');
}

const timeoutMs = Number(flags['timeout-ms']);
const runs = [];
for (const arm of armsToRun(String(flags.arm))) {
  // live 臂只跑一档（默认档；要全权档得显式点名），它要真凭据，不进默认矩阵。
  const modeList = arm === 'live'
    ? [flags.mode === 'bypass' ? 'bypassPermissions' : 'default']
    : modesToRun(String(flags.mode));
  for (const mode of modeList) {
    runs.push(await runArm({ arm, mode, tee, realBinary, timeoutMs }));
  }
}

const summary = runs.map(({ reading }) => ({ ...reading, verdict: verdict(reading) }));
const file = writeDump('cc-ask-channel-summary', {
  at: new Date().toISOString(),
  flags,
  tee,
  realBinary,
  placeholderKey: PLACEHOLDER_KEY,
  summary,
});

note('──────────────── 读数汇总 ────────────────');
for (const one of summary) {
  note(`${one.arm} @ ${one.permissionMode}：通道=${one.verdict.channel}；收场=${one.verdict.settled}`);
  note(`   AskUserQuestion 在模型工具表里=${String(one.verdict.toolOfferedToModel)}（来源：${one.inboundFirstMain.source}）；工具结果=${JSON.stringify(one.toolResults.map((r) => r.content))}`);
}
note('判据：');
note('  · 通道：哪个回调被调用 / 线级帧里是哪种 control_request（tee 关闭时只有前者）。');
note('  · 收场：有工具结果 = 工具返回了（当场拒或当场答）；到预算仍无工具结果且无后续请求 = 挂住。');
note('  · 全权档（bypassPermissions）与默认档（default）各一行，两行不一致就是「要应答面就得放弃全权绕过批准」的代价。');
note('  · live 臂（`--arm=live`）要 AIEVAL_PROBE_GATEWAY_API_KEY 与 AIEVAL_PROBE_GATEWAY_BASE_URL；它只回答「模型看不看得见、会不会问」。');
note('落盘：', file);
