/**
 * 探针 05（**对照臂**）：不带适配器的 `skillsOverride` 时，HOME 锚定的技能**会不会**进模型上下文。
 *
 * 为什么必须有这一臂：探针 03 证明了「带过滤时金丝雀不在请求里」，但那条读数单独看是
 * **不可证伪**的——「过滤生效」与「这台机器上根本没有 HOME 锚定的技能可漏」在读数上同形。
 * 这一臂把同一棵临时 HOME 交给**同一份装载器配置（只去掉 `skillsOverride`）**，
 * 让厂商自己把系统提示词写出来，再从**假网关收到的请求体**里数金丝雀。
 *
 * 三条口径：
 *   · 真包、真装载器、真会话、真请求体；只有上游模型是假的（本机回一段 SSE）；
 *   · 臂 A/B 各起一个**新进程**（`os.homedir()` 启动即定，必须在 env 里给 HOME）；
 *   · 两臂的临时 HOME、`agentDir`、`cwd` 内容逐字相同，唯一变量是有没有 `skillsOverride`。
 *
 * 用法（不需要凭据）：
 *   node packages/server/agents/probe/v12/05-skills-override-control.mjs
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const SDK = '@earendil-works/pi-coding-agent';
const AI = '@earendil-works/pi-ai';
const CANARY = 'home-canary-skill';
const ROW_SKILL = 'row-skill-probe';
const MODEL = 'probe-model';

const armFlag = process.argv.find((one) => one.startsWith('--arm='));
const arm = armFlag === undefined ? null : armFlag.slice('--arm='.length);
const overrideFlag = process.argv.includes('--with-override');

/** 假网关：只回一段最简的 anthropic SSE，助手说一句话（判据在读**请求**，不在读答复） */
function startFakeGateway(sink) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      sink.push({ url: req.url ?? '', body: raw === '' ? {} : JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`);
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收到。' } })}\n\n`);
      res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: typeof address === 'object' && address !== null ? address.port : 0, close: () => server.close() });
    });
  });
}

/** 与适配器 `keepRowAndProjectSkills` / `isUnder` 逐字同形（对照臂的那一半变量） */
function keepRowAndProjectSkills(base, roots) {
  const skills = base.skills.filter(
    (skill) => isUnder(skill.filePath, roots.rowSkillsDir) || isUnder(skill.filePath, roots.cwd),
  );
  return { skills, diagnostics: base.diagnostics };
}
function isUnder(path, root) {
  if (path === root) return true;
  const withSeparator = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`;
  return path.startsWith(withSeparator) || path.startsWith(`${withSeparator.replace(/\//g, '\\')}`);
}

/** 一臂：与适配器同形地装配（装载器 → 注册 provider → 会话 → 一次 prompt），只回读数 */
async function runArm({ cwd, configHome, withOverride, port }) {
  const sdk = await import(SDK);
  const ai = await import(AI);
  const rowSkillsDir = join(configHome, 'skills');

  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: configHome,
    additionalSkillPaths: [rowSkillsDir],
    noExtensions: true,
    settingsManager: sdk.SettingsManager.inMemory(),
    ...(withOverride ? { skillsOverride: (base) => keepRowAndProjectSkills(base, { rowSkillsDir, cwd }) } : {}),
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  const loaderSkills = loader.getSkills().skills.map((skill) => `${skill.name}@${skill.filePath}`);

  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const providerId = 'aieval-pi-probe05';
  runtime.registerProvider(providerId, {
    name: 'AIEval Probe',
    baseUrl: `http://127.0.0.1:${port}`,
    api: 'anthropic-messages',
    models: [{
      id: MODEL, name: MODEL, api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: true, contextWindow: 100_000, maxTokens: 8_192, compat: { supportsStrictTools: true },
    }],
  });
  await runtime.setRuntimeApiKey(providerId, 'sk-probe');
  const model = runtime.getModel(providerId, MODEL);

  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: configHome,
    modelRuntime: runtime,
    model,
    settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false } }),
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.create(cwd, join(configHome, 'sessions')),
    tools: ['read'],
  });
  await session.bindExtensions({ mode: 'rpc' });
  try {
    await session.prompt('这一轮只用来取证。');
  } finally {
    await session.abort();
    await session.waitForIdle();
    session.dispose();
    runtime.unregisterProvider(providerId);
  }
  return { loaderSkills };
}

