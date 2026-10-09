/**
 * v8 探针：思考强度在两协议上**真的生效**吗（2026-10-07，Task 10）。
 *
 * 判据**不是**「200 被接受」。本仓在 codex 侧踩过「参数到了、网关照样按自己的默认强度推理」
 * （`docs/faq/codex.md`、`probe/v4` 的 reasoning 系列）——字段名对 ≠ 生效。所以这里看三件事：
 *   ① 六行主表里的**状态码**：字段到底是被收下，还是被 400 顶回来；
 *   ② 同一协议内 `low` 与 `max` 的 reasoning **字符数可区分**（`max/low ≥ 1.2` 且方向为 max 更长 ⇒ 比值达标；
 *      两次完全相同 ⇒ 明确不区分；落在中间 ⇒ 只能算「弱区分（单样本）」）。
 *      ⚠️ **比值达标 ≠ 生效**（2026-10-07 实测，读数见 `probe/v8/REPORT.md`）：简单题上**同一档自己的抖动就有
 *      1.7~3.8 倍**，比档间差还大 ⇒ 单次读数会**假阳性**。真判据是「**在多步推理题上**测，且差额要超过同档抖动」；
 *      默认题与 brief 逐字一致，只当冒烟用，结论请看噪声基线与难题对照两段。
 *   ③ `off`（两协议同一个形状 `thinking: { type: 'disabled' }`）那两次**没有** reasoning 内容。
 * 三条若都不成立，结论照实写「该网关不区分强度」——这条探针的价值就在这个否定答案上。
 * ⚠️ 判据 ② 的**证据强度**要在读数里说清：2026-10-07 的实测（见 `probe/v8/REPORT.md`）里，
 * openai 侧补了第三组样本后 `low`/`max` 的区间**重叠**、还出现过方向相反的读数 ⇒ 结论是「**未能证实**」
 * 而不是「确证」；判 ② 时必须写出 **n/组**与所用统计量（档间差 vs 同档抖动）。
 *
 * 附加探针（默认开，`AIEVAL_PROBE_EXTRA=0` 可整体跳过；都打在六行主表**之后**，不改变主表形状）：
 *   A. **噪声基线**：`low` 每个协议再跑一次。没有它就看不出「low 与 max 的差」是信号还是采样抖动，
 *      这是本探针最容易被误读成「生效」的地方（脚本会把「差 ≤ 同档抖动」直接印成「未能证实」）。
 *   B. **`budget_tokens` 是否被忽略**（spec §8.3 要求证实或证伪）：anthropic 侧固定
 *      `output_config.effort='low'`，只把 `thinking.budget_tokens` 从 1024 换到 8192。
 *      两次长度相当 ⇒ 与官方兼容表「`budget_tokens` 被忽略」**一致**（单样本，不构成证实）。
 *   C. **难题对照**（只在某协议主表判为「不区分 / 弱区分」时跑）：换一个必须多步推理的问题重跑 low 与 max，
 *      用来排除「题目太简单 ⇒ 各档都只想一句 ⇒ 看起来不区分」这个假阴性。难题下仍不区分，才是硬结论。
 *
 * key **只从环境变量读**（AGENTS.md 硬规则；反面教材 `probe/v2/lib/gateway.mjs:27` 那份硬编码），
 * 缺了就明确报错，且全程不回显。不 import `@aieval/agents` 的 provider：探针打的是网关的 HTTP 接口
 * 本身，不是「调智能体」，故不走 `agentProvider.run`（`probe/` 下 v2–v7 同形）。
 *
 * 用法（PowerShell；key 由控制器注入，不要写进任何文件、任何日志、任何提交信息）：
 *   $env:AIEVAL_PROBE_GATEWAY_API_KEY = '<本机 key>'
 *   node packages/server/agents/probe/v8/judge-effort.mjs
 *
 * 可选环境变量（数值型一律校验为正整数，写错直接报错，不静默变成 NaN）：
 *   AIEVAL_PROBE_BASE_URL            默认 https://api.deepseek.com
 *   AIEVAL_PROBE_ANTHROPIC_BASE_URL  显式给 anthropic 路由（覆盖下面那条推导）
 *   AIEVAL_PROBE_MODEL               默认 deepseek-flash
 *   AIEVAL_PROBE_PROMPT              覆盖主表用的那个问题（默认与 brief 逐字一致）
 *   AIEVAL_PROBE_MAX_TOKENS          anthropic 侧的 max_tokens，默认 2048
 *   AIEVAL_PROBE_TIMEOUT_MS          单次请求超时，默认 180000（max 档要想很久）
 *   AIEVAL_PROBE_EXTRA               置 0 只跑六行主表
 *
 * 路由推导的**准确边界**（别把它当通用网关适配器）：只保证 DeepSeek 的三条形状——
 * 裸根 `https://api.deepseek.com`、OpenAI 惯用的 `…/v1`、以及 anthropic 路由 `…/anthropic`——
 * 都能还原出同一对协议 base（生产实际用的是裸根，见 `text-api.ts:135-139`）。**非 DeepSeek 网关**
 * （anthropic 路由不是 `<根>/anthropic`）必须用 `AIEVAL_PROBE_ANTHROPIC_BASE_URL` 显式指定。
 *
 * 退出码：六行（以及附加行）里只要有**一格没拿到 HTTP 响应**（网络 / 超时）就是 1；
 * 非 2xx 的状态码算**合法读数**，退出 0，否则一个 400 会把整轮读数吞掉。429 / 5xx 与网络异常
 * **各重试一次**（2s 后）：一次抖动不该落成「合法读数」，5xx 也不是网关对字段的答复。
 */

