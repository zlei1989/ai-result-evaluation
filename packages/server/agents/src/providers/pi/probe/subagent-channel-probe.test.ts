// @vitest-environment node
/**
 * 探针：子智能体两条通道（wire / 转写文件）的**真机读数**。
 *
 * 只读事实，不改判据：真适配器 + 真 SDK + 真扩展 + 假网关跑一轮派发，然后把
 *   · 扩展**实际写出**的转写文件路径（`os.tmpdir()/pi-subagents-<uid>/…` 全树枚举）
 *   · 适配器**算出来**的路径（`piSubagentTranscriptPath`）
 *   · 产物里 `subagentId !== null` 的消息（条数 / source / roundTrip / chunk）
 * 三份事实并排打出来。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, it } from 'vitest';
import { removeTreeWithRetry } from '../../../testing/cleanup';
import { anthropicText, anthropicToolUse, runPiConformanceRow } from '../../../testing/pi-conformance-fixture';
import { piSubagentTranscriptPath } from '../transcript';

const agentDir = mkdtempSync(join(tmpdir(), 'pi-probe-subagent-home-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const wireRoot = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);

/** 枚举 wireRoot 下所有文件（相对路径） */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

afterAll(() => {
  removeTreeWithRetry(agentDir);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

it('探针：真机派发一次，读三条通道的事实', async () => {
  const before = new Set(walk(wireRoot));
  let rowCwd = '';
  const run = await runPiConformanceRow({
    prompt: '按剧本收尾。',
    cwdSetup: (cwd) => { rowCwd = cwd; },
    script: [
      anthropicToolUse('Agent', {
        prompt: '只回一句话：子任务完成。',
        name: 'pong-agent',
        description: 'conformance subagent',
        subagent_type: 'general-purpose',
        run_in_background: false,
      }, 'toolu_subagent'),
      anthropicText('子任务完成。'),
      anthropicText('派发完了。'),
    ],
  });

  const after = walk(wireRoot).filter((path) => !before.has(path));
  console.log('[PROBE] wireRoot =', wireRoot);
  console.log('[PROBE] 本次新增的转写文件 =', JSON.stringify(after, null, 2));
  console.log('[PROBE] row cwd =', rowCwd);
  console.log('[PROBE] outcome.sessionId（会话文件）=', run.outcome.sessionId);

  const sessionFile = run.outcome.sessionId ?? '';
  const sessionId = sessionFile.split('/').pop()?.replace(/\.jsonl$/, '').split('_').slice(1).join('_') ?? '';
  console.log('[PROBE] 从会话文件名反推的 sessionId =', sessionId);

  for (const record of run.product.subagents) {
    const path = piSubagentTranscriptPath({ cwd: rowCwd, sessionId, agentId: record.subagentId });
    console.log('[PROBE] 适配器算出的转写路径 =', path, '存在 =', path !== null && existsSync(path));
    if (path !== null && existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      console.log('[PROBE] 文件行数 =', text.split('\n').filter((line) => line.trim() !== '').length, '字节 =', text.length);
      console.log('[PROBE] 首行 =', text.split('\n')[0]?.slice(0, 300));
    }
  }

  const own = run.product.messages.filter((message) => message.subagentId !== null);
  console.log('[PROBE] subagentId !== null 的消息条数 =', own.length);
  console.log('[PROBE] 逐条 =', JSON.stringify(own.map((message) => ({
    subagentId: message.subagentId,
    source: message.source,
    roundTrip: message.roundTrip,
    role: message.role,
    chunk: message.chunk,
    parentCallId: message.parentCallId,
    usage: message.usage === null ? null : 'set',
    text: message.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('').slice(0, 60),
  })), null, 2));
  console.log('[PROBE] 子任务行 =', JSON.stringify(run.product.subagents.map((record) => ({
    subagentId: record.subagentId,
    name: record.name,
    status: record.status,
    statusMissing: record.statusMissing,
    outcome: record.outcome,
    usage: record.usage,
    parentCallId: record.parentCallId,
  })), null, 2));
  console.log('[PROBE] 含「转写读不到」的事件 =', JSON.stringify(
    run.product.events.filter((event) => JSON.stringify(event).includes('转写')).map((event) => JSON.stringify(event).slice(0, 400)),
    null,
    2,
  ));
  console.log('[PROBE] 含「wire」的事件 =', JSON.stringify(
    run.product.events.filter((event) => JSON.stringify(event).includes('wire')).map((event) => JSON.stringify(event).slice(0, 300)),
    null,
    2,
  ).slice(0, 2000));
  console.log('[PROBE] usage =', JSON.stringify(run.product.usage));

  for (const path of after) {
    rmSync(join(wireRoot, path), { force: true });
  }
}, 300_000);
