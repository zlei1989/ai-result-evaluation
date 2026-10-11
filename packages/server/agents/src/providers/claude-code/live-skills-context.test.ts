// @vitest-environment node
/**
 * **真机**：claude 这一行的**技能面**（L3 判据）——「厂商到底认没认我们装进去的那条 skill」。
 *
 * 为什么这条判据是承重的：真机行里文件确实装上了（L1 成功），而模型**一次工具都没调**、
 * 哨兵串没命中。两种可能分不开：**① 这家没把 skill 放进会话的技能面** vs
 * **② 这个模型不肯调 `Skill`**（网关后面不是 Claude 模型）。本文件把 ① 变成可读的事实：
 * `getContextUsage().skills.skillFrontmatter` 是厂商自己列出的那份清单（带 `source`），
 * 它在不在里面，与模型的行为无关。
 *
 * 两条口径：
 *   · **判据一个字都不读模型答复**（同 `row-mcp.ts` 的文件头）：模型说「我按技能做了」在证据
 *     等级上是零——真机抓到过「没调上、模型却把结果编出来」；
 *   · **不断言行为**：模型调不调 `Skill` 是**观察项**（打印出来供报告读），
 *     本文件断言的只有「清单里有没有我们的名字」这一条硬事实。
 *
 * 顺带量一件事：**被测仓库自带 skill 的 `source` 原值**（`<cwd>/.claude/skills/`）——
 * 来源分档（本机启用项 / 厂商内置 / 被测仓库自带）的那张表要按实测取值写，不许按命名推测。
 *
 * 开关（默认跳过；会真的起 CLI、真的调模型）：
 * ```
 * AIEVAL_LIVE_SKILL_CONTEXT=1 \
 * [AIEVAL_LIVE_SKILL_CONTEXT_MODEL=GLM-5.3] \
 * ./node_modules/.bin/vitest run packages/server/agents/src/providers/claude-code/live-skills-context.test.ts
 * ```
 * 供应商读**宿主的** `~/.aieval/config.json` 里第一条 `anthropic`（与其他真机探针同一个来源）。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage } from '@aieval/contracts';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { claudeCodeProvider } from './index';

/** 探针的哨兵串：skill 正文最后一行要求逐字写出它——「模型真按 skill 走」的唯一判据 */
const SENTINEL = 'AIEVAL-SKILL-OK-7f3a';
const SKILL_NAME = 'tang-poem-meal';
const REPO_SKILL_NAME = 'repo-owned-probe';

const ENABLED = process.env['AIEVAL_LIVE_SKILL_CONTEXT'] === '1';
/** 等待上限按**分钟**留：网关冷启动实测 17.7 s、热了 3.5–5.5 s */
const TIMEOUT_MS = 600_000;

const SKILL_BODY = `---
name: ${SKILL_NAME}
description: 当用户让你推荐唐诗时，必须按本技能的规则作答
---

推荐唐诗时，只推荐一首与「吃饭 / 饮食」有关的唐诗。
答复的最后一行必须逐字写出这一行：${SENTINEL}
`;

/** 被测仓库自带的那一条（只为量它的 `source` 原值，正文与服务端行为无关） */
const REPO_SKILL_BODY = `---
name: ${REPO_SKILL_NAME}
description: 仓库自带的探针 skill（只为观测来源原值）
---

这条 skill 是被测仓库自带的，本行不该由我们装入它。
`;

function hostAnthropicProvider(): { baseUrl: string; apiKey: string; modelId: string } | null {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8')) as {
      providers?: { protocolType?: string; baseUrl?: string; apiKey?: string; models?: { id?: string }[] }[];
    };
    const provider = (config.providers ?? []).find((item) => item.protocolType === 'anthropic');
    const modelId = process.env['AIEVAL_LIVE_SKILL_CONTEXT_MODEL'] ?? provider?.models?.[0]?.id;
    if (provider?.baseUrl === undefined || provider.apiKey === undefined || modelId === undefined) return null;
    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId };
  } catch {
    return null;
  }
}

