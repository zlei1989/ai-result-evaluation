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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFFORT_OFF, type AgentEvent, type AgentMessage } from '@aieval/contracts';
import { AgentLoadError } from '../../errors';
import { setAgentRuntimeForTesting } from '../../runtime';
import { createRunInput } from '../../testing/agent-fixtures';
import { createFakePiRecorder, createFakePiSdk } from '../../testing/pi-sdk-fixture';
import { PI_SUBAGENTS_TOOL_NAMES } from '../../permission';
import {
  anthropicText,
  anthropicToolUse,
  runPiConformanceRow,
} from '../../testing/pi-conformance-fixture';
import { runPiRow, startPiGateway, type CapturedPiRequest } from '../../testing/pi-gateway-fixture';
import { piRequestToolDeclaration } from './observer';
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
    expect(wireForProtocol('openai')).toBe('openai-completions');
    expect(wireForProtocol('anthropic')).toBe('anthropic-messages');
    expect(baseUrlForWire('https://gw.example.com', 'openai')).toBe('https://gw.example.com/v1');
    expect(baseUrlForWire('https://gw.example.com/v1', 'openai')).toBe('https://gw.example.com/v1');
    expect(baseUrlForWire('https://gw.example.com/anthropic/v1', 'anthropic')).toBe(
      'https://gw.example.com/anthropic',
    );
  });

  it('两条 wire 的 compat 显式开（不开时 detectCompat 恒 false ⇒ 零出站请求）', () => {
    expect(compatForWire('openai-completions')).toEqual({ supportsStrictMode: true });
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
    expect(recorder.sessionOptions?.['sessionManager']).toEqual({ kind: 'memory-session' });
    expect(recorder.sessionOptions?.['settingsManager']).toMatchObject({
      kind: 'memory-settings',
      // 关掉 pi 自带重试（连接类失败默认 3 次会把墙钟放大到十几秒）
      settings: { retry: { enabled: false } },
    });
    // 扩展装配的 mode 必须写死 rpc（缺省 print 会让按 rpc 写的扩展判定配置错误）
    expect(recorder.bindings?.['mode']).toBe('rpc');
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
    expect(recorder.sessionOptions?.['tools']).toEqual(['read', 'grep', 'find', 'ls', 'mcp__*']);
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
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
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
      expect(seenA.every((request) => request.url === '/v1/chat/completions')).toBe(true);
      expect(seenB.every((request) => request.url === '/v1/chat/completions')).toBe(true);
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
   * **凭据不落盘**：跑完行目录里只有我们物化的 skills——没有 `auth.json`、没有 `models.json`、
   * 没有 `sessions/`。默认的 `DefaultAuthStorage` 会在**读一下**的时候就建出一个空壳 `auth.json`，
   * 这条用例是那条通道的唯一网。
   */
  it('跑完行目录里只有物化的 skills（凭据与模型目录都不落盘）', async () => {
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
       * 行目录里**一个文件都没有**（本次没传 skills ⇒ 连技能根都不建）。
       * 默认的 `DefaultAuthStorage` 会在**读一下**的时候就建出 2 字节的空壳 `auth.json`，
       * `modelsPath` 不设 `null` 时会建出 `models.json` / `models-store.json`——三者逐个点名。
       */
      expect(readdirSync(configHome)).toEqual([]);
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
      expect(seen[0]?.url).toBe('/v1/chat/completions');
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
