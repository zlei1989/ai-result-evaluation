/**
 * 非流式文本 API 外壳：一次调用拿一段文本，供「AI 生成评分标准项」（p2）与评分调用（p4）共用。
 * 为什么要共用一个外壳（§11 R5）：两处都是「非流式文本 API + 双协议路由」，
 * 写两份必然漂移——而漂移的表现是「生成能跑、评分 401」这类只在某一条路径上出现的故障。
 * 三个必须成立的口径：
 *   1. 双协议的接线不同，必须各自正确：OpenAI 打 `/chat/completions` 用 `Authorization: Bearer`、
 *      取 `choices[0].message.content`；Anthropic 打 `/v1/messages` 用 `x-api-key` + `anthropic-version`、
 *      system 走顶层字段、取 `content[]` 里的 text 块并拼接；
 *   2. baseUrl 的拼法要容忍用户手填的各种形态（尾斜杠、Anthropic 侧多写一个 `/v1`），
 *      见 `endpoint()`；
 *   3. 失败一律折成带中文原因的 `ServiceError`：401 → `AUTH_FAILED`（带 host，指向设置页）、
 *      429 → `RATE_LIMITED`（建议改用串行）、其余 → `INTERNAL`。绝不放任 `TypeError: fetch failed`
 *      冒到路由层——那对用户等于没有解释。
 *   4. **上游正文只进 `context` 与服务端日志，绝不进 `message`**（终审 H2；与 `@aieval/api` 的
 *      `upstreamError()` 逐字同一口径）：`message` 会被页面 `message.error(error.message)` 原样
 *      上屏（`apps/web-next/src/runs-view.ts` 的 `describeError`），而网关的正文既可能是一整页登录
 *      HTML，也可能**回显了我们的请求头**（`Authorization: Bearer <明文密钥>`）——那等于把密钥画在界面上。
 *      `fetch` 自身抛错的原文同理（`TypeError: fetch failed` 是英文，spec §10 禁止它冒到界面；
 *      p6 的 A3 就是这个形状）：英文原文放 `cause`/`context`，`message` 只留中文归因 + host + 模型名。
 *   5. **可中止**（终审 FIX-1）：`input.signal` 原样交给 `fetch`，且**响应体读取也在它的管辖内**——
 *      滴流响应（头已到、正文一直不来）会不断重置 HTTP 客户端的 `bodyTimeout` ⇒ 那一层根本没有上界，
 *      唯一能切断它的是我们自己的 abort。两个 `await`（发请求 / 读正文）都要按同一口径折成中文：
 *      被中止**不是**连通性故障，文案必须分开（否则日志会把一次用户终止指向「检查网络」这个错误方向）。
 *   6. **支持多轮对话与瞬时失败重试**（2026-09-27，评分结构修复）：`callTextApiConversation` 是多轮
 *      入口（评分解析失败时把结构错误反馈给模型再问一轮），`callTextApi` 是它的单轮特例——
 *      两条路径共用 `buildBody` 与 `callOnce`，**请求体形状只有一个构造点**，否则「单轮能跑、
 *      多轮 400」这类漂移只会在多轮那一条路径上出现。
 *  7. **瞬时失败（网络 / 5xx / 限流）自动重试一次以上**：本机实测真实网关会回 `500 服务维护中`，
 *      一次抖动就让一整行落 `failed`（还要人工重跑）是不划算的。重试**只覆盖瞬时面**
 *      （见 `RETRYABLE_CODES`），`AUTH_FAILED` / `CONFLICT` 与「已中止」一次都不重试。
 */
import { ServiceError, type ProtocolType } from '@aieval/contracts';
import { createLogger } from '@aieval/core';

