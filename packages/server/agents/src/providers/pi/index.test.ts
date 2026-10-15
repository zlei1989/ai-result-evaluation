// @vitest-environment node
/**
 * pi 适配器的三层判据：
 *  1. **注册形态**（元数据是真值）；
 *  2. **装配序列与隔离序列**（用假 SDK 逐步钉住顺序与那几个开关的取值）；
 *  3. **凭据与 provider 投射的并发隔离**（用**真包 + 本地假网关**断言出站目标——假件证明不了
 *     「请求打到哪台」）。
 *
 * 第 3 层的存在理由：pi 的 provider 注册是**按 id 索引的全局表**，而编排层是无界并发。
 * 写错这一格的表现是「A 行的请求带着 B 行的密钥打到 B 行的网关」，只在并发时出现，
 * 而且每一格的日志都正常。所以它必须拿真实现跑一次真请求。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFFORT_OFF, type AgentEvent, type AgentMessage } from '@aieval/contracts';
import { AgentLoadError } from '../../errors';
import { setAgentRuntimeForTesting } from '../../runtime';
import { createRunInput } from '../../testing/agent-fixtures';
import { createFakePiChildSession, createFakePiRecorder, createFakePiSdk } from '../../testing/pi-sdk-fixture';
import { PI_SUBAGENTS_TOOL_NAMES } from '../../permission';
import { PI_SUBAGENTS_MANAGER_KEY } from './subagent-wire';
import {
  anthropicText,
  anthropicToolUse,
  runPiConformanceRow,
} from '../../testing/pi-conformance-fixture';
import { runPiRow, startPiGateway, type CapturedPiRequest } from '../../testing/pi-gateway-fixture';
import { piRequestToolDeclaration, piSystemText } from './observer';
import { PI_ASK_USER_GUIDELINES, PI_ASK_USER_SNIPPET, PI_ASK_USER_TOOL } from './ask-user';
import { PI_STRUCTURED_OUTPUT_TOOL } from './structured-output';
import { piSubagentsExtensionPath, piSubagentsVersion } from './subagents';
import { piSubagentTranscriptPath } from './transcript';
import {
  PI_DEFAULT_EFFORT,
  PI_THINKING_LEVEL_MAP,
  baseUrlForWire,
  compatForWire,
  keepRowAndProjectSkills,
  piProvider,
  piProviderId,
  piSessionDir,
  piThinkingLevel,
  rowSkillsPath,
  wireForProtocol,
} from './index';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

describe('piProvider 的注册形态', () => {
  it('kind / displayName 与 contracts 的标签表一致（前端下拉与落盘那一格同名）', () => {
    expect(piProvider.kind).toBe('pi');
    expect(piProvider.displayName).toBe('Pi Coding Agent');
  });

  it('未选档位时会落到一个非关闭档（API 侧要用它拦「未选 + 模型不支持缺省档」）', () => {
    expect(piProvider.metadata.defaultEffort).toBe(PI_DEFAULT_EFFORT);
    expect(piProvider.metadata.reasoningEfforts).toContain(PI_DEFAULT_EFFORT);
    expect(piProvider.metadata.defaultEffort).not.toBe(EFFORT_OFF);
    // 声明里的「未选会落到哪一档」与真正发出去的那一档必须是同一个值
    expect(piThinkingLevel(undefined)).toBe(piThinkingLevel(PI_DEFAULT_EFFORT));
  });

  /**
   * `reasoningEfforts` 收 `max` 而**不收** `xhigh`。
   *
   * `max` 的代价是一条模型上的显式映射（没有映射时厂商会把它静默夹到 `high`）；
   * `xhigh` 则是双向静默：pi 对它没有内建映射，有 `max` 的映射之后会被往上夹到 `max`（升档）、
   * 没有映射时夹到 `high`（降档）——两种都不是用户点的那一档，故不进档位域。
   */
  it('档位域收 `max`（有映射才收）、不收 `xhigh`（静默夹档等于给了个假选项）', () => {
    expect(piProvider.metadata.reasoningEfforts).toContain('max');
    expect(piProvider.metadata.reasoningEfforts).not.toContain('xhigh');
    // 「收 max」与「模型上有那条映射」是一件事的两面，缺一面就是静默降档
    expect(PI_THINKING_LEVEL_MAP['max']).toBe('max');
  });

  /**
   * 子智能体那一格的三条边界必须留在说明里——`notes` 是**用户直接看到**的那一层，而这三条讲的
   * 都不是「扩展没装」那种失败形态，是「声明为 `yes` 之后仍然收不全 / 不必另配 / 多一件工具」：
   *   · 模型可以绕开扩展、用 `bash` 拉起宿主 `pi` CLI 凑一个子智能体 ⇒ 那条路径收不到，
   *     且**装了扩展也不改这条边界**（工具可用 ≠ 模型一定用它）；
   *   · 子会话的模型与网关凭据**继承父会话**（`subagentSource` 取 `wire` 的由来）⇒ 不必另配凭据；
   *   · 扩展的**包名与版本**要点名——「派发能力来自哪个包」是用户排障的第一格。
   *
   * 三条对应的事实在 `docs/protocols/pi.md` 的《已知边界与取舍》里各有一行（① 宿主 CLI 那条、
   * ② 子会话继承、③ 子任务由第三方扩展提供）：改这里的措辞要两处同一次改。
   */
  it('子智能体的边界写在说明里（宿主 CLI 那条在观测面外、子会话继承模型与凭据、扩展点名到版本）', () => {
    const notes = piProvider.metadata.messageCapability.notes.join('\n');
    // ① 绕开扩展走宿主 CLI 的派发：真跑了也不算进本行那几格
    expect(notes).toContain('拉起宿主 `pi` CLI');
    expect(notes).toContain('不在我们的观测面内');
    expect(notes).toContain('`subagentTurns: 0`');
    expect(notes).toContain('工具可用 ≠ 模型一定用它');
    // ② 子会话的模型与凭据来自父会话，不需要配置文件 / 环境变量 / 宿主 CLI
    expect(notes).toContain('继承主会话的模型与网关 / 密钥');
    expect(notes).toContain('`modelRegistry`');
    expect(notes).toContain('`modelRuntime`');
    expect(notes).toContain('不需要**配置文件 / 环境变量 / 宿主 CLI');
    /**
     * ③ 包名与版本：判据取**实际装着的那个版本**（`package.json` → 扩展清单），不写死字面量——
     * 依赖升了而这句话没跟着改，用户看到的就是一个假版本，而那种漂移没有任何别的守卫看得见。
     */
    const installed = piSubagentsVersion(piSubagentsExtensionPath());
    expect(installed, '读不到扩展清单的版本，这一格的判据无法成立').not.toBeNull();
    expect(notes).toContain(`@tintinweb/pi-subagents@${installed}`);
  });
});

describe('pi 的 provider 投射（纯函数）', () => {
  it('两条 wire 各按自己的方向归一 baseUrl（与 dsh 那条通路逐字同规则）', () => {
    expect(wireForProtocol('openai')).toBe('openai-responses');
    expect(wireForProtocol('anthropic')).toBe('anthropic-messages');
    expect(baseUrlForWire('https://gw.example.com', 'openai')).toBe('https://gw.example.com/v1');
    expect(baseUrlForWire('https://gw.example.com/v1', 'openai')).toBe('https://gw.example.com/v1');
    expect(baseUrlForWire('https://gw.example.com/anthropic/v1', 'anthropic')).toBe(
      'https://gw.example.com/anthropic',
    );
  });

  it('两条 wire 的 compat 显式开（不开时 detectCompat 恒 false ⇒ 零出站请求）', () => {
    expect(compatForWire('openai-responses')).toEqual({ supportsStrictMode: true });
    expect(compatForWire('anthropic-messages')).toEqual({ supportsStrictTools: true });
  });

  /**
   * provider id 由 `configHome` 派生：**每行唯一**是硬要求（`ModelRuntime` 的 provider 表按 id 索引，
   * 复用 id 会让两行互相改掉对方的 baseUrl / apiKey）。
   */
  it('provider id 由 configHome 派生：不同行不同 id、同一行稳定', () => {
    const a = piProviderId('/rows/a/.agenthome');
    const b = piProviderId('/rows/b/.agenthome');
    expect(a).not.toBe(b);
    expect(piProviderId('/rows/a/.agenthome')).toBe(a);
    // 目录名里的分隔符与中文不进 id（它要进请求路径与日志）
    expect(a).toMatch(/^aieval-pi-[0-9a-f]{12}$/);
    expect(piProviderId('/行/一/.agenthome')).toMatch(/^aieval-pi-[0-9a-f]{12}$/);
  });

  it('技能谓词：留白名单 ∪ cwd 之下的项目技能，丢掉 HOME 锚定的发现结果', () => {
    const rowDir = rowSkillsPath('/rows/a/.agenthome');
    const kept = keepRowAndProjectSkills(
      {
        skills: [
          { name: 'ours', filePath: `${rowDir}/ours/SKILL.md` },
          { name: 'project', filePath: '/ws/.agents/skills/project/SKILL.md' },
          { name: 'personal', filePath: '/home/someone/.agents/skills/personal/SKILL.md' },
          // 前缀相近但**不在** cwd 之下的目录：`startsWith` 会把它误留
          { name: 'sibling', filePath: '/ws-other/skills/sibling/SKILL.md' },
        ],
        diagnostics: [{ kind: 'collision' }],
      },
      { rowSkillsDir: rowDir, cwd: '/ws' },
    );
    expect(kept.skills.map((skill) => skill.name)).toEqual(['ours', 'project']);
    // 诊断原样带出（同名裁决要靠它如实呈现，不在这一层取舍）
    expect(kept.diagnostics).toEqual([{ kind: 'collision' }]);
  });
});