const DEFAULT_OPENAI_BASE = 'https://api.deepseek.com';
/** 429 / 5xx 与网络异常的重试间隔（只重试一次：探针要的是干净的读数，不是高可用） */
const RETRY_DELAY_MS = 2000;
const PROMPT = '用一句话说明 2+2 为什么等于 4';
/** 主表判为「不区分 / 弱区分」时的对照题：必须多步推理，各档的思考长度才拉得开 */
const HARD_PROMPT = '一个农夫有 17 只羊，除了 9 只以外全都跑了，他又买回跑掉数量的一半，最后还剩几只？请一步步推理。';
/** `off` 在主表里的档位名（两协议都是 `thinking: { type: 'disabled' }`，同一个形状） */
const OFF = 'off';

/** 读一个正整数环境变量：NaN / 0 / 负数 / 小数都是配置错误，直接报错（`Number('abc')` 会静默变成 NaN 再传进 fetch） */
function readPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数，收到「${raw}」`);
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const key = process.env.AIEVAL_PROBE_GATEWAY_API_KEY;
if (!key) throw new Error('缺少 AIEVAL_PROBE_GATEWAY_API_KEY（不要硬编码 key）');
const rawBase = process.env.AIEVAL_PROBE_BASE_URL ?? DEFAULT_OPENAI_BASE;
const model = process.env.AIEVAL_PROBE_MODEL ?? 'deepseek-flash';
const prompt = process.env.AIEVAL_PROBE_PROMPT ?? PROMPT;
const maxTokens = readPositiveInt('AIEVAL_PROBE_MAX_TOKENS', 2048);
const timeoutMs = readPositiveInt('AIEVAL_PROBE_TIMEOUT_MS', 180000);
const withExtra = process.env.AIEVAL_PROBE_EXTRA !== '0';

/**
 * 把一条路由还原成两条协议的 base。只保证 **DeepSeek** 的三条形状：
 *   ① `…/anthropic`（本机 `~/.aieval/config.json` 的 anthropic 路由就是这个形状）⇒ openai 退回根；
 *   ② 裸根（本机 openai 路由是 `https://api.deepseek.com/`，**生产实际用的就是这条**）；
 *   ③ OpenAI 惯用的 `…/v1`。
 * ②③ 的 anthropic 都落在 **`<根>/anthropic`**：DeepSeek 的 anthropic 路由**不跟着 `/v1` 走**
 * （曾经的写法是「剥掉 `/v1` 再拼 `/v1/messages`」，那对 DeepSeek 是错的——正是评审揪出来的那条）。
 * 非 DeepSeek 网关（anthropic 路由不是 `<根>/anthropic`）用 `AIEVAL_PROBE_ANTHROPIC_BASE_URL` 显式指定。
 */
function resolveBases(raw) {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/anthropic')) {
    return { openai: trimmed.slice(0, -'/anthropic'.length), anthropic: trimmed };
  }
  return { openai: trimmed, anthropic: `${trimmed.replace(/\/v\d+$/, '')}/anthropic` };
}

const bases = resolveBases(rawBase);
const anthropicOverride = process.env.AIEVAL_PROBE_ANTHROPIC_BASE_URL;
if (anthropicOverride) bases.anthropic = anthropicOverride.trim().replace(/\/+$/, '');