/**
 * 一次文本调用的路由：三种协议的必填项完全一致（模型 id 与凭据都在这里）。
 *
 * 后两格（2026-09-29 追加）是**模型能力**，只有「智能体评分」那条路用得上：评分路由由
 * `resolveJudgeRoute()` 解析出来后会被**原样**当成 `AgentRunInput.route` 交给适配器
 * （`judge-agent.ts` 的 `route: input.route`），于是这一份类型同时扮演两个角色。
 * 纯文本调用（`callTextApi` / `callTextApiConversation`）**不读**这两格 —— 窗口是给 CLI 的，
 * 而 Anthropic 的 1M 在 Messages API 上是 beta header，拼进模型名只会 404。
 */
export interface TextRoute {
  protocolType: ProtocolType;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /** 模型声明的上下文窗口；缺省 = 未知（适配器不注入，spec D8） */
  contextWindow?: number;
  /** 单次输出上限；今天只有 dsh 用得上 */
  maxOutputTokens?: number;
}

/** 对话里的一条消息：两种协议的 `role` 取值完全一致（`system` 只有 OpenAI 侧走消息数组） */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 单轮调用的入参（既有形状，逐字不变） */
export interface TextCallInput {
  system?: string;
  prompt: string;
  signal?: AbortSignal;
}

/** 多轮调用的入参：`messages` 是**完整**对话（含我们要它重答的那一轮失败答复） */
export interface TextConversationInput {
  system?: string;
  messages: readonly ChatMessage[];
  signal?: AbortSignal;
}

const log = createLogger('evaluator/text-api');

/** Anthropic 必须带版本头，缺它上游直接 400 */
const ANTHROPIC_VERSION = '2023-06-01';
/** 非流式调用的输出上限：评分结果是几十行的 JSON，4096 足够且能防住跑飞的模型 */
const MAX_TOKENS = 4096;

/**
 * 瞬时失败的重试预算（**不含首次**）与退避间隔。
 * 为什么要有它：2026-09-27 真实网关实测回 `500 {"type":"api_error","message":"服务维护中，请稍后重试"}`
 * ——一次抖动就把整行判 `failed`、还要人工点一次重跑，而重试一次的成本是几秒。
 * 3 次尝试（首次 + 2 次重试）是「临时抖动够用」与「不把一次真故障拖成分钟级」之间的折中；
 * 退避只用固定 600ms：上游是「维护中」这类短时故障，指数退避在这里买不到更多东西，
 * 却会让一行失败多等好几秒。
 *
 * **为什么是一个导出的可变对象而不是两个常量**：用例要能断言「第 2 次调用时带的是同一段对话」
 * 与「退避确实发生了」，而真等 2×600ms 会让每条负例都慢一秒多（全量套件里成倍放大）。
 * 调用方与用例都从这一个对象取值，**产品默认值**由一条独立用例钉住（`text-api.test.ts`）——
 * 只钉「注入值生效」而不钉默认值，等于把默认值变成无人验证的常量。
 */
export const TEXT_API_RETRY = {
  /** 总尝试次数（首次 + 重试） */
  attempts: 3,
  /** 两次尝试之间的等待（毫秒） */
  backoffMs: 600,
};

/**
 * 可重试的错误码（**只增不减**，且必须是「再试一次可能就好了」的那一类）：
 *   · `RATE_LIMITED`（429）——限流本身就是「稍后再来」；
 *   · `INTERNAL`——它同时承载网络不通 / 5xx / 上游返回了非 JSON（网关登录页或维护页）。
 *     `AUTH_FAILED` 刻意**不在**里面：密钥错了重试一百次还是错的，重试只是把一次明确的失败拖长。
 * `CONFLICT` 等其它码同理不重试。
 */
const RETRYABLE_CODES: readonly string[] = ['RATE_LIMITED', 'INTERNAL'];

/**
 * 拼请求地址。
 * openai：`{base}/chat/completions`——用户在设置页填的就是含 `/v1` 的 baseURL（spec §6.1 的例子），
 *   所以这里**不再补** `/v1`，只去掉末尾多余的斜杠。
 * anthropic：`{base}/v1/messages`——但用户很可能把 baseURL 填成已经带 `/v1` 的形式，
 *   这时再拼一次会得到 `/v1/v1/messages`（上游 404）。故先把结尾的 `/v1` 剥掉再拼。
 */
