/**
 * v11 探针（观测口径与矩阵已补齐）：cc 换成 **streaming input** 之后，
 * 中途塞一条用户消息到底落在哪一档。
 *
 * 要回答四件事：
 *   1. `query({ prompt: AsyncIterable<SDKUserMessage> })` 之下，**在途**再 push 一条用户消息，
 *      它到底到不到模型？落在**哪一次** `/v1/messages` 请求里、在 `messages[]` 的哪个位置？
 *   2. `priority: 'now' | 'next' | 'later'` 三个取值分别改变什么（**哪一档对应"这一批工具跑完"**）？
 *   3. `interrupt()` 在 streaming 模式下还能不能终结在途 turn？
 *   4. **辅助与主轮的判据**：入站请求里哪些是**辅助请求**（不含工具表、`<session>…</session>` 包裹、
 *      `messages: []` 探路）、哪些是**主轮请求**；注入的那句话进没进**主轮**。
 *
 * 为什么不需要网关 key：全部臂跑在**本机假上游**（`startUpstream`，`scriptedEnv` 的占位凭据）——
 * 谁发起请求、请求体里有什么，都由我们脚本决定。判据是**入站请求体**，那正是「模型看到了什么」。
 *
 * 观测口径（判据 1）：每条入站请求都落进 `cc-stream-input-<arm>-requests.jsonl` 一行，
 * 含 `path` + `messages` 全文 + `system` 是否为空 + 是否含 `system-reminder`，并给出定类
 * （`kind: 'main' | 'aux-no-tools' | 'aux-empty'`）。**主轮 = 带工具表的那条**。
 *
 * 用法：`node packages/server/agents/probe/v11/cc-stream-input.mjs
 *   [--arm=matrix|all|<臂名>] [--tool-ms=4000] [--hold-ms=5000] [--timeout-ms=25000]`
 * 产物：`probe/dumps/v11/cc-stream-input-<arm>.{json,jsonl,requests.jsonl}`（dumps 已 gitignore）。
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  claudeOptions,
  makeWorkspace,
  note,
  parseFlags,
  scriptedEnv,
  startUpstream,
  wrap,
  writeDump,
  writeJsonl,
} from './lib/cc-ask.mjs';

const flags = parseFlags(process.argv.slice(2), {
  arm: 'matrix',
  model: 'claude-sonnet-4-5',
  'tool-ms': '4000',
  'inject-ms': '1500',
  'after-inject-ms': '6500',
  'hold-ms': '5000',
  'second-push-ms': '9000',
  'timeout-ms': '25000',
});
const toolSec = Math.max(1, Math.round(Number(flags['tool-ms']) / 1000));
const injectMs = Number(flags['inject-ms']);
const afterInjectMs = Number(flags['after-inject-ms']);
const holdMs = Number(flags['hold-ms']);
const secondPushMs = Number(flags['second-push-ms']);
const timeoutMs = Number(flags['timeout-ms']);

/** 塞进流里的那条用户消息（`SDKUserMessage` 的最小形状；`priority` 只在指定时出现）。 */
function userMessage(text, priority) {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    ...(priority === undefined ? {} : { priority }),
  };
}

/**
 * 可中途 `push` 的输入流。
 * **不 `end()` 就一直挂着**——这正是 streaming input 模式与「一次性字符串 prompt」的区别：
 * 前者把 stdin 留着，后者首条 `result` 一到就 `endInput()`。
 */
function inputStream() {
  const queue = [];
  let wake = null;
  let closed = false;
  const notify = () => {
    if (wake !== null) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      while (queue.length === 0 && !closed) await new Promise((resolve) => { wake = resolve; });
      if (queue.length > 0) return { value: queue.shift(), done: false };
      return { value: undefined, done: true };
    },
    push(value) {
      queue.push(value);
      notify();
    },
    end() {
      closed = true;
      notify();
    },
  };
}

/**
 * 一条块里所有可能承载文本的地方。**只扫 `text` 块会漏**：缺省档会被读成「没进主轮」——
 * 实际上它把注入的话塞进了 **`tool_result` 块的 `content`**（形如
 * `<system-reminder>The user sent a new message while you were working: …</system-reminder>`）。
 * `tool_result.content` 既可能是字符串，也可能是块数组，两种都要扫。
 */
