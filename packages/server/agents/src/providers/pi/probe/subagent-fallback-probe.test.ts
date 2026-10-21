// @vitest-environment node
/**
 * 探针二：转写兜底通道的**阴性对照** + 扩展数据读取的解析事实。
 *
 * A. 子会话带一次真工具调用（`bash echo`）：工具结果有没有进产物、轮次对不对。
 * B. **预占 registry 槽**（扩展的 claim 先到先得 ⇒ 它挂不上，wire 的 `getRecord` 永远拿不到会话）
 *    ⇒ 子任务正文**只能**走转写文件通道。这是「兜底通道真的能读到」的阴性对照：
 *    说它读不到，必须先证明文件确实存在且内容对得上。
 * C. `piSubagentsExtensionPath` / `piSubagentsVersion` 的解析事实（含 Next 产物形态的锚点）。
 * D. 身份/会话 id 的拒绝分支。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, it } from 'vitest';
import { removeTreeWithRetry } from '../../../testing/cleanup';
import { anthropicText, anthropicToolUse, runPiConformanceCandidate } from '../../../testing/pi-conformance-fixture';
import { PI_SUBAGENTS_MANAGER_KEY } from '../subagent-wire';
import { piSubagentsExtensionPath, piSubagentsVersion } from '../subagents';
import { piSubagentTranscriptPath } from '../transcript';

const agentDir = mkdtempSync(join(tmpdir(), 'pi-probe2-home-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const wireRoot = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

afterAll(() => {
  removeTreeWithRetry(agentDir);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

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

function report(label: string, run: Awaited<ReturnType<typeof runPiConformanceCandidate>>, newFiles: string[]): void {
  console.log(`[PROBE2:${label}] 新增转写文件 =`, JSON.stringify(newFiles, null, 1));
  const own = run.product.messages.filter((message) => message.subagentId !== null);
  console.log(`[PROBE2:${label}] subagentId!==null 条数 =`, own.length);
  console.log(`[PROBE2:${label}] 逐条 =`, JSON.stringify(own.map((message) => ({
    source: message.source,
    roundTrip: message.roundTrip,
    role: message.role,
    chunk: message.chunk,
    parentCallId: message.parentCallId,
    usage: message.usage === null ? null : 'set',
    mergeKey: message.mergeKey,
    blocks: message.blocks.map((block) => `${block.type}:${JSON.stringify((block as { text?: string }).text ?? (block as { callId?: string }).callId ?? '').slice(0, 40)}`),
  })), null, 1));
  console.log(`[PROBE2:${label}] 子任务行 =`, JSON.stringify(run.product.subagents.map((record) => ({
    id: record.subagentId, name: record.name, status: record.status, outcome: record.outcome, usage: record.usage,
  })), null, 1));
  console.log(`[PROBE2:${label}] 事件里的 WARN/转写/wire 字样 =`, JSON.stringify(
    run.product.events
      .map((event) => JSON.stringify(event))
      .filter((text) => text.includes('转写') || text.includes('wire') || text.includes('WARN'))
      .map((text) => text.slice(0, 300)),
    null, 1,
  ));
  console.log(`[PROBE2:${label}] usage =`, JSON.stringify(run.product.usage));
}

/**
 * ⚠️ 这一份探针里有一条用例（E：后台档）**故意**跑出第三方扩展的未处理拒绝
 * （完成回调打在旧 ctx 上抛 `This extension ctx is stale…`）。进程级不接住它的话，
 * vitest 会把整轮记成「有未处理错误」，其余用例的结论跟着不可信
 * ——故在这里把它接下来、**原样打印**：读数仍然是那条原文，只是不再掀掉整轮。
 */
const probeUnhandled: unknown[] = [];
process.on('unhandledRejection', (error: unknown) => {
  probeUnhandled.push(error);
  console.log('[PROBE2:unhandled]', String(error).slice(0, 300));
});
afterAll(() => {
  console.log('[PROBE2] 整轮被接住的未处理拒绝条数 =', probeUnhandled.length);
});

it('A：子会话带一次真工具调用', async () => {
  const before = new Set(walk(wireRoot));
  const run = await runPiConformanceCandidate({
    prompt: '按剧本收尾。',
    script: [
      anthropicToolUse('Agent', {
        prompt: '先跑一条命令，再回一句话。',
        name: 'tool-agent',
        description: 'child with tool',
        subagent_type: 'general-purpose',
        run_in_background: false,
      }, 'toolu_subagent'),
      anthropicToolUse('bash', { command: 'echo child-tool-ran' }, 'toolu_child_shell'),
      anthropicText('子任务完成。'),
      anthropicText('派发完了。'),
    ],
  });
  const after = walk(wireRoot).filter((path) => !before.has(path));
  report('A', run, after);
  /**
   * 读之前逐条判在场：转写根是**全机共享**的（`os.tmpdir()/pi-subagents-<uid>/…`），同一个 vitest
   * 进程里别的文件也在跑子任务、也会清理这个根 ⇒ 先 `walk` 后 `read` 会偶发 `ENOENT`
   * （单独跑这一条绿、整目录跑偶发一红）。缺了就说清是「被并发用例清掉」，不把它当读数。
   */
  for (const path of after) {
    const full = join(wireRoot, path);
    if (!existsSync(full)) {
      console.log(`[PROBE2:A] 转写原文(${path}) = 已被并发用例清掉（共享转写根，跳过）`);
      continue;
    }
    console.log(`[PROBE2:A] 转写原文(${path}) =`, readFileSync(full, 'utf8').slice(0, 2500));
  }
  for (const path of after) rmSync(join(wireRoot, path), { force: true });
}, 300_000);

