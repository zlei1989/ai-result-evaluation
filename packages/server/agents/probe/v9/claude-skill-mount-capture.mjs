/**
 * v9 探针：claude-code 的 **skill 到底有没有进模型的入站请求体**——按 `settingSources` 分档 A/B。
 *
 * 为什么需要它：真机行里「技能面确证在、模型一次 `Skill` 都不发」，两种解释分不开——
 *   ① **装入链**没把清单送进模型上下文（那就是我们的缺陷，`settingSources` / 落点 / 时序都可能）；
 *   ② 清单送进去了，**模型不照做**（网关路由下第三方模型的行为问题）。
 * 分辨这两件事只需要**第一轮请求体**：CLI 在收到任何网关响应**之前**就把 system prompt、
 * `<system-reminder>` 与 `tools[]` 组装完并发出去。故本探针用一个**本地捕获网关**收下原文，
 * 不需要上游真的会答题、也不需要模型配合——它测的是**装配**，不是行为。
 *
 * 四条口径：
 *  1. **对齐适配器**（`src/providers/claude-code/index.ts` 的 options 逐格抄过来）：HOME / USERPROFILE /
 *     CLAUDE_CONFIG_DIR 全指向行私有目录、`settings.env` 钉路由、`settingSources` 由参数给、
 *     禁用名单 / `forwardSubagentText` / `includePartialMessages` / `CLAUDE_CODE_ENABLE_TODO_TOOLS` 同值；
 *  2. **捕获先于响应**：本地网关对任何路径都回一个最小合法 SSE，请求体在回之前已经落进 `records`；
 *  3. **落点四档**：`<configHome>/skills/`（本仓物化落点）与 `<configHome>/.claude/skills/`（另一候选
 *     用户级落点）各放一条，用来分辨「厂商到底扫的是哪一个目录」；
 *  4. **不打印密钥**：只记「有没有带头」，值一律不进产物。
 *
 * 用法（在仓库根）：
 * ```
 * node packages/server/agents/probe/v9/claude-skill-mount-capture.mjs
 * ```
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 主请求体的落盘目录（整个 `probe/dumps/` 已 gitignore——可能含网关侧原文） */
const DUMP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dumps', 'v9');

/** 本仓物化落点的那一条（`<configHome>/skills/<name>/SKILL.md`） */
const MATERIALIZED_SKILL = 'tang-poem-meal';
/** 另一候选用户级落点的那一条（`<configHome>/.claude/skills/<name>/SKILL.md`） */
const DOT_CLAUDE_SKILL = 'dot-claude-probe';
/** 被测仓库自带的那一条（`<cwd>/.claude/skills/`，project 档） */
const PROJECT_SKILL = 'repo-owned-probe';

const SENTINEL = 'AIEVAL-SKILL-OK-7f3a';

/** 探针提示词：与 `live-skills-context.test.ts` 同句，便于与真机行为探针对读。 */
const PROMPT = '请给我推荐一首唐诗。';

/** 分档表：每一档只动 `settingSources`，其余 options 逐字相同。 */
const VARIANTS = [
  { label: 'A-adapter', settingSources: ['user', 'project', 'local'], note: '现网口径' },
  { label: 'B-isolated', settingSources: [], note: '隔离档（旧口径）' },
  { label: 'C-user-only', settingSources: ['user'], note: '只有 user' },
  { label: 'D-no-user', settingSources: ['project', 'local'], note: '**剔掉 user**（判别档）' },
];

