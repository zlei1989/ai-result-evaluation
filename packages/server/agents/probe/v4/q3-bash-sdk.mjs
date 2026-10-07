/**
 * v4 / Q3：SDK 路径下 `Bash` / `PowerShell` 现在还 EPERM 吗？
 *
 * 上一轮（2026-09-30，经内网网关）的**环境级卡点 (a)**：
 *   经 SDK 时 `Bash`/`PowerShell` 恒定
 *   `EPERM: operation not permitted, mkdir '<TEMP>\claude\<slug>'`；
 *   `TaskCreate` 在存储层同样 EPERM/ENOENT。当时三种 `sandbox` 配置都一样。
 * 本轮 DSH 文件策略已是 danger-full-access，故**必须重测**这条是否已变。
 *
 * 判据：`tool_result` 的**逐字内容**（不要只看「有没有 EPERM」——先打印原文再下结论）。
 * 两个跑法：默认工具档 / `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`（看 shell 工具换成哪一格）。
 *
 * 用法：node probe/v4/q3-bash-sdk.mjs
 * 产物：probe/dumps/v4/q3-bash-sdk.json + claude-q3-*.jsonl
 */
import { note, writeDump } from './lib/env.mjs';
import { makeWorkspace, runClaudeSdk, toolPairs } from './lib/claude.mjs';

const WORKSPACE = makeWorkspace();
const PROMPT = 'Run exactly this shell command and then quote its complete raw output verbatim, including any error text: echo hi';

const VARIANTS = [
  { label: 'q3-bash-default', extraEnv: {} },
  { label: 'q3-bash-pwsh-tool', extraEnv: { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' } },
];

const runs = [];
for (const variant of VARIANTS) {
  const out = await runClaudeSdk({
    label: variant.label,
    prompt: PROMPT,
    workspace: WORKSPACE,
    extraEnv: variant.extraEnv,
    maxTurns: 6,
    timeoutMs: 300_000,
  });
  const pairs = toolPairs(out.messages);
  const result = out.result ?? null;
  const record = {
    label: variant.label,
    extraEnv: variant.extraEnv,
    prompt: PROMPT,
    workspace: WORKSPACE,
    messageCount: out.messages.length,
    error: out.error,
    initToolNames: Array.isArray(out.init?.tools) ? out.init.tools : null,
    toolPairs: pairs,
    // 逐字留 shell 类调用的结果原文
    shellResults: pairs
      .filter((pair) => /bash|powershell|shell|repl/i.test(String(pair.name)))
      .map((pair) => ({
        name: pair.name,
        input: pair.input,
        isError: pair.result?.isError ?? null,
        content: pair.result?.content ?? '（没有对应的 tool_result）',
      })),
    hasEperm: JSON.stringify(out.messages).includes('EPERM'),
    resultSummary: result === null ? null : {
      subtype: result.subtype,
      is_error: result.is_error,
      result: typeof result.result === 'string' ? result.result.slice(0, 2000) : result.result,
      terminal_reason: result.terminal_reason,
      usage: result.usage,
    },
    jsonl: out.file,
  };
  note(`== ${variant.label} ==`);
  note('  init 工具 =', JSON.stringify(record.initToolNames));
  note('  工具调用 =', JSON.stringify(pairs.map((pair) => pair.name)));
  note('  hasEperm =', record.hasEperm);
  for (const shell of record.shellResults) {
    note(`  [${shell.name}] input=${JSON.stringify(shell.input)} isError=${shell.isError}`);
    note('    逐字 content =', JSON.stringify(shell.content).slice(0, 1500));
  }
  note('  result.result =', JSON.stringify(record.resultSummary?.result)?.slice(0, 500));
  runs.push(record);
}

const file = writeDump('v4/q3-bash-sdk', { at: new Date().toISOString(), runs });
note('落盘：', file);
