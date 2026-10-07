/**
 * 扫 codex 二进制里的**配置/环境开关名**，为两件事找可用的旋钮：
 *   A. **思考内容**：codex 有没有"把原始推理也发出来"的开关（summary 之外的那条）；
 *   B. **子智能体消息**：有没有可订阅子线程事件的入口（rollout / app-server / resume）。
 *
 * 为什么先扫字符串：`-c <key>=<value>` 的**有效键名**只能从产物里找——上一轮的教训是
 * 「按键名猜结构必然出错」（`codex debug models` 的 profile 其实在 `model_messages.multi_agent`）。
 * 扫到的名字再逐个上真机试，避免瞎试。
 *
 * 用法：node probe/v4/codex-knobs-scan.mjs
 */
import { readFileSync } from 'node:fs';
import { note, writeDump } from './lib/env.mjs';

const EXES = {
  '0.154.0': 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
  '0.156.1': 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
};

/** A 组：思考内容相关的候选键名。 */
const REASONING_NEEDLES = [
  'show_raw_agent_reasoning',
  'hide_agent_reasoning',
  'model_reasoning_summary',
  'model_supports_reasoning_summaries',
  'reasoning_summary',
  'show_reasoning',
  'raw_reasoning',
  'reasoning_text',
  'summary_text',
  'encrypted_content',
];

/** B 组：子智能体 / 会话文件 / app-server 相关的候选入口。 */
const SUBAGENT_NEEDLES = [
  'agent_transcript_path',
  'subagent_notification',
  'rollout',
  'sessions',
  'history.jsonl',
  'thread/read',
  'thread/list',
  'app-server',
  'app_server',
  'CollabAgent',
  'collab_tool_call',
  'agents_states',
  'receiver_thread_ids',
  'spawn_agent',
  'agent_id',
  'exec resume',
  'resume',
];

const out = {};
for (const [label, exe] of Object.entries(EXES)) {
  let text = '';
  try { text = readFileSync(exe).toString('latin1'); } catch (error) { out[label] = { error: String(error?.message ?? error).slice(0, 160) }; continue; }
  const count = (list) => Object.fromEntries(list.map((needle) => [needle, text.split(needle).length - 1]));
  out[label] = { reasoning: count(REASONING_NEEDLES), subagent: count(SUBAGENT_NEEDLES) };
  note(`===== ${label}`);
  note('  [思考]', JSON.stringify(out[label].reasoning));
  note('  [子智能体]', JSON.stringify(out[label].subagent));
}

const file = writeDump('v4/codex-knobs-scan', {
  at: new Date().toISOString(),
  reasoningNeedles: REASONING_NEEDLES,
  subagentNeedles: SUBAGENT_NEEDLES,
  results: out,
  note: '计数只说明"这个名字在产物里存在"，不说明"它会被触发"——后续逐个上真机试。',
});
note('落盘：', file);