describe('pi 的装配序列与隔离序列', () => {
  /**
   * 每次装配用**自己那棵行目录**：技能是往 `configHome` 里真的写盘的，而共享夹具目录会让
   * 「这一行的物化」泄漏到下一个用例（`existsSync` 那类断言因此变成假绿）。
   */
  function freshRow(): ReturnType<typeof createRunInput> {
    const root = mkdtempSync(join(tmpdir(), 'pi-row-'));
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    mkdirSync(cwd, { recursive: true });
    return createRunInput({ cwd, configHome });
  }

  /**
   * 装配顺序是硬要求：`mkdir` → 建装载器 → `reload` → 建会话 → `bindExtensions`。
   * 顺序错了的表现不是报错而是**静默少东西**（技能表空、扩展没绑），故逐步断言。
   */
  it('按 mkdir → 装载器 → reload → runtime → 会话 → bindExtensions 的顺序装配', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const input = freshRow();
    const events: AgentEvent[] = [];
    const result = await piProvider.run({
      ...input,
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(recorder.assemblyOrder).toEqual([
      'resource-loader',
      'reload',
      'runtime',
      'create-session',
      'bind-extensions',
    ]);
    // configHome 由本层自己建（契约不保证它存在）；不传 skills 时技能根不建
    expect(existsSync(input.configHome)).toBe(true);
    expect(existsSync(rowSkillsPath(input.configHome))).toBe(false);
  });

  /**
   * **`bindExtensions` 抛错时这一行仍然收干净**：释放入口必须建在绑定点之前。
   *
   * 为什么：骨架手里的 `started` 要等 `start()` 返回才有值，而 `bindExtensions` 正是在 `start()`
   * 里面——它抛错时骨架的释放兜底**落空**（真机读数：dispose / abort / waitForIdle /
   * session_shutdown / provider 注销全 0），而 MCP 的 stdio 子进程清理挂在 `session_shutdown` 上
   * ⇒ 那一档会留下一个关不掉的子进程。变异体：把释放入口挪回 `bindExtensions` 之后（或去掉
   * try/catch）⇒ 本用例的 `disposed` 为 0，当场红。
   */
  it('`bindExtensions` 抛错 ⇒ 仍走完整条释放链，再把错误抛给骨架归因', async () => {
    const recorder = createFakePiRecorder();
    const fake = createFakePiSdk({ recorder }) as Record<string, Record<string, unknown>>;
    const pkg = fake['@earendil-works/pi-coding-agent']!;
    const original = pkg['createAgentSession'] as (options: unknown) => Promise<{ session: Record<string, unknown> }>;
    let disposed = 0;
    pkg['createAgentSession'] = async (options: unknown) => {
      const { session } = await original(options);
      return {
        session: {
          ...session,
          bindExtensions: async () => {
            throw new Error('扩展绑定点炸了');
          },
          dispose: () => {
            disposed += 1;
            (session['dispose'] as () => void)();
          },
        },
      };
    };
    setAgentRuntimeForTesting({ sdkModule: fake });

    const result = await piProvider.run({ ...freshRow(), onEvent: () => {} });
    expect(result.ok).toBe(false);
    expect(result.error?.message ?? '').toContain('扩展绑定点炸了');
    expect(disposed, '释放链一次都没跑：MCP 的 stdio 清理会留在那边').toBe(1);
  });

  it('隔离序列逐条：绝对技能路径 / noExtensions / 不设 noSkills 与 noContextFiles', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const input = createRunInput();
    await piProvider.run({ ...input, onEvent: () => {} });

    const loader = recorder.loaderOptions ?? {};
    const skillsPath = rowSkillsPath(input.configHome);
    // 绝对路径：相对路径按 cwd 解析（实测传 'skills' ⇒ 发现 0 条）
    expect(loader['additionalSkillPaths']).toEqual([skillsPath]);
    expect(skillsPath.startsWith('/') || /^[A-Za-z]:/.test(skillsPath)).toBe(true);
    // noExtensions 挡住被测仓库 `.pi/extensions/*.ts` 的任意代码执行
    expect(loader['noExtensions']).toBe(true);
    // 这两个键**不许出现**：noSkills 会把项目技能一起关掉，noContextFiles 会让 pi 读不到 AGENTS.md
    expect(loader).not.toHaveProperty('noSkills');
    expect(loader).not.toHaveProperty('noContextFiles');
    // agentDir 就是本行的配置目录，cwd 就是本行工作区
    expect(loader['agentDir']).toBe(input.configHome);
    expect(loader['cwd']).toBe(input.cwd);
    // 项目信任**显式**打开（不显式给会走 SDK 的内建探测，将来默认值变了我们不知道）
    const resolveProjectTrust = recorder.reloadOptions[0]?.['resolveProjectTrust'] as () => Promise<boolean>;
    await expect(resolveProjectTrust()).resolves.toBe(true);
    // 会话与设置走内存、不读不写 models.json / auth.json
    expect(recorder.runtimeOptions).toMatchObject({
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    expect(recorder.sessionOptions?.['settingsManager']).toMatchObject({
      kind: 'memory-settings',
      // 关掉 pi 自带重试（连接类失败默认 3 次会把墙钟放大到十几秒）
      settings: { retry: { enabled: false } },
    });
    // 扩展装配的 mode 必须写死 rpc（缺省 print 会让按 rpc 写的扩展判定配置错误）
    expect(recorder.bindings?.['mode']).toBe('rpc');
  });

  /**
   * **会话落盘**：管理器换成文件型、落点显式钉在行配置目录里，且**首跑与续接走两条不同的构造路径**。
   *
   * 为什么这三格都必须钉住：
   *   · 退回 `inMemory()` ⇒ 会话不落盘，续接无从谈起（而这一家在能力声明里写的是 `resume: yes`）；
   *   · 不给 `sessionDir` ⇒ 落点由「`agentDir` × `cwd`」两轴共同决定（厂商默认值就是那个形状），
   *     而行工作区会被重建、配置目录也会变 ⇒ 「这一行的会话在哪」变成算不出来的东西；
   *   · 续接用 `continueRecent` ⇒ 它取目录里 **mtime 最新**的一条，而行内重跑会在同一目录里留下
   *     上一次尝试的会话 ⇒ 接回来的是**上一次尝试**，用户以为在追问、模型答的是别人的上下文。
   *     故这里不只断言 `open` 被调用，还断言 `continueRecent` **一次都没被调用**。
   */
  it('首跑 create 到行内的显式会话目录（不是内存、不是厂商默认落点）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const input = freshRow();
    await piProvider.run({ ...input, onEvent: () => {} });

    expect(recorder.sessionManagerCalls).toEqual([
      { kind: 'create', cwd: input.cwd, sessionDir: piSessionDir(input.configHome) },
    ]);
    // 落点在行配置目录之内：换行即换目录，不需要第二个隔离机制
    expect(piSessionDir(input.configHome).startsWith(input.configHome)).toBe(true);
    expect(piSessionDir(input.configHome)).not.toContain(input.cwd);
    // 会话管理器是文件型的那一份（假件的三条构造路径各自记一笔，`inMemory` 已不在声明里）
    expect(recorder.sessionOptions?.['sessionManager']).toEqual({
      kind: 'file-session',
      cwd: input.cwd,
      sessionDir: piSessionDir(input.configHome),
    });
  });

  it('续接 open(会话文件)——不是 continueRecent（后者取 mtime 最新，行内重跑会接到上一次尝试）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const input = freshRow();
    // 续接要打开的会话文件必须真的在盘上（适配器先判存在性，见下一条用例）
    const sessionFile = join(piSessionDir(input.configHome), '2026-01-02T03-04-05-000Z_session-under-test.jsonl');
    mkdirSync(piSessionDir(input.configHome), { recursive: true });
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"session-under-test"}\n', 'utf8');

    await piProvider.run({ ...input, resume: { sessionId: sessionFile }, onEvent: () => {} });

    expect(recorder.sessionManagerCalls).toEqual([{ kind: 'open', path: sessionFile }]);
  });

  /**
   * 续接指到一条**不存在**的会话文件 ⇒ 抛中文原因，**绝不静默开新会话**。
   *
   * 为什么必须由适配器自己判：厂商的 `SessionManager.open(path)` 在文件不存在时**不抛**
   * ——它当场在同名路径上造一条新的。于是「文件没了」与「接上了」在调用点完全同形，
   * 表现是用户以为在追问、模型什么都不记得，而界面上一切正常（本仓最不接受的那类失败）。
   */
  it('续接的会话文件不存在 ⇒ 该行失败并点名路径（不静默开新会话）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const input = freshRow();
    const missing = join(piSessionDir(input.configHome), '2000-01-01T00-00-00-000Z_gone.jsonl');

    const result = await piProvider.run({ ...input, resume: { sessionId: missing }, onEvent: () => {} });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain(missing);
    expect(result.error?.message).toContain('不静默');
    // 一条会话都没建：失败发生在装配的会话构造那一步之前
    expect(recorder.sessionManagerCalls).toEqual([]);
  });

  /**
   * **0 字节的会话文件与「不存在」同档**：文件在场、一行内容都没有（写到一半被中断 /
   * 被截断）时厂商的 `open()` 照样成功，开出来的是一条**没有历史**的会话
   * ⇒ 「用户以为在追问、模型什么都不记得」在产物上长得与成功续接逐字一样。
   * 判据取盘上的字节数（半截 JSON 由厂商自己拒，零行不会）。
   *
   * 变异体：去掉 `statSync(...).size === 0` 这一支 ⇒ 本用例转成 `ok:true` + 一次 `open`，当场红。
   */
  it('续接的会话文件是 0 字节 ⇒ 该行失败并说明「里面没有上下文」（不静默开新会话）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const input = freshRow();
    const empty = join(piSessionDir(input.configHome), '2000-01-01T00-00-00-000Z_empty.jsonl');
    mkdirSync(piSessionDir(input.configHome), { recursive: true });
    writeFileSync(empty, '');

    const result = await piProvider.run({ ...input, resume: { sessionId: empty }, onEvent: () => {} });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain(empty);
    expect(result.error?.message).toContain('0 字节');
    expect(recorder.sessionManagerCalls, '不许真的 open 那条空会话').toEqual([]);
  });

  /**
   * 收尾落的是**会话文件路径**（`result.sessionId`），不是厂商那个会话 id。
   *
   * 判据取「假件按厂商命名规则现拼的那个路径」——用例自己算一遍，而不是读 `recorder.sessionFile`
   * （读它等于把断言写成同义反复）。文件名里嵌着时间戳 ⇒ id 拼不回路径，故落路径是唯一可行的那一格。
   */
  it('收尾落会话文件路径（不是会话 id）', async () => {
    const recorder = createFakePiRecorder();
    recorder.sessionId = 'session-under-test';
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const input = freshRow();

    const result = await piProvider.run({ ...input, onEvent: () => {} });

    expect(result.sessionId).toBe(
      join(piSessionDir(input.configHome), '2000-01-01T00-00-00-000Z_session-under-test.jsonl'),
    );
    expect(result.sessionId).not.toBe(recorder.sessionId);
  });

  /**
   * **投递面的反面**：声明写的是 `off-by-adapter`（厂商有这两档、窄壳也声明了，但适配器**还没接**）
   * ⇒ 事实必须是「端口挂着也一条都不投、连取件都不取」。
   *
   * 为什么反面就够（第一期四家全是「做不到」）：声明说「没接」而实际上接了，界面会把消息投进去
   * 却不显示排队状态；声明说「能投」而实际投不进去，则是「按钮可点、消息静默消失」。
   * 这一条钉住的是前者——把适配器悄悄接上投递面（却不改声明）会在这一格见红。
   */
  it('端口挂着也不投：适配器今天一格都不挂投递（`off-by-adapter` 的事实面）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const drained: string[] = [];
    const input = freshRow();

    const result = await piProvider.run({
      ...input,
      inject: {
        available: true,
        drain: (boundary) => {
          drained.push(boundary);
          return [{ id: 'm-1', text: '顺手把 changelog 补上' }];
        },
        markDelivered: () => {},
        retract: async () => 'unsupported',
      },
      onEvent: () => {},
    });

    expect(result.ok).toBe(true);
    expect(recorder.steering).toEqual([]);
    expect(recorder.followUps).toEqual([]);
    expect(drained).toEqual([]);
  });

  /**
   * 技能装入：整目录复制进 `<configHome>/skills/<名称>`，且**必须发生在建装载器之前**
   * （技能表是 `reload()` 那一刻扫出来的，写晚了这一行照样跑完、只是没有任何技能）。
   * 判据取「假件在 `reload` 时扫到的 cwd」——那正是谓词的入参，绕不过去。
   */
  /**
   * 模型那三格的取值：`cost` 四费率全 0（缺了厂商计价函数直接 TypeError）、
   * `contextWindow` / `maxTokens` 缺省时给**可辨认的上界**、给了值就逐字透传。
   * 判据取假件记下的注册配置——那正是出站时真正生效的那一份。
   */
  it('模型定义：cost 全 0；窗口/输出上限缺省给可辨认上界、给了值就透传', async () => {
    const first = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder: first }) });
    await piProvider.run({ ...freshRow(), onEvent: () => {} });
    const fallback = (first.registered[0]?.config['models'] as Array<Record<string, unknown>>)[0];
    expect(fallback?.['cost']).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // 缺省 = 未知：不得伪装成任何真实模型的规格（128000 / 16384 那类）
    expect(fallback?.['contextWindow']).not.toBe(128_000);
    expect(fallback?.['maxTokens']).not.toBe(16_384);
    expect(fallback?.['contextWindow']).toBeTypeOf('number');
    expect(fallback?.['maxTokens']).toBeTypeOf('number');
    /**
     * 档位可下发：`reasoning` 关着时 pi 眼里只有 `off` 一档（任何档位都被夹成关闭，
     * 而 metadata 却声明了六个档位）；`max` 只认模型上那条显式映射。
     * 逐行一份：注册面长期持有这份对象，共享一个可变对象等于让并发两行互相改档。
     */
    expect(fallback?.['reasoning']).toBe(true);
    expect(fallback?.['thinkingLevelMap']).toEqual({ max: 'max' });
    expect(fallback?.['thinkingLevelMap']).not.toBe(PI_THINKING_LEVEL_MAP);

    const second = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder: second }) });
    const input = freshRow();
    await piProvider.run({
      ...input,
      route: { ...input.route, contextWindow: 200_000, maxOutputTokens: 8_192 },
      onEvent: () => {},
    });
    const passed = (second.registered[0]?.config['models'] as Array<Record<string, unknown>>)[0];
    expect(passed?.['contextWindow']).toBe(200_000);
    expect(passed?.['maxTokens']).toBe(8_192);
    expect(passed?.['compat']).toEqual({ supportsStrictTools: true });
  });

  it('技能装入落在 reload 之前：物化结果就是谓词看到的那一份', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const input = freshRow();
    const skillSource = mkdtempSync(join(tmpdir(), 'pi-skill-src-'));
    writeFileSync(join(skillSource, 'SKILL.md'), '# 演示技能\n\n按步骤做。\n', 'utf8');
    // 假件在 reload 时按装载器的入参扫盘，故把「物化结果」如实报出来
    const discovered = () => [
      { name: 'demo', filePath: join(rowSkillsPath(input.configHome), 'demo', 'SKILL.md') },
      { name: 'personal', filePath: '/home/someone/.agents/skills/personal/SKILL.md' },
    ];
    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({ recorder, discoveredSkills: discovered() }),
    });

    await piProvider.run({
      ...input,
      skills: [{ name: 'demo', sourceDir: skillSource }],
      onEvent: () => {},
    });

    // 物化本体真的落盘了（整目录复制）
    expect(existsSync(join(rowSkillsPath(input.configHome), 'demo', 'SKILL.md'))).toBe(true);
    // 谓词只留白名单那一条，HOME 锚定的那条被丢掉
    expect(recorder.skills.skills.map((skill) => skill.name)).toEqual(['demo']);
  });

  it('不传 skills ⇒ 一条都不装、连技能根都不建（评分与用例同步两处没有技能面）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const input = freshRow();
    await piProvider.run({ ...input, onEvent: () => {} });
    expect(existsSync(rowSkillsPath(input.configHome))).toBe(false);
  });

  it('权限档落成工具白名单（pi 没有权限标志位，写能力住在工具集里）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    await piProvider.run({ ...createRunInput({ permission: 'read-only' }), onEvent: () => {} });
    // 档位名单原样交给会话，末尾那一格是 MCP 派生名的通配（工具名连接之后才知道，枚举不出来）；
    // 它必须是**成员**：修饰符形态会被厂商判成「改默认集」，白名单随之整个失效
    // 只读档不给 `mcp__*` 通配（它会把服务器自带写工具一并授权），见 `allowlist.test.ts` 的只读档用例
    expect(recorder.sessionOptions?.['tools']).toEqual(['read', 'grep', 'find', 'ls']);
    // 只读档刻意不含 bash：它能写盘，等于把只读档绕过去
    expect(recorder.sessionOptions?.['tools']).not.toContain('bash');
  });

  /**
   * 运行期断言：`noExtensions: true` 之下**发现来的扩展必须是 0**。
   * 造一条「发现来的扩展」（既不是 `<inline:` 也不在本行配置目录下）来证明兜底真的会开火：
   * 兜底是**不信任项目**重建装载器，且第二次断言仍失败时整行失败。
   */
  it('发现来的扩展非空 ⇒ 按不信任项目重建装载器；仍挡不住 ⇒ 整行失败', async () => {
    const recorder = createFakePiRecorder();
    const backdoor = { path: '/ws/.pi/extensions/repo_backdoor.ts' };
    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({
        recorder,
        extensionsAfterReload: [[backdoor], [backdoor]],
      }),
    });
    const result = await piProvider.run({ ...createRunInput(), onEvent: () => {} });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('repo_backdoor.ts');
    // 兜底确实重建了一次装载器（带 `resolveProjectTrust: () => false`）
    expect(recorder.reloadOptions).toHaveLength(2);
    const second = recorder.reloadOptions[1]?.['resolveProjectTrust'] as () => Promise<boolean>;
    await expect(second()).resolves.toBe(false);
    // 会话一次都没建起来（不带着任意代码执行往下跑）
    expect(recorder.sessionOptions).toBeNull();
  });

  it('兜底之后扩展表干净 ⇒ 继续跑（代价是本行失去项目技能）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({
        recorder,
        // 重建之后只剩我们白名单的那一条（发现来的那个已经被挡在外面）
        extensionsAfterReload: [[{ path: '/ws/.pi/extensions/repo_backdoor.ts' }], [{ path: piSubagentsExtensionPath() }]],
      }),
    });
    const result = await piProvider.run({ ...createRunInput(), onEvent: () => {} });
    expect(result.ok).toBe(true);
    expect(recorder.reloadOptions).toHaveLength(2);
    expect(recorder.assemblyOrder).toContain('create-session');
  });

  /**
   * 「我们装进来的」有三类：内联工厂、配置目录下的文件、**显式白名单的绝对路径**。
   * 漏掉第三类的症状不是漏检而是**假红**——装载器被无谓地按不信任项目重建，随后那一条仍在表里
   * ⇒ 整行以「扩展隔离失败」收场（子智能体扩展住在本仓 `node_modules` 里，正是第三类）。
   */
  it('我们自己的扩展（内联工厂 / 白名单路径）不算发现来的：断言不误伤这两种装载', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({
        recorder,
        extensionsAfterReload: [[{ path: '<inline:ours>' }, { path: piSubagentsExtensionPath() }]],
      }),
    });
    const result = await piProvider.run({ ...createRunInput(), onEvent: () => {} });
    expect(result.ok).toBe(true);
    expect(recorder.reloadOptions).toHaveLength(1);
  });

  /**
   * 白名单那一条**没装上**时这一行必须失败并点名——「声明 `subagent: yes` 而实际没有派发工具」
   * 是假声明，而它在装配面上一个字都不报（扩展表里少一条、其余全正常）。
   *
   * 归因码取 `AGENT_LOAD_FAILED`：它不是厂商运行期的失败（那样会归成 `AGENT_FAILED`，
   * 语义是「CLI 起不来 / 进程非零退出」），而是「声明支持却加载不上」。
   */
  it('子智能体扩展没装载 ⇒ 整行失败并点名包名与版本（不许声明支持却没装）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({ recorder, extensionsAfterReload: [[{ path: '<inline:ours>' }]] }),
    });
    const result = await piProvider.run({ ...createRunInput(), onEvent: () => {} });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(result.error?.message).toContain('@tintinweb/pi-subagents');
    // 版本一起点名：装错了版本要能从这一句直接看出来
    expect(result.error?.message).toMatch(/@tintinweb\/pi-subagents@\d+\.\d+\.\d+/);
    // 会话一次都没建起来（不带着「没有派发能力」的会话往下跑）
    expect(recorder.sessionOptions).toBeNull();
  });

  /**
   * 入口**解析不出来**（包不在 `node_modules` 里、或入口文件缺失）与上一条同一姿态：
   * 这一行拒绝在没有派发能力的前提下声称支持子智能体，且失败码同为 `AGENT_LOAD_FAILED`
   * （归成 `AGENT_FAILED` 会让「包没装」被读成「网关抽风」）。
   *
   * 判据传**空基准表**：解析基准逐个试完、全失败才会抛，而「拿一个不存在的目录当基准」在测试
   * 环境里不可靠——Vitest 的模块解析会兜底到本仓的 `node_modules`，从任何目录都解析得到。
   */
  it('解析不出扩展入口 ⇒ 按 AGENT_LOAD_FAILED 抛并点名包名', () => {
    let caught: unknown = null;
    try {
      piSubagentsExtensionPath([]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentLoadError);
    expect((caught as AgentLoadError).code).toBe('AGENT_LOAD_FAILED');
    expect((caught as AgentLoadError).message).toContain('@tintinweb/pi-subagents');
  });

  it('提示词与释放：先订阅再交提示词，收尾取消订阅、abort 后等 idle、dispose 恰好一次', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const result = await piProvider.run({ ...createRunInput({ prompt: '改标题' }), onEvent: () => {} });

    expect(result.ok).toBe(true);
    expect(recorder.prompts).toEqual(['改标题']);
    expect(recorder.subscribeCount).toBe(1);
    expect(recorder.unsubscribeCount).toBe(1);
    /**
     * 释放路径：骨架先 `interrupt()`（= `abort()`）再 `dispose()`，而本适配器的 dispose 也要
     * 先 abort 再等 idle ⇒ **`abort()` 会进两次**。这不是重复释放：`abort()` 幂等，
     * 而「先发停止信号、再回收」是骨架定死的顺序（见 `release.ts`），第二次是回收路径自己的收尾。
     */
    expect(recorder.abortCount).toBeGreaterThanOrEqual(1);
    expect(recorder.waitForIdleCount).toBeGreaterThanOrEqual(1);
    expect(recorder.disposeCount).toBe(1);
    // 本行的 provider 注册在 run 的边界内注销
    expect(recorder.unregistered).toEqual([recorder.registered[0]?.providerId]);
  });

  it('原始事件逐条落成日志事件（未识别不丢）', async () => {
    const recorder = createFakePiRecorder();
    recorder.events.push({ type: 'agent_start' });
    recorder.events.push({ type: 'queue_update', steering: [], followUp: [] });
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const events: AgentEvent[] = [];
    await piProvider.run({ ...createRunInput(), onEvent: (event) => events.push(event) });
    const logs = events.filter((event) => event.type === 'log');
    expect(logs).toHaveLength(2);
    expect(logs[0]?.type === 'log' ? logs[0].text : '').toContain('agent_start');
    expect(logs[1]?.type === 'log' ? logs[1].text : '').toContain('queue_update');
  });

  /**
   * 一次**完整往返**的产物（真机事件序列：两轮、一次工具调用）。
   *
   * 这条用例钉的是「投影真的接上了」这件事本身——`turns` / `tokens` / `finalText` 三格
   * 以及消息流都只能在整条链路上验，单看投影函数的返回值会漏掉「接错钩子」（例如填了
   * 投影但 `project` 还是诊断级兜底）。
   */
  it('完整往返的产物：轮次 / 计量 / 最终答复 / 消息流都对得上', async () => {
    const recorder = createFakePiRecorder();
    for (const event of fullRoundTripEvents()) recorder.events.push(event);
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const events: AgentEvent[] = [];
    const messages: AgentMessage[] = [];
    const result = await piProvider.run({
      ...createRunInput(),
      onEvent: (event) => events.push(event),
      onMessage: (message) => messages.push(message),
    });

    expect(result.ok, result.error?.message).toBe(true);
    // 两轮 = 两次模型往返（第一轮调工具、第二轮给答复）
    expect(result.turns).toBe(2);
    expect(result.finalText).toBe('改好了');
    /**
     * 两个往返的用量之和。`output` 是 **12 + 38**（**不含** `reasoning` 的 11 + 3——它是
     * `output` 的子集，并进去就是双计），`total` 是两次自报量之和（pi 报的是本次往返的量）。
     */
    expect(result.tokens).toEqual({
      input: 882,
      cached: 832,
      output: 50,
      reasoningOutput: 14,
      total: 1_764,
    });
    // 无子智能体：分量是 {0,0,0} / 0（「确实没有」不是「没采到」）
    expect(result.subagentTokens).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(result.subagentTurns).toBe(0);
    expect(result.exitReason).toBe('completed');

    // 内容级消息：助手（思考 + 工具调用）、工具结果、助手（答复）
    const assistant = messages.filter((message) => message.role === 'assistant');
    expect(assistant.some((message) => message.blocks.some((block) => block.type === 'thinking'))).toBe(true);
    expect(assistant.some((message) => message.blocks.some((block) => block.type === 'tool-call' && block.callId === 'call_1'))).toBe(true);
    expect(assistant.some((message) => message.blocks.some((block) => block.type === 'text' && block.text === '改好了'))).toBe(true);
    const tool = messages.find((message) => message.role === 'tool');
    expect(tool?.parentCallId).toBe('call_1');
    const toolBlock = tool?.blocks[0];
    expect(toolBlock?.type).toBe('tool-result');
    expect(toolBlock?.type === 'tool-result' ? toolBlock.text : '').toContain('fixture body');
    // 增量帧走内容通道（`streamingDelta: yes` 的产物证据）：合并后仍是快照收尾
    expect(messages.some((message) => message.chunk === 'delta')).toBe(true);
    expect(messages.every((message) => message.source === 'wire')).toBe(true);
  });

  /**
   * **收尾读子会话转写这条接线**（只有整条链路上验得了：转写路径要同时用到**本行的 `cwd`**
   * 与**本会话的 `sessionId`**，两者都在适配器的装配闭包里，投影函数拿不到）。
   *
   * 判据是产物：那个子会话的消息落进 `onMessage`，逐条带 `subagentId` 与 `session-file` 来源，
   * 轮次是它自己的 1..N。转写投影本身的规则由 `transcript.test.ts` 钉住，这条只钉**接线**——
   * 路径少用一格（例如拿主会话的轮次号或别的会话 id 去拼）就会读不到文件、这里当场红。
   */
  it('收尾把子会话转写读成子任务的消息：本行 cwd 与会话 id 都要用对', async () => {
    const input = freshRow();
    const recorder = createFakePiRecorder();
    recorder.sessionId = 'session-under-test';
    for (const event of fullRoundTripEvents()) recorder.events.push(event);
    recorder.events.push({ type: 'turn_start' });
    recorder.events.push({
      type: 'tool_execution_start',
      toolName: 'Agent',
      toolCallId: 'call_sub',
      args: { prompt: '核对页面', description: '核对页面' },
    });
    recorder.events.push({
      type: 'tool_execution_end',
      toolName: 'Agent',
      toolCallId: 'call_sub',
      isError: false,
      durationMs: 12,
      result: {
        content: [{ type: 'text', text: 'Agent completed in 0.1s (1 tool use, 1.0k token).\n\n核对完毕' }],
        details: { description: '核对页面', status: 'completed', turnCount: 1, agentId: 'agent-sub' },
      },
    });
    recorder.events.push({ type: 'agent_settled', aborted: false });

    /** 真落一份转写到**该会话该算出来的那个路径**上（路径公式的守卫在 `transcript.test.ts`） */
    const transcript = piSubagentTranscriptPath({ cwd: input.cwd, sessionId: recorder.sessionId, agentId: 'agent-sub' });
    if (transcript === null) throw new Error('夹具算不出转写路径');
    mkdirSync(dirname(transcript), { recursive: true });
    const line = (content: unknown[]): string => JSON.stringify({
      isSidechain: true,
      agentId: 'agent-sub',
      type: 'assistant',
      message: { role: 'assistant', content, usage: { input: 10, output: 2, cacheRead: 0, totalTokens: 12 }, stopReason: 'stop' },
      timestamp: '2026-10-12T23:44:02.773Z',
      cwd: input.cwd,
    });
    writeFileSync(transcript, `${line([{ type: 'text', text: '子任务第一步' }])}\n${line([{ type: 'text', text: '子任务第二步' }])}\n`, 'utf8');

    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const messages: AgentMessage[] = [];
    let busFired = false;
    await piProvider.run({
      ...input,
      onEvent: () => {
        /**
         * 总线在**第一条事件到达时**收场：扩展处理器在 `bindExtensions` 那一刻就注册好了，
         * 而它早于订阅 ⇒ 这个窗口里发事件与真机「管理器先收场、工具再返回」是同一时序。
         */
        if (busFired) return;
        busFired = true;
        for (const handler of recorder.extensionHandlers['subagents:completed'] ?? []) {
          handler({ id: 'agent-sub', type: 'general-purpose', description: '核对页面', result: '核对完毕', status: 'completed', usage: { input: 100, output: 5, cacheRead: 0, totalTokens: 105 } });
        }
      },
      onMessage: (message) => messages.push(message),
    });

    const child = messages.filter((message) => message.subagentId === 'agent-sub');
    expect(child.map((message) => [message.roundTrip, message.source, message.role])).toEqual([
      [1, 'session-file', 'assistant'],
      [2, 'session-file', 'assistant'],
    ]);
    expect(child[0]?.blocks[0]).toMatchObject({ type: 'text', text: '子任务第一步' });
    // 主会话那几条一个字都没被改到（归属是叠加，不是替换）
    expect(messages.filter((message) => message.subagentId === null).every((message) => message.source === 'wire')).toBe(true);
  });

  /**
   * **子会话正文的 wire 通道**（全链路：假件在 reload 时挂注册表 ⇒ 产品侧快照 + 删槽 ⇒
   * 总线报 started ⇒ 订阅子会话 ⇒ 事件缓冲在投影里排空）。
   *
   * 判据全是产物级：子会话消息的来源是 `wire`（不再带「补录」角标）、轮次从 1 起、
   * 全局槽在运行结束后被删（下一行的 claim 不会被挡）。
   */
  it('子会话正文走 wire：订阅子会话事件流，消息带 wire 来源与正确轮次', async () => {
    const input = freshRow();
    const recorder = createFakePiRecorder();
    recorder.sessionId = 'session-wire';
    // 子会话假件（共享夹具）：订阅那一刻同步吐两条助手收尾（与主会话夹具同一时序）
    const childEvents = [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '子任务第一步' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '子任务第二步' }] } },
    ];
    const childSession = createFakePiChildSession(childEvents);
    for (const event of fullRoundTripEvents()) recorder.events.push(event);
    recorder.events.push({ type: 'turn_start' });
    recorder.events.push({
      type: 'tool_execution_start',
      toolName: 'Agent',
      toolCallId: 'call_sub',
      args: { prompt: '核对页面', description: '核对页面' },
    });
    recorder.events.push({
      type: 'tool_execution_end',
      toolName: 'Agent',
      toolCallId: 'call_sub',
      isError: false,
      durationMs: 12,
      result: {
        content: [{ type: 'text', text: 'Agent completed in 0.1s (1 tool use, 1.0k token).\n\n核对完毕' }],
        details: { description: '核对页面', status: 'completed', turnCount: 2, agentId: 'agent-sub' },
      },
    });
    recorder.events.push({ type: 'agent_settled', aborted: false });

    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({
        recorder,
        registryEntryFactory: () => ({
          getRecord: (id: string) => (id === 'agent-sub' ? { session: childSession } : undefined),
        }),
      }),
    });
    const messages: AgentMessage[] = [];
    let busFired = false;
    await piProvider.run({
      ...input,
      onEvent: () => {
        if (busFired) return;
        busFired = true;
        // started 与 completed 一起到：订阅建立后立刻收场——缓冲里的正文照样要在后续投影里排空
        for (const handler of recorder.extensionHandlers['subagents:started'] ?? []) {
          handler({ id: 'agent-sub', type: 'general-purpose', description: '核对页面' });
        }
        for (const handler of recorder.extensionHandlers['subagents:completed'] ?? []) {
          handler({ id: 'agent-sub', type: 'general-purpose', description: '核对页面', result: '核对完毕', status: 'completed', usage: { input: 100, output: 5, cacheRead: 0, totalTokens: 105 } });
        }
      },
      onMessage: (message) => messages.push(message),
    });

    const child = messages.filter((message) => message.subagentId === 'agent-sub');
    expect(child.map((message) => [message.roundTrip, message.source, message.role])).toEqual([
      [1, 'wire', 'assistant'],
      [2, 'wire', 'assistant'],
    ]);
    expect(child[0]?.blocks[0]).toMatchObject({ type: 'text', text: '子任务第一步' });
    // 全局槽被删、claim 恰好一次：下一行的注册表快照不会被这一行挡住
    expect((globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY]).toBeUndefined();
    expect(recorder.registryClaims).toBe(1);
  });

  /**
   * **派发期的实时性**（这一条是 wire 通道「实时」二字的唯一端到端判据）。
   *
   * 真机形状（`pi 1.3.0` 的原始帧计数）：`Agent` 是**阻塞工具**，派发到收场之间父会话只发
   * **4 帧 `tool_execution_update` + 1 帧 `entry_appended`**，没有一帧带子任务正文。而 wire 缓冲的
   * 排空挂在父事件的投影上 ⇒ 只靠那几帧，子任务正文会按它们的节奏一小段一小段地漏、或整段攒到
   * 工具收尾才一次性涌出；合成帧泵把「进账即排空」补上，界面才能边产边长。
   *
   * ⚠️ 本夹具把父会话造成**彻底静默**（`hangPrompt` 之后一帧都不发），因此它证明的是
   * 「完全没有父事件时泵仍然把正文送出去」这一档，**证不了**「有那 4 帧时泵是否还必要」——
   * 后者要两臂同时测时延（接泵 / 不接泵），见 `.scratch/pi-audit3/LEDGER.md` 的交接速查 C-1。
   *
   * 夹具按这个形状搭：父会话交完派发的 `tool_execution_start` 就**停住不产事件**
   * （`hangPrompt`），子会话随后才产正文；判据是「子任务的消息在父会话还没有下一个事件时
   * 就已经到了 `onMessage`」。摘掉泵（或摘掉 `drain` 后的续泵）这里当场挂住到超时。
   */
  it('派发期父会话静默时子任务正文照样实时到达：不等 Agent 工具收尾', async () => {
    const input = freshRow();
    const recorder = createFakePiRecorder();
    recorder.sessionId = 'session-pump';
    /** 子会话假件：**订阅时不吐**，正文由用例在「父会话已静默」之后手动 emit */
    const childSession = createFakePiChildSession();
    for (const event of fullRoundTripEvents()) recorder.events.push(event);
    recorder.events.push({ type: 'turn_start' });
    recorder.events.push({
      type: 'tool_execution_start',
      toolName: 'Agent',
      toolCallId: 'call_sub',
      args: { prompt: '核对页面', description: '核对页面' },
    });
    // 刻意**不**排 tool_execution_end / agent_settled：派发期的父会话就是这个形状（静默）

    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({
        recorder,
        // 提示词挂住 ⇒ 父会话事件流在排完上面那几条之后彻底安静（真机派发期同形）
        hangPrompt: true,
        registryEntryFactory: () => ({
          getRecord: (id: string) => (id === 'agent-sub' ? { session: childSession } : undefined),
        }),
      }),
    });
    const messages: AgentMessage[] = [];
    let busFired = false;
    const running = piProvider.run({
      ...input,
      // 两级看门狗都关掉：这一条只问「正文有没有实时到」，不许被静止超时抢答
      watchdog: { idleTimeoutMs: 0, turnWallClockMs: 0 },
      onEvent: () => {
        if (busFired) return;
        busFired = true;
        // 只报 started（**不报终态**）：派发还在飞，正是界面该看到正文的那段时间
        for (const handler of recorder.extensionHandlers['subagents:started'] ?? []) {
          handler({ id: 'agent-sub', type: 'general-purpose', description: '核对页面' });
        }
      },
      onMessage: (message) => messages.push(message),
    });

    // 等派发的 tool_execution_start 投影完（子任务行落账、wire 订阅建立），此后父会话不再产事件
    await vi.waitFor(() => {
      expect(recorder.prompts).toHaveLength(1);
      expect(childSession.listenerCount).toBe(1);
    });
    const parentEventsSoFar = messages.length;
    childSession.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '子任务第一步' }] } });

    /**
     * 判据：父会话一个新事件都没有，这条正文却已经到了消费方。
     * 它只能来自 wire 自己推的那一帧（泵），所以这一等也是泵的唯一证明。
     */
    await vi.waitFor(() => {
      const child = messages.filter((message) => message.subagentId === 'agent-sub');
      expect(child.map((message) => [message.roundTrip, message.source, message.role])).toEqual([
        [1, 'wire', 'assistant'],
      ]);
    });
    // 父会话确实没产新事件：到的这条是子会话的，不是「父会话又说话了顺带捎出来的」
    expect(recorder.events).toHaveLength(0);
    expect(messages.filter((message) => message.subagentId === null)).toHaveLength(parentEventsSoFar);

    // 第二条照样实时跟出（泵不是只能用一次）
    childSession.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '子任务第二步' }] } });
    await vi.waitFor(() => {
      expect(messages.filter((message) => message.subagentId === 'agent-sub')).toHaveLength(2);
    });

    recorder.releaseStream?.();
    await running;
  });

  /**
   * **派发期的逐字流式**（本条是「消减等待焦虑」那个目标的端到端判据）。
   *
   * 与上一条的区别在**「逐字」而不是「逐条」**：上一条判「整条消息在派发期就到」，
   * 这一条判「同一轮的正文**分批**长出来」——子会话一轮产 N 帧增量，消费方要在收尾
   * **之前**就陆续收到，而不是攒到 `message_end` 一次性给。
   *
   * 为什么必须单独钉：`drain` 的批处理性质（一拍之内整批取走）保证了「不丢帧」，
   * 但它同时意味着**如果只在收尾前泵一次，界面上就还是整条跳出**——那正是这个目标要消掉的东西。
   * 判据取「收尾之前收到的条数 ≥ 2 且逐步递增」，纯整条投递的实现在这里当场红。
   */
  it('派发期逐字流式：同一轮的增量分批到达消费方，不是攒到收尾才一次性给', async () => {
    const input = freshRow();
    const recorder = createFakePiRecorder();
    recorder.sessionId = 'session-delta';
    const childSession = createFakePiChildSession();
    for (const event of fullRoundTripEvents()) recorder.events.push(event);
    recorder.events.push({ type: 'turn_start' });
    recorder.events.push({
      type: 'tool_execution_start',
      toolName: 'Agent',
      toolCallId: 'call_sub',
      args: { prompt: '核对页面', description: '核对页面' },
    });

    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({
        recorder,
        hangPrompt: true,
        registryEntryFactory: () => ({
          getRecord: (id: string) => (id === 'agent-sub' ? { session: childSession } : undefined),
        }),
      }),
    });
    const messages: AgentMessage[] = [];
    let busFired = false;
    const running = piProvider.run({
      ...input,
      watchdog: { idleTimeoutMs: 0, turnWallClockMs: 0 },
      onEvent: () => {
        if (busFired) return;
        busFired = true;
        for (const handler of recorder.extensionHandlers['subagents:started'] ?? []) {
          handler({ id: 'agent-sub', type: 'general-purpose', description: '核对页面' });
        }
      },
      onMessage: (message) => messages.push(message),
    });
    const childDeltas = (): AgentMessage[] =>
      messages.filter((message) => message.subagentId === 'agent-sub' && message.chunk === 'delta');

    await vi.waitFor(() => {
      expect(recorder.prompts).toHaveLength(1);
      expect(childSession.listenerCount).toBe(1);
    });

    /** 逐帧 emit，且**每一帧都等到消费方收到**——这才叫「分批到达」而不是「攒一批」 */
    for (const piece of ['逐', '字', '出', '来']) {
      const before = childDeltas().length;
      childSession.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: piece },
      });
      await vi.waitFor(() => {
        expect(childDeltas().length, `片段「${piece}」没有在收尾之前到达消费方`).toBeGreaterThan(before);
      });
    }
    // 收尾还没发生（父会话静默、没有 message_end）就有 4 条增量到了 ⇒ 逐字流式成立
    expect(childDeltas()).toHaveLength(4);
    expect(recorder.events).toHaveLength(0);

    // 收尾那一刻交出权威快照，且它与那 4 条增量同载体（合并器据此把逐字拼成完整块）
    childSession.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '逐字出来' }] } });
    await vi.waitFor(() => {
      const own = messages.filter((message) => message.subagentId === 'agent-sub');
      expect(own.some((message) => message.chunk === 'snapshot')).toBe(true);
    });
    const own = messages.filter((message) => message.subagentId === 'agent-sub');
    const deltaKeys = new Set(own.filter((message) => message.chunk === 'delta').map((message) => message.mergeKey));
    expect(own.some((message) => message.chunk === 'snapshot' && deltaKeys.has(message.mergeKey))).toBe(true);

    recorder.releaseStream?.();
    await running;
  });

  /**
   * **wire 通道按 run 划界**（snapshot-then-delete 的隔离判据）：每行 reload 后快照到
   * **自己那份**注册表条目。假件的 claim 是先到先得（与真实工厂同语义）⇒ 若产品侧忘了
   * 「快照后删槽」，第二行的 claim 会落空、它的 `getRecord` 拿到的是第一行的条目（永远
   * 查不到自己的子会话）⇒ 它的子任务正文整行退回转写通道（来源变 `session-file`），当场红。
   * 「两行 reload 交叠时互斥串行」那条竞态由 `subagent-wire.test.ts` 的并发用例单独钉住
   * （本用例的两行按 `waitFor` 先后装配，reload 本就不交叠）。
   */
  it('wire 通道按 run 划界：并发两行各自拿到自己的子会话事件流，正文互不串', async () => {
    const makeRow = (agentId: string, task: string): {
      recorder: ReturnType<typeof createFakePiRecorder>;
      input: ReturnType<typeof createRunInput>;
      session: { messages: unknown[]; subscribe: (listener: (event: unknown) => void) => () => void };
    } => {
      const root = mkdtempSync(join(tmpdir(), 'pi-row-wire-'));
      const cwd = join(root, 'workspace');
      const configHome = join(root, '.agenthome');
      mkdirSync(cwd, { recursive: true });
      const recorder = createFakePiRecorder();
      const childEvents = [
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${agentId} 的第一步` }] } },
      ];
      const session = createFakePiChildSession(childEvents);
      for (const event of fullRoundTripEvents()) recorder.events.push(event);
      recorder.events.push({ type: 'turn_start' });
      recorder.events.push({
        type: 'tool_execution_start',
        toolName: 'Agent',
        toolCallId: 'call_sub',
        args: { prompt: task, description: task },
      });
      recorder.events.push({
        type: 'tool_execution_end',
        toolName: 'Agent',
        toolCallId: 'call_sub',
        isError: false,
        durationMs: 9,
        result: {
          content: [{ type: 'text', text: 'Agent completed.' }],
          details: { description: task, status: 'completed', turnCount: 1, agentId },
        },
      });
      recorder.events.push({ type: 'agent_settled', aborted: false });
      return { recorder, input: createRunInput({ cwd, configHome }), session };
    };
    const first = makeRow('agent-first', '第一行任务');
    const second = makeRow('agent-second', '第二行任务');

    // 两行交叠着跑（与「注册面按 run 划界」同一条时序：交叠正是互斥要挡的窗口）
    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({
        recorder: first.recorder,
        registryEntryFactory: () => ({
          getRecord: (id: string) => (id === 'agent-first' ? { session: first.session } : undefined),
        }),
      }),
    });
    const messagesFirst: AgentMessage[] = [];
    const runFirst = piProvider.run({
      ...first.input,
      onEvent: () => {
        for (const handler of first.recorder.extensionHandlers['subagents:started'] ?? []) {
          handler({ id: 'agent-first', type: 'general-purpose', description: '第一行任务' });
        }
        for (const handler of first.recorder.extensionHandlers['subagents:completed'] ?? []) {
          handler({ id: 'agent-first', type: 'general-purpose', description: '第一行任务', result: '完成', status: 'completed', usage: { input: 10, output: 1, cacheRead: 0, totalTokens: 11 } });
        }
      },
      onMessage: (message) => messagesFirst.push(message),
    });
    await vi.waitFor(() => {
      expect(first.recorder.assemblyOrder).toContain('create-session');
    });
    setAgentRuntimeForTesting({
      sdkModule: createFakePiSdk({
        recorder: second.recorder,
        registryEntryFactory: () => ({
          getRecord: (id: string) => (id === 'agent-second' ? { session: second.session } : undefined),
        }),
      }),
    });
    const messagesSecond: AgentMessage[] = [];
    const runSecond = piProvider.run({
      ...second.input,
      onEvent: () => {
        for (const handler of second.recorder.extensionHandlers['subagents:started'] ?? []) {
          handler({ id: 'agent-second', type: 'general-purpose', description: '第二行任务' });
        }
        for (const handler of second.recorder.extensionHandlers['subagents:completed'] ?? []) {
          handler({ id: 'agent-second', type: 'general-purpose', description: '第二行任务', result: '完成', status: 'completed', usage: { input: 10, output: 1, cacheRead: 0, totalTokens: 11 } });
        }
      },
      onMessage: (message) => messagesSecond.push(message),
    });
    await Promise.all([runFirst, runSecond]);

    // 各行只看得到自己那份子会话正文（来源 wire），另一行的身份一个字都不进本行
    expect(messagesFirst.filter((message) => message.subagentId !== null).map((message) => [message.subagentId, message.source]))
      .toEqual([['agent-first', 'wire']]);
    expect(messagesSecond.filter((message) => message.subagentId !== null).map((message) => [message.subagentId, message.source]))
      .toEqual([['agent-second', 'wire']]);
    expect((globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY]).toBeUndefined();
  });

  /**
   * **wire 通道快照落空的降级姿态**（claim 没发生那档）：子任务正文整行退回转写文件通道，
   * 来源照旧 `session-file`（「补录」角标如实标注），结论与子任务行不受影响。
   */
  it('wire 快照落空：子任务正文退回转写文件通道（来源 session-file），结论不受影响', async () => {
    const input = freshRow();
    const recorder = createFakePiRecorder();
    recorder.sessionId = 'session-degraded';
    for (const event of fullRoundTripEvents()) recorder.events.push(event);
    recorder.events.push({ type: 'turn_start' });
    recorder.events.push({
      type: 'tool_execution_start',
      toolName: 'Agent',
      toolCallId: 'call_sub',
      args: { prompt: '核对页面', description: '核对页面' },
    });
    recorder.events.push({
      type: 'tool_execution_end',
      toolName: 'Agent',
      toolCallId: 'call_sub',
      isError: false,
      durationMs: 12,
      result: {
        content: [{ type: 'text', text: 'Agent completed.' }],
        details: { description: '核对页面', status: 'completed', turnCount: 1, agentId: 'agent-sub' },
      },
    });
    recorder.events.push({ type: 'agent_settled', aborted: false });

    const transcript = piSubagentTranscriptPath({ cwd: input.cwd, sessionId: recorder.sessionId, agentId: 'agent-sub' });
    if (transcript === null) throw new Error('夹具算不出转写路径');
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({
      isSidechain: true,
      agentId: 'agent-sub',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '兑底的正文' }], usage: { input: 10, output: 2, cacheRead: 0, totalTokens: 12 }, stopReason: 'stop' },
      timestamp: '2026-10-15T23:44:02.773Z',
      cwd: input.cwd,
    })}\n`, 'utf8');

    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder, registryEntryFactory: null }) });
    const messages: AgentMessage[] = [];
    let busFired = false;
    const result = await piProvider.run({
      ...input,
      onEvent: () => {
        if (busFired) return;
        busFired = true;
        for (const handler of recorder.extensionHandlers['subagents:started'] ?? []) {
          handler({ id: 'agent-sub', type: 'general-purpose', description: '核对页面' });
        }
        for (const handler of recorder.extensionHandlers['subagents:completed'] ?? []) {
          handler({ id: 'agent-sub', type: 'general-purpose', description: '核对页面', result: '核对完毕', status: 'completed', usage: { input: 100, output: 5, cacheRead: 0, totalTokens: 105 } });
        }
      },
      onMessage: (message) => messages.push(message),
    });
    const child = messages.filter((message) => message.subagentId === 'agent-sub');
    expect(child.map((message) => [message.source, message.role])).toEqual([['session-file', 'assistant']]);
    expect(child[0]?.blocks[0]).toMatchObject({ type: 'text', text: '兑底的正文' });
    expect(result.subagentTokens).not.toBeNull();
  });

  /**
   * **增量通道隔离**（按一致性套件的同一条口径）：喂了增量帧的场景必须钉住**事件条数**。
   *
   * 判据有两半，缺一不可：
   *   · 事件条数等于下面的字面量，其中 `log` 那 20 条逐条可数（14 条阶段/角色事件各一条原始负载、
   *     两次助手 `message_end`——第二次多一条答复正文的人话日志、工具起止各一条、两次 `turn_end`、
   *     `agent_end` 与 `agent_settled`）；**喂进去的 4 个增量帧一条都不算**，它们只产内容消息；
   *   · 另外 4 条是 `usage`（两次 `turn_start`、两次助手收尾；`agent_settled` 那一次与上一条逐字段
   *     相同、被骨架去重）；
   *   · 事件流里不出现 `assistantMessageEvent`（增量帧的信封名）——比数数更直接地指向漏点。
   * 增量一旦掉回 `log` 兜底，条数就是 baseline + 帧数，这里当场红。
   */
  it('增量不产事件：事件条数被钉住，事件流里不含增量信封', async () => {
    const recorder = createFakePiRecorder();
    for (const event of fullRoundTripEvents()) recorder.events.push(event);
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const events: AgentEvent[] = [];
    await piProvider.run({ ...createRunInput(), onEvent: (event) => events.push(event) });
    expect(events.filter((event) => event.type === 'log')).toHaveLength(20);
    expect(events).toHaveLength(24);
    const leaked = events.filter((event) => event.type === 'log' && event.text.includes('assistantMessageEvent'));
    expect(leaked).toEqual([]);
  });

  /**
   * **思考正文与工具结果正文必须能在事件流里逐字查到**（`needsMessagesForReasoningEvidence: false`
   * 的实现义务）。判据取的是**产物**：拿真实跑出来的一串事件去查那两段文本，而不是断言
   * 「投影里有一句会落盘」——后者是无区分力的自述。
   */
  it('思考正文与工具结果正文都进 log（推理证据不必再补 messages.jsonl）', async () => {
    const recorder = createFakePiRecorder();
    for (const event of fullRoundTripEvents()) recorder.events.push(event);
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const events: AgentEvent[] = [];
    await piProvider.run({ ...createRunInput(), onEvent: (event) => events.push(event) });
    const logs = events.flatMap((event) => (event.type === 'log' ? [event.text] : [])).join('\n');
    expect(logs).toContain('先看 note.txt');
    expect(logs).toContain('fixture body');
  });

  /**
   * 看门狗路径：pi 的 `prompt()` 永不抛，挂死只能由骨架的静止超时收掉。
   * 这条同时钉住「中止之后适配器仍要把流交出来」——pi 的 `abort()` 会终结在途轮次。
   */
  it('看门狗判定静止超时后按 timed-out 收场，运行时被释放', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder, hangPrompt: true }) });
    const events: AgentEvent[] = [];
    const result = await piProvider.run({
      ...createRunInput(),
      // 两级都调小到毫秒级；墙钟那一级关掉，让结论只可能来自空闲超时
      watchdog: { idleTimeoutMs: 30, turnWallClockMs: 0 },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitReason).toBe('timed-out');
    expect(result.error?.code).toBe('AGENT_TIMED_OUT');
    expect(recorder.abortCount).toBeGreaterThanOrEqual(1);
    expect(recorder.disposeCount).toBe(1);
  });

  it('用户终止：结论落 canceled（与看门狗那条分得开）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder, hangPrompt: true }) });
    const controller = new AbortController();
    const running = piProvider.run({
      ...createRunInput(),
      signal: controller.signal,
      // 关掉两级看门狗：这一条只测「用户点的终止」，不许被静止超时抢答
      watchdog: { idleTimeoutMs: 0, turnWallClockMs: 0 },
      onEvent: () => {},
    });
    // 等提示词真的交出去再终止（订阅与 prompt 都在流的第一轮迭代里）
    await vi.waitFor(() => {
      expect(recorder.prompts).toHaveLength(1);
    });
    controller.abort();
    const result = await running;
    expect(result.exitReason).toBe('canceled');
    expect(result.error?.code).toBe('AGENT_CANCELED');
    expect(recorder.disposeCount).toBe(1);
  });

  /**
   * **起请求之前的抛错必须折成失败**。
   *
   * 厂商的 `prompt()` 在凭据缺失 / 模型未选 / 正在压缩 / 已有在跑的轮次时会**直接抛**（`.d.ts`
   * 的 `@throws` 一族），它不是「运行期失败」那条 `stopReason` 通道。把拒绝与落定归成同一个信号
   * ⇒ 一次「凭据缺失」被读成 `ok:true / completed / finalText:null`（「成功了、只是没说话」），
   * 而骨架的 catch 与归因层都看不到它（真机形状：路由不给 apiKey ⇒ **零出站请求**却报成功；
   * 候选行因此被记成 completed、评分行报「适配器未回传最终消息」，两处都指向错误的方向）。
   */
  it('prompt() 在建请求前抛错 ⇒ 折成失败（不许静默成功），且释放照旧', async () => {
    const recorder = createFakePiRecorder();
    const sdk = createFakePiSdk({ recorder }) as Record<string, Record<string, unknown>>;
    const piSdk = sdk['@earendil-works/pi-coding-agent'] as Record<string, unknown>;
    const createSession = piSdk['createAgentSession'] as (options: unknown) => Promise<{ session: { prompt: unknown } }>;
    piSdk['createAgentSession'] = async (options: unknown) => {
      const created = await createSession(options);
      created.session.prompt = async () => {
        throw new Error('Authentication failed for "aieval-pi-test". Use /login or set an API key.');
      };
      return created;
    };
    setAgentRuntimeForTesting({ sdkModule: sdk });
    const result = await piProvider.run({
      ...createRunInput(),
      watchdog: { idleTimeoutMs: 0, turnWallClockMs: 0 },
    });

    expect(result.ok, 'prompt 的拒绝被吞成了成功').toBe(false);
    expect(result.exitReason).toBe('error');
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('Authentication failed');
    // 失败路径同样要收干净（释放不是成功路径的特权）
    expect(recorder.disposeCount).toBe(1);
  });

  /**
   * **释放序列要给扩展发一次 `session_shutdown`（reason: `quit`），且发在 `dispose()` 之前**。
   *
   * 厂商把扩展自己的关闭钩子挂在这个事件上（MCP 扩展的连接清理——进而 stdio 子进程的回收——
   * 就是它），而 `AgentSession.dispose()` **不 emit** 它：只有 `AgentSessionRuntime.dispose()`
   * 与 `reload()` 会。窄壳走 `createAgentSession()`，所以这一发由适配器按厂商同一条顺序补上
   * （`AgentSessionRuntime.dispose()` 的实体就是 `emit(session_shutdown{reason:'quit'})` → `session.dispose()`）。
   *
   * 判据取**两条**：装了监听者的行里那一发有且只有一次、且排在 `dispose` 之前；
   * 没有监听者的行里**一次都不发**（`hasHandlers` 那一格不是装饰）。
   */
  it('释放时给扩展发一次 session_shutdown(quit)，且排在 dispose 之前；没人听就不发', async () => {
    const withListener = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder: withListener, shutdownListener: true }) });
    const first = await piProvider.run({ ...createRunInput(), watchdog: { idleTimeoutMs: 0, turnWallClockMs: 0 } });
    expect(first.ok).toBe(true);
    expect(withListener.extensionShutdowns).toEqual(['session_shutdown:quit']);
    expect(withListener.releaseOrder).toEqual(['session_shutdown:quit', 'dispose']);

    const withoutListener = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder: withoutListener }) });
    const second = await piProvider.run({ ...createRunInput(), watchdog: { idleTimeoutMs: 0, turnWallClockMs: 0 } });
    expect(second.ok).toBe(true);
    expect(withoutListener.extensionShutdowns, '没有监听者时不许白走一趟 emit').toEqual([]);
    expect(withoutListener.disposeCount).toBe(1);
  });
});

