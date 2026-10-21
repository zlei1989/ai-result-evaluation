// @vitest-environment node
/**
 * **真机整个候选**：一条启用的 skill 真的落进了**三家各自**那一候选的配置目录（整目录、含附属文件），
 * 停用的那条不在；源目录读不到时**该候选失败**、点名哪一条、且**不自动重试**。
 *
 * 与 `agents` 包那三份同名守卫（`providers/<家>/skills.test.ts`）的分工：那三份钉的是**适配器**
 * （假 SDK、真物化、各自的 boot 点）；本文件钉的是**编排层整条链**——技能根里的目录 →
 * `installableSkills` → `run()` 入参 → 真适配器 → 真物化 → 候选配置目录里的文件 / 候选失败。
 * 中间任何一环接错，判据都不是「少一个文件」而是「这个候选看起来正常地跑完了」，而那正是这条链最该防的假绿。
 *
 * 三家的**落点同形**（`<候选配置目录>/skills/<名称>/SKILL.md`），差异只有两处，都在断言里点名：
 *   · codex 首启会把 6 个**内置** skill 物化进**同一个** `skills/` 下的 `.system/`
 *     ⇒ 「清单外不碰」这条口径在它身上是可观测的（物化若整目录清空，`.system` 会消失）；
 *   · 「模型真按 skill 走了一次」的证据形态逐家不同（claude 发 `Skill` 工具、codex 没有 Skill 工具
 *     ⇒ 认它真读了 `SKILL.md`、dsh 发 `skill` 工具），故本文件只**如实打印**工具活动，
 *     行为硬门槛归真机冒烟（候选内自动观测按家尽力而为）。
 *
 * 两组的**成本不同**，故分开说明：
 *   · 「装入成功」那一组走**真厂商**（真 CLI + 真模型）：判据在候选配置目录里的文件上（L1），
 *     另把模型答复里有没有踩中 skill 里的哨兵串**打印出来**——那是行为面的观察，不断言；
 *   · 「装不进去」那组**不需要网关**：物化在起进程之前就失败（所以它跑得再真也不发一次请求），
 *     判据是候选状态 + 归因码 + 尝试次数。
 *
 * 开关（默认跳过；成功那组会真的起 CLI、真的调模型）：
 * ```
 * AIEVAL_LIVE_CANDIDATE_SKILLS=1 ./node_modules/.bin/vitest run packages/server/evaluator/src/live-candidate-skills.test.ts
 * ```
 * 供应商读宿主 `~/.aieval/config.json` 的**第一条对应协议**的记录（claude 用 `anthropic`、
 * codex 与 dsh 用 `openai`；读不到 ⇒ 那一家如实跳过，不变成环境性红）；
 * 配置目录与用例目录都指到临时目录（`createTempHome`），绝不碰宿主那份配置。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentKind, ProtocolType } from '@aieval/contracts';
import { foldMessages, candidateAgentHomeDir, candidateMessagesFile, readCandidateRecords } from '@aieval/core';
import { CANDIDATE_RETRY, runCandidate } from './orchestrator';
import { getRun, saveRun } from './run-store';
import {
  createTempHome,
  initFixtureRepo,
  makeCaseFixture,
  makeProviderFixture,
  makeCandidateFixture,
  makeRunFixture,
  seedConfig,
  type TempHome,
} from './testing/fixtures';

const ENABLED = process.env['AIEVAL_LIVE_CANDIDATE_SKILLS'] === '1';
/** 等待上限按**分钟**留：网关冷启动实测 17.7 s、热了 3.5–5.5 s，一个候选里还有多次模型往返 */
const TIMEOUT_MS = 600_000;

/** 三家各跑一行：同一份技能根、同一个题面，差异只在 `agentKind` 与它认的协议 */
const VENDORS: ReadonlyArray<{ kind: AgentKind; protocol: ProtocolType }> = [
  { kind: 'cc', protocol: 'anthropic' },
  { kind: 'codex', protocol: 'openai' },
  { kind: 'dsh', protocol: 'openai' },
];

/**
 * 靶子技能：极简、必然被触发。
 * 末候选的哨兵串不是装饰——唐诗是模型**本来就会**的东西，「答复里出现唐诗」证明不了它读过这个 skill。
 */
const TARGET_SKILL = `---
name: tang-poem-meal
description: 当用户让你推荐唐诗时，必须按本技能的规则作答
---

推荐唐诗时，只推荐一首与「吃饭 / 饮食」有关的唐诗。
答复的最后一行必须逐字写出这个候选：AIEVAL-SKILL-OK-7f3a
`;

