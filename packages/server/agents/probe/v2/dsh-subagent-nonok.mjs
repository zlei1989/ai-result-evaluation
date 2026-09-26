/**
 * dsh 真机项③：**子任务失败 / 取消路径的 `subagent.finished` 形态**。
 *
 * 设计稿 §6.5.2 / §11.1 第 20 项 / §9.3 三处都登记着同一个空白：
 * 真机只覆盖了**成功路径**（`status: "ok"` + `stopReason: "completed"`），
 * **非 ok 的取值没抓到** ⇒ 那一格目前只能写 `statusMissing: 'unverified'`。
 *
 * 本脚本跑**两种非成功收场**，各抓一次原始 `subagent.finished`：
 *  ① `interrupt` —— 父智能体主动 `interrupt_agent` 掉一个正在跑的后台子任务（取消路径）；
 *  ② `abandon`  —— 子任务还在跑时直接关掉运行时（传输中断路径，最接近"评测中途被杀"）。
 *
 * 判据：`params.status` 与 `params.stopReason` 的**原始取值**——本脚本不做任何映射，
 * 只如实抄下来（设计稿 §6.5.2 的口径就是"未知取值原样透出，不假装映射成 failed"）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from './lib/gateway.mjs';
import { runDshProbe, summarize } from './lib/dsh.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'aieval-v2-sub-'));
note('工作区 =', workspace);

/** 从一批通知里挑出子任务相关的负载（顶层通知，不在 `params.event` 下）。 */
function subagentLoads(notifications) {
  return notifications
    .filter((one) => typeof one?.method === 'string' && one.method.startsWith('subagent'))
    .map((one) => ({ method: one.method, params: one.params }));
}

const results = {};

// ── 场景①：父智能体主动中断正在跑的子任务 ───────────────────────────────────────
const interruptPrompt = [
  '严格按顺序执行下面每一步，**不要跳过、不要合并、不要等子任务跑完**：',
  '1. 调用 subagent 工具（`run_in_background` 保持默认 true）派生一个子智能体：',
  '   description 填 "Long ticker"，prompt 填「用 pwsh 连续执行 40 次 `Start-Sleep -Seconds 3; Write-Output tick`，每次输出一个 tick，中途绝对不要结束」。',
  '2. 从工具返回里读出这个子智能体的 id（形如 uuid）。',
  '3. 立刻调用 interrupt_agent，agent_id 填上一步读到的那个 id。',
  '4. 用一句话报告 interrupt_agent 的返回内容。',
].join('\n');

const interruptRun = await runDshProbe({
  label: 'subagent-interrupt',
  prompt: interruptPrompt,
  workspace,
  settleMs: 90000,
  timeoutMs: 600000,
});
note('interrupt 场景通知分布：');
for (const [key, count] of summarize(interruptRun.notifications)) note('  ·', key, '×', count);
const interruptLoads = subagentLoads(interruptRun.notifications);
note('子任务通知：');
for (const one of interruptLoads) note('  ·', one.method, JSON.stringify(one.params).slice(0, 500));
results.interrupt = {
  prompt: interruptPrompt,
  error: interruptRun.error,
  finalResponse: interruptRun.result?.finalResponse ?? null,
  loads: interruptLoads,
};

// ── 场景②：子任务仍在跑时关掉运行时（不等它收场） ──────────────────────────────
const abandonPrompt = [
  '调用 subagent 工具派生一个子智能体：description 填 "Never ends"，',
  'prompt 填「用 pwsh 连续执行 60 次 `Start-Sleep -Seconds 5; Write-Output tick`，中途绝对不要结束」。',
  '排完之后**立刻结束你这一轮**，不要等子智能体完成，也不要调用别的工具。',
].join('\n');

const abandonRun = await runDshProbe({
  label: 'subagent-abandon',
  prompt: abandonPrompt,
  workspace,
  settleMs: 6000,
  timeoutMs: 300000,
});
note('abandon 场景通知分布：');
for (const [key, count] of summarize(abandonRun.notifications)) note('  ·', key, '×', count);
const abandonLoads = subagentLoads(abandonRun.notifications);
note('子任务通知：');
for (const one of abandonLoads) note('  ·', one.method, JSON.stringify(one.params).slice(0, 500));
results.abandon = {
  prompt: abandonPrompt,
  error: abandonRun.error,
  finalResponse: abandonRun.result?.finalResponse ?? null,
  loads: abandonLoads,
};

const file = writeDump('v2/dsh-subagent-nonok', {
  at: new Date().toISOString(),
  workspace,
  note: 'status / stopReason 一律原样抄录，不做映射',
  ...results,
});
note('→', file);
