/**
 * 列出上游网关的模型清单，并**逐字标出 codex 认识的那 3 个带 multi_agent profile 的 slug**
 * （`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna`，见设计稿 §7.5.2 / §7.5.3 牌 A）。
 *
 * 为什么这一条是整轮验证的**前置**：codex 的 `spawn_agent` 与 `SubagentStart/Stop` hook 能否真机触发，
 * 完全取决于网关是否提供 codex 认识、且 preset 自带 multi_agent profile 的模型名。
 * 设计稿把它定性为「本仓无解」，所以必须先确认一次当前的实际清单。
 */
import { GATEWAY_API_KEY, GATEWAY_BASE_URL, fetchWithTimeout, note, writeDump } from './lib/gateway.mjs';

const KNOWN = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];

const response = await fetchWithTimeout(`${GATEWAY_BASE_URL}/models`, {
  headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
}, 60000);
const body = await response.json();
const models = body.data ?? [];
const ids = models.map((m) => m.id ?? m.name ?? '<无 id>');

note('HTTP', response.status, '模型数', ids.length);
for (const id of ids) note('  ·', id);

const hits = KNOWN.filter((slug) => ids.includes(slug));
note('codex 认识的带 profile slug 命中：', hits.length === 0 ? '【无】' : hits.join(', '));

writeDump('v2/models', {
  at: new Date().toISOString(),
  baseUrl: GATEWAY_BASE_URL,
  status: response.status,
  count: ids.length,
  ids,
  codexProfileSlugsFound: hits,
  codexProfileSlugsWanted: KNOWN,
});
