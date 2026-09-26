/**
 * claude 真机项③-e：定位「SDK 路径 Bash 必失败（EPERM）」是否由某个启动参数决定。
 *
 * 已知：**直接跑 CLI 时 `Bash` 成功**（`v2/claude-cli-bash`），**经 SDK 时必失败**。
 * 两者只差启动参数与环境。本脚本用 CLI 逐个加上 SDK 会带的参数，找出触发失败的那一个。
 *
 * 为什么要定位：`Bash` 是评测里最常用的工具，若"经 SDK 就不可用"是真实的，
 * 那是本仓 claude 适配器的一条硬边界；若只是某个参数，那只是一个环境噪声。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { note, writeDump } from './lib/gateway.mjs';
import { CLAUDE_BASE_URL, CLAUDE_TOKEN } from './lib/claude.mjs';

const workspace = 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\.probe-ws\\claude-cli-args';
mkdirSync(workspace, { recursive: true });
writeFileSync(`${workspace}\\notes.txt`, 'x\n', 'utf8');

const prompt = '用 Bash 工具执行 `node -e "console.log(7)"`，然后只回答它返回的原文。';
const cli = 'D:\\.nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

const BASE = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'Claude-Sonnet-4.6'];

const VARIANTS = [
  ['A-permission-mode', ['--permission-mode', 'bypassPermissions']],
  ['B-dangerously-skip', ['--dangerously-skip-permissions']],
  ['C-setting-sources-empty', ['--permission-mode', 'bypassPermissions', '--setting-sources', '']],
  ['D-entrypoint-sdk', ['--permission-mode', 'bypassPermissions']],
];

const results = {};
for (const [label, extra] of VARIANTS) {
  let stdout = '';
  let failure = null;
  try {
    stdout = execFileSync(cli, [...BASE, ...extra], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: CLAUDE_BASE_URL,
        ANTHROPIC_API_KEY: CLAUDE_TOKEN,
        ANTHROPIC_AUTH_TOKEN: CLAUDE_TOKEN,
        ...(label === 'D-entrypoint-sdk' ? { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } : {}),
      },
    });
  } catch (error) {
    failure = String(error?.message ?? error).slice(0, 300);
    stdout = String(error?.stdout ?? '');
  }
  const rows = stdout.split('\n').filter((line) => line.trim() !== '').map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const texts = [];
  for (const row of rows) {
    for (const block of row?.message?.content ?? []) {
      if (block?.type === 'tool_result') texts.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
    }
  }
  note(`【${label}】${failure === null ? 'OK' : `异常 ${failure.slice(0, 80)}`} → tool_result =`, JSON.stringify(texts).slice(0, 300));
  results[label] = { extra, failure, toolResults: texts };
}

const file = writeDump('v2/claude-cli-args-matrix', { at: new Date().toISOString(), workspace, prompt, results });
note('→', file);