/**
 * 模型**真的调用过**的工具名：只认内容级消息里的 `tool-call` 块（`messages.jsonl` 的唯一真源）。
 *
 * 为什么不 grep 事件的原始文本：`log` 事件里混着工具**结果**与文件正文，
 * `agents-md` / `telemetry` 这类词就在被测仓库的 `CLAUDE.md` 里出现过——那种「命中」是假证据。
 */
function toolNames(messages: readonly AgentMessage[]): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool-call') names.add(block.name);
    }
  }
  return [...names];
}

describe.skipIf(!ENABLED)('真机：claude 的技能面（L3）与模型行为', () => {
  it('技能面里有没有我们的名字 + 模型调不调 Skill + 仓库自带 skill 的 source 原值', async () => {
    const provider = hostAnthropicProvider();
    if (provider === null) {
      console.warn('宿主配置里没有 anthropic 供应商，跳过真机技能面探针');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'aieval-live-skill-context-'));
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    const sourceDir = join(root, 'skills-src', SKILL_NAME);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'SKILL.md'), SKILL_BODY, 'utf8');
    // 被测仓库自带的那一条：`settingSources` 三档全开 ⇒ CC 会自动发现它（跨家的静默差异）
    mkdirSync(join(cwd, '.claude', 'skills', REPO_SKILL_NAME), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'skills', REPO_SKILL_NAME, 'SKILL.md'), REPO_SKILL_BODY, 'utf8');

    const events: AgentEvent[] = [];
    const messages: AgentMessage[] = [];
    const controller = new AbortController();
    try {
      const result = await claudeCodeProvider.run({
        cwd,
        configHome,
        permission: 'full',
        prompt: '请给我推荐一首唐诗。',
        route: {
          protocolType: 'anthropic',
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          modelId: provider.modelId,
        },
        signal: controller.signal,
        skills: [{ name: SKILL_NAME, sourceDir }],
        onEvent: (event) => events.push(event),
        onMessage: (message) => messages.push(message),
      });

      /**
       * 判据：**最后一条** `vendor-system` 里的技能面（本行只在收尾发一条带它的）。
       * 读侧取最后一条的理由与编排层逐字相同（后到的覆盖先到的）。
       */
      const vendor = [...events].reverse().find((event) => event.type === 'vendor-system');
      const skills = vendor?.skills ?? null;
      const tools = toolNames(messages);
      const sentinelHit = typeof result.finalText === 'string' && result.finalText.includes(SENTINEL);

      // 证据原样打印（报告读它，别让读者只看结论）
      console.log(`[live-skill-context] model=${provider.modelId} exitReason=${result.exitReason} turns=${String(result.turns)}`);
      console.log('[live-skill-context] 技能面（vendor-system.skills）：', JSON.stringify(skills));
      console.log('[live-skill-context] 工具调用名：', JSON.stringify(tools));
      console.log('[live-skill-context] 哨兵命中：', sentinelHit, '| finalText 末 200 字：', String(result.finalText).slice(-200));
      console.log('[live-skill-context] 行内装到的文件：', readFileSync(join(configHome, 'skills', SKILL_NAME, 'SKILL.md'), 'utf8').split('\n')[1]);

      /**
       * **硬判据只有一条**：厂商的技能面真的采到了（`skills !== null`）。
       * 采不到时这一条会红，而那是**如实**的红——它说明这条真机证据不成立（不是「没装上」）。
       */
      expect(skills, '技能面没采到（vendor-system.skills 为 null）：本次真机证据不成立').not.toBeNull();
      /**
       * 名字在不在清单里**如实打印、由报告判定**，不写成断言：
       * 「不在」是一个要交上去的**结论**（⇒ 是我们的缺陷，回头查封面那条链），
       * 而不是「探针坏了」。写成断言会让这一条从「读数」变成「立场」。
       */
      const ours = (skills ?? []).filter((entry) => entry.name === SKILL_NAME);
      console.log('[live-skill-context] 我们的名字在技能面里：', ours.length > 0, JSON.stringify(ours));
      // 装了的那条必须至少出现在「我们发现得了」的那一份事实里：清单为空 ⇒ 一定是缺陷，不是模型行为
      expect((skills ?? []).length, '技能面是空的（厂商一条都没列）').toBeGreaterThan(0);
    } finally {
      removeTreeWithRetry(root);
    }
  }, TIMEOUT_MS);
});