function endpoint(route: TextRoute): string {
  const base = route.baseUrl.replace(/\/+$/, '');
  if (route.protocolType === 'anthropic') {
    return `${base.replace(/\/v1$/, '')}/v1/messages`;
  }
  return `${base}/chat/completions`;
}

/** 从 URL 里取 host（错误文案与 context 都要它：用户要据此判断是哪个供应商的问题） */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 请求体构造（**唯一一处**，单轮与多轮共用）。
 * 两个协议的形状差异只有三处：system 是顶层字段还是消息数组的第一条、`content` 是字符串还是块数组、
 * 以及 OpenAI 侧要显式 `stream: false`。这三处写两份必然在某一处漂移，而漂移的表现是
 * 「单轮能跑、多轮 400」（或者反过来的 401）——只在多轮那条路径上出现，最难查。
 */
function buildBody(route: TextRoute, input: TextConversationInput): unknown {
  return route.protocolType === 'anthropic'
    ? {
      model: route.modelId,
      max_tokens: MAX_TOKENS,
      stream: false,
      // Anthropic 的 system 是**顶层字段**，放进 messages 会被当成普通用户消息
      ...(input.system === undefined ? {} : { system: input.system }),
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
    }
    : {
      model: route.modelId,
      stream: false,
      messages: [
        ...(input.system === undefined ? [] : [{ role: 'system', content: input.system }]),
        ...input.messages.map((message) => ({ role: message.role, content: message.content })),
      ],
    };
}

/**
 * 发一次请求并把响应解析成纯文本。**单轮与多轮的共同内核**（重试循环包在它外面）。
 * 两个 `await`（发请求 / 读正文）与状态码、解析失败各自折成带中文原因的 `ServiceError`——
 * 与重构前逐字同一口径，只是把它们从 `callTextApi` 里搬了出来。
 */
async function callOnce(
  route: TextRoute,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<string> {
  const url = endpoint(route);
  const host = hostOf(url);
  const headers: Record<string, string> =
    route.protocolType === 'anthropic'
      ? {
        'content-type': 'application/json',
        'x-api-key': route.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      }
      : {
        'content-type': 'application/json',
        Authorization: `Bearer ${route.apiKey}`,
      };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // 不传时不写这一项：`signal: undefined` 与「没有这一格」在 fetch 眼里等价，
      // 但显式传 undefined 会让 `new Request()` 的 init 里多出一个键，桩断言更难写
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw fetchFailure(error, { host, url, modelId: route.modelId, signal });
  }

  // 读正文同样在 signal 的管辖内：滴流响应正是在这一步无界（头已到、正文一直不来），
  // 不在这里折错就会把一次中止变成裸 `AbortError`（英文）冒到评分器的折错分支上。
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw fetchFailure(error, { host, url, modelId: route.modelId, signal });
  }
  if (!response.ok) throw httpError(response.status, host, url, raw, route.modelId);

  return route.protocolType === 'anthropic'
    ? parseAnthropic(raw, host, route.modelId)
    : parseOpenAI(raw, host, route.modelId);
}

/** 让出 `ms` 毫秒（重试退避用）；抽出来是为了用例能一眼看出「重试之间确实等了」 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 「这次失败值不值得再试一次」。
 * 判据是**错误码**而不是错误类型：调用链上抛的永远是 `ServiceError`（`callOnce` 三条出口都折过），
 * 而码表是语义（「限流」与「密钥错」的处置不同），按类型判只能看到「都是 ServiceError」。
 * 已中止（用户终止 / 外层兜底超时）**一次都不重试**：那正是调用方要求停下来的意思，
 * 重试等于把「按了终止」变成「又飞了三次请求」。
 */
function isRetryable(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return false;
  return error instanceof ServiceError && RETRYABLE_CODES.includes(error.code);
}