/**
 * 一次完整往返的原始事件串（两轮、一次工具调用），逐条照真机序列的形状写。
 * 单列出来是为了让「产物断言」与「事件条数」两条用例喂**同一份**输入。
 */
function fullRoundTripEvents(): unknown[] {
  const assistant = (content: unknown[], usage: Record<string, unknown>, stopReason: string): unknown => ({
    type: 'message_end',
    message: {
      role: 'assistant',
      content,
      usage,
      stopReason,
      responseId: 'resp-1',
      timestamp: 1_700_000_000_000,
    },
  });
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'system', content: 'sys' } },
    { type: 'message_end', message: { role: 'system', content: 'sys' } },
    { type: 'message_start', message: { role: 'user', content: '改标题' } },
    { type: 'message_end', message: { role: 'user', content: '改标题' } },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    // 两个增量帧：思考与「工具入参片段」。它们只该进内容通道
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '先看 note.txt' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"path"' } },
    assistant(
      [
        { type: 'thinking', thinking: '先看 note.txt', thinkingSignature: 'reasoning_content' },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'note.txt' } },
      ],
      { input: 846, output: 12, cacheRead: 0, cacheWrite: 0, reasoning: 11, totalTokens: 858, cost: {} },
      'toolUse',
    ),
    { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', args: { path: 'note.txt' } },
    {
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'read',
      isError: false,
      durationMs: 3,
      result: { content: [{ type: 'text', text: 'fixture body' }], details: { lines: 1 } },
    },
    { type: 'message_start', message: { role: 'toolResult', toolCallId: 'call_1' } },
    { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_1' } },
    { type: 'turn_end', message: { role: 'assistant' }, toolResults: [] },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '改好' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '了' } },
    assistant(
      [{ type: 'text', text: '改好了' }],
      { input: 36, output: 38, cacheRead: 832, cacheWrite: 0, reasoning: 3, totalTokens: 906, cost: {} },
      'stop',
    ),
    { type: 'turn_end', message: { role: 'assistant' }, toolResults: [] },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled', aborted: false },
  ];
}

