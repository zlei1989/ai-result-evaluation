/**
 * v4 claude-code 探测的共享外壳（SDK 侧）。
 *
 * 与 v2 的 `probe/v2/lib/claude.mjs` 的关系：**不是**复用，是重写。v2 那份把内网网关
 * （`likecode-llm-proxy*.jd.com`）写死成常量，2026-10-01 起不可达；本轮走 DeepSeek 官方
 * anthropic 兼容端点。另外 v2 那份还带一个 40 字符的硬编码 token——本仓不该再有这种东西。
 *
 * 口径（本轮实测定的，见 `q1-cli-*` 的原始流）：
 *  - `ANTHROPIC_BASE_URL` = `https://api.deepseek.com/anthropic`（**不带** `/v1`，SDK/CLI 自己拼
 *    `/v1/messages`）；
 *  - 凭据用同一个 DeepSeek key，`ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY` **两种都通**；
 *  - 模型名 `deepseek-chat` / `deepseek-reasoner` CLI 都能用；stderr 会打一条
 *    `[claude-code:unrecognized_model] {...}` **警告**，但**不阻断**（五种跑法全部 exit=0）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEEPSEEK_ANTHROPIC_BASE_URL, appendJsonl, loadDeepSeekKey, note } from './env.mjs';

/** 全局 claude CLI（题面给定路径）。 */
export const CLAUDE_EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

/** 本轮固定用的模型名（DeepSeek 官方模型清单里的两个）。 */
export const DEEPSEEK_MODEL = 'deepseek-chat';

/** 造一个最小工作区（`Read` / `Bash` / workflow 都需要一个 cwd）。 */
export function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'aieval-v4-cc-'));
  writeFileSync(join(root, 'notes.txt'), ['alpha', 'beta', 'gamma', 'NEEDLE-one', 'delta'].join('\n') + '\n', 'utf8');
  return root;
}

/**
 * 与**本仓适配器对齐**的启动口径（`src/providers/claude-code/index.ts`）：
 * `settingSources: ['user','project','local']` + `permissionMode: 'bypassPermissions'`
 * + `allowDangerouslySkipPermissions: true`（少了最后一格整个权限档静默失效）。
 */
export const ADAPTER_ALIGNED_OPTIONS = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  settingSources: ['user', 'project', 'local'],
};

/** 隔离档：不读用户/项目/local 设置（本轮默认；本机 `~/.claude` 不存在，故两档等价）。 */
export const ISOLATED_OPTIONS = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  settingSources: [],
};

/** 把 DeepSeek 的 anthropic 端点 + 凭据拼成一份 env（**密钥只在 env 里，绝不落盘**）。 */
export function deepseekClaudeEnv(extra = {}) {
  const key = loadDeepSeekKey();
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_MODEL: DEEPSEEK_MODEL,
    ...extra,
  };
}

/**
 * 用真实 `@anthropic-ai/claude-agent-sdk` 跑一条任务，原始消息逐条落盘。
 *
 * @param {object} options
 * @param {string} options.label            落盘名（`probe/dumps/v4/claude-<label>.jsonl`）
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {string} [options.workspace]
 * @param {Record<string,string>} [options.extraEnv]
 * @param {object} [options.extraOptions]   覆盖/补充 SDK 选项
 * @param {number} [options.maxTurns]
 * @param {number} [options.timeoutMs]
 */
export async function runClaudeSdk({
  label,
  prompt,
  model = DEEPSEEK_MODEL,
  workspace = makeWorkspace(),
  extraEnv = {},
  extraOptions = {},
  maxTurns = 12,
  timeoutMs = 300_000,
}) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const env = deepseekClaudeEnv(extraEnv);
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
      abortController: abort,
      ...ISOLATED_OPTIONS,
      // 与 v2 同格：把本次路由钉在 settings 档，防被测目录的 .claude/settings.json 抢走 base URL。
      settings: { env: { ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL } },
      ...extraOptions,
    },
  });
  try {
    for await (const message of query) {
      messages.push(message);
      if (messages.length >= 4000) break;
    }
  } catch (caught) {
    error = {
      name: caught?.constructor?.name ?? typeof caught,
      message: String(caught?.message ?? caught).slice(0, 4000),
    };
  } finally {
    clearTimeout(timer);
  }
  const file = appendJsonl(`v4/claude-${label}`, messages);
  const init = messages.find((one) => one?.type === 'system' && one?.subtype === 'init') ?? null;
  const result = messages.find((one) => one?.type === 'result') ?? null;
  note(`${label}：SDK 消息 ${messages.length} 条 → ${file}`);
  if (error !== null) note(`${label} 抛错：`, error.name, error.message.slice(0, 300));
  return { messages, error, init, result, file, model, workspace, extraEnv };
}

/** 从消息流里抽出 `tool_use` / `tool_result` 对（claude 的调用与结果分属两条消息）。 */
export function toolPairs(messages) {
  const pairs = [];
  for (const message of messages) {
    const content = message?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') pairs.push({ name: block.name, id: block.id, input: block.input, result: null });
      if (block?.type === 'tool_result') {
        const hit = pairs.find((pair) => pair.id === block.tool_use_id);
        if (hit !== undefined) hit.result = { isError: block.is_error ?? null, content: block.content };
      }
    }
  }
  return pairs;
}