/**
 * 带瞬时重试的多轮调用：**所有文本调用（单轮与多轮）都从这里出去**。
 * 重试期间原样复用同一个 `body`（同一段对话），失败原因进 WARN 日志——
 * AGENT.md 的日志表把「重试」列在 WARN 那一档，且重试必须在日志里留痕，
 * 否则「这一次为什么慢了三秒」在事后没有任何线索。
 */
async function callWithRetry(
  route: TextRoute,
  input: TextConversationInput,
): Promise<string> {
  const body = buildBody(route, input);
  const host = hostOf(endpoint(route));
  let lastError: unknown;
  for (let attempt = 1; attempt <= TEXT_API_RETRY.attempts; attempt += 1) {
    try {
      // 第 2 次及以后才是「重试」：首次失败也要走同一条出口，故日志放在 catch 里
      return await callOnce(route, body, input.signal);
    } catch (error) {
      lastError = error;
      const retryable = isRetryable(error, input.signal);
      const hasNext = attempt < TEXT_API_RETRY.attempts;
      const code = error instanceof ServiceError ? error.code : 'INTERNAL';
      const message = error instanceof Error ? error.message : String(error);
      if (!retryable || !hasNext) {
        if (retryable) {
          log.warn('文本 API 重试次数已用尽，按失败收尾', { host, modelId: route.modelId, attempt, code, message });
        }
        throw error;
      }
      log.warn('文本 API 瞬时失败，稍后重试', { host, modelId: route.modelId, attempt, code, message });
      await sleep(TEXT_API_RETRY.backoffMs);
    }
  }
  // 循环必然在 return 或 throw 上离开；这一行只为让 tsc 看到「不是所有分支都返回值」
  throw lastError instanceof Error ? lastError : new ServiceError('INTERNAL', `调用文本 API 失败（${host}，模型 ${route.modelId}）`);
}

/**
 * 调用文本 API 并返回模型输出的纯文本（单轮）。
 * 非流式（`stream: false`）是刻意的：评分与提示词生成都要完整结果，流式只会让解析更复杂。
 * `input.signal` 可选：评分通路传编排层那一把（用户终止 + 外层兜底超时都走它），
 * 提示词生成不传——不传时行为与本功能之前逐字相同（见文件头第 5 条）。
 */