describe('pi 的凭据投射（并发隔离：真包 + 本地假网关）', () => {
  /**
   * **交叠闸门**：两行都发出**第一次**请求之前，谁都拿不到回包。
   *
   * 为什么需要它：没有闸门时第二行要等第一行整个跑完才开始装配（实测两行的注册都在 370 ms 前后、
   * 但注销也一样整齐），于是「两行共用一份 provider 注册 / 一份凭据表」这类缺陷**原理上踩不到**
   * ——把 provider id 改成常量、把 runtime 改成模块级共享，用例照样全绿（实测过）。
   * 闸门把两行钉在同一个窗口里：各自的注册、鉴权与首次请求都发生在对方的运行期内，
   * 隔离才被真正检验。
   *
   * 判据用**真实请求到达**（而不是计时器）：闸门只在两台的第一次请求都到齐之后才放行。
   */
  function createOverlapGate() {
    let arrived = 0;
    let release: (() => void) | null = null;
    const allArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      /** 这一行的第一次请求到了：两台都到齐就一起放行 */
      async wait(): Promise<void> {
        arrived += 1;
        if (arrived >= 2) release?.();
        await allArrived;
      },
      /** 已经放行过（后续请求不该再被闸住） */
      get opened(): boolean {
        return arrived >= 2;
      },
    };
  }

  /** 本地假网关：记下「谁打过来的、带的是哪把密钥」，然后回一段最简的 OpenAI 流 */
  function startGateway(
    seen: Array<{ url: string; auth: string | undefined }>,
    gate: { wait: () => Promise<void>; opened: boolean },
  ): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        // openai 那条 wire 用 `Authorization: Bearer`；anthropic 那条用 `x-api-key`
        //（头值类型是 `string | string[] | undefined`，按真实标量头收窄）
        const bearer = req.headers.authorization;
        const apiKeyHeader = req.headers['x-api-key'];
        seen.push({
          url: req.url ?? '',
          auth: typeof bearer === 'string' ? bearer : typeof apiKeyHeader === 'string' ? apiKeyHeader : undefined,
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        void (async () => {
          // 首次请求过闸门（第二次起直接放行，否则两行的第二次请求会互相等）
          if (!gate.opened) await gate.wait();
          // Responses wire 的最简流（事件名 + `type` 都给，见 `pi-gateway-fixture` 的同款说明）
          const item = {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done', annotations: [] }],
          };
          for (const [name, payload] of [
            ['response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }],
            ['response.output_item.added', {
              type: 'response.output_item.added',
              output_index: 0,
              item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
            }],
            ['response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: 'msg_1',
              output_index: 0,
              content_index: 0,
              delta: 'done',
            }],
            ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
            ['response.completed', {
              type: 'response.completed',
              response: {
                id: 'resp_1',
                status: 'completed',
                output: [item],
                usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, total_tokens: 7 },
              },
            }],
          ] as Array<[string, Record<string, unknown>]>) {
            res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        })();
      });
    });
    server.unref();
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
      });
    });
  }

  /** 一行：真包走生产路径（不经 sdkModule 注入），打到指定的本地网关 */
  async function runRow(root: string, port: number, apiKey: string): Promise<void> {
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    mkdirSync(cwd, { recursive: true });
    const result = await piProvider.run({
      ...createRunInput({ cwd, configHome }),
      prompt: 'say done',
      route: {
        protocolType: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey,
        modelId: 'm1',
        contextWindow: 100_000,
        maxOutputTokens: 4_096,
      },
      onEvent: () => {},
    });
    expect(result.ok, result.error?.message).toBe(true);
  }

  /**
   * **并发隔离**（规格的硬要求）：两行**同时**跑、`baseUrl` 与 `apiKey` 各不相同，
   * 断言各自出站打到自己那台、密钥不串。
   *
   * 变异体（把 per-run runtime 改成模块级共享）必须让这条红：共享之后两行的 provider 注册互相覆盖，
   * 请求会一起落到同一台网关上、带着同一个密钥——而两行的日志、事件、结论全是正常的。
   */
  it('两行同时跑：各自打到自己那台网关、各自的密钥不串', async () => {
    const seenA: Array<{ url: string; auth: string | undefined }> = [];
    const seenB: Array<{ url: string; auth: string | undefined }> = [];
    // 两台网关共用**同一个**闸门（判据是「两台都收到第一次请求」）
    const gate = createOverlapGate();
    const gatewayA = await startGateway(seenA, gate);
    const gatewayB = await startGateway(seenB, gate);
    setAgentRuntimeForTesting(null);
    const rootA = mkdtempSync(join(tmpdir(), 'pi-row-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'pi-row-b-'));
    try {
      await Promise.all([
        runRow(rootA, gatewayA.port, 'sk-row-a'),
        runRow(rootB, gatewayB.port, 'sk-row-b'),
      ]);
      /**
       * 判据是**每一条**出站请求，不是「至少有一条」：
       *   · 本次提示词不调工具 ⇒ 一次模型往返 ⇒ 每台恰好一条请求（数目也钉住：
       *     跑出第二条说明装配把同一轮发了两次，那是另一个缺陷）；
       *   · 每条都必须是**自己那把密钥**（`Bearer` 前缀逐字比对，不用模糊包含）。
       */
      expect(seenA.length).toBe(1);
      expect(seenB.length).toBe(1);
      expect([...new Set(seenA.map((request) => request.auth))]).toEqual(['Bearer sk-row-a']);
      expect([...new Set(seenB.map((request) => request.auth))]).toEqual(['Bearer sk-row-b']);
      // 密钥不串：以「另一行的密钥」为子串的请求一条都不许有（含被改写过的形态）
      expect(seenB.some((request) => request.auth?.includes('sk-row-a'))).toBe(false);
      expect(seenA.some((request) => request.auth?.includes('sk-row-b'))).toBe(false);
      expect(seenA.every((request) => request.url === '/v1/responses')).toBe(true);
      expect(seenB.every((request) => request.url === '/v1/responses')).toBe(true);
    } finally {
      gatewayA.server.close();
      gatewayB.server.close();
    }
  }, 60_000);

  /**
   * **注册面归属**：每次运行各有一份 `ModelRuntime` 与一份凭据存储，凭据不跨运行残留。
   *
   * 为什么这条与出站那条不能互相顶替：出站断言证明的是「请求打对了地方」，而**每行的模型定义自带
   * destination**（`Model` 上有 `baseUrl`）⇒ 把 runtime 改成模块级共享、provider id 改成常量，
   * 出站照样各自正确（实测：共享 runtime + 常量 id，两行仍各自 200、密钥不串）。
   * 真正会坏的是**注册面本身**：共享之后序号 N 的注册被 N+1 覆盖（同名对撞），
   * 而每次运行在收尾都 `unregisterProvider` ⇒ 序号 N 的收尾会把序号 N+1 的注册一起注销掉。
   * 这条用例就钉「注册面按 run 划界」：两行各自的注册 id 必须留在**自己那一份**里。
   */
  it('注册面按 run 划界：两行各有一份 runtime 与凭据存储，注册 id 不互见', async () => {
    const makeRow = (): { recorder: ReturnType<typeof createFakePiRecorder>; input: ReturnType<typeof createRunInput> } => {
      const root = mkdtempSync(join(tmpdir(), 'pi-row-registry-'));
      const cwd = join(root, 'workspace');
      const configHome = join(root, '.agenthome');
      mkdirSync(cwd, { recursive: true });
      const recorder = createFakePiRecorder();
      return { recorder, input: createRunInput({ cwd, configHome }) };
    };
    const first = makeRow();
    const second = makeRow();

    // 两行真的同时跑：先各装配到一半，再一起收尾（共享句柄的缺陷正是在交叠里现形）
    const fakeFirst = createFakePiSdk({ recorder: first.recorder });
    setAgentRuntimeForTesting({ sdkModule: fakeFirst });
    const runFirst = piProvider.run({ ...first.input, onEvent: () => {} });
    await vi.waitFor(() => {
      expect(first.recorder.assemblyOrder).toContain('create-session');
    });
    const fakeSecond = createFakePiSdk({ recorder: second.recorder });
    setAgentRuntimeForTesting({ sdkModule: fakeSecond });
    const runSecond = piProvider.run({ ...second.input, onEvent: () => {} });
    await vi.waitFor(() => {
      expect(second.recorder.assemblyOrder).toContain('create-session');
    });
    await Promise.all([runFirst, runSecond]);

    // 两次运行必须是**两份** runtime 与**两份**凭据存储
    expect(first.recorder.runtimeOptions).not.toBe(second.recorder.runtimeOptions);
    const firstStore = first.recorder.runtimeKeys[0]?.store as { writes: string[] };
    const secondStore = second.recorder.runtimeKeys[0]?.store as { writes: string[] };
    expect(firstStore).not.toBe(secondStore);
    // 凭据不跨运行残留：各自那份里只有自己那一笔
    expect(firstStore.writes).toEqual([`${piProviderId(first.input.configHome)}=sk-test-key`]);
    expect(secondStore.writes).toEqual([`${piProviderId(second.input.configHome)}=sk-test-key`]);
    // 注册 id 由 configHome 派生 ⇒ 两行不撞名；收尾各自注销自己的那一个
    const firstId = first.recorder.registered[0]?.providerId;
    const secondId = second.recorder.registered[0]?.providerId;
    expect(firstId).toBe(piProviderId(first.input.configHome));
    expect(secondId).toBe(piProviderId(second.input.configHome));
    expect(firstId).not.toBe(secondId);
    expect(first.recorder.unregistered).toEqual([firstId]);
    expect(second.recorder.unregistered).toEqual([secondId]);
  });

  /**
   * anthropic 那条 wire 的**出站路径**：`stripV1Suffix` 之后由 SDK 追加 `/v1/messages`。
   * 与 openai 那条分开断言，因为两条的归一方向相反（写反了是一条 404，而日志里只有一句
   * 厂商原文的 `stopReason: 'error'`）。
   */
  it('anthropic 那条 wire：剥尾 /v1 之后打到 /v1/messages', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        // anthropic 那条 wire 的凭据在 `x-api-key` 上（不是 `Authorization`）
        seen.push({ url: req.url ?? '', auth: req.headers['x-api-key'] as string | undefined });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":1}}}\n\n');
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      });
    });
    server.unref();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    try {
      const root = mkdtempSync(join(tmpdir(), 'pi-row-anthropic-'));
      const cwd = join(root, 'workspace');
      const configHome = join(root, '.agenthome');
      mkdirSync(cwd, { recursive: true });
      const result = await piProvider.run({
        ...createRunInput({ cwd, configHome }),
        prompt: 'say ok',
        route: {
          protocolType: 'anthropic',
          // 尾部带 `/v1`：归一必须剥掉它，否则会打成 `/v1/v1/messages`
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'sk-anth',
          modelId: 'm1',
        },
        onEvent: () => {},
      });
      expect(result.ok, result.error?.message).toBe(true);
      expect(seen.map((request) => request.url)).toEqual(['/v1/messages?beta=true']);
      expect(seen[0]?.auth).toBe('sk-anth');
    } finally {
      server.close();
    }
  }, 60_000);

  /**
   * **凭据不落盘**：跑完行配置目录里只有**会话落点**那一层——没有 `auth.json`、没有 `models.json`、
   * 没有 `models-store.json`。默认的 `DefaultAuthStorage` 会在**读一下**的时候就建出一个空壳
   * `auth.json`，这条用例是那条通道的唯一网。
   *
   * 为什么这里现在会看到 `sessions/`：会话是文件型的（续接靠它），落点就是 `<configHome>/sessions`。
   * 这一格是**该有的产物**，与「凭据 / 模型目录泄漏」是两件事——故用**正列举**而不是「目录为空」，
   * 既有那几条泄漏断言逐条保留。
   */
  it('跑完行目录里只有会话落点（凭据与模型目录都不落盘）', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const gateway = await startGateway(seen, { wait: async () => {}, opened: true });
    try {
      const root = mkdtempSync(join(tmpdir(), 'pi-row-disk-'));
      const cwd = join(root, 'workspace');
      const configHome = join(root, '.agenthome');
      mkdirSync(cwd, { recursive: true });
      await piProvider.run({
        ...createRunInput({ cwd, configHome }),
        route: {
          protocolType: 'openai',
          baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
          apiKey: 'sk-disk-secret',
          modelId: 'm1',
        },
        onEvent: () => {},
      });
      /**
       * 行配置目录里只有会话落点那一层（本次没传 skills ⇒ 连技能根都不建）。
       * 默认的 `DefaultAuthStorage` 会在**读一下**的时候就建出 2 字节的空壳 `auth.json`，
       * `modelsPath` 不设 `null` 时会建出 `models.json` / `models-store.json`——三者逐个点名。
       */
      expect(readdirSync(configHome)).toEqual(['sessions']);
      // 会话真的落在那里面（一条 `.jsonl`，且路径就是收尾要报的那一格）
      const sessionFiles = readdirSync(piSessionDir(configHome));
      expect(sessionFiles).toHaveLength(1);
      expect(sessionFiles[0]?.endsWith('.jsonl')).toBe(true);
      for (const leaked of ['auth.json', 'models.json', 'models-store.json', 'settings.json']) {
        expect(existsSync(join(configHome, leaked)), leaked).toBe(false);
      }
      // 工作区没有被我们写过任何东西
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      gateway.server.close();
    }
  }, 60_000);
});