function blockTexts(block, blockIndex) {
  const out = [];
  if (typeof block?.text === 'string') out.push({ where: 'text', blockIndex, text: block.text });
  if (typeof block?.thinking === 'string') out.push({ where: 'thinking', blockIndex, text: block.thinking });
  const content = block?.content;
  if (typeof content === 'string') out.push({ where: 'tool_result.content', blockIndex, text: content });
  if (Array.isArray(content)) {
    content.forEach((inner, innerIndex) => {
      if (typeof inner?.text === 'string') out.push({ where: `tool_result.content[${innerIndex}].text`, blockIndex, text: inner.text });
    });
  }
  return out;
}

/**
 * 这条入站请求里，「我们塞进去的那句话」出现在哪 —— 这是整支探针的核心判据。
 * `where` 说明它落在哪种块里（`text` = 独立文本块；`tool_result.content` = 折进工具结果正文），
 * `messageBlockTypes` 说明它和谁同一条消息，`wrappedInSession` 是**辅助请求**的签名。
 */
function findInserted(record, needle) {
  const hits = [];
  record.messages.forEach((message, messageIndex) => {
    const blocks = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: message?.content }];
    blocks.forEach((block, blockIndex) => {
      const messageBlockTypes = blocks.map((one) => one?.type ?? 'text');
      for (const candidate of blockTexts(block, blockIndex)) {
        if (!candidate.text.includes(needle)) continue;
        hits.push({
          messageIndex,
          blockIndex,
          where: candidate.where,
          role: message?.role ?? null,
          blockType: block?.type ?? null,
          messageBlockTypes,
          wrappedInSession: candidate.text.includes('<session>'),
        });
      }
    });
  });
  return hits;
}

/** 一条入站请求的 `messages[]` 速览（角色 + 块类型 + 文本前 60 字）——没有它就读不出时序。 */
function previewMessages(record) {
  return record.messages.map((message) => {
    const blocks = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: message?.content }];
    return {
      role: message?.role ?? null,
      blocks: blocks.map((block) => {
        if (block?.type === 'text') return `text:${String(block.text).replace(/\s+/g, ' ').slice(0, 60)}`;
        if (block?.type === 'tool_use') return `tool_use:${String(block.name)}`;
        if (block?.type === 'tool_result') return 'tool_result';
        return String(block?.type ?? '?');
      }),
    };
  });
}

/** 一条 SDK 消息的速览（用于时间线）。 */
function previewSdkMessage(message) {
  const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
  const texts = blocks
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text).replace(/\s+/g, ' ').slice(0, 50))
    .join(' | ');
  const tools = blocks.filter((block) => block?.type === 'tool_use').map((block) => String(block.name)).join(',');
  return {
    type: message?.type ?? null,
    subtype: message?.subtype ?? null,
    ...(texts === '' ? {} : { text: texts }),
    ...(tools === '' ? {} : { tools }),
    ...(message?.type === 'result' ? { isError: message?.is_error ?? null, resultText: String(message?.result ?? '').replace(/\s+/g, ' ').slice(0, 60) } : {}),
  };
}

/** 这次请求里最后一个块的类型（用来判断「用户消息插在工具结果之前还是之后」）。 */
function tailBlockOf(record) {
  const last = record.messages.at(-1);
  const blocks = Array.isArray(last?.content) ? last.content : [];
  const types = blocks.map((block) => block?.type ?? 'text');
  return { role: last?.role ?? null, types };
}

/**
 * 判据 1 的定类：**主轮 vs 辅助**。
 * 判据是**带不带工具表**（`toolCount > 0`）——探针里主轮一直带 27 件工具，辅助请求（探路 / 标题生成）
 * 一件都不带；再用 `messages: []` 与 `<session>` 包裹把两类辅助分开，三条互证。
 * 注意：`system-reminder` 只出现在**消息体内**（`system` 字段是另一份系统提示），所以两处分开记。
 */