export async function callTextApi(route: TextRoute, input: TextCallInput): Promise<string> {
  return callWithRetry(route, {
    // 单轮就是「一段对话只有一条用户消息」：与多轮共用同一个请求体构造点
    messages: [{ role: 'user', content: input.prompt }],
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

/**
 * 多轮调用：把**完整对话**交给模型（含它上一轮不合格的答复与我们的纠错要求）。
 * 为什么需要它（2026-09-27，目标页实测）：评分模型偶尔回一段散文或半截 JSON，一次解析失败就
 * 让整行落 `failed`——而它手里已经有全部上下文，只要告诉它「哪里不合格」就能答对。
 * 与 `callTextApi` 共用请求体构造、折错、中止与瞬时重试（见文件头第 6/7 条）。
 */
export async function callTextApiConversation(
  route: TextRoute,
  input: TextConversationInput,
): Promise<string> {
  if (input.messages.length === 0) {
    // 空对话会让两种协议都返回 400（上游不认空 messages），在本地拦下并给出可读原因
    throw new ServiceError('INTERNAL', `调用文本 API 失败（${hostOf(endpoint(route))}，模型 ${route.modelId}）：对话里一条消息都没有`);
  }
  return callWithRetry(route, input);
}

/**
 * 发请求 / 读正文这两个 `await` 抛错时的**同一处**折错（两处各写一份必然漂移：
 * 「终止」与「网络不通」的文案一旦在某一处退化成通用归因，排查方向就被指错了）。
 *
 * 判据是 `signal.aborted` 而不是错误类型：中止只可能来自我们自己交出去的 signal
 * （用户按终止 / 编排层的外层兜底），而 undici 抛的是 `DOMException(AbortError)` /
 * `TypeError` 两种形状（Node 版本与阶段而异）——按错误类型判会漏掉其中一种。
 * 归因与终态之间是**单向**的：这里只保证「不是连通性故障」这句话不说错，
 * 「用户终止 ⇒ canceled / 我们超时 ⇒ timed-out」由编排层按它自己的记账区分（signal 不带原因）。
 */
function fetchFailure(
  error: unknown,
  input: { host: string; url: string; modelId: string; signal?: AbortSignal },
): ServiceError {
  const context = { host: input.host, url: input.url, modelId: input.modelId };
  if (input.signal?.aborted === true) {
    return new ServiceError('INTERNAL', `调用文本 API 已中止（${input.host}，模型 ${input.modelId}）：该次调用已被终止或超时`, {
      cause: error,
      context,
    });
  }
  return new ServiceError(
    'INTERNAL',
    `调用文本 API 失败（${input.host}，模型 ${input.modelId}）：请检查该供应商的地址与网络连通性`,
    { cause: error, context },
  );
}

/**
 * 非 2xx → 可展示的中文原因（状态码分类见 spec §10 的错误表）。
 *
 * 上游正文（`raw`）**只进 context 与服务端日志**，绝不进 message（口径见文件头第 4 条）。
 * 诊断能力不降级：片段（仍是前 300 字）同时进 context 与一条 WARN 日志——路由层那条 error 日志
 * 只打 message，片段移出 message 后就只剩状态码，故这里自己落一条。
 */
function httpError(status: number, host: string, url: string, raw: string, modelId: string): ServiceError {
  const snippet = raw.slice(0, 300);
  log.warn('上游返回非 2xx', { host, status, modelId, body: snippet });
  if (status === 401 || status === 403) {
    return new ServiceError(
      'AUTH_FAILED',
      `供应商密钥无效或无权访问（${host}，模型 ${modelId}）：请到设置页检查该供应商的 API 密钥`,
      { context: { host, url, status, body: snippet } },
    );
  }
  if (status === 429) {
    return new ServiceError(
      'RATE_LIMITED',
      `上游限流（${host}，模型 ${modelId}）：请降低并发，把评测改成串行后重试`,
      { context: { host, url, status, body: snippet } },
    );
  }
  return new ServiceError('INTERNAL', `文本 API 返回 HTTP ${status}（${host}，模型 ${modelId}）`, {
    context: { host, url, status, body: snippet },
  });
}

/** 解析 OpenAI 兼容响应：`choices[0].message.content` */
function parseOpenAI(raw: string, host: string, modelId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 正文同样只进 context：网关返回登录页 HTML 时它可能整页回显请求头（见文件头第 4 条）
    throw new ServiceError('INTERNAL', `文本 API 返回的不是合法 JSON（${host}，模型 ${modelId}）：可能被网关或登录页拦截`, {
      context: { host, modelId, body: raw.slice(0, 300) },
    });
  }
  const content = (parsed as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new ServiceError('INTERNAL', `文本 API 未返回文本内容（${host}，模型 ${modelId}）：响应里没有 choices[0].message.content`, {
      context: { host, modelId, body: raw.slice(0, 300) },
    });
  }
  return content;
}

/** 解析 Anthropic 响应：拼接 `content[]` 里所有 `type: 'text'` 块 */
function parseAnthropic(raw: string, host: string, modelId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceError('INTERNAL', `文本 API 返回的不是合法 JSON（${host}，模型 ${modelId}）：可能被网关或登录页拦截`, {
      context: { host, modelId, body: raw.slice(0, 300) },
    });
  }
  const blocks = (parsed as { content?: { type?: string; text?: unknown }[] }).content;
  const text = (blocks ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
  if (text === '') {
    throw new ServiceError('INTERNAL', `文本 API 未返回文本内容（${host}，模型 ${modelId}）：响应里没有 type=text 的内容块`, {
      context: { host, modelId, body: raw.slice(0, 300) },
    });
  }
  return text;
}
