/**
 * v11 探针 ②（Q2）：**答案能不能随 `canUseTool` 的「允许并改写入参」递回去**。
 *
 * 这是 cc 那一家的成败点：权限应答的类型面上只有「允许 + `updatedInput`」与「拒绝 + `message`」，
 * 没有结果字段。于是唯一可能的递法就是往 `updatedInput` 里塞答案——**但厂商认不认这一格，必须真跑**。
 *
 * 判据（每条都是一次独立运行，只切「我们返回什么」这一个自变量）：
 *
 *  | 臂 | 我们返回的权限结果 | 期望/要抄的读数 |
 *  |---|---|---|
 *  | `plain` | `{behavior:'allow'}`（不带更新入参） | 对照臂：没有答案时工具结果长什么样 |
 *  | `answers` | `allow` + `updatedInput` 里附 `answers`（单选给标签串、多选给数组） | 工具结果里能不能逐字看到我们给的答案 |
 *  | `multi-csv` | 同上，但多选答案是逗号串 | 数组 vs 逗号串两种写法厂商认哪种 |
 *  | `notes` | `answers` + `annotations`（notes） | 「多选补充一段话」这条路的落点 |
 *  | `response` | `answers` + `response`（自由输入） | 单选里自由输入覆盖选项的落点 |
 *  | `answer-custom` | 按本仓 `ccAnswersOf` 算出来的值：单选自由输入给**那个串**（不另加 `response`）、多选自由输入**拼进数组** | 弹层写的自由输入经 option 值进工具结果后模型看不看得到 |
 *  | `invalid` | `updatedInput` 故意违反该工具入参 schema | 改写入参**过不过厂商的入参校验**，报错原文是什么 |
 *  | `late` | 先挂住 `--late-ms`，再 `allow` + `answers` | 「人晚点才答」这条真机路径走不走得通 |
 *
 * 每一臂都会把**后续入站请求体里的 `tool_result`** 抄回来——那是模型最终看到的那一份，
 * 不经过我们的任何投影。
 *
 * 用法：`node packages/server/agents/probe/v11/cc-ask-answer.mjs [--arm=all|plain|answers|multi-csv|notes|response|answer-custom|invalid|late] [--mode=default|bypass] [--late-ms=3000] [--timeout-ms=45000] [--no-tee]`
 * 产物：`probe/dumps/v11/cc-ask-answer-*.{jsonl,json}`
 */
import { note, parseFlags, preflightTee, readFrames, reportCallback, resolveClaudeBinary, runQuery, summarizeControlFrames, teeOptions, toolResultsFrom, toolResultsFromMessages, writeDump, wrap, claudeOptions, makeWorkspace, scriptedEnv, startUpstream, PLACEHOLDER_KEY } from './lib/cc-ask.mjs';

const flags = parseFlags(process.argv.slice(2), {
  arm: 'all',
  mode: 'default',
  'late-ms': '3000',
  'timeout-ms': '45000',
  model: 'claude-sonnet-4-5',
});
const useTee = flags['no-tee'] !== true;

const Q1 = 'Which approach should the probe take?';
const Q2 = 'Which paths may I touch?';
const ASK_INPUT = {
  questions: [
    {
      question: Q1,
      header: 'Approach',
      multiSelect: false,
      options: [
        { label: 'Alpha', description: '答案随权限应答的改写入参递回去' },
        { label: 'Beta', description: '提问本身走另一条对话框通道' },
      ],
    },
    {
      question: Q2,
      header: 'Scope',
      multiSelect: true,
      options: [
        { label: 'workspace', description: '只动工作区' },
        { label: 'system', description: '也可以动系统文件' },
      ],
    },
  ],
};

/** 每条臂「我们递回去的那一份」——`null` 表示这一臂不递答案（对照臂）。 */
const ARMS = {
  plain: { note: '对照臂：只 allow，不改写入参', updatedInput: null },
  answers: {
    note: '单选给标签串、多选给数组',
    updatedInput: { answers: { [Q1]: 'Alpha', [Q2]: ['workspace'] } },
  },
  'multi-csv': {
    note: '多选给逗号串（厂商输出 schema 的原话是 comma-separated）',
    updatedInput: { answers: { [Q1]: 'Alpha', [Q2]: 'workspace,system' } },
  },
  notes: {
    note: 'answers + annotations(notes)：多选「补充一段话」',
    updatedInput: {
      answers: { [Q1]: 'Alpha', [Q2]: ['workspace'] },
      annotations: { [Q2]: { notes: '探针补记：只动工作区，别碰系统文件。' } },
    },
  },
  response: {
    note: 'answers + response（自由输入）',
    updatedInput: { answers: { [Q1]: 'Alpha', [Q2]: ['workspace'] }, response: '探针自由输入：先按 Alpha 走。' },
  },
  'answer-custom': {
    note: '按本仓 ccAnswersOf 算出的值：单选给自由输入串、多选把自由输入拼进数组',
    updatedInput: {
      answers: { [Q1]: '探针自由输入：先按 Alpha 走。', [Q2]: ['workspace', '探针自由输入：再多带一个 system。'] },
    },
    markers: ['探针自由输入：先按 Alpha 走。', 'workspace', '探针自由输入：再多带一个 system。'],
  },
  invalid: {
    note: '故意违反入参 schema（questions 换成字符串）⇒ 看厂商拒不拒',
    updatedInput: { questions: 'not-an-array' },
  },
  late: {
    note: '先挂住再答（人晚点才答的真机路径）',
    updatedInput: { answers: { [Q1]: 'Alpha', [Q2]: ['workspace'] } },
    hold: true,
  },
};