it('B：预占 registry 槽 ⇒ wire 拿不到 manager，正文只能走转写兜底', async () => {
  const before = new Set(walk(wireRoot));
  // 扩展的 claim 是先到先得（槽非空就不写）⇒ 这个候选扩展的 manager 永远不挂上
  (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY] = { getRecord: (): undefined => undefined };
  let run: Awaited<ReturnType<typeof runPiConformanceCandidate>>;
  try {
    run = await runPiConformanceCandidate({
      prompt: '按剧本收尾。',
      script: [
        anthropicToolUse('Agent', {
          prompt: '只回一句话：子任务完成。',
          name: 'fallback-agent',
          description: 'fallback subagent',
          subagent_type: 'general-purpose',
          run_in_background: false,
        }, 'toolu_subagent'),
        anthropicText('子任务完成。'),
        anthropicText('派发完了。'),
      ],
    });
  } finally {
    delete (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY];
  }
  const after = walk(wireRoot).filter((path) => !before.has(path));
  report('B', run, after);
  for (const path of after) console.log(`[PROBE2:B] 转写原文(${path}) =`, readFileSync(join(wireRoot, path), 'utf8').slice(0, 1500));
  for (const path of after) rmSync(join(wireRoot, path), { force: true });
}, 300_000);

it('C：扩展入口 / 版本的解析事实（含 Next 产物形态的锚点）', () => {
  const entry = piSubagentsExtensionPath();
  console.log('[PROBE2:C] piSubagentsExtensionPath() =', entry);
  console.log('[PROBE2:C] piSubagentsVersion() =', piSubagentsVersion(entry));
  console.log('[PROBE2:C] 入口存在 =', existsSync(entry));
  const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8')) as Record<string, unknown>;
  console.log('[PROBE2:C] pi 字段 =', JSON.stringify(manifest['pi']));
  console.log('[PROBE2:C] main/exports/type =', JSON.stringify({ main: manifest['main'], exports: manifest['exports'], type: manifest['type'] }));
  console.log('[PROBE2:C] dist/index.js 前 3 行 =', readFileSync(join(dirname(dirname(entry)), 'dist/index.js'), 'utf8').split('\n').slice(0, 3).join(' | ').slice(0, 300));
  // 模拟 Next 服务端产物里的 `import.meta.url` 锚点（.next/server/chunks/xxx.js）
  const nextAnchor = join(repoRoot, 'apps/web-next/.next/server/chunks/probe-anchor.js');
  for (const anchor of [nextAnchor, join(repoRoot, 'apps/web-next/noop.js'), join(repoRoot, 'noop.js')]) {
    try {
      const resolved = createRequire(anchor).resolve('@tintinweb/pi-subagents/package.json');
      console.log('[PROBE2:C] 锚点可解析 =', anchor, '⇒', resolved);
    } catch (error) {
      console.log('[PROBE2:C] 锚点解析失败 =', anchor, '⇒', error instanceof Error ? error.message : String(error));
    }
  }
});

it('D：身份 / 会话 id 的拒绝分支', () => {
  const base = { cwd: '/tmp/whatever', sessionId: '01a1444f-506b-7514-bd4e-b6c9ac65a341', agentId: '1847b923-8da2-48a' };
  console.log('[PROBE2:D] 真机那一对 id ⇒', piSubagentTranscriptPath(base));
  for (const [sessionId, agentId] of [
    ['..', 'a'], ['a/../b', 'a'], ['../../etc', 'a'], ['a/b', 'a'], ['a\\b', 'a'],
    ['ok', '..'], ['ok', '../../evil'], ['ok', 'a/b'], ['ok', 'a\\b'], ['ok', 'a.b'], ['ok', 'a b'], ['ok', ''], ['', 'a'],
  ] as Array<[string, string]>) {
    console.log(`[PROBE2:D] sessionId=${JSON.stringify(sessionId)} agentId=${JSON.stringify(agentId)} ⇒`, piSubagentTranscriptPath({ ...base, sessionId, agentId }));
  }
});

it('E：后台档派发（run_in_background: true，也就是该入参的缺省值）', async () => {
  const before = new Set(walk(wireRoot));
  const run = await runPiConformanceCandidate({
    prompt: '按剧本收尾。',
    script: [
      anthropicToolUse('Agent', {
        prompt: '只回一句话：子任务完成。',
        name: 'bg-agent',
        description: 'background subagent',
        subagent_type: 'general-purpose',
        run_in_background: true,
      }, 'toolu_bg'),
      anthropicText('派发完了。'),
      anthropicText('子任务完成。'),
    ],
  });
  const after = walk(wireRoot).filter((path) => !before.has(path));
  report('E', run, after);
  for (const path of after) console.log(`[PROBE2:E] 转写原文(${path}) =`, readFileSync(join(wireRoot, path), 'utf8').slice(0, 1200));
  await new Promise((resolve) => setTimeout(resolve, 800));
  console.log('[PROBE2:E] 运行落定后再看消息条数 =', run.product.messages.length,
    '带 subagentId 的 =', run.product.messages.filter((message) => message.subagentId !== null).length);
  for (const path of after) rmSync(join(wireRoot, path), { force: true });
}, 300_000);
