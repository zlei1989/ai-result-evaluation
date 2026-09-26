/**
 * claude 真机项④：`Task*` 四个工具的**真实返回形状**（设计稿 §11.1 第 27 项的唯一缺口）。
 *
 * 设计稿原文：「`id` 从哪来（`TaskCreate` 的 result 形状未登记、`TaskCreated` hook 在 ⑨ 里没被用）**未说**
 * ⇒ claude 侧的"依赖"维度（`blockedBy`）**会落空**。需真机看一次 `TaskCreate` 的返回。」
 *
 * 本脚本只调用 `Task*`（**不调 Bash**：本机 SDK 路径上 shell 工具不可用，见 `v2/claude-bash-variants`），
 * 把四次调用的 `tool_result` 与结构化 `tool_use_result` 一并落盘。
 *
 * 注意：`Task*` 的存储落在 `~/.claude/tasks`；该目录**不存在时会报 ENOENT**，
 * 本脚本在跑之前先确保它存在（真机实测的副产品结论）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { note, writeDump } from './lib/gateway.mjs';
import { makeClaudeWorkspace, runClaudeProbe, toolPairs } from './lib/claude.mjs';

/**
 * `Task*` 的存储落点是 `<HOME>/.claude/tasks/<sessionId>`，而 CLI **不会**自己创建它：
 * 真机三次一致地以
 * `ENOENT: no such file or directory, lstat '…\\.claude\\tasks\\<sessionId>'`
 * 失败（整个 `tasks` 目录为空）。
 * ⇒ 用 SDK 的 `sessionId` 选项**把会话 id 钉死**（`sdk.d.ts`：`sessionId?: string`），
 *    这样就能在跑之前把那个目录建出来，把"厂商返回形状"这一格真正拿到。
 */
const sessionId = randomUUID();
const sessionTasksDir = join(homedir(), '.claude', 'tasks', sessionId);
mkdirSync(sessionTasksDir, { recursive: true });
/**
 * `.lock` 是**目录**不是文件：先建文件会得到
 * `EPERM … mkdir '…\\.lock.lock'`（它在 `<锁名>.lock` 上加后缀，说明锁本身按目录语义用）。
 * 真机逐步逼出来的三个 ENOENT/EPERM 连起来是：冷存储下 CLI 既不建会话目录、
 * 也不建锁目录，而工具对 ENOENT 未兜底 ⇒ 首次使用时 `TaskCreate` 必失败。
 */
const lockDir = join(sessionTasksDir, '.lock');
if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });
note('任务存储目录 =', sessionTasksDir);

const workspace = makeClaudeWorkspace();
const prompt = [
  '只使用 Task* 系列工具，按顺序执行：',
  '1. TaskCreate：subject "Probe task one"，description "created by v2 probe"；',
  '2. TaskCreate：subject "Probe task two"，description "second"；',
  '3. TaskList：列出全部任务；',
  '4. TaskUpdate：把第一条任务 status 改成 in_progress，并 addBlockedBy 指向第二条任务的 id；',
  '5. TaskGet：读取第一条任务的详情；',
  '6. 用一句话汇总你看到的 id 形态。不要调用 Bash/PowerShell/Read 等其它工具。',
].join('\n');

const run = await runClaudeProbe({
  label: 'task-tools',
  prompt,
  workspace,
  maxTurns: 14,
  extraOptions: { sessionId },
});
const textOf = (result) => {
  if (result == null) return null;
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('\n');
  return JSON.stringify(content);
};

// 结构化旁路与文本结果按出现顺序配对（`tool_use_result` 与 `tool_result` 在同一条消息上）
const structuredByIndex = [];
for (const message of run.messages) {
  if (message?.tool_use_result === undefined) continue;
  structuredByIndex.push(message.tool_use_result);
}

const pairs = toolPairs(run.messages).filter((pair) => pair.name.startsWith('Task'));
pairs.forEach((pair, index) => {
  note(`--- ${pair.name} ---`);
  note('  input =', JSON.stringify(pair.input).slice(0, 260));
  note('  isError =', pair.result?.isError ?? null);
  note('  text =', JSON.stringify(textOf(pair.result)).slice(0, 700));
  note('  structured =', JSON.stringify(structuredByIndex[index] ?? null).slice(0, 700));
});

const file = writeDump('v2/claude-task-tools', {
  at: new Date().toISOString(),
  sessionId,
  sessionTasksDir,
  workspace,
  prompt,
  error: run.error,
  finalResponse: run.messages.filter((one) => one?.type === 'result').at(-1)?.result ?? null,
  pairs: pairs.map((pair, index) => ({
    name: pair.name,
    input: pair.input,
    isError: pair.result?.isError ?? null,
    text: textOf(pair.result),
    structured: structuredByIndex[index] ?? null,
  })),
});
note('→', file);