/** 我们递回去的那份答案里，应当能在工具结果里逐字看到的串（缺省那一组；臂可以自带一组）。 */
const MARKERS = ['Alpha', 'workspace'];
const INVALID_EXPECT = 'not-an-array';

function decideForAsk(record, state) {
  if (record.isChild) return { kind: 'text', text: 'child ok' };
  if (state.mainSeen === 1) return { kind: 'tool', id: 'toolu_probe_ask_1', name: 'AskUserQuestion', input: ASK_INPUT };
  return { kind: 'text', text: '收尾' };
}

async function runArm({ arm, mode, tee, realBinary, timeoutMs, lateMs }) {
  const label = `cc-ask-answer-${arm}`;
  const spec = ARMS[arm];
  if (spec === undefined) throw new Error(`--arm 只认 ${Object.keys(ARMS).join(' / ')}，收到 ${arm}`);
  const workspace = makeWorkspace();
  const upstream = await startUpstream({ decide: decideForAsk });
  const calls = [];

  const options = claudeOptions({
    workspace,
    env: scriptedEnv({ upstreamUrl: upstream.url, model: flags.model }),
    model: flags.model,
    mode,
    extraOptions: {
      canUseTool: async (toolName, input, returnedOptions) => {
        const recorded = reportCallback(label, toolName, input, returnedOptions);
        if (input === null || typeof input !== 'object') {
          calls.push({ ...recorded, returned: '对象以外的入参，原样 allow' });
          return { behavior: 'allow' };
        }
        if (arm === 'plain') {
          calls.push({ ...recorded, returned: "{behavior:'allow'}（不带 updatedInput）" });
          return { behavior: 'allow' };
        }
        if (spec.hold === true) {
          note(`【${label}】按 late 臂挂住 ${lateMs}ms 再答（这一格就是「人晚点才答」）`);
          await new Promise((resolve) => setTimeout(resolve, lateMs));
        }
        // `input` 是工具 `checkPermissions` 归一后的那份入参；答案按静态证据的形状并入。
        const updatedInput = { ...input, ...spec.updatedInput };
        calls.push({ ...recorded, returned: `allow + updatedInput=${JSON.stringify(updatedInput)}` });
        return { behavior: 'allow', updatedInput };
      },
      ...(tee ? teeOptions({ label, realBinary }) : {}),
    },
  });

  // late 臂要留出挂住 + 后续往返的余量，否则「预算到点」会被误读成「挂住」
  const budget = timeoutMs + (spec.hold === true ? lateMs : 0);
  const run = await runQuery({ label, prompt: '请先用 AskUserQuestion 工具向我确认两件事，再继续。', options, timeoutMs: budget });
  upstream.close();

  const frames = tee ? readFrames(label) : null;
  const controlFrames = frames === null ? [] : summarizeControlFrames(frames.outgoing);
  const toolResults = toolResultsFrom(upstream.records);
  // 第二条来源：SDK 消息流里的 `tool_result`。两条应当一致；不一致就说明中间还有一层投影。
  const fromMessages = toolResultsFromMessages(run.messages);
  const content = JSON.stringify(toolResults.map((one) => one.content));
  const firstMain = upstream.records.find((one) => one.toolCount > 0) ?? null;
  const resultMessage = run.messages.find((one) => one?.type === 'result') ?? null;
  // 厂商会不会因为「改写入参」而报错：SDK 消息流里的 is_error 工具结果 + stderr 里的两类原文
  const errorHits = [];
  for (const hit of ['schema-invalid', 'invalid permission result', 'InputValidationError', 'updatedInput']) {
    if (run.stderr.includes(hit)) errorHits.push(`stderr:${hit}`);
  }
  for (const message of run.messages) {
    const blocks = message?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) if (block?.type === 'tool_result' && block?.is_error === true) errorHits.push(`sdk-message:is_error:${JSON.stringify(block.content).slice(0, 200)}`);
  }

  const reading = {
    label,
    arm,
    armNote: spec.note,
    permissionMode: mode,
    returnedUpdatedInput: spec.updatedInput,
    markersExpected: spec.markers ?? MARKERS,
    tee: frames === null ? 'off' : { out: frames.outgoing.file, unparsed: frames.outgoing.unparsed },
    timeoutMs: budget,
    timedOut: run.timedOut,
    sdkError: run.error,
    sdkResult: resultMessage === null ? null : { subtype: resultMessage.subtype ?? null, isError: resultMessage.is_error ?? null, result: String(resultMessage.result ?? '').slice(0, 600) },
    inboundFirstMain: firstMain === null ? null : { hasAskUserQuestion: firstMain.hasAskUserQuestion, toolCount: firstMain.toolCount },
    callbacks: calls,
    controlFrames,
    toolResults,
    toolResultsFromMessages: fromMessages,
    // 判据本身：我们给的答案串有没有逐字出现在工具结果里
    markers: Object.fromEntries((spec.markers ?? MARKERS).map((marker) => [marker, content.includes(marker)])),
    invalidMarkerSeen: content.includes(INVALID_EXPECT),
    laterMainRequestCount: upstream.records.filter((one) => one.index > (firstMain?.index ?? -1) && one.toolCount > 0).length,
  };

  note(`【${label}】回调 ${calls.length} 次；工具结果 ${toolResults.length} 条；超时=${run.timedOut}`);
  note(`  我们返回：${calls[0]?.returned ?? '（回调没被调用）'}`);
  for (const result of toolResults) note(`  模型看到的工具结果原文：${wrap(JSON.stringify(result.content))}`);
  note(`  第二条来源（SDK 消息流）的工具结果：${wrap(JSON.stringify(fromMessages.map((one) => one.content)))}`);
  note(`  判据标记命中：${JSON.stringify(reading.markers)}；异常命中=${JSON.stringify(errorHits)}`);
  return { reading, errorHits, upstreamRecords: upstream.records };
}

