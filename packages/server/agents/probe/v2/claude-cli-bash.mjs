/**
 * claude 真机项③-d：直接用 **CLI 的 `--output-format stream-json`** 抓 `Bash` 的原始 tool_result。
 *
 * 为什么换路子：经 SDK 走时 `Bash`/`PowerShell` 恒定失败于
 * `EPERM: operation not permitted, mkdir '<TEMP>\claude\<slug>'`（三档 sandbox 配置都一样），
 * 而**直接跑 CLI 时同一个提示词能跑通**。为了把"claude 的 Bash 结果里有没有退出码"这个问题
 * 用真机证据回答掉，这里改走 CLI 的原生流式 JSON（与适配器无关，只取厂商原文）。
 *
 * 注意：CLI 路径 ≠ SDK 路径（codex 侧同样如此），
 * 所以结论里必须标明"证据来自 CLI 路径"，并在 SDK 路径上如实登记为**环境受限、未取得样本**。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { note, writeDump } from './lib/gateway.mjs';
import { CLAUDE_BASE_URL, CLAUDE_TOKEN } from './lib/claude.mjs';

const workspace = 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\.probe-ws\\claude-cli';
mkdirSync(workspace, { recursive: true });
writeFileSync(`${workspace}\\notes.txt`, 'alpha\nbeta\n', 'utf8');

const prompt = [
  '请严格按顺序执行，每步都必须真的调用对应工具：',
  '1. 用 Bash 工具执行命令 `node -e "process.exit(3)"`（会以退出码 3 结束，属预期，不要重试）；',
  '2. 用 Bash 工具执行命令 `node -e "console.log(123)"`；',
  '3. 用一句话报告两次工具返回各自的内容。',
].join('\n');

const cli = 'D:\\.nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--model', 'Claude-Sonnet-4.6'];

let stdout = '';
let failure = null;
try {
  stdout = execFileSync(cli, args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 420000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: CLAUDE_BASE_URL,
      ANTHROPIC_API_KEY: CLAUDE_TOKEN,
      ANTHROPIC_AUTH_TOKEN: CLAUDE_TOKEN,
    },
  });
} catch (error) {
  failure = { message: String(error?.message ?? error).slice(0, 500), stdoutLen: String(error?.stdout ?? '').length };
  stdout = String(error?.stdout ?? '');
}

const lines = stdout.split('\n').filter((line) => line.trim() !== '');
const messages = [];
for (const line of lines) {
  try {
    messages.push(JSON.parse(line));
  } catch {
    /* 非 JSON 行（进度条等）忽略 */
  }
}
note('CLI 输出行 =', lines.length, '；可解析 JSON =', messages.length);
if (failure !== null) note('CLI 退出异常：', failure.message);

const collected = [];
for (const message of messages) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block?.type === 'tool_use') collected.push({ kind: 'use', name: block.name, id: block.id, input: block.input });
    if (block?.type === 'tool_result') {
      collected.push({ kind: 'result', toolUseId: block.tool_use_id, isError: block.is_error ?? null, content: block.content });
    }
  }
  if (message?.tool_use_result !== undefined) collected.push({ kind: 'structured', toolUseResult: message.tool_use_result });
}

for (const item of collected) {
  note('·', item.kind, item.name ?? item.toolUseId ?? '', JSON.stringify(item.input ?? item.content ?? item.toolUseResult).slice(0, 420));
}

const file = writeDump('v2/claude-cli-bash', {
  at: new Date().toISOString(),
  workspace,
  prompt,
  cli,
  args,
  failure,
  messageCount: messages.length,
  collected,
});
note('→', file);