/**
 * **出站工具表**：权限档到工具面的最后一公里。
 *
 * 为什么必须拿真出站请求判、而不是读 `PI_PERMISSION_OPTIONS`：那一张表只是**我们交给装配面的
 * 白名单**，而「名单里的名字到底有没有变成模型可见的工具」还隔着厂商那一层——白名单是
 * **成员匹配器**，名字对不上（扩展改名、拼错、或名单整个被当成修饰符丢掉）时**一个字都不报**，
 * 只是这一轮少一件工具。真机形态：只读档名单里塞了 `Agent` 时，请求体的 `tools` 数组里真的有它。
 *
 * 两条判据各自独立：执行档要**有**派发工具（否则「声明支持派发」落不到工具面上），
 * 只读档要**没有**任何扩展工具（`Agent` 派出的子会话能写文件 ⇒ 权限提升）。
 */
describe('pi 的出站工具表（真包 + 假网关）', () => {
  it('执行档请求体里有扩展那三件、只读档一件都没有（白名单是成员匹配器，不列就静默消失）', async () => {
    const full = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      permission: 'full',
      script: [anthropicText('好。')],
    });
    const readOnly = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      permission: 'read-only',
      script: [anthropicText('好。')],
    });

    // 请求体的 `tools` 就长这样（顺序 = 装配面给出的名单顺序，后面那件通配在没有 MCP 时无命中）
    expect(full.requestTools).toEqual(['read', 'bash', 'edit', 'write', 'Agent', 'get_subagent_result', 'steer_subagent']);
    expect(readOnly.requestTools).toEqual(['read', 'grep', 'find', 'ls']);
    // 逐件再判一次：整表相等会在「只多了一件」时也红，而这里要的是「一件都不许多」
    for (const tool of PI_SUBAGENTS_TOOL_NAMES) {
      expect(readOnly.requestTools, `只读档的出站工具表里出现了 ${tool}`).not.toContain(tool);
      expect(full.requestTools, `执行档的出站工具表里缺了 ${tool}`).toContain(tool);
    }
  }, 60_000);

  /**
   * **提问那一件**（宿主注册的自定义工具）在出站请求里的两臂：传了应答面才有它。
   *
   * 为什么必须从**请求体**判：白名单是成员匹配器，名字没拼进去时厂商**静默**少一件——
   * 「我们交了一份工具定义」与「模型看得到它」是两件事，只有出站那一份请求分得开。
   */
  it('提问工具只随应答面出站：传了回调在 `tools[]` 里，不传则整表少它一件', async () => {
    const withCallback = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      script: [anthropicText('好。')],
      onAskUser: async () => ({ outcome: 'answered', answers: [{ header: '选路径', selected: ['选项 A'], custom: null }] }),
    });
    const withoutCallback = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      script: [anthropicText('好。')],
    });

    expect(withCallback.requestTools).toEqual([
      'read', 'bash', 'edit', 'write', 'Agent', 'get_subagent_result', 'steer_subagent', PI_ASK_USER_TOOL,
    ]);
    expect(withoutCallback.requestTools).toEqual([
      'read', 'bash', 'edit', 'write', 'Agent', 'get_subagent_result', 'steer_subagent',
    ]);
  }, 60_000);

  /**
   * **提示词那两格真的进了出站请求**（`promptSnippet` 进 `## Available tools` 段、
   * `promptGuidelines` 进 `## Guidelines` 段）。
   *
   * 为什么必须从请求体判：这两格是**宿主工具这条通道唯一的行为提示来源**（厂商不给时机提示），
   * 写错一个字（例如把字段名写成 `promptSnippets`）编译期不报、运行期静默无效——`PiSessionOptions`
   * 是本仓手写的窄接口，不与厂商的选项类型对账。判据取**这两段文本出现在系统段里**，
   * 而不是「我们把这个字符串交给了 SDK」。
   */
  it('提问工具的三格提示词都进了出站请求的系统段（宿主工具这条通道的时机提示只能靠它）', async () => {
    const withCallback = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      script: [anthropicText('好。')],
      onAskUser: async () => ({ outcome: 'unavailable', answers: null }),
    });
    const system = piSystemText(withCallback.requests[0]?.body, 'anthropic-messages');
    // 工具段那一行由厂商渲染成 `- <工具名>: <promptSnippet>`，两个都在
    expect(system).toContain(`- ${PI_ASK_USER_TOOL}: ${PI_ASK_USER_SNIPPET}`);
    for (const guideline of PI_ASK_USER_GUIDELINES) {
      expect(system, `提示词里的时机约束「${guideline.slice(0, 12)}…」没进系统段`).toContain(guideline);
    }
    // 不传回调 ⇒ 这一件不在，那两段里也就不该有它（同一个判据的反面）
    const withoutCallback = await runPiConformanceRow({ prompt: '按剧本收尾。', script: [anthropicText('好。')] });
    const bare = piSystemText(withoutCallback.requests[0]?.body, 'anthropic-messages');
    expect(bare).not.toContain(PI_ASK_USER_TOOL);
  }, 60_000);
});

