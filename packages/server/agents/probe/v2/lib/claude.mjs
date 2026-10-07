/**
 * claude-code 真机探测的共享外壳：用**真实的 `@anthropic-ai/claude-agent-sdk`** 跑一条任务，
 * 把原始 SDK 消息逐条落盘（不经本仓适配器的投影）。
 *
 * 网关口径（本轮实测定的）：
 *  - 上游 `likecode-llm-proxy-test.jd.com`（**http**，测试环境）与 `likecode-llm-proxy.jd.com`（https）
 *    的 `/v1/messages` 都可用；
 *  - 鉴权头两种都收（`x-api-key` / `Authorization: Bearer`），token 由 cc-switch 托管
 *    （40 字符，见 `probe/v2/cc-switch-read.mjs` 的只读抽取）；
 *  - `ANTHROPIC_BASE_URL` **不带** `/v1`（SDK/CLI 自己拼）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, note } from './gateway.mjs';

/**
 * 本轮可用的 Anthropic wire 端点与凭据（见文件头）。
 *
 * 两个端点都实测可用（2026-09-30），但**测试环境会偶发把上游超时当成正常回复**
 * （assistant 正文就是 `"Request timed out"`，`terminal_reason: 'api_error'`）⇒
 * 用 `AIEVAL_V2_CLAUDE_BASE_URL` 可切到生产端重跑，不必改代码。
 */
export const CLAUDE_BASE_URL = process.env.AIEVAL_V2_CLAUDE_BASE_URL ?? 'http://likecode-llm-proxy-test.jd.com';
export const CLAUDE_FALLBACK_BASE_URL = 'https://likecode-llm-proxy.jd.com';
export const CLAUDE_TOKEN = '96c7851a09d2618659786746e124a8f02b3f3a0f';

/** 造一个最小工作区（claude 的 `Read` / `Bash` 都要有东西可操作）。 */
export function makeClaudeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'aieval-v2-cc-'));
  writeFileSync(
    join(root, 'notes.txt'),
    ['alpha', 'beta', 'gamma', 'NEEDLE-one', 'delta'].join('\n') + '\n',
    'utf8',
  );
  writeFileSync(join(root, 'app.js'), ['function greet(name) {', "  return 'hello ' + name;", '}', ''].join('\n'), 'utf8');
  return root;
}

/**
 * 与**本仓适配器对齐**的启动口径（`src/providers/claude-code/index.ts:176-236`）：
 *  - `settingSources: ['user','project','local']`（适配器**不是**空数组——2026-09-29 的口径变更）；
 *  - `permissionMode: 'bypassPermissions'` **必须**配 `allowDangerouslySkipPermissions: true`，
 *    少了后者整个权限档静默失效；
 *  - `settings.env` 钉住本次路由（防被测仓库的 `.claude/settings.json` 抢走 base URL）。
 *
 * ⚠️ **本机实测（2026-09-30）：这一档在本机跑不通**——一旦 `settingSources` 非空，
 * 本机 `~/.claude.json` 里的历史配置就会生效（MCP servers 全部挂上、工具表 30 → 45，
 * 且 provider 被切到 **Bedrock**，请求以
 * `InvokeModelWithResponseStream … ValidationException` 失败）。
 * ⇒ 探测默认取 `ISOLATED_OPTIONS`（`settingSources: []`）以保证可比；
 * 要对齐适配器时显式传 `extraOptions: ADAPTER_ALIGNED_OPTIONS`，并接受上面那份环境噪声。
 */
export const ADAPTER_ALIGNED_OPTIONS = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  settingSources: ['user', 'project', 'local'],
};

/** 隔离档：不读用户/项目/local 设置，只吃本次注入（探测默认值）。 */
export const ISOLATED_OPTIONS = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  settingSources: [],
};

/**
 * 跑一条 claude 任务。
 *
 * @param {object} options
 * @param {string} options.label       落盘名
 * @param {string} options.prompt
 * @param {string} options.workspace
 * @param {string} [options.model]     默认 `Claude-Sonnet-4.6`（网关模型清单里的名字）
 * @param {Record<string,string>} [options.extraEnv] 例如 `CLAUDE_CODE_ENABLE_TODO_TOOLS: '1'`
 * @param {object} [options.extraOptions] 覆盖/补充 SDK 选项
 * @param {number} [options.maxTurns]
 * @param {number} [options.timeoutMs]
 */
export async function runClaudeProbe({
  label,
  prompt,
  workspace,
  model = process.env.AIEVAL_V2_CLAUDE_MODEL ?? 'Claude-Sonnet-4.6',
  extraEnv = {},
  extraOptions = {},
  maxTurns = 12,
  timeoutMs = 420000,
  permissionMode = 'bypassPermissions',
}) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: CLAUDE_BASE_URL,
    ANTHROPIC_API_KEY: CLAUDE_TOKEN,
    ANTHROPIC_AUTH_TOKEN: CLAUDE_TOKEN,
    ...extraEnv,
  };
  const messages = [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let error = null;
  const query = sdk.query({
    prompt,
    options: {
      cwd: workspace,
      model,
      env,
      maxTurns,
      permissionMode,
      abortController: abort,
      ...ISOLATED_OPTIONS,
      // 与适配器同一格：把本次路由钉在 flag 档（否则 settings 里的 env 会盖掉它）
      settings: { env: { ANTHROPIC_BASE_URL: CLAUDE_BASE_URL, ANTHROPIC_API_KEY: CLAUDE_TOKEN, ANTHROPIC_AUTH_TOKEN: CLAUDE_TOKEN } },
      ...extraOptions,
    },
  });
  try {
    for await (const message of query) {
      messages.push(message);
      if (messages.length >= 2000) break;
    }
  } catch (caught) {
    error = {
      name: caught?.constructor?.name ?? typeof caught,
      message: String(caught?.message ?? caught).slice(0, 2000),
    };
  } finally {
    clearTimeout(timer);
  }
  const file = appendJsonl(`v2/claude-${label}`, messages);
  note(`${label}：SDK 消息 ${messages.length} 条 → ${file}`);
  if (error !== null) note(`${label} 抛错：`, error.name, error.message.slice(0, 300));

  // `system/init` 里的 `tools[]` 是工具表的唯一真源（本轮多个结论都靠它）
  const init = messages.find((one) => one?.type === 'system' && one?.subtype === 'init') ?? null;
  return { messages, error, init, file, model, env: { ...extraEnv } };
}

/** 从消息流里抽出 `tool_use` / `tool_result` 对（claude 的调用与结果分属两条消息）。 */
export function toolPairs(messages) {
  const uses = new Map();
  const pairs = [];
  for (const message of messages) {
    const content = message?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        uses.set(block.id, block);
        pairs.push({ name: block.name, id: block.id, input: block.input, result: null });
      }
      if (block?.type === 'tool_result') {
        const hit = pairs.find((pair) => pair.id === block.tool_use_id);
        if (hit !== undefined) hit.result = { isError: block.is_error ?? null, content: block.content };
      }
    }
  }
  void uses;
  return pairs;
}
