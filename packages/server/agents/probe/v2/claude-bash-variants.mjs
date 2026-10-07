/**
 * claude 真机项③-c：找出**能让 `Bash` 真的跑起来**的配置，并抓它的原始 tool_result。
 *
 * 前两轮的失败形状是 `EPERM: operation not permitted, mkdir '<TEMP>\claude\<slug>'`，
 * 与 cwd 位置无关（D 盘同样失败）⇒ 不是路径问题，而是 CLI 的**沙箱层**在准备目录时被拒。
 * SDK 的 `Options.sandbox`（`{ enabled, failIfUnavailable, ... }`，见 `sdk.d.ts`）是它自己的开关，
 * 本脚本对三种配置各跑一次同样的 bash 调用，把"哪种能跑"变成实测结论。
 *
 * 判据：`tool_result` 原文 + `tool_use_result`（结构化旁路）里**有没有退出码**。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { note, writeDump } from './lib/gateway.mjs';
import { runClaudeProbe, toolPairs } from './lib/claude.mjs';

const workspace = 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\.probe-ws\\claude-bash2';
mkdirSync(workspace, { recursive: true });
writeFileSync(`${workspace}\\notes.txt`, 'alpha\nbeta\n', 'utf8');

const prompt = [
  '请严格按顺序执行，每步都必须真的调用对应工具：',
  '1. 用 Bash 工具执行命令 `node -e "process.exit(3)"`（会以退出码 3 结束，属预期，不要重试）；',
  '2. 用 Bash 工具执行命令 `node -e "console.log(123)"`；',
  '3. 用一句话报告两次工具返回各自的内容。',
].join('\n');

const textOf = (result) => {
  if (result == null) return null;
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('\n');
  return JSON.stringify(content);
};

const VARIANTS = [
  ['sandbox-off', { sandbox: { enabled: false } }],
  ['sandbox-degrade', { sandbox: { failIfUnavailable: false, autoAllowBashIfSandboxed: true } }],
  ['default', {}],
];

const results = {};
for (const [label, extraOptions] of VARIANTS) {
  const run = await runClaudeProbe({
    label: `bash-${label}`,
    prompt,
    workspace,
    maxTurns: 10,
    extraOptions,
  });
  const pairs = toolPairs(run.messages)
    .filter((pair) => pair.name === 'Bash' || pair.name === 'PowerShell')
    .map((pair) => ({ name: pair.name, input: pair.input, isError: pair.result?.isError ?? null, text: textOf(pair.result) }));
  note(`===== ${label} =====`);
  for (const pair of pairs) {
    note(' ', pair.name, '| isError =', pair.isError, '| result =', JSON.stringify(pair.text).slice(0, 400));
  }
  const structured = run.messages.filter((one) => one?.tool_use_result !== undefined).map((one) => one.tool_use_result);
  results[label] = { pairs, structured, error: run.error };
  // 一旦有一档跑通就停：剩下的档位不再花时间
  if (pairs.some((pair) => pair.isError !== true)) {
    note(`⇒ ${label} 跑通了，后续档位跳过`);
    break;
  }
}

const file = writeDump('v2/claude-bash-variants', { at: new Date().toISOString(), workspace, prompt, results });
note('→', file);