/**
 * 结构化输出的**三条路径**（原生 / 降级 / 没要 schema）与 `applied.structuredOutput` 的口径。
 *
 * 判据全部落在**出站请求**与**运行结果**两份事实上（真包 + 假网关）：只判其中一份等于没判——
 * 适配器整段忽略 `outputSchema` 时，结果里那一格照样可以是自述。
 */
describe('pi 的结构化输出通道（真包 + 假网关）', () => {
  /** 评分 schema 的同族形状：根对象 + 必填标量 + 封闭对象（与另三家拿到的题目同形） */
  const schema = {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
    additionalProperties: false,
  };

  it('原生通道：工具带着原 schema 出站、参数投影回最终答复、上报为真', async () => {
    const run = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      script: [
        anthropicToolUse(PI_STRUCTURED_OUTPUT_TOOL, { verdict: '还行' }, 'toolu_native'),
        anthropicText('已提交。'),
      ],
      outputSchema: schema,
    });
    expect(run.strictTool?.strict, '工具没有开厂商侧强制').toBe(true);
    expect(run.strictTool?.parameters, '出站的 schema 不是调用方那一份').toEqual(schema);
    expect(run.outcome.applied.structuredOutput, '答复来自被 strict 约束的工具参数').toBe(true);
    expect(JSON.parse(run.outcome.finalText ?? ''), '产物没有投影回最终答复').toEqual({ verdict: '还行' });
    // 投影出去的那条助手快照必须是**同一份文本**：评分通路与对话视图各读一处，两处漂移最难查
    const snapshots = run.product.messages.filter(
      (message) => message.role === 'assistant' && message.chunk === 'snapshot' && message.blocks.some((block) => block.type === 'text' && block.text === run.outcome.finalText),
    );
    expect(snapshots.length, '最终答复在对话视图里没有对应的一条助手快照').toBeGreaterThan(0);
  }, 60_000);

  it('模型没走工具（只回正文）⇒ 工具声明照样出站，但上报为假', async () => {
    const run = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      // 这一格是**允许**的：pi 的 `ToolChoice` 只有 auto / none，模型完全可以不调工具
      script: [anthropicText(JSON.stringify({ verdict: '还行' }))],
      outputSchema: schema,
    });
    expect(run.strictTool?.strict, '工具声明本身仍然是 strict').toBe(true);
    expect(run.outcome.applied.structuredOutput, '答复是正文，形状没有任何厂商保证').toBe(false);
  }, 60_000);

  it('预检不过 ⇒ 显式降级：工具降 prefer（照样出站）、原 schema 进提示词、上报为假', async () => {
    // `additionalProperties: true` 是 pi 的 strict 子集明确拒绝的构造（开放对象）
    const rejected = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: true,
    };
    const run = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      script: [anthropicText(JSON.stringify({ verdict: '还行' }))],
      outputSchema: rejected,
    });
    // 降级不收窄 schema：进提示词的是**原样**那一份（开放对象那一格逐字还在）
    const system = JSON.stringify(run.requests[0]?.body ?? {});
    expect(system, '降级时提示词里没有那份 schema').toContain('additionalProperties');
    /**
     * 工具**留声明**：`strict: 'prefer'` 的语义是「拿不到 strict 就静默回落成非 strict 声明」，
     * 模型照旧拿得到这条出口；`strict` 那一格因此不是 `true`（厂商没有按 schema 约束形状）。
     */
    expect(run.requestTools, '降级档把工具整个撤掉了').toContain(PI_STRUCTURED_OUTPUT_TOOL);
    expect(run.strictTool?.strict, '降级档仍然声称厂商侧强制').not.toBe(true);
    expect(run.outcome.applied.structuredOutput, '降级路径不许上报成原生通道').toBe(false);
  }, 60_000);

  /**
   * 降级档的**工具调用**：模型调了工具、参数也投影进了最终答复，但那一档没有厂商侧强制
   * ⇒ 上报仍为 `false`。这一格与上面那条分得开：上面钉的是「没调工具也不许报真」，
   * 这里钉的是「调了也不许报真」——少了它，把 `applied` 写成「答复走了工具就算」也能全绿。
   */
  it('降级档模型调了工具 ⇒ 参数进最终答复，但上报仍为假（那一档没有厂商侧强制）', async () => {
    const rejected = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: true,
    };
    const run = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      script: [
        anthropicToolUse(PI_STRUCTURED_OUTPUT_TOOL, { verdict: '还行' }, 'toolu_degraded'),
        anthropicText('已提交。'),
      ],
      outputSchema: rejected,
    });
    expect(JSON.parse(run.outcome.finalText ?? ''), '工具参数没有投影回最终答复').toEqual({ verdict: '还行' });
    expect(run.outcome.applied.structuredOutput, '没有厂商侧强制的一档不许上报成原生通道').toBe(false);
  }, 60_000);

  it('没要 schema ⇒ 一件工具都不多、上报为假（这一格不是「降级」）', async () => {
    const run = await runPiConformanceRow({ prompt: '按剧本收尾。', script: [anthropicText('好。')] });
    expect(run.requestTools).not.toContain(PI_STRUCTURED_OUTPUT_TOOL);
    expect(run.strictTool).toBeNull();
    expect(run.outcome.applied.structuredOutput).toBe(false);
  }, 60_000);
});