/** 哨兵串：模型答复里出现它 = 它真的按这条 skill 走过一次（行为面观察，不是硬门槛） */
const SENTINEL = 'AIEVAL-SKILL-OK-7f3a';

/** 停用对照用的第二条（内容随便，它**不该**出现在候选内） */
const DISABLED_SKILL = `---
name: disabled-one
description: 停用对照：它不该出现在候选配置目录里
---

无论用户说什么，都回答「不应答」。
`;

/** 宿主配置里第一条该协议的供应商（读不到返回 `null` ⇒ 那一组如实跳过，不变成环境性红） */
function hostProvider(protocol: ProtocolType, model?: string): { baseUrl: string; apiKey: string; modelId: string } | null {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8')) as {
      providers?: { protocolType?: string; baseUrl?: string; apiKey?: string; models?: { id?: string }[] }[];
    };
    const provider = (config.providers ?? []).find((item) => item.protocolType === protocol);
    const modelId = model ?? provider?.models?.[0]?.id;
    if (provider?.baseUrl === undefined || provider.apiKey === undefined || modelId === undefined) return null;
    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId };
  } catch {
    return null;
  }
}

/** 在**技能根**里造一条 skill：`<配置目录>/skills/<名称>/SKILL.md`（可再给若干附属文件） */
function seedSkillInRoot(skillsRoot: string, name: string, markdown: string, extras: Record<string, string> = {}): string {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8');
  for (const [rel, content] of Object.entries(extras)) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return dir;
}

let home: TempHome | null = null;
afterEach(() => {
  home?.cleanup();
  home = null;
});

