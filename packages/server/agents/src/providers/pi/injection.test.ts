// @vitest-environment node
/**
 * 两个横切面的守卫：**MCP 注入**（自给 `loadConfig` + 每台 `exposure: 'direct'` + 坏条目在我们这层摘）
 * 与**厂商侧事实**（`vendor-system`：工具表走 `vendor-tool-table`、技能面走 `getSkills()`）。
 *
 * 为什么这几条必须逐条钉住（每一条都对应一类真机缺陷）：
 *   · 不装 MCP 扩展时，`<agentDir>/mcp.json` 躺在盘上也一台都不连；只装扩展不给 `loadConfig`，
 *     读的是 `getAgentDir()` 而不是这一行的配置目录；
 *   · 曝光档的缺省是 `codemode`：工具**只可调用、不声明** ⇒ 我们的 L3 判据（payload 工具表里出现
 *     `mcp__<名>__`）永不触发，MCP 注入本身也会静默失效；
 *   · `vendor-system` 一条都不发时，行级观测格整组退化成「厂商没投送」，而这一行其实什么都有。
 *
 * ⚠️ **本文件的 `requestPayloads` 是手搓的夹具入参，不是厂商真发出去的请求**：它只能证明
 * 「拿到这样一份 payload 时我们读得出什么」，**不覆盖白名单**——工具**能不能进** payload
 * 完全由厂商在会话装配时裁决，产品把 MCP 工具滤掉时这里的断言照样绿。
 * 白名单的判据在 `allowlist.test.ts`（真包 + 假网关 + 真 stdio MCP 服务器，读出站请求的工具表）。
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, McpServers } from '@aieval/contracts';
import { setAgentRuntimeForTesting } from '../../runtime';
import { createFakePiRecorder, createFakePiSdk, type FakePiSdkOptions } from '../../testing/pi-sdk-fixture';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { createRunInput } from '../../testing/agent-fixtures';
import type { AgentRunInput } from '../../types';
import { piProvider } from '.';
import { PI_MCP_EXPOSURE, PI_MCP_STARTUP_WAIT_MS, createPiMcpLoadConfig, toPiMcpServers } from './mcp';

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'pi-injection-'));
});

afterEach(() => {
  setAgentRuntimeForTesting(null);
  removeTreeWithRetry(tempRoot);
});

/** 一棵行目录（技能与 MCP 都往 `configHome` 里落，共享目录会让断言互相泄漏） */
function freshRow(): { root: string; cwd: string; configHome: string } {
  const root = mkdtempSync(join(tempRoot, 'row-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  return { root, cwd, configHome };
}

/** 源技能目录（`materializeSkills` 读它，读不到会抛 ⇒ 每个用到 skills 的用例都要先造出来） */
function makeSourceSkill(row: { root: string }, name: string): string {
  const dir = join(row.root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 示例\n---\n\n正文\n`, 'utf8');
  return dir;
}

/**
 * 一次运行。其余几格是**夹具**的（不是产品入参）：`requestPayloads` 由假件在 `prompt()` 里依次
 * 交给 `before_provider_request` 的处理器，等价于「模型往返发出之前，观察者读到了这份 payload」；
 * `discoveredSkills` / `skillDiagnostics` 是厂商装载器在 `reload()` 那一刻报回来的技能面。
 */
async function runRow(
  recorder: ReturnType<typeof createFakePiRecorder>,
  input: AgentRunInput,
  sdkOptions: Pick<FakePiSdkOptions, 'requestPayloads' | 'discoveredSkills' | 'skillDiagnostics'> = {},
): Promise<void> {
  setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder, ...sdkOptions }) });
  await piProvider.run(input);
}

/** 技能段（厂商 `formatSkillsForPrompt` 的形状） */
function skillsSection(entries: Array<{ name: string; location: string }>): string {
  return [
    '<skills>',
    '<available_skills>',
    ...entries.flatMap((entry) => [
      '  <skill>',
      `    <name>${entry.name}</name>`,
      '    <description>示例</description>',
      `    <location>${entry.location}</location>`,
      '  </skill>',
    ]),
    '</available_skills>',
    '</skills>',
  ].join('\n');
}

/** openai wire 的请求体（系统段在 `messages[]`，工具名在 `tools[].function.name`） */
function openaiPayload(system: string, tools: string[]): unknown {
  return {
    model: 'test-model',
    messages: [{ role: 'system', content: system }, { role: 'user', content: '跑一下' }],
    tools: tools.map((name) => ({ type: 'function', function: { name } })),
  };
}

/** anthropic wire 的请求体（系统段在顶层 `system`，工具名在 `tools[].name`） */
function anthropicPayload(system: string, tools: string[]): unknown {
  return {
    model: 'test-model',
    system: [{ type: 'text', text: system }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '跑一下' }] }],
    tools: tools.map((name) => ({ name })),
  };
}

/** 只留 `vendor-system`（判别联合的窄化辅助：断言里直接读 `skills` 才过得了类型） */
function vendorEvents(events: readonly AgentEvent[]): Extract<AgentEvent, { type: 'vendor-system' }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: 'vendor-system' }> => event.type === 'vendor-system');
}

/** 日志事件里的文字（WARN 播报的判据） */
function logTexts(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'log' ? [event.text] : []));
}

/** 一次 `agent_settled`：投影必须为它跑一遍，`vendor-system` 才有出口 */
const SETTLED = { type: 'agent_settled', aborted: false };

/** `loadConfig` 的读数（假件把它原样记在 `mcpExtensionOptions` 里） */
function loadConfigOf(recorder: ReturnType<typeof createFakePiRecorder>): () => {
  servers: Array<{ name: string; config: Record<string, unknown> }>;
  errors: string[];
  autoEnableCodemode: boolean;
} {
  const options = recorder.mcpExtensionOptions ?? {};
  return options['loadConfig'] as ReturnType<typeof loadConfigOf>;
}

describe('MCP 注入：自给 loadConfig、零文件、每台显式 exposure', () => {
  it('装 MCP 扩展时给的是我们自己的 loadConfig，逐台 exposure 是 direct', async () => {
    const row = freshRow();
    const recorder = createFakePiRecorder();
    recorder.events.push(SETTLED);
    const input: AgentRunInput = {
      ...createRunInput({ cwd: row.cwd, configHome: row.configHome }),
      mcpServers: { context7: { transport: 'http', enabled: true, url: 'https://mcp.context7.com/mcp' } },
    };
    await runRow(recorder, input);

    expect(recorder.mcpExtensionInstalled, '配了 MCP 却不装扩展 ⇒ 一台都不会连').toBe(true);
    // 默认 loadConfig 读 `getAgentDir()`（受 `PI_CODING_AGENT_DIR` 控制，**不是**这一行的 agentDir），
    // 且会把被测仓库的 `.pi/mcp.json` 一起读进来 ⇒ 必须自给
    expect(typeof recorder.mcpExtensionOptions?.['loadConfig'], '不给 loadConfig ⇒ 读的不是我们的行目录').toBe('function');
    expect(recorder.mcpExtensionOptions?.['startupWaitMs'], '等待预算显式钉住，不吃厂商缺省').toBe(PI_MCP_STARTUP_WAIT_MS);

    const loaded = loadConfigOf(recorder)();
    expect(loaded.servers.map((server) => server.name)).toEqual(['context7']);
    // 曝光档：缺省 `codemode` 下工具不进模型可见的工具表（我们的 L3 判据永不触发）
    expect(loaded.servers[0]?.config['exposure']).toBe(PI_MCP_EXPOSURE);
    expect(loaded.servers[0]?.config['exposure']).toBe('direct');
    expect(loaded.autoEnableCodemode).toBe(false);
  });

  it('不给 mcpServers ⇒ 不装 MCP 扩展（本行没有 MCP 这件事在装配面上看得出来）', async () => {
    const row = freshRow();
    const recorder = createFakePiRecorder();
    recorder.events.push(SETTLED);
    await runRow(recorder, createRunInput({ cwd: row.cwd, configHome: row.configHome }));
    expect(recorder.mcpExtensionInstalled).toBe(false);
    // 观察者与 MCP 无关，它恒装：没有它两份 L3 判据都无处落
    expect(recorder.extensionHandlers['before_provider_request']?.length).toBe(1);
  });

  it('零文件注入：行目录里没有 mcp.json，被测仓库自带的 .pi/mcp.json 也进不来', async () => {
    const row = freshRow();
    // 被测仓库自带一台服务器：默认 loadConfig 会把它读进来（SDK 下 trust 恒真）
    mkdirSync(join(row.cwd, '.pi'), { recursive: true });
    writeFileSync(join(row.cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { repoOnly: { command: 'node' } } }), 'utf8');
    const recorder = createFakePiRecorder();
    recorder.events.push(SETTLED);
    const events: AgentEvent[] = [];
    const input: AgentRunInput = {
      ...createRunInput({ cwd: row.cwd, configHome: row.configHome, onEvent: (event) => events.push(event) }),
      mcpServers: { probe: { transport: 'stdio', enabled: true, command: 'node', args: ['server.js'] } },
    };
    await runRow(recorder, input);

    expect(loadConfigOf(recorder)().servers.map((server) => server.name)).toEqual(['probe']);
    // 落盘事实：注入零文件（行目录里不该出现 mcp.json）
    expect(readdirSync(row.configHome)).not.toContain('mcp.json');
    expect(logTexts(events).join('\n')).not.toContain('repoOnly');
  });

  it('坏条目在我们这一层摘：形状不对 / 占位没解析 / 键不合法，都不进厂商配置', () => {
    /**
     * 手改配置能造出来的几种坏法。编排层的形状闸在正常路径上拦得住它们，这里是**第二道防线**
     * （自给 `loadConfig` 会绕过厂商自己的校验，而 pi 的姿态是「让这一台失败」而不是跳过）。
     */
    const malformed = {
      good: { transport: 'stdio', enabled: true, command: 'node', args: ['a.js'], env: { TOKEN: 'sk-1' } },
      noCommand: { transport: 'stdio', enabled: true, command: '' },
      strayPlaceholder: { transport: 'http', enabled: true, url: 'https://x.test/${HOST}/mcp' },
      unresolvedEnv: { transport: 'stdio', enabled: true, command: 'node', env: { TOKEN: '${TOKEN}' } },
      badEnvKey: { transport: 'stdio', enabled: true, command: 'node', env: { 'BAD=KEY': 'x' } },
      badHeaderKey: { transport: 'http', enabled: true, url: 'https://y.test/mcp', headers: { 'X Y': 'v' } },
      // 用户关掉的：静默跳过（既不是「配错了」也不是「这一趟跳过」）
      off: { transport: 'http', enabled: false, url: 'https://z.test/mcp' },
    } as unknown as McpServers;

    const plan = toPiMcpServers(malformed);
    expect(plan.entries.map((entry) => entry.name)).toEqual(['good']);
    const loaded = createPiMcpLoadConfig(plan)();
    // 摘掉的原因进 `errors`：厂商的启动报告会原样带上，用户看得到「哪一条的哪一格」
    const errors = loaded.errors.join('\n');
    for (const name of ['noCommand', 'strayPlaceholder', 'unresolvedEnv', 'badEnvKey', 'badHeaderKey']) {
      expect(errors, name).toContain(name);
    }
    // 关掉的那台既不进配置也不进错误名单
    expect(errors).not.toContain('off');
  });

  it('loadConfig 每次现造一份（厂商那边改条目改不到我们这份）', () => {
    const plan = toPiMcpServers({ probe: { transport: 'stdio', enabled: true, command: 'node' } });
    const load = createPiMcpLoadConfig(plan);
    const first = load();
    const entry = first.servers[0];
    if (entry !== undefined) entry.config.command = '被改掉了';
    expect(load().servers[0]?.config.command).toBe('node');
  });
});

describe('厂商侧事实：工具表走 vendor-tool-table、技能面走 getSkills()', () => {
  // ⚠️ 这一组是**读出侧**的补充用例：payload 由本文件手搓，所以它证不了白名单放不放 MCP 工具进来
  // （那个判据在 `allowlist.test.ts`，必须走真包）。它们守的是另一半——工具表如实投送、通道自报正确。
  it('openai wire：工具表与技能清单同一条事件交出去，通道自报 vendor-tool-table', async () => {
    const row = freshRow();
    const recorder = createFakePiRecorder();
    recorder.events.push(SETTLED);
    const events: AgentEvent[] = [];
    const input: AgentRunInput = {
      ...createRunInput({ cwd: row.cwd, configHome: row.configHome, onEvent: (event) => events.push(event) }),
      mcpServers: { probe: { transport: 'stdio', enabled: true, command: 'node' } },
    };
    await runRow(recorder, input, {
      discoveredSkills: [
        { name: 'alpha', filePath: join(row.configHome, 'skills', 'alpha', 'SKILL.md') },
        { name: 'repo-skill', filePath: join(row.cwd, '.pi', 'skills', 'repo-skill', 'SKILL.md') },
      ],
      requestPayloads: [openaiPayload(
        skillsSection([{ name: 'alpha', location: join(row.configHome, 'skills', 'alpha', 'SKILL.md') }]),
        ['read', 'mcp__probe__echo'],
      )],
    });

    const vendor = vendorEvents(events);
    expect(vendor).toHaveLength(1);
    const facts = vendor[0];
    expect(facts?.mcpChannel, 'MCP 的事实通道：工具表就是判据本身').toBe('vendor-tool-table');
    expect(facts?.tools).toContain('mcp__probe__echo');
    // 这一家没有「每台一张状态表」：留 null = 厂商没投送这一格（不是空数组）
    expect(facts?.mcpServers).toBeNull();
    expect(facts?.skills?.map((skill) => [skill.name, skill.origin])).toEqual([
      ['alpha', 'local-enabled'],
      ['repo-skill', 'repo-provided'],
    ]);
  });

  it('anthropic wire：同一份 payload 也能读出工具表（tools[].name）', async () => {
    const row = freshRow();
    const recorder = createFakePiRecorder();
    recorder.events.push(SETTLED);
    const events: AgentEvent[] = [];
    const input: AgentRunInput = {
      ...createRunInput({
        cwd: row.cwd,
        configHome: row.configHome,
        onEvent: (event) => events.push(event),
        route: { ...createRunInput().route, protocolType: 'anthropic' },
      }),
      mcpServers: { probe: { transport: 'stdio', enabled: true, command: 'node' } },
    };
    await runRow(recorder, input, { requestPayloads: [anthropicPayload('光秃秃', ['read', 'mcp__probe__echo'])] });

    expect(vendorEvents(events)[0]?.tools).toEqual(['read', 'mcp__probe__echo']);
  });

  it('同一份 payload 只发一条 vendor-system（观测格的读法是「取最后一条」）', async () => {
    const row = freshRow();
    const recorder = createFakePiRecorder();
    recorder.events.push({ type: 'turn_start' }, SETTLED);
    const events: AgentEvent[] = [];
    await runRow(
      recorder,
      createRunInput({ cwd: row.cwd, configHome: row.configHome, onEvent: (event) => events.push(event) }),
      { requestPayloads: [openaiPayload(skillsSection([]), ['read'])] },
    );
    expect(vendorEvents(events)).toHaveLength(1);
  });

  it('一次请求都没有 ⇒ 不发 vendor-system（没有取证点，不许编一份空事实）', async () => {
    const row = freshRow();
    const recorder = createFakePiRecorder();
    recorder.events.push(SETTLED);
    const events: AgentEvent[] = [];
    await runRow(
      recorder,
      createRunInput({ cwd: row.cwd, configHome: row.configHome, onEvent: (event) => events.push(event) }),
    );
    expect(vendorEvents(events)).toEqual([]);
  });

  it('L3 装载档：装入的技能没进这一轮的系统段 ⇒ 一条点名的 WARN（两条 wire 各读自己那一处）', async () => {
    const row = freshRow();
    const sourceDir = makeSourceSkill(row, 'alpha');
    const location = join(row.configHome, 'skills', 'alpha', 'SKILL.md');
    /** 跑一次，返回全部日志文字（`inPrompt` 决定这一轮的系统段里有没有 alpha） */
    const run = async (protocolType: 'openai' | 'anthropic', inPrompt: boolean): Promise<string> => {
      const recorder = createFakePiRecorder();
      recorder.events.push(SETTLED);
      const events: AgentEvent[] = [];
      const input: AgentRunInput = {
        ...createRunInput({
          cwd: row.cwd,
          configHome: row.configHome,
          onEvent: (event) => events.push(event),
          route: { ...createRunInput().route, protocolType },
        }),
        skills: [{ name: 'alpha', sourceDir }],
      };
      // 两条 wire 的系统段位置不同（见 `observer.ts`）：装载档必须按各自的 wire 读
      const section = skillsSection(inPrompt ? [{ name: 'alpha', location }] : []);
      const payload = protocolType === 'openai'
        ? openaiPayload(section, ['read'])
        : anthropicPayload(section, ['read']);
      await runRow(recorder, input, { requestPayloads: [payload] });
      return logTexts(events).join('\n');
    };

    for (const protocolType of ['openai', 'anthropic'] as const) {
      const absent = await run(protocolType, false);
      expect(absent, protocolType).toContain('alpha');
      expect(absent, protocolType).toContain('系统提示词');
      // 反向臂：这一轮真的带了它 ⇒ 不该有这条 WARN（否则判据只会「恒报缺」）
      expect(await run(protocolType, true), protocolType).not.toContain('系统提示词');
    }
  });
});

describe('同名冲突：只作 note、结论仍按厂商清单判「已装上」', () => {
  it('冲突的胜者在清单里 ⇒ vendor-system.skills 仍然带着这个名字（行级不会判 missing）', async () => {
    const row = freshRow();
    const sourceDir = makeSourceSkill(row, 'alpha');
    const winner = join(row.cwd, '.pi', 'skills', 'alpha', 'SKILL.md');
    const loser = join(row.configHome, 'skills', 'alpha', 'SKILL.md');
    const recorder = createFakePiRecorder();
    recorder.events.push(SETTLED);
    const events: AgentEvent[] = [];
    const input: AgentRunInput = {
      ...createRunInput({ cwd: row.cwd, configHome: row.configHome, onEvent: (event) => events.push(event) }),
      skills: [{ name: 'alpha', sourceDir }],
    };
    // 厂商的清单里是胜者那一条（被测仓库自带），我们物化的那一份被顶掉、根本不在表里
    await runRow(recorder, input, {
      discoveredSkills: [{ name: 'alpha', filePath: winner }],
      skillDiagnostics: [{
        type: 'collision',
        message: 'name "alpha" collision',
        path: loser,
        collision: { resourceType: 'skill', name: 'alpha', winnerPath: winner, loserPath: loser },
      }],
      requestPayloads: [anthropicPayload(skillsSection([{ name: 'alpha', location: winner }]), ['read'])],
    });

    // ① 清单里有这个名字 ⇒ 行级推导（`vendor-skill-list`）判的是 `installed`；
    //    `missing` 的条件是「清单非空且里面没有它」，而这里它明明在。
    expect(vendorEvents(events)[0]?.skills?.map((skill) => skill.name)).toEqual(['alpha']);
    // ② 冲突如实呈现：两端路径都在，且措辞不暗示「厂商没认」
    const warn = logTexts(events).find((text) => text.includes('同名冲突')) ?? '';
    expect(warn).toContain(winner);
    expect(warn).toContain(loser);
    expect(warn).toContain('已装上');
    expect(warn).not.toContain('未出现');
  });
});
