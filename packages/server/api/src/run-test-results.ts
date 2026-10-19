/**
 * 测试结果的**只读投影**：从候选消息账本里认出「测试命令 → 测试输出」那一对，
 * 折成排名页要的三态（采集到 / 未采集 / 解析失败）。
 *
 * 三条边界：
 *   1. **只读 `messages.jsonl`**：测试输出在 `tool-result` 块里，命令在配对的 `tool-call` 块里。
 *      事件台账（`events.jsonl`）只有 `log` 原文、没有调用与结果的配对，本投影不碰它，
 *      也不改它的形状；
 *   2. **一行取最后一次**：同一行可能跑过多次测试（重跑 / 追问），排名页要的是最新事实；
 *      把历史加总会把一次已经修好的失败永远留在通过率里；
 *   3. **截断不猜**：`tool-result.truncation` 说这份文本不全 ⇒ 直接 `unparsed`，
 *      不拿残缺明细算一个偏小的通过率。
 */
import {
  detectTestFramework,
  parseTestOutput,
  testCommandOf,
  type AgentMessage,
  type RowTestSummary,
  type RunTestResults,
} from '@aieval/contracts';
import { getRowRecords } from './run-artifacts';
import { getRunView } from './runs';

/** 工具入参是任意 JSON：字符串形态先当 JSON 原文读，对象形态序列化后再读（都不抛） */
function commandOfInput(input: unknown): string | null {
  if (typeof input === 'string') return testCommandOf(input);
  try {
    return testCommandOf(JSON.stringify(input));
  } catch {
    // 循环引用 / BigInt：入参不是一份可读的命令，照「没有命令」处置
    return null;
  }
}

/**
 * 纯投影：给一行的折叠后消息，返回这一行的测试结论。
 *
 * 先收齐所有调用命令，再按消息顺序扫结果——调用与结果可能分属两条消息，
 * 单趟扫描会在结果先到的那条上找不到命令。
 */
export function projectRowTestSummary(rowId: string, messages: readonly AgentMessage[]): RowTestSummary {
  const commands = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool-call') continue;
      const command = commandOfInput(block.input);
      if (command !== null && detectTestFramework(command, '') !== null) commands.set(block.callId, command);
    }
  }
  let latest: { command: string; text: string; truncated: boolean } | null = null;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool-result') continue;
      const command = commands.get(block.callId);
      if (command === undefined) continue;
      latest = { command, text: block.text, truncated: block.truncation.kind === 'truncated' };
    }
  }
  if (latest === null) return { rowId, status: 'not-collected' };
  if (latest.truncated) {
    return {
      rowId,
      status: 'unparsed',
      framework: detectTestFramework(latest.command, ''),
      command: latest.command,
      reason: '测试输出被截断，无法确认全量用例',
    };
  }
  const parsed = parseTestOutput({ command: latest.command, output: latest.text });
  if (parsed.status === 'parsed') {
    return {
      rowId,
      status: 'collected',
      framework: parsed.run.framework,
      command: parsed.run.command,
      passed: parsed.run.passed,
      failed: parsed.run.failed,
      skipped: parsed.run.skipped,
      total: parsed.run.total,
    };
  }
  if (parsed.status === 'unparsed') {
    return {
      rowId,
      status: 'unparsed',
      framework: parsed.framework,
      command: latest.command,
      reason: parsed.reason,
    };
  }
  // 命令已判定是测试、输出却没有测试特征：这仍是「有测试命令、读不出结果」，不能记成未采集
  return {
    rowId,
    status: 'unparsed',
    framework: detectTestFramework(latest.command, ''),
    command: latest.command,
    reason: '测试命令的输出没有可识别的测试结果',
  };
}

/**
 * 一轮的测试结果投影（行序 = 快照顺序，服务端不排名）。
 *
 * 逐行降级：某一行消息读不出来时只把那一行记成 `unparsed` 并带原因，
 * 不把整张排名表打空——「一行坏」与「全都没采到」是两句不同的话。
 */
export function getRunTestResults(runId: string): RunTestResults {
  const run = getRunView(runId);
  const rows = run.rows.map((row): RowTestSummary => {
    try {
      return projectRowTestSummary(row.id, getRowRecords(runId, row.id).messages);
    } catch (error) {
      return {
        rowId: row.id,
        status: 'unparsed',
        framework: null,
        command: '',
        reason: `读取消息记录失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  return { rows };
}