for (const vendor of VENDORS) {
  describe.skipIf(!ENABLED)(`真机整个候选：${vendor.kind} 的 skill 装入`, () => {
    it('启用的那条整目录落进行配置目录（含附属文件），停用的那条不在，行正常跑完', async () => {
      const live = hostProvider(vendor.protocol);
      if (live === null) {
        console.warn(`宿主配置里没有 ${vendor.protocol} 协议的供应商，跳过 ${vendor.kind} 那一行`);
        return;
      }
      home = createTempHome();
      const repo = initFixtureRepo(join(home.root, 'repo'));
      const skillsRoot = join(home.configDir, 'skills');
      const targetSource = seedSkillInRoot(skillsRoot, 'tang-poem-meal', TARGET_SKILL, {
        'references/example.md': '# 附属文件\n\n这个文件必须跟着一起装进去。\n',
        'scripts/list.sh': '#!/bin/sh\necho tang\n',
      });
      seedSkillInRoot(skillsRoot, 'disabled-one', DISABLED_SKILL);

      const provider = makeProviderFixture({
        protocolType: vendor.protocol,
        baseUrl: live.baseUrl,
        apiKey: live.apiKey,
        models: [{ id: live.modelId, source: 'manual' }],
      });
      const testCase = makeCaseFixture({
        repoPath: repo.repoPath,
        commitHash: repo.commit,
        // 题面就是规格里那一句：它会命中 tang-poem-meal 的 description
        taskPrompt: '请给我推荐一首唐诗。',
      });
      /**
       * 评分走**文本通路**，与候选用哪一家、哪种协议无关 ⇒ 固定挑宿主那条 `anthropic` 记录。
       *
       * 为什么不让候选那一候选的供应商兼作评分：本探针只回答「技能装没装上」，评分模型跟着候选走会让
       * 每一轮的评分端点随宿主配置漂移；固定一条记录，判据才与「这次用了哪家」解耦。
       */
      const judge = hostProvider('anthropic') ?? live;
      const judgeProvider = makeProviderFixture({
        protocolType: judge === live ? vendor.protocol : 'anthropic',
        baseUrl: judge.baseUrl,
        apiKey: judge.apiKey,
        models: [{ id: judge.modelId, source: 'manual' }],
      });
      seedConfig({
        workspaceRoot: home.workspaceRoot,
        providers: [provider, judgeProvider],
        cases: [testCase],
        // 评分走文本通路：不配它那一个候选会以「未配置评分模型」收场，
        // 而那是与本题无关的失败面——本探针要看的是候选那一段的装入与收场
        defaultJudge: { providerId: judgeProvider.id, modelId: judge.modelId },
        // 停用名单：那一条**只**在设置页里有痕迹，装入侧必须照它剔掉
        skills: { 'disabled-one': { disabled: true } },
      });
      const candidate = makeCandidateFixture({
        agentKind: vendor.kind,
        providerId: provider.id,
        providerName: provider.name,
        baseUrl: provider.baseUrl,
        modelId: live.modelId,
      });
      const run = makeRunFixture({
        workspaceRoot: home.workspaceRoot,
        caseId: testCase.id,
        executionMode: 'parallel',
        candidates: [candidate],
        repoPath: repo.repoPath,
        commitHash: repo.commit,
      });
      saveRun(run);

      // 真机探针**不重试**：瞬时失败重试一次就是再起一遍 CLI、再花一次配额
      const productionRetries = CANDIDATE_RETRY.maxRetries;
      CANDIDATE_RETRY.maxRetries = 0;
      try {
        await runCandidate(run.id, candidate.id);
        const settled = getRun(run.id).candidates[0];
        const agentHome = candidateAgentHomeDir(home.workspaceRoot, run.id, candidate.id);
        const installed = join(agentHome, 'skills', 'tang-poem-meal');
        const installedNames = existsSync(join(agentHome, 'skills')) ? readdirSync(join(agentHome, 'skills')) : [];
        const log = (line: string): void => console.log(`[live-candidate-skills] ${vendor.kind} ${line}`);
        log(`候选状态：${settled?.status ?? '(无)'} | 归因：${JSON.stringify(settled?.error ?? null)}`);
        log(`候选内技能目录：${installedNames.join(', ') || '(不存在)'}`);
        /**
         * 行为面的**观察**（不是硬门槛）：答复从该候选的消息日志里读——候选快照上没有答复那一格
         * （`finalText` 是运行结果上的值，它只进评分通路）。哨兵串在 → 这条 skill 真的被模型用过一次；
         * 不在也不能判这个候选失败（「候选内自动观测按家尽力而为」是这一档的口径，行为硬门槛归真机冒烟），
         * 故这里只打印、不断言。
         */
        const transcript = foldMessages(readCandidateRecords(candidateMessagesFile(home.workspaceRoot, run.id, candidate.id)).messages).filter(
          (message) => message.subagentId === null && message.role === 'assistant',
        );
        const answer = transcript
          .flatMap((message) => message.blocks)
          .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
          .join('\n')
          .trim();
        /**
         * 这个候选**真调过哪些工具**（归一后的原始名）+ 每条调用的一句话活动摘要。
         * 三家的「调用成功」证据形态不同：claude 找 `Skill`、dsh 找 `skill`，而 codex **没有**
         * Skill 工具 ⇒ 看的是它有没有真去读 `SKILL.md`（摘要里带文件名）。
         */
        const toolCalls = transcript
          .flatMap((message) => message.blocks)
          .flatMap((block) => (block.type === 'tool-call' ? [block] : []));
        const toolNames = [...new Set(toolCalls.map((block) => block.name))];
        log(`模型答复：${answer.slice(0, 300) || '(未采到)'}`);
        log(`候选调过的工具：${toolNames.join(', ') || '(一个都没有)'}`);
        log(`工具活动：${toolCalls.map((block) => block.summary ?? block.name).slice(0, 8).join(' | ') || '(无)'}`);
        log(`哨兵命中：${answer.includes(SENTINEL)}`);

        // ① 硬判据（L1）：整目录落盘，入口与附属文件逐字相同
        expect(existsSync(join(installed, 'SKILL.md'))).toBe(true);
        expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(targetSource, 'SKILL.md'), 'utf8'));
        expect(readFileSync(join(installed, 'references', 'example.md'), 'utf8')).toBe('# 附属文件\n\n这个文件必须跟着一起装进去。\n');
        // ② 停用的那条不在（「停用 = 文件级不放」是三家统一的停用手段）
        expect(existsSync(join(agentHome, 'skills', 'disabled-one'))).toBe(false);
        /**
         * ③ 「清单外不碰」：codex 首启会把 6 个**内置** skill 物化进同一个 `skills/` 下的 `.system/`
         * ——它必须还在（物化整目录清空就会把它抹掉，而那只在厂商侧表现为「内置能力凭空少了 6 条」）。
         * 除它之外，`skills/` 下只允许有清单里那一条。
         */
        expect(installedNames.filter((name) => name !== '.system')).toEqual(['tang-poem-meal']);
        // ④ 装入没让这个候选变样：照常跑完（评分通路也是真的）
        expect(settled?.status).toBe('judged');
        expect(settled?.error ?? null).toBeNull();
      } finally {
        CANDIDATE_RETRY.maxRetries = productionRetries;
      }
    }, TIMEOUT_MS);
  });
}

