/**
 * 把上一支探测落下的**两份 rollout（父 / 子）**逐条打开，回答三个必须眼见为实的问题：
 *
 *   ① 里面的 `reasoning` 记录**到底有没有正文**？（若只有 token 计数，那它解决不了"思考内容"）
 *   ② 父子链路怎么建？——会话文件名里带线程 id，而事件流的 `collab_tool_call.receiver_thread_ids`
 *      就是子线程 id ⇒ 能不能**只凭事件流就定位到子会话文件**（不依赖 hook）？
 *   ③ 子那份里能不能恢复出**子智能体的消息与工具调用**（这是"展示子智能体消息"的最低要求）？
 *
 * 用法：node probe/v4/codex-rollout-inspect.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { note, writeDump } from './lib/env.mjs';

const SCRATCH = 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\packages\\server\\agents\\probe\\dumps\\v4\\tmp\\subagent-transcript';
const SUMMARY = 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\packages\\server\\agents\\probe\\dumps\\v4\\codex-subagent-transcript.json';

const summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
const files = summary.inspected.map((one) => join(SCRATCH, one.file));

/** 文件名末尾就是线程 id：`rollout-<ISO时间>-<threadId>.jsonl` */
function threadIdOf(file) {
  const hit = /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-(.+?)\.jsonl$/.exec(file);
  return hit === null ? null : hit[1];
}

const report = [];
for (const file of files) {
  const rows = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => { try { return JSON.parse(line); } catch { return { unparsable: line.slice(0, 200) }; } });
  const reasoning = [];
  const messages = [];
  const calls = [];
  const collab = [];
  let meta = null;
  for (const row of rows) {
    const payload = row.payload ?? row;
    if (meta === null && (payload?.id !== undefined || payload?.cwd !== undefined)) meta = payload;
    if (payload?.type === 'reasoning') {
      // 关键：把**所有**字段都列出来，看正文落在哪一格（summary / content / text / encrypted）
      reasoning.push({
        keys: Object.keys(payload),
        summary: JSON.stringify(payload.summary ?? null).slice(0, 300),
        content: JSON.stringify(payload.content ?? null).slice(0, 600),
        text: typeof payload.text === 'string' ? payload.text.slice(0, 400) : null,
        encrypted: typeof payload.encrypted_content === 'string' ? `<len=${payload.encrypted_content.length}>` : null,
      });
    }
    if (payload?.type === 'message') messages.push({ role: payload.role, text: JSON.stringify(payload.content ?? '').slice(0, 200) });
    if (payload?.type === 'function_call') calls.push({ name: payload.name, arguments: String(payload.arguments ?? '').slice(0, 200) });
    if (JSON.stringify(payload).includes('receiver_thread_ids')) collab.push(JSON.stringify(payload).slice(0, 500));
  }
  const entry = {
    file: file.slice(SCRATCH.length + 1),
    threadIdFromFilename: threadIdOf(file),
    lines: rows.length,
    reasoningCount: reasoning.length,
    reasoning,
    messageCount: messages.length,
    messages,
    functionCallCount: calls.length,
    functionCalls: calls,
    collabRowsContainingReceiverThreadIds: collab,
    metaHead: meta === null ? null : JSON.stringify(meta).slice(0, 400),
  };
  report.push(entry);
  note(`===== ${entry.file}`);
  note(`  文件名里的线程 id：${entry.threadIdFromFilename}`);
  note(`  reasoning ${entry.reasoningCount} 条 / message ${entry.messageCount} 条 / function_call ${entry.functionCallCount} 条`);
  for (const one of entry.reasoning) note(`    reasoning keys=${JSON.stringify(one.keys)} text=${one.text === null ? 'null' : JSON.stringify(one.text.slice(0, 120))} summary=${one.summary.slice(0, 80)}`);
  for (const one of entry.functionCalls) note(`    call: ${one.name}(${one.arguments.slice(0, 80)})`);
  for (const one of entry.messages) note(`    msg[${one.role}]: ${one.text.slice(0, 120)}`);
  if (collab.length > 0) note(`    collab 行：${collab[0].slice(0, 200)}`);
}

const hasReasoningText = report.some((one) => one.reasoning.some((r) => r.text !== null || (r.content !== null && r.content !== 'null' && r.content !== '[]')));
const childEntry = report.length >= 2 ? report.reduce((a, b) => (b.lines < a.lines ? b : a)) : null;
const verdict = {
  '① reasoning 里有没有正文': hasReasoningText ? '✅ 有（见上面的 reasoning 行）' : '❌ 只有计数/加密，没有可读正文',
  '② 能否只凭事件流定位子会话文件':
    childEntry?.threadIdFromFilename != null
      ? `✅ 能：文件名末尾即线程 id（子那份 = ${childEntry.threadIdFromFilename}），而子线程 id 由事件流的 collab_tool_call.receiver_thread_ids 给出`
      : '⚠️ 文件名里没解析出线程 id',
  '③ 子那份能否恢复消息与工具调用': childEntry !== null && childEntry.messageCount > 0 && childEntry.functionCallCount > 0
    ? `✅ 能：子那份（${childEntry.file}）有 message ${childEntry.messageCount} 条、function_call ${childEntry.functionCallCount} 条`
    : '❌ 否',
};
for (const [k, v] of Object.entries(verdict)) note(`判定 ${k}：${v}`);

const file = writeDump('v4/codex-rollout-inspect', {
  at: new Date().toISOString(),
  files,
  report,
  verdict,
  note: 'rollout 的文件名形如 rollout-<ISO时间>-<threadId>.jsonl；会话目录按 $CODEX_HOME/sessions/<年>/<月>/<日>/ 分层。',
});
note('落盘：', file);
