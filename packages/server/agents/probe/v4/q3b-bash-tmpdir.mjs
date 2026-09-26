/**
 * v4 / Q3 追问：EPERM 到底卡在哪一格？
 *
 * 已知（`q3-bash-sdk.mjs` 实测）：SDK 下 `Bash`/`PowerShell` 仍然
 *   `EPERM: operation not permitted, mkdir '<TEMP>\claude\<slug>'`。
 *
 * 本脚本排除「是不是 OS/DSH 权限」这个假设，并试一个**可能的绕过**：
 *   - A：先证明**同一个路径**用 PS 与 node 都能 mkdir（能，见 `q3-mkdir-*` 记录）；
 *   - B：换 `CLAUDE_CODE_TMPDIR` 到一个全新目录再跑一次 Bash —— 若通了，说明是
 *        `<TEMP>\claude` 那一格的历史状态/ACL 问题，而不是 claude 的 Bash 工具根本不可用。
 *
 * 用法：node probe/v4/q3b-bash-tmpdir.mjs
 * 产物：probe/dumps/v4/q3b-bash-tmpdir.json
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { note, writeDump } from './lib/env.mjs';
import { makeWorkspace, runClaudeSdk, toolPairs } from './lib/claude.mjs';

// ── A：同路径可写性（对照组）────────────────────────────────────────────────────
const claudeTmp = join(tmpdir(), 'claude');
const aclOfClaudeTmp = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Acl -LiteralPath '${claudeTmp}').Access | ForEach-Object { "$($_.IdentityReference)|$($_.FileSystemRights)|$($_.AccessControlType)" }`], { encoding: 'utf8', windowsHide: true });
const probeDir = join(claudeTmp, `v4-mkdir-control-${Date.now()}`);
let mkdirControl = null;
try {
  mkdirSync(probeDir, { recursive: true });
  mkdirControl = { ok: true, dir: probeDir };
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Remove-Item -LiteralPath '${probeDir}' -Recurse -Force`], { windowsHide: true });
} catch (error) {
  mkdirControl = { ok: false, dir: probeDir, code: error?.code, message: String(error?.message ?? error) };
}
note('A 对照：同路径 node mkdir =', JSON.stringify(mkdirControl));
note('A 对照：claude 临时根存在 =', existsSync(claudeTmp), '；ACL =', JSON.stringify((aclOfClaudeTmp.stdout ?? '').trim().split(/\r?\n/)));

// ── B：换 CLAUDE_CODE_TMPDIR 再跑 Bash ─────────────────────────────────────────
const freshTmp = mkdtempSync(join(tmpdir(), 'aieval-v4-cctmp-'));
const workspace = makeWorkspace();
writeFileSync(join(workspace, 'notes.txt'), 'alpha\nbeta\n', 'utf8');
note('B：CLAUDE_CODE_TMPDIR =', freshTmp);

const out = await runClaudeSdk({
  label: 'q3b-bash-fresh-tmpdir',
  prompt: 'Run exactly this shell command and then quote its complete raw output verbatim, including any error text: echo hi',
  workspace,
  extraEnv: { CLAUDE_CODE_TMPDIR: freshTmp, CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' },
  maxTurns: 6,
  timeoutMs: 300_000,
});
const pairs = toolPairs(out.messages);
const shellResults = pairs
  .filter((pair) => /bash|powershell|shell/i.test(String(pair.name)))
  .map((pair) => ({ name: pair.name, input: pair.input, isError: pair.result?.isError ?? null, content: pair.result?.content ?? '（无 tool_result）' }));
note('B：工具调用 =', JSON.stringify(pairs.map((pair) => pair.name)));
note('B：hasEperm =', JSON.stringify(out.messages).includes('EPERM'));
for (const shell of shellResults) note(`B：[${shell.name}] isError=${shell.isError} content=${JSON.stringify(shell.content).slice(0, 900)}`);

const file = writeDump('v4/q3b-bash-tmpdir', {
  at: new Date().toISOString(),
  control: { claudeTmp, exists: existsSync(claudeTmp), acl: (aclOfClaudeTmp.stdout ?? '').trim().split(/\r?\n/), nodeMkdir: mkdirControl },
  freshTmp,
  run: {
    label: 'q3b-bash-fresh-tmpdir',
    error: out.error,
    initToolNames: out.init?.tools ?? null,
    toolNames: pairs.map((pair) => pair.name),
    shellResults,
    hasEperm: JSON.stringify(out.messages).includes('EPERM'),
    jsonl: out.file,
  },
});
note('落盘：', file);
