/**
 * claude 真机项③：工具**结果形状**三连（设计稿 §7.6.6 与 §11.1 第 27 项登记的未验证格）。
 *
 *  ① `Read` 的结果**是否恒带 `<system-reminder>`**（§7.6.6 第 2 行：未验证；
 *     若恒带则 `lineNumbersIncluded` 的判据要更细，且必须剥掉 reminder）；
 *  ② `Bash` **能否拿到退出码**（§7.6.6 第 3 行："倾向拿不到，但未真机确认"）；
 *  ③ `TaskCreate` 的**返回形状**（§11.1 第 27 项：`TaskStep.id` 的来源缺一环，
 *     而 `blockedBy` 要靠它解析）——顺带把 `TaskUpdate` / `TaskList` 的返回也抓下来。
 *
 * 判据：全部看 `tool_result` 的**原文**，不做任何解释性转写。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from './lib/gateway.mjs';
import { makeClaudeWorkspace, runClaudeProbe, toolPairs } from './lib/claude.mjs';

const workspace = makeClaudeWorkspace();
note('工作区 =', workspace);

/**
 * 工作区**之外**的一份文件：设计稿说 claude 的 `Read` 结果里前置/后置 `<system-reminder>`，
 * 而那份 reminder 的常见触发条件正是「读了 cwd 之外的文件」。
 * 两个位置各读一次，才能把「恒带」与「条件带」分开（§7.6.6 第 2 行问的就是这个）。
 */
const outside = mkdtempSync(join(tmpdir(), 'aieval-v2-outside-'));
const outsideFile = join(outside, 'outside.txt');
writeFileSync(outsideFile, 'outside-one\noutside-two\n', 'utf8');

const prompt = [
  '请严格按顺序执行下面每一步，每步都必须真的调用对应工具：',
  '1. 用 Read 工具读取工作区里的 notes.txt 的全文；',
  `2. 用 Read 工具读取工作区之外的这份文件：${outsideFile} ；`,
  '3. 用 TaskCreate 工具创建一条任务：subject 填 "Probe task one"，description 填 "created by v2 probe"；',
  '4. 用 TaskCreate 再创建一条：subject 填 "Probe task two"，description 填 "second"；',
  '5. 用 TaskList 工具列出全部任务；',
  '6. 用 TaskUpdate 把第一条任务的状态改成 in_progress，并用 addBlockedBy 把它阻塞在第二条任务上；',
  '7. 用 TaskGet 工具读取第一条任务的详情；',
  '8. 最后用一句话汇总。',
].join('\n');

const run = await runClaudeProbe({ label: 'tool-results', prompt, workspace, maxTurns: 20 });
note('init.tools 数 =', run.init?.tools?.length ?? '【无 init】');
note('错误 =', run.error === null ? '无' : `${run.error.name}: ${run.error.message.slice(0, 200)}`);

const pairs = toolPairs(run.messages);
/** 把工具结果压成一行文本：`content` 可能是字符串或块数组。 */
function textOf(result) {
  if (result === null || result === undefined) return null;
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block === 'string' ? block : block?.text ?? JSON.stringify(block))).join('\n');
  }
  return JSON.stringify(content);
}

const summary = [];
for (const pair of pairs) {
  const text = textOf(pair.result);
  summary.push({ name: pair.name, input: pair.input, isError: pair.result?.isError ?? null, resultText: text });
  note(`--- ${pair.name} ---`);
  note('  input =', JSON.stringify(pair.input).slice(0, 300));
  note('  isError =', pair.result?.isError ?? null);
  note('  result =', JSON.stringify(text).slice(0, 1200));
}

const file = writeDump('v2/claude-tool-results', {
  at: new Date().toISOString(),
  workspace,
  prompt,
  model: run.model,
  error: run.error,
  initTools: run.init?.tools ?? null,
  pairs: summary,
});
note('→', file);
