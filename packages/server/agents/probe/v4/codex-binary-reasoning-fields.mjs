/**
 * codex 到底**消费哪个字段**来产出 `item.type === 'reasoning'`？
 *
 * 背景：上游（responses wire）回的 reasoning 条目逐字长这样——
 *   `{"type":"reasoning", "content":[{"type":"reasoning_text","text":"<整段推理明文>"}],
 *     "summary":[], "encrypted_content":"…"}`
 * ——**明文在 `content[].reasoning_text` 里，而 `summary` 是空的**；
 * 同时 `exec` 事件流里 `item.type === 'reasoning'` 一条都不出现
 * （且把 `model_reasoning_summary` 设成 detailed/concise/none 都不改变结果）。
 *
 * 于是有两种互斥解释，本脚本查的是**打包二进制**（不需要跑模型）：
 *   (a) codex **只消费 `summary`**：那么二进制里会引用 `summary_text` 这类摘要形态，
 *       而**不引用** `reasoning_text` ⇒ 上游不给摘要时就"无可投射"，不是"不投影"；
 *   (b) codex **压根不解析 reasoning 条目**：两个名字都查不到实体引用。
 *
 * 判据：字符串计数（只看"有没有引用"这一层，不解释实现）。
 *
 * 用法：node probe/v4/codex-binary-reasoning-fields.mjs
 */
import { readFileSync } from 'node:fs';
import { note, writeDump } from './lib/env.mjs';

const EXES = {
  '0.154.0（全局 CLI）': 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
  '0.156.1（SDK 自带）': 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
};

const NEEDLES = [
  'reasoning_text',      // 上游**明文推理**的字段名（我们抓到的就是它）
  'summary_text',        // responses wire 里"摘要块"的字段名
  'encrypted_content',   // 只回密文时的那一格
  'reasoning_summary',   // 摘要档位相关的名字
  'reasoning_content',   // chat wire 的推理字段名
  'reasoning',           // 裸词（粗判有无"推理"这个概念）
  'ReasoningItem',
  'summary_index',
  'content_index',
];

const out = {};
for (const [label, exe] of Object.entries(EXES)) {
  let text = null;
  try { text = readFileSync(exe).toString('latin1'); } catch (error) { out[label] = { error: String(error?.message ?? error).slice(0, 160) }; continue; }
  const counts = {};
  for (const needle of NEEDLES) counts[needle] = text.split(needle).length - 1;
  out[label] = { exe, bytes: text.length, counts };
  note(`===== ${label}`);
  for (const [needle, count] of Object.entries(counts)) note(`  ${needle.padEnd(20)} ${count}`);
}

/** 判定：以 `summary_text` 与 `reasoning_text` 的相对存在性定性。 */
const verdicts = [];
for (const [label, row] of Object.entries(out)) {
  if (row.error !== undefined) { verdicts.push(`${label}：读不到（${row.error}）`); continue; }
  const hasSummary = row.counts.summary_text > 0;
  const hasReasoningText = row.counts.reasoning_text > 0;
  verdicts.push(
    `${label}：summary_text=${row.counts.summary_text}、reasoning_text=${row.counts.reasoning_text} ⇒ `
    + (hasSummary && !hasReasoningText
      ? '**只引用摘要形态**，不引用明文推理字段 ⇒ 支持解释 (a)：上游不给 `summary` 时"无可投射"'
      : (hasReasoningText
        ? '**引用了明文推理字段** ⇒ 它有能力读到 `reasoning_text`，那么"事件流里没有"就更像是**选择性投影**或**上游摘要为空**'
        : '两个字段都没引用 ⇒ 偏向解释 (b)：不解析 reasoning 条目')),
  );
}
for (const one of verdicts) note('判定：', one);

const file = writeDump('v4/codex-binary-reasoning-fields', {
  at: new Date().toISOString(),
  needles: NEEDLES,
  results: out,
  verdicts,
});
note('落盘：', file);
