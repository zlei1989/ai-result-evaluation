/**
 * v11 应答者探针的**共用定义**：四臂的 profile 行、插件落盘、提示词与判读。
 *
 * 两个脚本共用它，是为了让「真机跑的」与「离线干跑的」用的是**同一份行定义**——
 * 抄两份的话，离线检查绿了而真机跑的是另一份形状，那种假绿比没有检查更坏。
 *
 * 落点：本目录与另几支探针共用，文件名一律带 `answerer-` 前缀，避免撞名。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 应答者插件源码（本目录的真源文件） */
export const ANSWERER_PLUGIN_FILE = join(HERE, 'answerer-plugin.mjs');
/** 插件在行里被引用的文件名（相对名；解析基准由真机/离线 dump 回答） */
export const ANSWERER_PLUGIN_NAME = 'aieval-ask-answerer.mjs';
/** `ask_user_question` 那一行（缺省 config = `mode: legacy`，阻塞档） */
export const ASK_USER_ROW = { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' };
/** 应答者那一行（相对名，与适配器的 stream-tap 同一形状） */
export const ANSWERER_ROW = { id: 'aieval-ask-answerer', name: `./${ANSWERER_PLUGIN_NAME}` };

/**
 * 四臂：只差 profile 的两行与一个子进程环境变量。
 * `expect` 是「这一臂要拿哪一支原文」，判读只看它，不做任何自动修复。
 */
export function buildArms() {
  const timedRow = (timeout) => ({ ...ASK_USER_ROW, config: { mode: 'timed', timeout } });
  return {
    A: {
      label: 'v11-A-answerer-legacy',
      title: 'Ａ 阻塞档 + 应答者（canned）',
      rows: [ASK_USER_ROW, ANSWERER_ROW],
      env: { AIEVAL_PROBE_ANSWER: 'canned' },
      expect: 'answers',
    },
    B: {
      label: 'v11-B-no-answerer-legacy',
      title: 'Ｂ 阻塞档 + 无应答者',
      rows: [ASK_USER_ROW],
      env: { AIEVAL_PROBE_ANSWER: undefined },
      expect: 'error',
    },
    C: {
      label: 'v11-C-no-answerer-timed',
      title: 'Ｃ timed 档（timeout=8s）+ 无应答者',
      rows: [timedRow(8)],
      env: { AIEVAL_PROBE_ANSWER: undefined },
      expect: 'pending',
    },
    D: {
      label: 'v11-D-answerer-timed-file',
      title: 'Ｄ timed 档（timeout=60s）+ 应答者（file side channel）',
      rows: [timedRow(60), ANSWERER_ROW],
      env: { AIEVAL_PROBE_ANSWER: 'file', AIEVAL_PROBE_ANSWER_WAIT_MS: '45000' },
      expect: 'answers',
      serve: true,
    },
  };
}

/**
 * 把应答者插件写到**两个候选落点**并各写一份：
 *   · `<configHome>/profiles/sdk/aieval-ask-answerer.mjs` —— 离线 dump 实证的基准（profile 目录）；
 *   · `<configHome>/aieval-ask-answerer.mjs` —— `--patch` overlay 那条路的基准（`dshHome` 根）。
 * 两条路各有一套基准 ⇒ 两处都写，再靠插件自报的 `import.meta.url` 把「实际加载了哪一份」变成读数。
 */
export function plantPlugin(configHome) {
  const source = readFileSync(ANSWERER_PLUGIN_FILE, 'utf8');
  const files = [join(configHome, 'profiles', 'sdk', ANSWERER_PLUGIN_NAME), join(configHome, ANSWERER_PLUGIN_NAME)];
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source, { encoding: 'utf8', mode: 0o600 });
  }
  return files;
}

/** 提示词：只问一题、选项带探针 nonce；并明令把结果原文回抄（模型转述会毁掉判据）。 */
export function buildPrompt(nonce) {
  return [
    '调用 ask_user_question 工具问用户一个问题（只问一题）：',
    'id 用 "probe_confirm"，header 用「确认」，question 用「是否继续？」；',
    `options 给两项：label「PROBE-${nonce}-A」与 label「PROBE-${nonce}-B」（各带一句 description）；`,
    'multi_select 不填，timeout 参数一律不要给。',
    '拿到工具结果后，把结果原文（成功就是那段 JSON、失败就是错误原文）一字不改地写进你的最终答复，',
    '不要重试、不要改写、不要补充解释。',
  ].join('\n');
}

/** 与插件同一条挑项规则：label 以 `-B` 结尾的优先，否则最后一项。 */
export function composeAnswers(questions) {
  return questions.map((question) => {
    const options = Array.isArray(question?.options) ? question.options : [];
    const flagged = options.find((option) => typeof option?.label === 'string' && option.label.endsWith('-B'));
    const option = flagged ?? options[options.length - 1] ?? null;
    return option === null
      ? { id: question.id, selected: [], custom: 'AIEVAL_PROBE_ANSWER' }
      : { id: question.id, selected: [option.label] };
  });
}

/** 读应答者 sidecar（它自己写的原文）；文件不存在 ⇒ 空表（= 插件没被加载或没收到请求）。 */
export function readTranscript(configHome) {
  try {
    return readFileSync(join(configHome, 'aieval-ask-answerer.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 从一次运行的通知流里抽出 `ask_user_question` 的调用与结果（v2 同名函数的强化版）。 */
export function askUserPairs(notifications) {
  const pairs = [];
  for (const one of notifications) {
    const event = one?.params?.event;
    if (event?.type === 'tool/call' && event.data?.name === 'ask_user_question') {
      pairs.push({ callId: event.data.callId, arguments: event.data.arguments, result: null, turn: event.data.turn, step: event.data.step });
    }
    if (event?.type === 'tool/result') {
      const hit = pairs.find((pair) => pair.callId === event.data?.message?.toolCallId);
      if (hit !== undefined) hit.result = event.data;
    }
  }
  return pairs;
}

/**
 * 工具结果那一格里的**文本**（工具用 `JSON.stringify(value)` 出一个 text 块）。
 * 判据必须打在文本上而不是整份 content 上：后者带着 `type`/`text` 两层壳，正则很容易假阳。
 */
export function resultText(pair) {
  const blocks = pair?.result?.message?.content;
  if (!Array.isArray(blocks)) return null;
  return blocks.find((block) => block?.type === 'text')?.text ?? null;
}

/** 一句话判读（只做「像不像」；原文永远在旁边，人可以推翻它）。 */
export function verdictOf(arm, pair, transcript) {
  const text = resultText(pair);
  const isError = pair?.result?.message?.isError === true;
  const lines = [
    `工具调用 ${pair === undefined ? '【没发生】' : '1 次'}`,
    `isError=${pair?.result?.message?.isError ?? '【无 result】'}`,
    `插件加载=${transcript.some((row) => row.phase === 'plugin-loaded') ? '是' : '否'}`
      + ` / 已作答=${transcript.some((row) => row.phase === 'answer') ? '是' : '否'}`,
  ];
  if (arm.expect === 'answers') {
    lines.push(isError !== true && /"answers"\s*:/.test(text ?? '') ? '⏳ 形状像 answers 支' : '❌ 没看到 answers 支（看原文）');
  } else if (arm.expect === 'error') {
    lines.push(isError === true ? '⏳ 形状像报错支' : '❌ 没看到错误');
  } else {
    lines.push(/"pending"\s*:\s*true/.test(text ?? '') ? '⏳ 形状像 pending 支' : '❌ 没看到 pending 支');
  }
  return lines;
}