/**
 * 两条 wire 的**出站形态**各判一次：同一份 schema 在 openai 那条上落在 `tools[].function` 里、
 * 在 anthropic 那条上落在 `tools[]` 顶层。
 *
 * 为什么必须两条都判：`compat` 少开一格时（`supportsStrictMode` / `supportsStrictTools`）厂商是
 * **零出站请求 + `stopReason: 'error'`** 收场——请求侧事实整个消失，而这一格看起来只是「这一行
 * 莫名其妙失败了」。判据读 `observer.ts` 的纯函数（与一致性套件同一份读法），不另写一份解析。
 */
describe('pi 的 strict 工具声明在两条 wire 上的出站位置', () => {
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };

  it('openai：`tools[].function` 上带 strict 与原样 parameters', async () => {
    const seen: CapturedPiRequest[] = [];
    const gateway = await startPiGateway(seen);
    try {
      const { body } = await runPiRow(seen, gateway.port, { protocolType: 'openai', outputSchema: schema });
      /**
       * 这一行的剧本回的是**正文**（不是工具参数）⇒ 骨架会追问一轮修正，请求因此不止一条。
       * 路径那一格只钉第一条：它证明 openai 那条 wire 的请求真的发出去了（`compat` 没开时是零请求）。
       */
      expect(seen[0]?.url).toBe('/v1/responses');
      const declaration = piRequestToolDeclaration(body, PI_STRUCTURED_OUTPUT_TOOL);
      expect(declaration, 'openai 那条 wire 的请求里没有那一件工具').not.toBeNull();
      expect(declaration?.strict, 'openai 侧没有开厂商侧强制（compat.supportsStrictMode 没生效）').toBe(true);
      expect(declaration?.parameters, '出站的 schema 不是调用方那一份').toEqual(schema);
    } finally {
      gateway.server.close();
    }
  }, 60_000);

  it('anthropic：`tools[]` 顶层带 strict 与原样 input_schema', async () => {
    const seen: CapturedPiRequest[] = [];
    const gateway = await startPiGateway(seen);
    try {
      const { body } = await runPiRow(seen, gateway.port, { protocolType: 'anthropic', outputSchema: schema });
      const declaration = piRequestToolDeclaration(body, PI_STRUCTURED_OUTPUT_TOOL);
      expect(declaration, 'anthropic 那条 wire 的请求里没有那一件工具').not.toBeNull();
      expect(declaration?.strict, 'anthropic 侧没有开厂商侧强制（compat.supportsStrictTools 没生效）').toBe(true);
      expect(declaration?.parameters).toEqual(schema);
    } finally {
      gateway.server.close();
    }
  }, 60_000);
});