/** 最小的 Anthropic SSE 流：够让 CLI 认为这一轮正常收场，不必真的调上游。 */
function minimalSse(model) {
  const chunk = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    chunk('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_probe',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    chunk('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    chunk('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
    chunk('content_block_stop', { type: 'content_block_stop', index: 0 }),
    chunk('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    chunk('message_stop', { type: 'message_stop' }),
  ].join('');
}

/**
 * 本地捕获网关：记下每个请求的 `{path, body}`，再回最小 SSE。
 * 任何路径都收（CLI 会打 `/v1/messages?beta=true`，也可能先发一次标题生成）。
 */
function startCaptureGateway() {
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (b) => chunks.push(b));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      records.push({
        method: request.method ?? 'GET',
        path: request.url ?? '',
        hasAuth: request.headers['x-api-key'] !== undefined || request.headers.authorization !== undefined,
        body,
        rawBytes: raw.length,
      });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(minimalSse(String(body?.model ?? 'probe')));
    });
  });
  return {
    records,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`);
        });
      }),
    close: () => server.close(),
  };
}

/** 宿主配置里第一条 anthropic 供应商（与其余真机探针同一来源） */
function hostAnthropic() {
  const config = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8'));
  const provider = (config.providers ?? []).find((one) => one.protocolType === 'anthropic');
  if (provider?.baseUrl === undefined || provider.apiKey === undefined) throw new Error('宿主配置里没有 anthropic 供应商');
  return { apiKey: provider.apiKey, modelId: provider.models?.[0]?.id ?? 'probe-model' };
}

/**
 * 从请求体里把**所有文本**捞出来（system 可能是字符串或块数组、messages 各条同理），
 * 并记住每一段来自哪里——「清单进没进上下文」与「进在哪一格」是两个结论。
 */
function textSegments(body) {
  const out = [];
  const push = (value, where) => {
    if (typeof value === 'string') out.push({ where, text: value });
    else if (Array.isArray(value)) {
      value.forEach((block, index) => {
        if (typeof block?.text === 'string') out.push({ where: `${where}[${index}].${block.type ?? '?'}`, text: block.text });
      });
    }
  };
  push(body?.system, 'system');
  for (const [index, message] of (body?.messages ?? []).entries()) push(message?.content, `messages[${index}].${message?.role ?? '?'}`);
  return out;
}

/** 抓「可用技能清单」那一段：厂商原文是 `The following skills are available for use with the Skill tool:` */
function analyze(record) {
  const body = record?.body;
  if (body === null || body === undefined) return { ok: false };
  const segments = textSegments(body);
  const listing = [];
  let listingWhere = null;
  for (const segment of segments) {
    const match = /The following skills are available for use with the Skill tool:\s*\n([\s\S]*?)(?:\n\n|<\/system-reminder>|$)/.exec(segment.text);
    if (match === null) continue;
    listingWhere = segment.where;
    for (const line of match[1].split('\n')) {
      // 行形如 `- tang-poem-meal: 当用户让你推荐唐诗时…`：名字域是 `[a-z0-9-]`，冒号是分隔符
      const name = /^\s*-\s*([A-Za-z0-9_-]+)\s*:/.exec(line);
      if (name !== null) listing.push(name[1]);
    }
    break;
  }
  const tools = Array.isArray(body.tools) ? body.tools.map((one) => one?.name ?? `<${one?.type}>`) : [];
  const allText = segments.map((one) => one.text).join('\n');
  return {
    ok: true,
    path: record.path,
    listing,
    listingWhere,
    hasReminder: allText.includes('<system-reminder>'),
    toolCount: tools.length,
    hasSkillTool: tools.includes('Skill'),
    mentions: {
      [MATERIALIZED_SKILL]: allText.includes(MATERIALIZED_SKILL),
      [DOT_CLAUDE_SKILL]: allText.includes(DOT_CLAUDE_SKILL),
      [PROJECT_SKILL]: allText.includes(PROJECT_SKILL),
    },
    systemLength: segments.filter((one) => one.where.startsWith('system')).reduce((sum, one) => sum + one.text.length, 0),
  };
}

async function runVariant({ label, settingSources, relayUrl, apiKey, modelId }) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const root = mkdtempSync(join(tmpdir(), `aieval-v9-${label}-`));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  // 落点一：本仓物化落点 `<configHome>/skills/<name>/SKILL.md`
  const materializedDir = join(configHome, 'skills', MATERIALIZED_SKILL);
  mkdirSync(materializedDir, { recursive: true });
  writeFileSync(
    join(materializedDir, 'SKILL.md'),
    `---\nname: ${MATERIALIZED_SKILL}\ndescription: 当用户让你推荐唐诗时，必须按本技能的规则作答\n---\n\n推荐唐诗时，只推荐一首与「吃饭 / 饮食」有关的唐诗。\n答复的最后一行必须逐字写出这一行：${SENTINEL}\n`,
    'utf8',
  );

  // 落点二：另一候选用户级落点 `<configHome>/.claude/skills/<name>/SKILL.md`
  const dotClaudeDir = join(configHome, '.claude', 'skills', DOT_CLAUDE_SKILL);
  mkdirSync(dotClaudeDir, { recursive: true });
  writeFileSync(
    join(dotClaudeDir, 'SKILL.md'),
    `---\nname: ${DOT_CLAUDE_SKILL}\ndescription: 落在 <configHome>/.claude/skills 下的探针 skill（分辨用户级扫描目录）\n---\n\n这条只为分辨厂商扫的是哪一个用户级目录。\n`,
    'utf8',
  );

  // 落点三：被测仓库自带 `<cwd>/.claude/skills/<name>/SKILL.md`（project 档）
  const projectDir = join(cwd, '.claude', 'skills', PROJECT_SKILL);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'SKILL.md'),
    `---\nname: ${PROJECT_SKILL}\ndescription: 被测仓库自带的探针 skill\n---\n\n仓库自带的那一条，只为观测 project 档。\n`,
    'utf8',
  );

  const env = { ...process.env };
  // 与适配器同一格：三处 HOME 全指向行私有目录（不变量 3）
  env.HOME = configHome;
  env.USERPROFILE = configHome;
  env.CLAUDE_CONFIG_DIR = configHome;
  env.ANTHROPIC_BASE_URL = relayUrl;
  env.ANTHROPIC_API_KEY = apiKey;
  env.ANTHROPIC_AUTH_TOKEN = apiKey;
  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let thrown = null;
  const messages = [];
  try {
    const query = sdk.query({
      prompt: PROMPT,
      options: {
        cwd,
        env,
        model: modelId,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources,
        disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification', 'DesignSync'],
        forwardSubagentText: true,
        includePartialMessages: true,
        settings: { env: { ANTHROPIC_BASE_URL: relayUrl, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: apiKey } },
        abortController: controller,
      },
    });
    for await (const message of query) {
      messages.push(message);
      if (messages.length > 400) break;
    }
  } catch (error) {
    thrown = String(error?.message ?? error).slice(0, 300);
  } finally {
    clearTimeout(timer);
  }
  const init = messages.find((one) => one?.type === 'system' && one?.subtype === 'init') ?? null;
  return { root, cwd, configHome, init, thrown, messageCount: messages.length };
}

async function main() {
  const { apiKey, modelId } = hostAnthropic();
  const gateway = startCaptureGateway();
  const relayUrl = await gateway.listen();
  console.log(`本地捕获网关：${relayUrl}（密钥只进 env，不入产物）`);
  console.log(`模型：${modelId}\n`);

  const rows = [];
  for (const variant of VARIANTS) {
    gateway.records.length = 0;
    const run = await runVariant({ label: variant.label, settingSources: variant.settingSources, relayUrl, apiKey, modelId });
    // 第一轮请求 = 第一条带 messages 的 POST（标题生成那条也走同一路径，故按「有没有 tools」取主请求）
    /**
     * 认出**主请求**：CLI 先发一条「标题生成」（`tools: []`、system 很短），主请求的判据是
     * **非空 tools 且条数最多**（真机 20 项）。抓包顺序不可依赖，故按形状挑而不是按下标。
     */
    const withTools = gateway.records.filter(
      (record) => Array.isArray(record.body?.tools) && record.body.tools.length > 0,
    );
    const main = withTools.sort((a, b) => b.body.tools.length - a.body.tools.length)[0] ?? gateway.records[0] ?? null;
    const info = analyze(main);
    const initSkills = run.init?.skills ?? null;
    rows.push({ variant, run, info, records: gateway.records.length, initSkills });

    // 主请求体落盘（密钥只在请求头里，体内不含；仍按字符替换兜一道）
    mkdirSync(DUMP_DIR, { recursive: true });
    writeFileSync(
      join(DUMP_DIR, `${variant.label}.json`),
      JSON.stringify(main?.body ?? null, null, 2).split(apiKey).join('***'),
      'utf8',
    );

    // 原文上下文：名字到底出现在**哪一句**里（「可用技能清单」vs 别处），逐字打出来才可判读
    for (const segment of textSegments(main?.body)) {
      for (const needle of [MATERIALIZED_SKILL, PROJECT_SKILL, DOT_CLAUDE_SKILL]) {
        const at = segment.text.indexOf(needle);
        if (at < 0) continue;
        const from = Math.max(0, at - 260);
        console.log(`  ↳ ${segment.where} 命中 \`${needle}\`：…${segment.text.slice(from, at + 120).replace(/\n/g, '\\n')}…`);
      }
    }
    /**
     * `messages` 的**角色序列**：清单落在哪一格决定了网关翻译时会不会把它丢掉——
     * Anthropic 的 Messages API 只认 `user` / `assistant`，落在别处就是一条要被翻译层解释的输入。
     */
    const roles = (main?.body?.messages ?? []).map((message) => message?.role ?? '?');
    console.log(`  messages 角色序列=${JSON.stringify(roles)} 主请求体落盘 dumps/v9/${variant.label}.json`);

    console.log(`=== ${variant.label}  settingSources=${JSON.stringify(variant.settingSources)}（${variant.note}）===`);
    // 逐条请求的形状：CLI 会先发「标题生成」那一条（非正式轮次），主请求靠 tools / system 长度认出来
    for (const [index, record] of gateway.records.entries()) {
      const body = record.body ?? {};
      const systemText = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
      console.log(
        `  [${index}] ${record.path} model=${String(body.model ?? '—')} 字节=${record.rawBytes} ` +
          `system=${systemText.length} tools=${Array.isArray(body.tools) ? body.tools.length : '无'} ` +
          `keys=${JSON.stringify(Object.keys(body).sort())} 含清单=${systemText.includes('skills are available')} ` +
          `含用户名=${systemText.includes(MATERIALIZED_SKILL)} 含 <system-reminder>=${JSON.stringify(body.messages ?? '').includes('system-reminder')}`,
      );
    }
    console.log(`  主请求 path=${info.path ?? '—'} 字节=${main?.rawBytes ?? '—'} 带鉴权头=${main?.hasAuth ?? '—'}`);
    console.log(`  system 字符数=${info.systemLength ?? '—'} 含 <system-reminder>=${info.hasReminder ?? '—'} 工具数=${info.toolCount ?? '—'} 含 Skill 工具=${info.hasSkillTool ?? '—'}`);
    console.log(`  技能清单（注入位置 ${info.listingWhere ?? '未找到'}，共 ${info.listing?.length ?? 0} 条）：${JSON.stringify(info.listing ?? [])}`);
    console.log(`  名字出现：${JSON.stringify(info.mentions ?? {})}`);
    console.log(`  system/init.skills=${JSON.stringify(initSkills)}`);
    console.log(`  消息数=${run.messageCount} 抛错=${run.thrown ?? '—'} 临时根=${run.root}\n`);
  }

  console.log('=== 判定表 ===');
  for (const row of rows) {
    const names = row.info.listing ?? [];
    console.log(
      [
        row.variant.label.padEnd(14),
        JSON.stringify(row.variant.settingSources).padEnd(28),
        `清单=${names.length}`.padEnd(8),
        `物化条=${names.includes(MATERIALIZED_SKILL) ? '✓' : '✗'}`,
        `.claude条=${names.includes(DOT_CLAUDE_SKILL) ? '✓' : '✗'}`,
        `仓库条=${names.includes(PROJECT_SKILL) ? '✓' : '✗'}`,
        `Skill工具=${row.info.hasSkillTool ? '✓' : '✗'}`,
      ].join('  '),
    );
  }
  gateway.close();
  /**
   * 收尾清掉本轮的临时根：每档一份 `mkdtemp`（含 `.agenthome` 与工作区），不清就是往 `$TMPDIR` 里留垃圾。
   * 路径先打印出来再删——报告要能回溯「判定表来自哪一次运行」，但留痕靠下面的打印与 dumps，不靠留着目录。
   */
  for (const row of rows) {
    console.log(`临时根（已清理）：${row.run.root}`);
    try {
      rmSync(row.run.root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`临时根清理失败不影响结论）：${row.run.root} —— ${String(error?.message ?? error)}`);
    }
  }
}

await main();