function classifyRecord(record) {
  const messagesText = JSON.stringify(record.messages ?? []);
  const systemRaw = record.body?.system;
  const systemText = JSON.stringify(systemRaw ?? null);
  const systemEmpty = Array.isArray(systemRaw)
    ? systemRaw.length === 0
    : typeof systemRaw !== 'string' || systemRaw.trim() === '';
  return {
    path: record.path,
    isCountTokens: String(record.path).includes('count_tokens'),
    hasToolTable: record.toolCount > 0,
    messageCount: (record.messages ?? []).length,
    systemEmpty,
    systemLength: systemText.length,
    systemHasSystemReminder: systemText.includes('system-reminder'),
    messagesHasSystemReminder: messagesText.includes('<system-reminder>'),
    wrapsSession: messagesText.includes('<session>'),
    kind: record.toolCount > 0 ? 'main' : (record.messages ?? []).length === 0 ? 'aux-empty' : 'aux-no-tools',
  };
}

/**
 * 跑一条臂。
 *
 * `timing`：
 *  - `inflight`：工具（`sleep N`）还在跑时注入；
 *  - `after-tool`：工具已经跑完、**而那一轮的模型答复还在途**时注入
 *    （靠 `holdMs` 把带 `tool_result` 的那条主轮请求的响应扣住，把窗口拉长到注入时刻之后）；
 *  - `after-round`：工具跑完、那一轮也已收场（`late-inject` 原样）。
 */