/**
 * 发一次 POST 并**尽力**解析 JSON，429 / 5xx 与网络异常**各重试一次**（2s 后）。
 * 为什么要重试：不重试的话一次网关抖动会落成一行「合法读数」并按退出码 0 收场，而 5xx 根本不是
 * 网关对字段的答复——它会把「字段被拒」和「网关抽风」混成同一格读数（重试次数会落进读数）。
 * 非 JSON 响应（多半是走错路由拿到的 HTML 404 页）要把原文留下来：直接 `response.json()`
 * 抛出的 SyntaxError 会把真正的病因盖掉，而真机上「路由拼错」和「字段被拒」是两回事。
 */
async function postJson(url, headers, body) {
  const maxAttempts = 2;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      // 只对瞬时失败重试：4xx（含 400 / 422）是网关对**字段**的答复，必须原样落进读数
      const transient = response.status === 429 || response.status >= 500;
      if (transient && attempt < maxAttempts) {
        console.log(`    ↻ ${url} 返回 ${response.status}，${RETRY_DELAY_MS}ms 后重试一次`);
        continue;
      }
      return { status: response.status, json, text, retries: attempt - 1 };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) console.log(`    ↻ ${url} 请求异常（${error?.message ?? error}），${RETRY_DELAY_MS}ms 后重试一次`);
    }
  }
  throw lastError;
}

