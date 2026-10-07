/**
 * claude 真机项④-b：用 **CLI 路径** 取 `Task*` 的厂商返回形状（SDK 路径在本机被 EPERM 挡住）。
 *
 * 为什么换路径：经 SDK 时 `TaskCreate` 在存储层就失败——
 * `ENOENT lstat '…\\.claude\\tasks\\<sessionId>'` → （补建目录后）`ENOENT …\\.lock'`
 * → `EPERM mkdir '…\\.lock.lock'`；同一台机器上 `Bash` 也是 SDK 路径 EPERM、CLI 路径正常。
 * 这是**本机进程树 + 沙箱**的产物，不是厂商行为 ⇒ 取厂商返回形状必须走 CLI。
 *
 * 判据：`TaskCreate` / `TaskList` / `TaskUpdate` / `TaskGet` 各自的 `tool_result` 原文 +
 * 结构化 `tool_use_result`（设计稿 §11.1 第 27 项要的正是这个：`TaskStep.id` 从哪来）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { note, writeDump } from './lib/gateway.mjs';
import { CLAUDE_BASE_URL, CLAUDE_TOKEN } from './lib/claude.mjs';

/** 钉死会话 id：这样能在 CLI 起来之前把 `Task*` 的存储目录与锁目录准备好。 */
const sessionId = randomUUID();
const sessionTasksDir = join(homedir(), '.claude', 'tasks', sessionId);
mkdirSync(sessionTasksDir, { recursive: true });
mkdirSync(join(sessionTasksDir, '.lock'), { recursive: true });
note('会话 id =', sessionId);

const workspace = 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\.probe-ws\\claude-tasks';
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'notes.txt'), 'x\n', 'utf8');

const prompt = [
  '只使用 Task* 系列工具，严格按顺序执行（不要调用 Bash / PowerShell / Read 等其它工具）：',
  '1. TaskCreate：subject "Probe task one"，description "created by v2 probe"；',
  '2. TaskCreate：subject "Probe task two"，description "second"；',
  '3. TaskList：列出全部任务；',
  '4. TaskUpdate：把第一条任务的 status 改成 in_progress，并用 addBlockedBy 指向第二条任务的 id；',
  '5. TaskGet：读取第一条任务的详情；',
  '6. 用一句话汇总你看到的 id 形态。',
].join('\n');

const cli = 'D:\\.nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const args = [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
  '--model', process.env.AIEVAL_V2_CLAUDE_MODEL ?? 'Claude-Sonnet-4.6',
  '--session-id', sessionId,
];

let stdout = '';
let failure = null;
try {
  stdout = execFileSync(cli, args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: CLAUDE_BASE_URL,
      ANTHROPIC_API_KEY: CLAUDE_TOKEN,
      ANTHROPIC_AUTH_TOKEN: CLAUDE_TOKEN,
    },
  });
} catch (error) {
  failure = String(error?.message ?? error).slice(0, 400);
  stdout = String(error?.stdout ?? '');
}

const messages = stdout
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const collected = [];
for (const message of messages) {
  for (const block of message?.message?.content ?? []) {
    if (block?.type === 'tool_use') collected.push({ kind: 'use', name: block.name, id: block.id, input: block.input });
    if (block?.type === 'tool_result') {
      collected.push({
        kind: 'result',
        toolUseId: block.tool_use_id,
        isError: block.is_error ?? null,
        content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
      });
    }
  }
  if (message?.tool_use_result !== undefined) collected.push({ kind: 'structured', value: message.tool_use_result });
}

note('消息数 =', messages.length, failure === null ? '' : `；CLI 退出异常 ${failure.slice(0, 120)}`);
for (const item of collected) {
  note('·', item.kind, item.name ?? '', JSON.stringify(item.input ?? item.content ?? item.value).slice(0, 500));
}

const file = writeDump('v2/claude-task-tools-cli', {
  at: new Date().toISOString(),
  sessionId,
  workspace,
  prompt,
  failure,
  collected,
});
note('→', file);