/** 结论提示：只描述「看到什么算哪种结论」。 */
function verdict(reading) {
  const expected = reading.markersExpected;
  const hitAll = expected.every((marker) => reading.markers[marker] === true);
  if (reading.arm === 'plain') {
    return reading.toolResults.length === 0
      ? '对照臂没有工具结果 ⇒ 这一档没跑到收场，读数不成立'
      : `对照臂：不带答案时的原文=${JSON.stringify(reading.toolResults[0]?.content)?.slice(0, 200)}`;
  }
  if (reading.arm === 'invalid') {
    return reading.toolResults.length === 0
      ? '改写入参被拒或整轮挂住 ⇒ 看 stderr / SDK 消息流里的报错原文'
      : `改写入参被接受：工具结果=${JSON.stringify(reading.toolResults[0]?.content)?.slice(0, 200)}；非法串出现=${String(reading.invalidMarkerSeen)}`;
  }
  if (hitAll) return `✅ 答案递回去了：工具结果里逐字含 ${JSON.stringify(expected)}`;
  if (reading.toolResults.length === 0) return '❌ 没有工具结果（挂住或整轮出错）⇒ 看 sdkError / stderr 原文';
  return `❌ 工具结果里看不到我们给的答案：原文=${JSON.stringify(reading.toolResults[0]?.content)?.slice(0, 240)}`;
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

const arms = String(flags.arm) === 'all' ? ['plain', 'answers', 'multi-csv', 'notes', 'response', 'answer-custom', 'invalid', 'late'] : [String(flags.arm)];
const runs = [];
for (const arm of arms) {
  runs.push(await runArm({
    arm,
    mode: flags.mode === 'bypass' ? 'bypassPermissions' : String(flags.mode),
    tee,
    realBinary,
    timeoutMs: Number(flags['timeout-ms']),
    lateMs: Number(flags['late-ms']),
  }));
}

const summary = runs.map(({ reading, errorHits }) => ({ ...reading, errorHits, verdict: verdict(reading) }));
const file = writeDump('cc-ask-answer-summary', {
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
note('  · 工具结果里**逐字**出现我们给的答案串 ⇒ 权限通道能递答案（走 α）。');
note('  · 工具结果是我们给的答案之外的收场（例如「The user did not answer the questions.」）⇒ 递不回去（走 β），把原文抄进报告里。');
note('  · `invalid` 臂：改写入参违反 schema 时厂商是拒、是忽略、还是原样收下——决定我们能不能往入参里加字段。');
note('  · `late` 臂：挂住之后再答能不能被接受；这才是「人在几十秒后才点完成」的真机路径。');
note('落盘：', file);
