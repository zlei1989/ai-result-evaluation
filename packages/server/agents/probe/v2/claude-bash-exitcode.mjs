/**
 * claude 真机项③-b：把 `Bash` 的**原始 tool_result** 抓下来（退出码可得性的直接证据）。
 *
 * 背景：前两轮 SDK 探测里 `Bash`/`PowerShell` 都失败于
 * `EPERM: operation not permitted, mkdir '<TEMP>\claude\<slug>'`，
 * 而**同一台机器上直接跑 CLI 时 bash 是好的**（且历史上 `%TEMP%\claude\` 下就有成功的 slug 目录）。
 * ⇒ 先换一个工作区位置（D 盘，与历史上成功的 slug 同盘）再试一次；仍失败就如实登记为环境限制。
 *
 * 判据：`tool_result` 的文本里有没有退出码，以及 `tool_use_result`（结构化输出）里有没有 `exitCode`。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { note, writeDump } from './lib/gateway.mjs';
import { runClaudeProbe, toolPairs } from './lib/claude.mjs';

const workspace = 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\.probe-ws\\claude-bash';
mkdirSync(workspace, { recursive: true });
writeFileSync(`${workspace}\\notes.txt`, 'alpha\nbeta\n', 'utf8');
note('工作区 =', workspace);

const prompt = [
  '请严格按顺序执行，每步都必须真的调用对应工具：',
  '1. 用 Bash 工具执行命令 `node -e "process.exit(3)"`（会以退出码 3 结束，属预期，不要重试）；',
  '2. 用 Bash 工具执行命令 `node -e "console.log(123)"`；',
  '3. 用一句话报告你从这两次工具返回里分别看到了什么。',
].join('\n');

const run = await runClaudeProbe({ label: 'bash-exitcode', prompt, workspace, maxTurns: 10 });
const pairs = toolPairs(run.messages);
const textOf = (result) => {
  if (result == null) return null;
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('\n');
  return JSON.stringify(content);
};
for (const pair of pairs) {
  note(`--- ${pair.name} ---`);
  note('  input =', JSON.stringify(pair.input).slice(0, 240));
  note('  isError =', pair.result?.isError ?? null);
  note('  result =', JSON.stringify(textOf(pair.result)).slice(0, 700));
}

// 结构化旁路（唯一可能带 exitCode 的地方）
const structured = run.messages.filter((one) => one?.tool_use_result !== undefined).map((one) => one.tool_use_result);

const file = writeDump('v2/claude-bash-exitcode', {
  at: new Date().toISOString(),
  workspace,
  prompt,
  error: run.error,
  pairs: pairs.map((pair) => ({ name: pair.name, input: pair.input, isError: pair.result?.isError ?? null, text: textOf(pair.result) })),
  structured,
});
note('→', file);