/**
 * **装不进去 ⇒ 该候选失败、点名哪一条、不自动重试**。
 *
 * 只跑一家：这一组的判定点在**编排层**（候选失败 + 不重试），与是哪一家无关；而「物化失败归成
 * `AGENT_SKILLS_UNAVAILABLE`」这一格，三家适配器各自有一份不花钱的守卫
 * （`providers/<家>/skills.test.ts`，假 SDK + 真物化）。
 *
 * 源目录「读不到」的造法：技能目录里放一个权限 `0000` 的**文件**——扫描器只看入口文件与目录名
 * （大小统计是 best-effort，读不到就缺席），所以这条在设置页里是**合格**的；
 * 而整目录复制必须读它 ⇒ `EACCES`。这正是这一条要覆盖的形状：
 * 「扫过之后源目录变得读不到」在真实使用里是用户删了 / 挪了 / 权限变了。
 * ⚠️ **不能拿一个 `0000` 的目录当靶子**：`cpSync` 递归进不去那个目录时抛的是 libuv 之外的
 * C++ 异常（`libc++abi: terminating due to uncaught exception … directory_iterator`），
 * **整个测试进程当场终止**——那是被测机制之外的环境噪声，不是这条要覆盖的失败面。
 *
 * 它跑的是**真适配器**（不是假 provider），所以与真机同处一个文件；但它**不需要网关**——
 * 物化发生在起进程之前，失败之后一次请求都不会发。
 */
describe.skipIf(!ENABLED)('真机整个候选：装不进去 ⇒ 该候选失败', () => {
  it('源目录读不到 ⇒ 行 failed + `AGENT_SKILLS_UNAVAILABLE` + 点名 + attempts 停在 1', async () => {
    home = createTempHome();
    const repo = initFixtureRepo(join(home.root, 'repo'));
    const skillsRoot = join(home.configDir, 'skills');
    const source = seedSkillInRoot(skillsRoot, 'locked-skill', TARGET_SKILL.replace('tang-poem-meal', 'locked-skill'));
    const locked = join(source, 'secret.md');
    writeFileSync(locked, '读不到的内容\n', 'utf8');
    // 0000：谁都读不出来（目录的 r-x 照旧，故扫描与 stat 都不受影响）。跑完必须改回来，
    // 否则临时目录删不掉（`rmSync` 删一个 0000 文件是允许的，但留着它会让「读不到」这件事外溢）
    chmodSync(locked, 0o000);

    const provider = makeProviderFixture({
      protocolType: 'anthropic',
      // 这个候选**永远走不到**发请求那一步（物化先失败）；地址刻意用一个不存在的主机，
      // 万一哪天物化被绕过，它会**响亮地**失败而不是静默地打真网关
      baseUrl: 'https://skills-probe.invalid/anthropic',
      models: [{ id: 'probe-model', source: 'manual' }],
    });
    const testCase = makeCaseFixture({ repoPath: repo.repoPath, commitHash: repo.commit, taskPrompt: '随便说点什么。' });
    seedConfig({ workspaceRoot: home.workspaceRoot, providers: [provider], cases: [testCase], defaultJudge: null });
    const candidate = makeCandidateFixture({
      agentKind: 'cc',
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      modelId: 'probe-model',
    });
    const run = makeRunFixture({
      workspaceRoot: home.workspaceRoot,
      caseId: testCase.id,
      executionMode: 'parallel',
      candidates: [candidate],
      repoPath: repo.repoPath,
      commitHash: repo.commit,
    });
    saveRun(run);

    /** 诊断信息（断言失败时唯一能回答「它到底怎么失败的」的东西） */
    const report = (): string => `package=${JSON.stringify(getRun(run.id).candidates[0]?.error ?? null)}`;
    // 打开产品默认的重试预算：这一条要同时证「候选失败」与「失败之后没有被自动重跑」
    const productionRetries = CANDIDATE_RETRY.maxRetries;
    const productionDelay = CANDIDATE_RETRY.delayMs;
    CANDIDATE_RETRY.maxRetries = 2;
    CANDIDATE_RETRY.delayMs = 1;
    try {
      await runCandidate(run.id, candidate.id);
      const settled = getRun(run.id).candidates[0];
      console.log('[live-candidate-skills] 失败面：', settled?.status, JSON.stringify(settled?.error ?? null), 'attempts=', settled?.attempts);

      expect(settled?.status, report()).toBe('failed');
      expect(settled?.error?.code).toBe('AGENT_SKILLS_UNAVAILABLE');
      // 点名到条：用户要据此回设置页改哪一条
      expect(settled?.error?.message).toContain('locked-skill');
      // 不自动重试：装不进去不是瞬时故障（重试只会把同一个失败延后 3s × N）
      expect(settled?.attempts).toBe(1);
    } finally {
      CANDIDATE_RETRY.maxRetries = productionRetries;
      CANDIDATE_RETRY.delayMs = productionDelay;
      // 权限改回来（见上面 chmod 那一处的说明）
      chmodSync(locked, 0o600);
    }
  }, TIMEOUT_MS);
});