/**
 * **失败读数的两条真机形状**（真包 + 假网关）：一条是「起请求之前就抛」，一条是「请求发出去了、
 * 厂商把用量留在冻结全 0 上」。两条都必须在**结果**这一侧留下正确的事实——假 SDK 那条守卫
 * （把 `prompt` 换成 reject）证不了厂商真的会抛，而全 0 用量是完全真实的厂商行为。
 */
describe('pi 的失败读数（真包 + 假网关）', () => {
  it('路由不给 apiKey ⇒ 零出站请求、结论是失败（不是静默成功）', async () => {
    const run = await runPiConformanceRow({
      prompt: '随便问一句。',
      script: [anthropicText('答复。')],
      apiKey: '',
    });
    expect(run.requests, '厂商在起请求之前就该抛，一次出站都不该有').toHaveLength(0);
    expect(run.outcome.ok, '一次凭据缺失被读成了成功').toBe(false);
    expect(run.outcome.exitReason).toBe('error');
    expect(run.outcome.error?.message).toContain('No API key found');
    expect(run.outcome.finalText).toBeNull();
  }, 60_000);

  it('上游回 500（失败的一轮）⇒ tokens 是 null，不是「采到了 0 token」', async () => {
    const run = await runPiConformanceRow({ prompt: '随便问一句。', script: [], status: 500 });
    expect(run.outcome.ok).toBe(false);
    /**
     * 契约：`tokens` 采不到就是 `null`（0 会让人得出「这家很省」的错误结论）。厂商那一侧
     * 把失败消息的 `usage` 留在冻结全 0 上 ⇒ 这一格只有「拒掉全 0 指纹」才拿得到 `null`。
     */
    expect(run.outcome.tokens, '失败的一轮被记成了 0 token').toBeNull();
    const usageWarns = run.product.events.filter(
      (event) => event.type === 'log' && typeof event.text === 'string' && event.text.includes('没有可读的用量'),
    );
    expect(usageWarns.length, '「未采集计量」这条 WARN 该出现').toBeGreaterThan(0);
  }, 60_000);
});


/**
 * **MCP stdio 子进程要随这一行一起收掉**（真包 + 真 MCP 服务器 + 假网关）。
 *
 * 这是 §2.6 那条的**验收判据**：厂商把 MCP 连接的清理挂在扩展事件 `session_shutdown` 上，
 * 而 `AgentSession.dispose()` 不 emit 它 ⇒ 适配器必须在释放序列里自己补那一发（见
 * `createSessionDisposer`）。判据是**进程事实**：被测服务器把自己的 pid 写盘，`run()` 返回后
 * 那个 pid 必须已经不存在——不是「我们发过事件」，而是「子进程真的没了」。
 */
const PID_MCP_SERVER = `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.argv[2];
const pidPath = process.argv[3];
writeFileSync(pidPath, String(process.pid), 'utf8');
const mark = (line) => { try { appendFileSync(logPath, line + '\\n'); } catch {} };
const send = (message) => { process.stdout.write(JSON.stringify(message) + '\\n'); };
const TOOLS = [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }];

createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  if (message.method === 'initialize') {
    mark('initialize');
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } } });
    return;
  }
  if (message.method === 'notifications/initialized') { mark('initialized'); return; }
  if (message.method === 'tools/list') { mark('tools/list'); send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } }); return; }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
});
`;

describe('pi 的 MCP 子进程回收（真包 + 真 stdio 服务器）', () => {
  it('run() 返回之后，这一行为之拉起的 MCP 服务器已经退出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-mcp-reap-'));
    const cwd = join(root, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const serverPath = join(root, 'probe-mcp-server.mjs');
    const handshakePath = join(root, 'handshake.log');
    const pidPath = join(root, 'mcp.pid');
    writeFileSync(serverPath, PID_MCP_SERVER, 'utf8');
    writeFileSync(handshakePath, '', 'utf8');
    const seen: CapturedPiRequest[] = [];
    const { server, port } = await startPiGateway(seen);
    let pid: number | null = null;
    try {
      const result = await piProvider.run({
        ...createRunInput({ cwd, configHome: join(root, '.agenthome') }),
        prompt: 'say done',
        route: {
          protocolType: 'openai',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'sk-gateway',
          modelId: 'm1',
          contextWindow: 100_000,
          maxOutputTokens: 32_768,
        },
        mcpServers: {
          probe: { transport: 'stdio', enabled: true, command: process.execPath, args: [serverPath, handshakePath, pidPath] },
        },
        onEvent: () => {},
      });
      expect(result.ok, result.error?.message).toBe(true);
      expect(existsSync(pidPath), 'MCP 服务器没起来，这一条的结论不成立').toBe(true);
      pid = Number(readFileSync(pidPath, 'utf8').trim());
      // 退出是异步的（扩展的处理器被 await 过，但进程自己还要收尾）
      await vi.waitFor(() => {
        expect(mcpChildAlive(pid as number), `MCP 子进程 pid=${pid} 在 run() 返回后仍然活着`).toBe(false);
      }, { timeout: 5_000 });
    } finally {
      server.close();
      // 清场：这一条自己拉起的子进程由自己收掉（不许留孤儿）
      if (pid !== null && mcpChildAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 已经退出
        }
      }
    }
  }, 60_000);
});

/** 子进程还活着吗（`kill(pid, 0)` 不真发信号） */
function mcpChildAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