/** 非 2xx 时摘出网关给的原因（压平 + 截断），供 REPORT 逐字引用 */
function failureDetail(status, json, text) {
  if (status >= 200 && status < 300) return null;
  const message = json?.error?.message ?? json?.message ?? text;
  return String(message ?? '').replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * openai 协议（`/chat/completions`）：强度走 `reasoning_effort`、关闭走 `thinking.disabled`。
 * @param effort 档位；`undefined` = 这一格不下发
 * @param thinking `thinking` 字段；`undefined` = 不下发
 * @param options `prompt` 可覆盖问题（难题对照用）
 */
async function openai(effort, thinking, options = {}) {
  const { status, json, text, retries } = await postJson(
    `${bases.openai}/chat/completions`,
    { authorization: `Bearer ${key}` },
    {
      model,
      stream: false,
      messages: [{ role: 'user', content: options.prompt ?? prompt }],
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
      ...(thinking === undefined ? {} : { thinking }),
    },
  );
  const choice = json?.choices?.[0];
  const message = choice?.message;
  // DeepSeek 的字段名是 `reasoning_content`；个别网关把同一份内容放在 `reasoning` 别名里，一并认。
  // **取首个非空候选**：只看「非 null」的话，`reasoning_content: ''` + 有内容的 `reasoning`
  // 会被判成「无 reasoning」——那正是加这个别名想防的误读。承载字段名要落进读数
  //（「哪些字段被接受」这一问靠它才答得准）。
  const carriers = [
    ['message.reasoning_content', message?.reasoning_content],
    ['message.reasoning', message?.reasoning],
  ];
  const hit = carriers.find(([, value]) => typeof value === 'string' && value !== '');
  return {
    status,
    reasoning: hit ? hit[1] : null,
    carrier: hit ? hit[0] : null,
    stop: choice?.finish_reason ?? null,
    detail: failureDetail(status, json, text),
    retries,
  };
}

/**
 * anthropic 协议（`/v1/messages`）：强度走 `output_config.effort`、关闭走 `thinking.disabled`。
 * `options.maxTokens` 可抬高上限——`budget_tokens` 探针要把它抬到预算之上，
 * 否则真 Anthropic 会直接判 400（预算必须小于 max_tokens）。
 */
async function anthropic(effort, thinking, options = {}) {
  const { status, json, text, retries } = await postJson(
    `${bases.anthropic}/v1/messages`,
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    {
      model,
      max_tokens: options.maxTokens ?? maxTokens,
      stream: false,
      messages: [{ role: 'user', content: options.prompt ?? prompt }],
      ...(effort === undefined ? {} : { output_config: { effort } }),
      ...(thinking === undefined ? {} : { thinking }),
    },
  );
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const thinkingText = blocks.filter((block) => block?.type === 'thinking').map((block) => block.thinking ?? '').join('');
  return {
    status,
    reasoning: thinkingText === '' ? null : thinkingText,
    carrier: thinkingText === '' ? null : 'content[].thinking',
    stop: json?.stop_reason ?? null,
    detail: failureDetail(status, json, text),
    retries,
  };
}

const rows = [];

/**
 * 跑一格。任何异常（网络 / 超时 / DNS）都落成一行 `ERR`，**绝不让一格失败吞掉后面的读数**：
 * 六行里有一行是网络故障时，另外五行的数据仍然是有效的。
 */
async function runCase(label, protocol, call) {
  const startedAt = Date.now();
  let row;
  try {
    const result = await call();
    const chars = result.reasoning === null ? 0 : [...result.reasoning].length;
    row = { label, protocol, status: result.status, chars, reasoning: result.reasoning, carrier: result.carrier, stop: result.stop, detail: result.detail, retries: result.retries ?? 0 };
  } catch (error) {
    row = { label, protocol, status: null, chars: null, reasoning: null, carrier: null, stop: null, detail: String(error?.message ?? error), retries: 0 };
  }
  row.ms = Date.now() - startedAt;
  rows.push(row);
  const readout = row.reasoning === null ? '无' : `${row.chars} 字符`;
  console.log(`  · ${protocol}/${label} → ${row.status ?? 'ERR'}（reasoning ${readout}，${row.ms}ms）`);
}

/** 表格单元格：竖线与换行会破坏 Markdown 表结构，落表前先压平 */
function cell(value) {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/** 主表打印：列头与 brief 一致，可直接粘进 REPORT.md */
function printTable(list) {
  console.log('| 协议 | 档位 | 状态码 | reasoning 是否存在 | 字符数 |');
  console.log('|---|---|---|---|---|');
  for (const row of list) {
    console.log(`| ${cell(row.protocol)} | ${cell(row.label)} | ${cell(row.status ?? 'ERR')} | ${row.reasoning === null ? '否' : '是'} | ${cell(row.chars ?? '—')} |`);
  }
}

console.log('[v8 探针] 思考强度在两协议上真的生效吗');
console.log(`  模型：${model}`);
console.log(`  openai    → ${bases.openai}/chat/completions`);
console.log(`  anthropic → ${bases.anthropic}/v1/messages`);
console.log('  凭据：AIEVAL_PROBE_GATEWAY_API_KEY（已注入，全程不回显）');
console.log(`  anthropic max_tokens：${maxTokens}`);
console.log(`  附加探针：${withExtra ? '开（噪声基线 / budget_tokens / 按需难题对照）' : '关（AIEVAL_PROBE_EXTRA=0）'}`);
console.log('');

console.log('[六行主表]');
await runCase('low', 'openai', () => openai('low'));
await runCase('max', 'openai', () => openai('max'));
await runCase(OFF, 'openai', () => openai(undefined, { type: 'disabled' }));
await runCase('low', 'anthropic', () => anthropic('low'));
await runCase('max', 'anthropic', () => anthropic('max'));
await runCase(OFF, 'anthropic', () => anthropic(undefined, { type: 'disabled' }));

const mainRows = [...rows];

/** 主表里取某协议某档那一行（附加行不进主表） */
function mainRow(protocol, label) {
  return mainRows.find((row) => row.protocol === protocol && row.label === label);
}

/**
 * 单协议初判：`low` 与 `max` 的**长度比**是否够得上「比值达标」（1.2 是**可辩护的下限**而不是精确科学）。
 * ⚠️ 比值达标**不等于**生效：单次读数会被采样抖动骗（见 `conclusive()`）。
 */
function distinguishable(protocol) {
  const low = mainRow(protocol, 'low');
  const max = mainRow(protocol, 'max');
  if (!low?.reasoning || !max?.reasoning) return false;
  return max.chars > low.chars && max.chars / low.chars >= 1.2;
}

/** `low` 档两次读数的抖动（只有附加探针跑过才有；没跑或有一格失败返回 null） */
function lowNoise(protocol) {
  const first = mainRow(protocol, 'low');
  const again = extraRows.find((row) => row.protocol === protocol && row.label === 'low（复跑）');
  if (!first?.reasoning || !again?.reasoning) return null;
  return Math.abs(first.chars - again.chars);
}

/**
 * 主表那一次读数**是否足以下结论**：比值达标 **且**差额**超过同档抖动**。
 * 只有两条都成立才跳过难题对照——2026-10-07 实测里 openai 是 702→935（1.33×）判了「可区分」，
 * 补样本后 low 复跑 297（抖动 405 > 差额 233）⇒ 那次读数根本不可信，而难题对照也因此被跳过。
 * 噪声基线拿不到（没跑 / 有一格失败）时返回 false，照旧跑对照——宁可多打两次也不要不打。
 */
function conclusive(protocol) {
  if (!distinguishable(protocol)) return false;
  const noise = lowNoise(protocol);
  if (noise === null) return false;
  const low = mainRow(protocol, 'low');
  const max = mainRow(protocol, 'max');
  return Math.abs(max.chars - low.chars) > noise;
}

/** 噪声基线：同一档跑两次的抖动幅度（只有附加探针跑过才有） */
function noiseLine(protocol, again) {
  const first = mainRow(protocol, 'low');
  if (!first?.reasoning || !again?.reasoning || first.chars === 0 || again.chars === 0) {
    return `  ${protocol}：low 复跑没拿到可比读数（首次 ${first?.chars ?? '—'} / 复跑 ${again?.chars ?? '—'}）`;
  }
  const spread = Math.abs(first.chars - again.chars);
  const ratio = Math.max(first.chars, again.chars) / Math.min(first.chars, again.chars);
  return `  ${protocol}：low 两次 ${first.chars} vs ${again.chars} 字符（抖动 ${spread} 字符，比值 ${ratio.toFixed(2)}）`;
}

// 附加探针 A/B：噪声基线 + budget_tokens（都只是 low 档，快；不影响主表）
if (withExtra) {
  console.log('\n[附加 A/B] 噪声基线 + budget_tokens');
  await runCase('low（复跑）', 'openai', () => openai('low'));
  await runCase('low（复跑）', 'anthropic', () => anthropic('low'));
  await runCase('low + budget_tokens 1024', 'anthropic', () => anthropic('low', { type: 'enabled', budget_tokens: 1024 }, { maxTokens: 16384 }));
  await runCase('low + budget_tokens 8192', 'anthropic', () => anthropic('low', { type: 'enabled', budget_tokens: 8192 }, { maxTokens: 16384 }));
}

const extraRows = rows.slice(mainRows.length);

// 附加探针 C：主表读数**不足以下结论**时才花时间跑难题对照（排除「题目太简单 / 样本太少」的假阳性）
if (withExtra) {
  for (const protocol of ['openai', 'anthropic']) {
    if (conclusive(protocol)) continue;
    console.log(`\n[附加 C] ${protocol} 主表未判出可区分（或差额没超过同档抖动）⇒ 换难题对照`);
    await runCase('low（难题）', protocol, () => (protocol === 'openai' ? openai('low', undefined, { prompt: HARD_PROMPT }) : anthropic('low', undefined, { prompt: HARD_PROMPT })));
    await runCase('max（难题）', protocol, () => (protocol === 'openai' ? openai('max', undefined, { prompt: HARD_PROMPT }) : anthropic('max', undefined, { prompt: HARD_PROMPT })));
  }
}

console.log('\n## 六行主表\n');
printTable(mainRows);

if (extraRows.length > 0) {
  console.log('\n## 附加读数（不计入主表；`AIEVAL_PROBE_EXTRA=0` 可跳过）\n');
  printTable(extraRows);
}

console.log('\n[逐行附注] 承载字段 / 截断 / 重试 / 网关原文');
for (const row of rows) {
  const notes = [];
  if (row.carrier) notes.push(`承载字段 ${row.carrier}`);
  if (row.stop) notes.push(`stop=${row.stop}`);
  // max_tokens 截断会让「max 档更长」这个判据失真（长度被上限压平），必须显式喊出来
  if (row.stop === 'max_tokens' || row.stop === 'length') notes.push('⚠️ 被 max_tokens 截断，长度读数不可比（用 AIEVAL_PROBE_MAX_TOKENS 抬高重跑）');
  if (row.retries > 0) notes.push(`重试 ${row.retries} 次后拿到这一行`);
  if (row.detail) notes.push(`网关原文：${row.detail}`);
  if (notes.length > 0) console.log(`  · ${row.protocol}/${row.label}：${notes.map(cell).join('；')}`);
}

console.log('\n[机器初判]（结论以 REPORT.md 为准，这里只是把三条判据摆出来）');
for (const protocol of ['openai', 'anthropic']) {
  const low = mainRow(protocol, 'low');
  const max = mainRow(protocol, 'max');
  const off = mainRow(protocol, OFF);
  if (!low?.reasoning || !max?.reasoning) {
    console.log(`  ${protocol}：✗ 有档位没有 reasoning 内容（low=${low?.chars ?? '—'} / max=${max?.chars ?? '—'}）⇒ 无从比较，先看状态码与网关原文`);
  } else {
    const ratio = max.chars / low.chars;
    const verdict = max.chars === low.chars
      ? '✗ 不可区分（两次字符数完全相同）'
      : ratio >= 1.2
        ? '⚠️ 比值达标（**不等于生效**：简单题上单次读数会假阳性，必须对着噪声基线与难题对照读，见头注释）'
        : ratio <= 1 / 1.2
          ? '⚠️ 方向相反（low 更长，与档位语义不符）'
          : '⚠️ 弱区分（单样本，先看噪声基线）';
    console.log(`  ${protocol}：low=${low.chars} / max=${max.chars} 字符，比值 ${ratio.toFixed(2)} ⇒ ${verdict}`);
  }
  console.log(`  ${protocol}：${off?.reasoning === null ? '✅ off 没有 reasoning 内容（真的关掉了）' : `✗ off 仍有 ${off?.chars ?? '?'} 字符 reasoning（没关掉）`}`);
}

if (withExtra) {
  console.log('\n[噪声基线] 同一档两次的抖动（判「可区分」时拿它当尺子；**n 很小，只覆盖 low**）');
  for (const protocol of ['openai', 'anthropic']) {
    const again = extraRows.find((row) => row.protocol === protocol && row.label === 'low（复跑）');
    console.log(noiseLine(protocol, again));
    // 把「档间差 vs 同档抖动」直接算出来：差额落在抖动里就只能说「未能证实」，
    // 这是 2026-10-07 那轮实测教给判据的一句话（当时单样本比值判了「可区分」，补样本后区间重叠）。
    const first = mainRow(protocol, 'low');
    const max = mainRow(protocol, 'max');
    if (first?.reasoning && max?.reasoning && again?.reasoning) {
      const gap = Math.abs(max.chars - first.chars);
      const noise = Math.abs(first.chars - again.chars);
      const call = gap > noise
        ? '差 > 同档抖动（仍要难题对照 + 更多样本才算数，单次读数不算证实）'
        : '**差 ≤ 同档抖动 ⇒ 未能证实**（这就是「比值达标」会假阳性的样子）';
      console.log(`    ⇒ 档间差 ${gap} 字符 vs low 同档抖动 ${noise} 字符：${call}`);
    }
  }
  const small = extraRows.find((row) => row.label === 'low + budget_tokens 1024');
  const large = extraRows.find((row) => row.label === 'low + budget_tokens 8192');
  if (small && large) {
    console.log('\n[budget_tokens] 固定 output_config.effort=low，只换 thinking.budget_tokens');
    const comparable = small.reasoning !== null && large.reasoning !== null && small.chars > 0 && large.chars > 0;
    const ratio = comparable ? Math.max(small.chars, large.chars) / Math.min(small.chars, large.chars) : null;
    console.log(`  1024 → ${small.chars ?? '—'} 字符（${small.status ?? 'ERR'}）；8192 → ${large.chars ?? '—'} 字符（${large.status ?? 'ERR'}）`);
    console.log(
      comparable
        ? `  两次比值 ${ratio.toFixed(2)} ⇒ ${ratio >= 1.5 ? '疑似**未被忽略**（大预算明显更长）' : '与「budget_tokens 被上游忽略」**一致**（各一格，n=1/组，不构成证实）'}`
        : '  两次没拿到可比读数，结论只能照状态码与网关原文写',
    );
  }
}

// 429 / 5xx 不是「网关对字段的答复」，要单独喊出来，别混进「字段被接受」的证据里
const unhealthy = rows.filter((row) => row.status === 429 || (typeof row.status === 'number' && row.status >= 500));
if (unhealthy.length > 0) {
  console.error(`\n[注意] ${unhealthy.length} 格是网关故障（429/5xx），不是对字段的答复：${unhealthy.map((row) => `${row.protocol}/${row.label}=${row.status}`).join('、')}——结论别用这几格`);
}

const failed = rows.filter((row) => row.status === null);
if (failed.length > 0) {
  console.error(`\n[失败] ${failed.length} 格没拿到 HTTP 响应（网络 / 超时，已各重试一次）：${failed.map((row) => `${row.protocol}/${row.label}`).join('、')}`);
  process.exitCode = 1;
}