async function runArm(config) {
  const { arm, tier, timing, priority, endAfterFirst, injectAt, holdFor, auxTool, pushSecond } = config;
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const workspace = makeWorkspace(`aieval-v11-cc-stream-${arm}-`);
  const nonce = `${arm}-${Date.now()}`;
  const injected = `PROBE-INJECTED-${nonce}`;
  const second = `PROBE-SECOND-${nonce}`;
  let toolGiven = false;
  const upstream = await startUpstream({
    decide(record) {
      record.at = at();
      /**
       * 回「慢工具」的判据是**内容**而不是序号：CLI 在真正的第一轮之前会打几条探路请求
       * （实测见过一条 `messages: []` 的），按序号判会把工具帧回给那些请求、然后被丢掉——
       * 表现就是「明明回了 tool_use，工具一次都没跑，时间线里直接 result/success」。
       */
      const carriesFirst = findInserted(record, 'PROBE-FIRST').length > 0;
      /**
       * 还要排掉 CLI 的**辅助请求**：真机实测它在主轮之前会打一条把话包在 `<session>…</session>` 里的
       * 请求（附带 `messages: []` 的探路请求）。把工具帧回给那些请求会被直接丢掉。
       */
      const isAuxiliary = JSON.stringify(record.messages ?? []).includes('<session>');
      const carriesToolResult = JSON.stringify(record.messages ?? []).includes('"tool_result"');
      // 判据 3 的反证臂：**故意**把工具帧回给辅助请求，看它会不会被静默丢弃。
      if (auxTool === true && !toolGiven && record.toolCount === 0 && (record.messages ?? []).length > 0) {
        toolGiven = true;
        return { kind: 'tool', id: `toolu_${arm}`, name: 'Bash', input: { command: `sleep ${toolSec} && echo probe-tool-done` } };
      }
      if (carriesFirst && !isAuxiliary && !toolGiven && !record.isChild) {
        toolGiven = true;
        return { kind: 'tool', id: `toolu_${arm}`, name: 'Bash', input: { command: `sleep ${toolSec} && echo probe-tool-done` } };
      }
      // 「工具跑完、答复在途」这一档：把带 tool_result 的主轮请求的响应扣住。
      const hold = carriesToolResult && holdFor > 0 ? { holdMs: holdFor } : {};
      return { kind: 'text', text: `reply-${record.index}`, ...hold };
    },
  });
  const env = scriptedEnv({ upstreamUrl: upstream.url, model: flags.model });
  const stream = inputStream();
  const messages = [];
  const timeline = [];
  let stderr = '';
  const abortController = new AbortController();
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const query = sdk.query({
    prompt: stream,
    options: {
      ...claudeOptions({ workspace, env, model: flags.model, mode: 'bypassPermissions' }),
      abortController,
      stderr: (data) => {
        stderr += String(data);
      },
    },
  });

  /**
   * **先开始消费，再 push**：SDK 的迭代器内部有缓冲，若等注入延时过完才 `for await`，
   * 注入之前产生的那些 SDK 消息会全部挤在「开始消费」的那一毫秒上，时序读数就废了
   * （表现是 `system/init` 与 `task_started` 同毫秒）。时序判据一律以**入站请求的 `at`** 为准，
   * 这里把 SDK 侧的到达时刻也修准，两套读数才能互证。
   */
  const consumed = (async () => {
    for await (const message of query) {
      timeline.push({ at: at(), ...previewSdkMessage(message) });
      messages.push(message);
      if (messages.length >= 4000) break;
    }
  })();

  stream.push(userMessage('PROBE-FIRST run the slow command, then stop.'));
  // 等工具真的开始跑（假上游回完第一帧、CLI 去执行 `sleep`），再注入——这才是「在途」
  await delay(injectAt);
  const injectedAt = at();
  stream.push(userMessage(injected, priority));
  if (endAfterFirst === true) stream.end();

  let secondPushAtValue = null;
  if (pushSecond === true) {
    await delay(Math.max(0, secondPushMs - at()));
    secondPushAtValue = at();
    stream.push(userMessage('PROBE-SECOND keep going, then stop.'));
  }

  let interrupted = false;
  let interruptedAt = null;
  if (arm === 'interrupt') {
    await delay(500);
    interruptedAt = at();
    await query.interrupt?.();
    interrupted = true;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);
  let error = null;
  try {
    await consumed;
  } catch (caught) {
    error = { name: caught?.constructor?.name ?? typeof caught, message: String(caught?.message ?? caught).slice(0, 800) };
  } finally {
    clearTimeout(timer);
    stream.end();
  }

  /**
   * 读数：**每一条入站请求**都进读数（判据 1 的口径）——不再只留模型请求。
   * `count_tokens` 那条单列一个标记，其余按「带不带工具表」定类。
   */
  const readings = upstream.records.map((record, order) => {
    const classified = classifyRecord(record);
    const bodyText = JSON.stringify(record.body ?? {});
    return {
      order,
      index: record.index,
      at: record.at ?? null,
      answeredAt: record.respondedAt === undefined ? null : record.respondedAt - t0,
      aborted: record.aborted === true,
      holdMs: record.holdMs ?? 0,
      isChild: record.isChild,
      toolCount: record.toolCount,
      hasAskUserQuestion: record.hasAskUserQuestion,
      ...classified,
      tail: tailBlockOf(record),
      preview: previewMessages(record),
      insertedHits: findInserted(record, injected),
      // 口径自检：结构化命中为空、而整份请求体里有这句话 ⇒ 说明还有我们没扫到的落点（只扫 `text` 块就是这么漏的）
      insertedRawInBody: bodyText.includes(injected),
      insertedRawInSystem: JSON.stringify(record.body?.system ?? null).includes(injected),
      secondHits: findInserted(record, second),
      firstHits: findInserted(record, 'PROBE-FIRST'),
      reply: record.reply,
    };
  });
  const mainOnes = readings.filter((one) => one.kind === 'main');
  const auxOnes = readings.filter((one) => one.kind !== 'main');
  const hitOrders = (hits) => readings.filter((one) => hits(one).length > 0).map((one) => one.order);
  const results = messages.filter((message) => message?.type === 'result');
  const payload = {
    arm,
    tier: tier ?? null,
    timing,
    priority: priority ?? null,
    endAfterFirst: endAfterFirst === true,
    holdFor,
    auxTool: auxTool === true,
    pushSecond: pushSecond === true,
    injected,
    second,
    injectedAt,
    secondPushAt: secondPushAtValue,
    interrupted,
    interruptedAt,
    toolSec,
    timedOut,
    error,
    upstreamRequests: upstream.records.length,
    countTokensRequests: readings.filter((one) => one.isCountTokens).length,
    mainRequestOrders: mainOnes.map((one) => one.order),
    auxiliaryRequestOrders: auxOnes.map((one) => one.order),
    auxiliaryKinds: auxOnes.map((one) => `${one.order}:${one.kind}${one.wrapsSession ? '+session' : ''}${one.messageCount === 0 ? '+empty' : ''}`),
    insertedSeenInRequests: hitOrders((one) => one.insertedHits),
    insertedSeenInMainRequests: hitOrders((one) => (one.kind === 'main' ? one.insertedHits : [])),
    // 「命中主轮请求的序号与块位置」——矩阵每格的原文读数（`#序号:m消息号b块号:落点`）
    insertedMainHitWheres: readings
      .filter((one) => one.kind === 'main')
      .flatMap((one) => one.insertedHits.map((hit) => `#${one.order}:m${hit.messageIndex}b${hit.blockIndex}:${hit.where}`)),
    insertedSeenInAuxiliaryRequests: hitOrders((one) => (one.kind === 'main' ? [] : one.insertedHits)),
    secondSeenInRequests: hitOrders((one) => one.secondHits),
    secondSeenInMainRequests: hitOrders((one) => (one.kind === 'main' ? one.secondHits : [])),
    // 工具帧到底有没有被接受：看有没有任何一条入站请求带 `tool_result`（带了就说明工具真跑过）
    toolFrameAccepted: upstream.records.some((record) => JSON.stringify(record.messages ?? []).includes('"tool_result"')),
    resultCount: results.length,
    resultSubtypes: results.map((one) => one?.subtype ?? null),
    readings,
    timeline,
    sdkMessageTypes: messages.map((message) => `${message?.type ?? '?'}${message?.subtype === undefined ? '' : `/${message.subtype}`}`),
    stderrTail: stderr.slice(-1200),
  };
  const json = writeDump(`cc-stream-input-${arm}`, payload);
  const jsonl = writeJsonl(`cc-stream-input-${arm}`, messages);
  // 判据 1：每条入站请求一行，含 `path` + `messages` 全文 + `system` 全文（用来核「是否为空」）
  const requestsFile = writeJsonl(`cc-stream-input-${arm}-requests`, upstream.records.map((record, order) => ({
    order,
    at: record.at ?? null,
    classify: classifyRecord(record),
    messages: record.messages,
    system: record.body?.system ?? null,
    tools: record.toolNames ?? null,
    reply: record.reply,
    holdMs: record.holdMs ?? 0,
    answeredAt: record.respondedAt === undefined ? null : record.respondedAt - t0,
    aborted: record.aborted === true,
  })));
  upstream.close();

  note(`── 臂 ${arm}（tier=${tier ?? '无'}，时机=${timing}，priority=${priority ?? '缺省'}${endAfterFirst === true ? '，push 后立刻 end()' : ''}${auxTool === true ? '，工具帧故意回给辅助请求' : ''}）`);
  note(`   注入于 ${injectedAt}ms${interruptedAt === null ? '' : `；interrupt() 于 ${interruptedAt}ms`}${secondPushAtValue === null ? '' : `；第二条消息于 ${secondPushAtValue}ms`}；扣响应 ${holdFor}ms`);
  note(`   入站请求 ${payload.upstreamRequests} 次（主轮 #${payload.mainRequestOrders.join(', #')}；辅助 #${payload.auxiliaryRequestOrders.join(', #')}=${payload.auxiliaryKinds.join(' ')}）；工具帧被接受=${payload.toolFrameAccepted}`);
  note(`   我们那句话出现在主轮 #${payload.insertedSeenInMainRequests.join(', #')}；只在辅助 #${payload.insertedSeenInAuxiliaryRequests.join(', #')}`);  note(`   result 条数 ${payload.resultCount}：${payload.resultSubtypes.join(' / ')}${timedOut ? '（到点被 abort）' : ''}`);
  readings.forEach((one) => {
    note(`   请求#${one.order} @${one.at}ms ${one.kind}${one.wrapsSession ? '+session' : ''} path=${one.path} 消息 ${one.messageCount} 条/工具 ${one.toolCount} 件/system空=${one.systemEmpty}/消息内 reminder=${one.messagesHasSystemReminder} 尾块 ${one.tail.role}:${one.tail.types.join('+')} 回复 ${one.reply?.kind ?? '?'}${one.aborted ? ' [被客户端撤]' : ''} 命中 ${JSON.stringify(one.insertedHits.map((hit) => `m${hit.messageIndex}b${hit.blockIndex}:${hit.where}${hit.wrappedInSession ? '(session)' : ''}`))}${one.insertedHits.length === 0 && one.insertedRawInBody ? ' ⚠裸命中(口径漏了)' : ''}`);
  });
  note(`   时间线：${timeline.map((one) => `${one.at}ms:${one.type}${one.subtype === null ? '' : `/${one.subtype}`}`).join(' → ')}`);
  if (error !== null) note(`   抛错：${error.name} ${error.message.slice(0, 200)}`);
  note(`   产物：${json} / ${jsonl} / ${requestsFile}`);
  return payload;
}

