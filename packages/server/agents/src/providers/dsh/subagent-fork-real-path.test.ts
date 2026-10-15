// @vitest-environment node
/**
 * dsh **派发工具名**的真机判据：`subagent` 与 `subagent_fork` 两条路都要能指出派发点。
 *
 * 为什么必须真机：`subagent_fork` 是不是**也会派子智能体**，只有厂商的运行时说了算——它由
 * `dsh-base/cordis.patch.yml` 把同一个插件（`@deepseek-ai/dsh-tool-subagent`）挂两次而来
 * （`{provider: 'spawn', toolName: 'subagent'}` 与 `{provider: 'fork', toolName: 'subagent_fork'}`），
 * 而工具表里两个名字并列。假件替不掉这一格：真机两臂的差别正是「fork 那条路会不会投
 * `subagent.started` / `subagent/catalog`」。
 *
 * 判据是**收尾那条记录**的 `parentCallId`（不是每一条）：第一条在 `subagent.started` 那一刻
 * 必然没有派发点——任务名（`subagent/catalog`）还没到，认领无从谈起，那是设计如此。
 * 少了这个认领，派发行只能靠界面「任务名逐字相同」那条兜底判据挂到某一轮上，撞名即落空。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, SubagentRecord } from '@aieval/contracts';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { createRunInput, collectEvents } from '../../testing/agent-fixtures';
import { startDshScriptedUpstream } from '../../testing/dsh-real-path-fixture';
import { setAgentRuntimeForTesting } from '../../runtime';
import { dshProvider } from './index';

/** 一次真机运行里，那个子任务的记录与派发点 */
interface ArmObservation {
  records: SubagentRecord[];
  /** 收尾那条（目录项早已到达）能不能指出派生它的那次调用 */
  settledParentCallId: string | null;
}

async function runArm(toolName: 'subagent' | 'subagent_fork'): Promise<ArmObservation> {
  const root = mkdtempSync(join(tmpdir(), 'aieval-dsh-fork-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.dshhome');
  mkdirSync(cwd, { recursive: true });
  const upstream = await startDshScriptedUpstream({
    callId: 'call_fork_probe_1',
    toolName,
    args: { description: '探针子任务', prompt: '回一句话就好。' },
    finalText: '收尾。',
  });
  setAgentRuntimeForTesting(null);
  try {
    const records: SubagentRecord[] = [];
    const events: AgentEvent[] = [];
    await dshProvider.run({
      ...createRunInput({
        cwd,
        configHome,
        permission: 'full',
        prompt: `请用 ${toolName} 派一个子任务，然后收尾。`,
        route: {
          protocolType: 'anthropic',
          baseUrl: upstream.url,
          apiKey: 'probe-placeholder',
          modelId: 'real-path-model',
        },
        onEvent: collectEvents(events),
        onSubagent: (record: SubagentRecord) => records.push(record),
      }),
    });
    return { records, settledParentCallId: records.at(-1)?.parentCallId ?? null };
  } finally {
    upstream.close();
    setAgentRuntimeForTesting(null);
    removeTreeWithRetry(root);
  }
}

describe('dsh 派发工具名（真机）', () => {
  it('`subagent` 与 `subagent_fork`：两条路都派出子任务，且收尾那条都带派发点', async () => {
    const spawn = await runArm('subagent');
    const fork = await runArm('subagent_fork');
    expect(spawn.records.length, '`subagent` 臂没派出子任务（剧本或工具表变了）').toBeGreaterThan(0);
    expect(fork.records.length, '`subagent_fork` 臂没派出子任务 ⇒ 它走的不是这条通道，判据要重定').toBeGreaterThan(0);
    expect(spawn.settledParentCallId, '`subagent` 臂丢了派发点').not.toBeNull();
    expect(fork.settledParentCallId, '`subagent_fork` 臂丢了派发点（派发工具名漏了它）').not.toBeNull();
  }, 180_000);
});
