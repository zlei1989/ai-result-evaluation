/**
 * overlay patch 的生成器（探测侧）：**与适配器将要写的那份同形**，
 * 好让「机制是否成立」与「适配器写得对不对」用同一个形状验。
 *
 * 形状（见计划 D3/D3b）：
 *   ① `- id: llm-pi-ai` 的 id 定向覆盖：整份替换该行的 config（patch 语义是**替换不是深合并**）
 *      ⇒ 只声明我们那一条路由，模型列表也只声明本次运行这一个模型；
 *   ② `- insert:` 把 `ask_user_question` 挂进 profile（新增行必须走 insert，顶层 `- id:` 只能改/禁既有行）。
 *
 * ⚠️ 字符串一律加双引号并转义：模型名可能含 `:` / `/`（`jd/GLM-5.3`），裸写会被 YAML 解析成别的结构。
 */

/** 协议 → pi-ai wire（D2：openai 只走 responses）。 */
export function wireForProtocol(protocolType) {
  return protocolType === 'openai' ? 'openai-responses' : 'anthropic-messages';
}

/** 按 wire 归一化 baseURL（D8）：anthropic 剥掉尾部 `/v1`、openai 补上 `/v1`。 */
export function baseUrlForWire(baseUrl, protocolType) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (protocolType === 'openai') return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return trimmed.replace(/\/v1$/, '');
}

/** YAML 双引号标量：反斜杠与双引号都要转义。 */
function quote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * 生成 overlay 的 YAML 文本。
 * @param {object} input
 * @param {'openai'|'anthropic'} input.protocolType 供应商的协议（决定 api 与 baseURL 归一化）
 * @param {string} input.baseUrl 供应商地址（**未归一化**，由本函数归一化）
 * @param {string} input.model 模型 id（必须与交给 harness 的 `model` 逐字一致）
 * @param {number} [input.contextWindow] 上下文窗口；未知则**不写这个键**
 * @param {number} [input.maxTokens] 单次输出上限；未知则不写
 * @param {Record<string, string|null>} [input.reasoningEfforts] 档位 → wire 拼写
 * @param {string} [input.routeKey] 路由键（默认 `aieval-route`，已核对不与 catalog 的 39 个键撞车）
 */
export function buildOverlay(input) {
  const routeKey = input.routeKey ?? 'aieval-route';
  const effortEntries = Object.entries(input.reasoningEfforts ?? {});
  const lines = [
    '# 由探测脚本写入：本次运行的路由、模型与档位（overlay，叠在 profile 之上）',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${routeKey}:`,
    `        api: ${wireForProtocol(input.protocolType)}`,
    `        baseURL: ${quote(baseUrlForWire(input.baseUrl, input.protocolType))}`,
    '        apiKeyEnv: AIEVAL_ROUTE_API_KEY',
    '        models:',
    `          - id: ${quote(input.model)}`,
    ...(input.contextWindow === undefined ? [] : [`            contextWindow: ${input.contextWindow}`]),
    ...(input.maxTokens === undefined ? [] : [`            maxTokens: ${input.maxTokens}`]),
    ...(effortEntries.length === 0
      ? []
      : [
        '            reasoningEfforts:',
        ...effortEntries.map(([level, wire]) => `              ${level}: ${wire === null ? 'null' : quote(wire)}`),
      ]),
    '',
    '# 新增行必须走 insert（顶层 `- id:` 只能覆盖或禁用既有行）——见 dsh-base 的文件头',
    '- insert:',
    '    - id: tool-ask-user',
    '      name: "@deepseek-ai/dsh-tool-ask-user"',
    '',
  ];
  return lines.join('\n');
}