if (arm === null) {
  // 驱动器：两臂各起一个自己的进程（HOME 只能在启动时定）
  const fakeHome = mkdtempSync(join(tmpdir(), 'pi-v12-home-'));
  for (const dir of ['.agents', '.pi']) {
    const target = join(fakeHome, dir, 'skills', CANARY);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'SKILL.md'),
      `---\nname: ${CANARY}\ndescription: 宿主家目录里的金丝雀技能\n---\n\n这一段只该留在宿主家目录。\n`,
      'utf8',
    );
  }
  const arms = [
    { name: 'A-no-override', args: [] },
    { name: 'B-with-override', args: ['--with-override'] },
  ];
  const readings = { fakeHome, arms: {} };
  for (const entry of arms) {
    const out = spawnSync(process.execPath, [selfPath, `--arm=${entry.name}`, ...entry.args], {
      cwd: dirname(selfPath),
      env: { ...process.env, HOME: fakeHome },
      encoding: 'utf8',
    });
    const line = (out.stdout ?? '').split('\n').find((one) => one.startsWith('{'));
    readings.arms[entry.name] = line === undefined
      ? { parseError: true, stdout: out.stdout, stderr: out.stderr, status: out.status }
      : JSON.parse(line);
  }
  const dumpDir = join(dirname(selfPath), '..', 'dumps', 'v12');
  mkdirSync(dumpDir, { recursive: true });
  writeFileSync(join(dumpDir, '05-skills-override-control.json'), `${JSON.stringify(readings, null, 2)}\n`, 'utf8');
  for (const [name, reading] of Object.entries(readings.arms)) {
    console.log(`[v12] ${name}: 装载器技能 ${reading.loaderSkills?.length ?? '?'} 条；请求里金丝雀 ${reading.canaryInRequest ?? '?'} 次`);
  }
  rmSync(fakeHome, { recursive: true, force: true });
} else {
  // 单臂：这一臂只回答「这个环境下，这一次请求里有没有金丝雀」
  const requests = [];
  const gateway = await startFakeGateway(requests);
  const root = mkdtempSync(join(tmpdir(), 'pi-v12-arm-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(join(cwd, '.pi', 'skills', 'project-skill-probe'), { recursive: true });
  writeFileSync(
    join(cwd, '.pi', 'skills', 'project-skill-probe', 'SKILL.md'),
    '---\nname: project-skill-probe\ndescription: 项目自带的技能\n---\n\n正文。\n',
    'utf8',
  );
  writeFileSync(join(cwd, 'AGENTS.md'), '# 探针工作区\n\n这一行只用来取证。\n', 'utf8');
  // 行技能源（物化的来源）→ 目标：与适配器的 `materializeSkills` 同形（复制成 `<configHome>/skills/<名>`）
  const source = join(root, 'skill-source', ROW_SKILL);
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'SKILL.md'),
    `---\nname: ${ROW_SKILL}\ndescription: 行技能\n---\n\n行技能正文。\n`,
    'utf8',
  );
  const { cpSync } = await import('node:fs');
  cpSync(source, join(configHome, 'skills', ROW_SKILL), { recursive: true });

  const reading = await runArm({ cwd, configHome, withOverride: overrideFlag, port: gateway.port });
  gateway.close();
  const body = requests.at(-1)?.body ?? {};
  const asText = JSON.stringify(body);
  const out = {
    arm,
    withOverride: overrideFlag,
    requestCount: requests.length,
    url: requests.at(-1)?.url ?? null,
    loaderSkills: reading.loaderSkills,
    canaryInRequest: asText.split(CANARY).length - 1,
    canaryInSystem: JSON.stringify(body.system ?? '').includes(CANARY),
    rowSkillInSystem: JSON.stringify(body.system ?? '').includes(ROW_SKILL),
    toolNames: (body.tools ?? []).map((tool) => tool?.name ?? null),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  rmSync(root, { recursive: true, force: true });
}
