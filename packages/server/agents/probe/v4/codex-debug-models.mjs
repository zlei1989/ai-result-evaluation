/**
 * 复核 §7.5.2 那张「哪些模型自带 `multi_agent` profile」的表（**本地、不花模型调用**）。
 *
 * 设计稿的判据是 `codex debug models` 输出里 `model_messages.multi_agent` 是 `{role, mode}` 还是 `null`；
 * 它当时（0.154.0）记下"只有 3 个 slug 带它"，而 2026-10-01 的真机逐名探测发现**只认 `gpt-6-astra` 一个**。
 * 本轮网关回来了，顺带把这台机器上的**当前**表重打一遍：这张表是**版本相关**的事实，
 * 不能当成"codex 的能力"（§7.5.3 更正 1 的原话）。
 *
 * 用法：node probe/v4/codex-debug-models.mjs
 */
import { spawnCapture } from './lib/codex-exec.mjs';
import { note, writeDump } from './lib/env.mjs';

const CODEX_EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';

for (const [label, exe] of [['0.154.0', CODEX_EXE]]) {
  const run = await spawnCapture(exe, ['debug', 'models'], { timeoutMs: 120_000, stdin: '' });
  note(`${label} debug models：exit=${run.exitCode} stdout=${run.stdout.length}B stderr=${run.stderr.length}B`);

  /**
   * 输出是**一个 JSON 对象** `{"models":[…]}`（实测 517 KB）。
   * ⚠️ 第一次写这个脚本时我按"逐模型的 JSON 片段 + 顶层 `multi_agent`"去抠，**抠出 0 个**——
   * 真实形状是：模型自带 `multi_agent_version`，而 **profile 在 `model_messages.multi_agent`**，
   * 且**每个模型都有这个键**，区别只在值是 `null` 还是对象。
   * ⇒ 又一次"先打印原文再下结论"：**按键名猜结构必然出错**。
   */
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch (error) { note(`${label} stdout 不是 JSON：`, String(error?.message ?? error).slice(0, 160)); }
  const models = parsed?.models ?? [];
  const rows = models.map((model) => {
    const holder = model.model_messages ?? {};
    const hasKey = Object.prototype.hasOwnProperty.call(holder, 'multi_agent');
    const value = holder.multi_agent;
    return {
      slug: model.slug,
      multiAgentVersion: model.multi_agent_version ?? null,
      hasMultiAgentKey: hasKey,
      multiAgentIsNull: value === null,
      multiAgentIsObject: value !== null && typeof value === 'object',
    };
  });

  const withProfile = rows.filter((row) => row.multiAgentIsObject).map((row) => row.slug);
  const withoutProfile = rows.filter((row) => row.multiAgentIsNull).map((row) => row.slug);
  note(`${label} 模型数 ${rows.length}`);
  for (const row of rows) note(`  · ${row.slug.padEnd(24)} version=${String(row.multiAgentVersion).padEnd(4)} multi_agent=${row.multiAgentIsObject ? '对象（带 profile）' : 'null'}`);
  note(`${label} 带 profile（${withProfile.length}）：`, JSON.stringify(withProfile));

  const file = writeDump('v4/codex-debug-models', {
    at: new Date().toISOString(),
    exe: { label, path: exe },
    exitCode: run.exitCode,
    stderrHead: run.stderrLines.slice(0, 5),
    modelCount: rows.length,
    rows,
    withProfile,
    withoutProfile,
    verdict: `本机 ${label} 只有 ${withProfile.length} 个模型在 model_messages.multi_agent 上带 profile（${withProfile.join('、') || '无'}）`
      + '；表是**版本相关**的事实（§7.5.3 更正 1），不能当成 codex 的固有能力。',
    rawHead: run.stdout.slice(0, 600),
  });
  note('落盘：', file);
}