/**
 * 臂表。2×3 矩阵 = 三档 × 两个注入时刻；另有三条检验臂与两条原有的回归臂。
 * `next` = 缺省档（不写 `priority`）。
 */
const plan = [
  { arm: 'next', tier: 'next', timing: 'inflight', priority: undefined, injectAt: injectMs },
  { arm: 'later', tier: 'later', timing: 'inflight', priority: 'later', injectAt: injectMs },
  { arm: 'now', tier: 'now', timing: 'inflight', priority: 'now', injectAt: injectMs },
  { arm: 'next-after', tier: 'next', timing: 'after-tool', priority: undefined, injectAt: afterInjectMs, holdFor: holdMs },
  { arm: 'later-after', tier: 'later', timing: 'after-tool', priority: 'later', injectAt: afterInjectMs, holdFor: holdMs },
  { arm: 'now-after', tier: 'now', timing: 'after-tool', priority: 'now', injectAt: afterInjectMs, holdFor: holdMs },
  { arm: 'late-inject', tier: 'next', timing: 'after-round', priority: undefined, injectAt: 6000, holdFor: 0 },
  { arm: 'next-then-second', tier: 'next', timing: 'inflight', priority: undefined, injectAt: injectMs, holdFor: 0, pushSecond: true },
  { arm: 'aux-tool', tier: null, timing: 'inflight', priority: undefined, injectAt: injectMs, holdFor: 0, auxTool: true },
  { arm: 'end', tier: null, timing: 'inflight', priority: undefined, injectAt: injectMs, holdFor: 0, endAfterFirst: true },
  { arm: 'interrupt', tier: null, timing: 'inflight', priority: undefined, injectAt: injectMs, holdFor: 0 },
];
const matrixArms = ['next', 'later', 'now', 'next-after', 'later-after', 'now-after'];
const wanted = flags.arm === 'all'
  ? plan
  : flags.arm === 'matrix'
    ? plan.filter((one) => matrixArms.includes(one.arm))
    : plan.filter((one) => one.arm === flags.arm);
if (wanted.length === 0) {
  note(`未知的 --arm=${flags.arm}；可选：matrix / all / ${plan.map((one) => one.arm).join(' / ')}`);
  process.exit(2);
}
const out = [];
for (const one of wanted) {
  try {
    out.push(await runArm({ ...one }));
  } catch (caught) {
    note(`臂 ${one.arm} 整体抛错：${String(caught?.stack ?? caught).slice(0, 1200)}`);
    out.push({ arm: one.arm, fatal: String(caught?.message ?? caught) });
  }
}
const summaryFile = writeDump('cc-stream-input-summary', out);
note('');
note(wrap(`总表：${out.map((one) => `${one.arm}=主轮命中[${(one.insertedSeenInMainRequests ?? []).join(',')}]/辅助命中[${(one.insertedSeenInAuxiliaryRequests ?? []).join(',')}]/result ${one.resultCount ?? '?'}`).join('  |  ')}`));
note(`汇总产物：${summaryFile}`);
