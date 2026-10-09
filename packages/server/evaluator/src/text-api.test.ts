// @vitest-environment node
/**
 * 文本 API 外壳：双协议（openai / anthropic）的非流式调用。
 * 注意：用 `vi.stubGlobal('fetch', …)` 桩掉 fetch（Node 18+ 有全局 fetch，不需要 polyfill）；
 * `afterEach` 必须 `vi.unstubAllGlobals()`，否则桩会泄漏给同文件后续用例。
 * 本文件要钉住的是**接线**（URL、请求头、请求体的形状、响应字段的取值路径），
 * 而不是 HTTP 客户端的行为——p4 的评分器与 p2 的「AI 生成」都依赖这份接线完全一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFFORT_OFF, ServiceError, type ProtocolType } from '@aieval/contracts';
import { TEXT_API_RETRY, callTextApi, callTextApiConversation, type TextRoute } from './text-api';

/** 造一个 fetch 响应（只需要 ok / status / json / text 四个成员） */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 桩掉 fetch，返回一个能读到 (url, init) 的 spy */
function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const route = (protocolType: ProtocolType): TextRoute => ({
  protocolType,
  baseUrl: protocolType === 'openai' ? 'https://api.deepseek.com/v1' : 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-test-key',
  modelId: 'deepseek-chat',
});

/** 取第 n 次调用的 (url, init) */
function callArgs(fetchMock: ReturnType<typeof vi.fn>, index = 0): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

/** 产品默认值（在下面第一条用例里被钉住；这里存一份用于还原） */
const PRODUCTION_ATTEMPTS = 3;
const PRODUCTION_BACKOFF_MS = 600;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // 重试预算可能被某条用例改过（见 `TEXT_API_RETRY` 的注释）：**必须**还原，
  // 否则后面用例的请求次数与耗时都会跟着变——那种失败非常难查（症状与本次改动毫无关系）
  TEXT_API_RETRY.attempts = PRODUCTION_ATTEMPTS;
  TEXT_API_RETRY.backoffMs = PRODUCTION_BACKOFF_MS;
});

describe('callTextApi —— OpenAI 兼容协议', () => {
  it('打 {baseUrl}/chat/completions，带 Bearer 与 model，取 choices[0].message.content', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: '生成结果' } }] }));
    const text = await callTextApi(route('openai'), { prompt: '写个 LRU' });

    const { url, init } = callArgs(fetchMock);
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: '写个 LRU' }]);
    expect(text).toBe('生成结果');
  });

  it('给了 system 时放在 messages 的第一条', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await callTextApi(route('openai'), { system: '你是评分员', prompt: '打分' });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as { messages: unknown[] };
    expect(body.messages).toEqual([
      { role: 'system', content: '你是评分员' },
      { role: 'user', content: '打分' },
    ]);
  });

  it('baseUrl 带尾斜杠时不产生双斜杠（用户手填的地址形态很多）', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await callTextApi({ ...route('openai'), baseUrl: 'https://api.deepseek.com/v1/' }, { prompt: 'x' });
    expect(callArgs(fetchMock).url).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});

describe('callTextApi —— Anthropic 兼容协议', () => {
  it('打 {baseUrl}/v1/messages，带 x-api-key 与 anthropic-version，拼接 text 块', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ content: [{ type: 'text', text: '前半段' }, { type: 'text', text: '后半段' }] }),
    );
    const text = await callTextApi(route('anthropic'), { prompt: '写个 LRU' });

    const { url, init } = callArgs(fetchMock);
    expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();       // Anthropic 不认 Bearer
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-chat');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toEqual([{ role: 'user', content: '写个 LRU' }]);
    expect(text).toBe('前半段后半段');
  });

  it('system 走顶层 system 字段而不是 messages（Anthropic 的接口形态）', async () => {
    const fetchMock = stubFetch(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await callTextApi(route('anthropic'), { system: '你是评分员', prompt: '打分' });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as Record<string, unknown>;
    expect(body.system).toBe('你是评分员');
    expect(body.messages).toEqual([{ role: 'user', content: '打分' }]);
  });

  it('baseUrl 末尾的 /v1 不会被叠成 /v1/v1/messages（Anthropic 侧用户常填错这一处）', async () => {
    const fetchMock = stubFetch(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await callTextApi({ ...route('anthropic'), baseUrl: 'https://api.deepseek.com/anthropic/v1' }, { prompt: 'x' });
    expect(callArgs(fetchMock).url).toBe('https://api.deepseek.com/anthropic/v1/messages');
  });
});

describe('callTextApi —— 错误映射', () => {
  it('401 抛 AUTH_FAILED，message 与 context 都带 host（spec §10：错误信息指向设置页）', async () => {
    stubFetch(jsonResponse({ error: { message: 'invalid key' } }, 401));
    let caught: unknown;
    try {
      await callTextApi(route('openai'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('AUTH_FAILED');
    expect((caught as Error).message).toContain('api.deepseek.com');
    expect((caught as ServiceError).context).toMatchObject({ host: 'api.deepseek.com' });
  });

  it('429 抛 RATE_LIMITED 并在 message 里建议改用串行（spec §10）', async () => {
    stubFetch(jsonResponse({ error: { message: 'rate limited' } }, 429));
    let caught: unknown;
    try {
      await callTextApi(route('anthropic'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('RATE_LIMITED');
    expect((caught as Error).message).toContain('串行');
  });

  it('其它非 2xx 抛 INTERNAL，message 含状态码与 host（**不含上游正文**，见下方 H2 守卫）', async () => {
    stubFetch(jsonResponse({ error: { message: 'boom' } }, 500));
    let caught: unknown;
    try {
      await callTextApi(route('openai'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as Error).message).toContain('500');
    expect((caught as Error).message).toContain('api.deepseek.com');
  });

  it('响应缺 choices[0].message.content 时抛 INTERNAL（不返回空串——空串会被当成一次成功的评分）', async () => {
    stubFetch(jsonResponse({ choices: [] }));
    await expect(callTextApi(route('openai'), { prompt: 'x' })).rejects.toThrow(/未返回文本内容/);
  });

  it('网络层抛错时折成 ServiceError 而不是把 fetch 的 TypeError 冒出去（且 message 里不留英文原文）', async () => {
    // `message` 会被页面原样上屏：英文 `fetch failed` 是本仓 p6 冒烟 A3 的原始症状（spec §10 禁止）。
    // 英文原文只留在 `cause` 与 context 里供服务端排障。
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    let caught: unknown;
    try {
      await callTextApi(route('openai'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as Error).message).toContain('api.deepseek.com');
    expect((caught as Error).message).toContain('请检查该供应商的地址与网络连通性');
    expect((caught as Error).message).not.toContain('fetch failed');
    expect((caught as Error).cause).toBeInstanceOf(TypeError);
  });
});

/**
 * 以下四条**超出 task-14 brief 的用例清单**，是本实现补的接线守卫（后两条来自变异分析）。
 * 为什么补：brief 的用例在 anthropic 侧只断言了 x-api-key / anthropic-version / Authorization
 * 缺席、max_tokens 与 messages，于是三处接线即使写错也全绿——① anthropic 少发 content-type
 * 或把 stream 写成 true；② 解析时不过滤块类型（把带 text 字段的非 text 块拼进正文）；
 * ③ anthropic 侧的空正文不报错、直接返回空串（空串会被当成一次成功的评分）；
 * ④ 403 被收窄出 AUTH_FAILED（brief 只造了 401，而网关对无效密钥常回 403）。
 * 它们都是「测试欠断言」型的漏洞：变异体活着，而线上表现为评分正文被污染、静默为空，
 * 或把「密钥错了」误导成「服务端内部错误」。
 *
 * ⚠️ 上面这条「其它非 2xx 的 message 含响应片段」是**改前**的口径，已按终审 H2 收窄：
 * 现在 message 只留中文归因 + host + modelId，正文只进 context 与服务端日志
 * （守卫见文件末尾那一组「上游正文绝不进 message」）。
 */
describe('callTextApi —— 补充守卫（brief 用例未覆盖的接线）', () => {
  it('anthropic 也带 content-type: application/json，且请求体显式 stream: false', async () => {
    const fetchMock = stubFetch(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await callTextApi(route('anthropic'), { prompt: 'x' });
    const { init } = callArgs(fetchMock);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect((JSON.parse(String(init.body)) as Record<string, unknown>).stream).toBe(false);
  });

  it('anthropic 只拼接 type=text 的块（非 text 块即使带 text 字段也不混进正文）', async () => {
    stubFetch(
      jsonResponse({
        content: [
          { type: 'thinking', text: '（网关把内部推理也塞进了 text 字段）' },
          { type: 'text', text: '答案' },
        ],
      }),
    );
    await expect(callTextApi(route('anthropic'), { prompt: 'x' })).resolves.toBe('答案');
  });

  it('anthropic 响应一个 text 块都没有时抛 INTERNAL（与 openai 侧同一口径，不返回空串）', async () => {
    stubFetch(jsonResponse({ content: [{ type: 'thinking', thinking: '只有推理没有答案' }] }));
    await expect(callTextApi(route('anthropic'), { prompt: 'x' })).rejects.toThrow(/未返回文本内容/);
  });

  it('403 与 401 一样映射 AUTH_FAILED（网关对无效密钥常回 403 而不是 401）', async () => {
    // 这一条是**变异分析的产物**：把实现里的 `status === 401 || status === 403` 收窄成 `status === 401`
    // 时，brief 的用例全绿（它只造了 401）——即「403 分支」是一段无人验证的死代码，
    // 而它在真实网关上会以 INTERNAL（500）冒到界面，把「密钥错了」误导成「服务端内部错误」。
    stubFetch(jsonResponse({ error: { message: 'forbidden' } }, 403));
    let caught: unknown;
    try {
      await callTextApi(route('openai'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('AUTH_FAILED');
    expect((caught as Error).message).toContain('api.deepseek.com');
  });

  /**
   * 终审 FIX-1：`input.signal` 必须**原样**递给 `fetch`，且中止的两种形状都要折成
   * 「已中止」而不是「请检查该供应商的地址与网络连通性」——后者会把一次用户终止 / 我们自己的
   * 兜底超时指向「查网络」这个完全错误的方向。
   *
   * 两条用例分别覆盖两个 `await`：① 发请求就被中止（头都没拿到）；
   * ② 头已到、**正文读到一半**被中止——**滴流响应正是这一种**，也是 HTTP 客户端那一层唯一
   * 真无界的形状（字节不断到来会持续重置 `bodyTimeout`），故它必须也在 signal 的管辖内。
   */
  it('signal 原样交给 fetch；发请求阶段被中止 → 「已中止」而不是连通性归因', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen = init.signal;
      // 真实 fetch 在 signal 被 abort 时抛 AbortError：夹具如实模拟，把两者的时序绑在一起
      return await new Promise<Response>((_resolve, reject) => {
        const fail = (): void => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (init.signal?.aborted === true) { fail(); return; }
        init.signal?.addEventListener('abort', fail, { once: true });
      });
    }));

    const pending = callTextApi(route('openai'), { prompt: 'x', signal: controller.signal });
    // 同步段就该已经进到 fetch 里：调用方没把 signal 递下去时这一条立刻红
    expect(seen).toBe(controller.signal);
    controller.abort();

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as Error).message).toContain('已中止');
    expect((caught as Error).message).not.toContain('网络连通性');
    // 英文原文（DOMException 的 message）同样不许进 message：spec §10 禁止它冒到界面
    expect((caught as Error).message).not.toContain('aborted');
  });

  it('响应体读到一半被中止（滴流响应）→ 同样折成「已中止」', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      // 头已到、正文一直不来：这一支**只有** signal 能切断它
      text: async () =>
        await new Promise<string>((_resolve, reject) => {
          const fail = (): void => reject(new DOMException('This operation was aborted', 'AbortError'));
          if (init.signal?.aborted === true) { fail(); return; }
          init.signal?.addEventListener('abort', fail, { once: true });
        }),
    }) as unknown as Response));

    const pending = callTextApi(route('openai'), { prompt: 'x', signal: controller.signal });
    await Promise.resolve(); // 让 `fetch` 那一步落定、进入读正文
    controller.abort();

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as Error).message).toContain('已中止');
    expect((caught as Error).message).not.toContain('网络连通性');
  });
});

/**
 * **上游正文不得出现在 `message` 里**（终审 H2）。
 *
 * 为什么这条必须在 evaluator 这一侧再钉一遍：同一件事在两条路径上曾经**相反**——
 * `@aieval/api` 的 `upstreamError()`（`providers.ts`）刻意把正文只放进 context 与日志，
 * 并写明了理由（网关可能回显 `Authorization: Bearer <明文密钥>`）；而本包的 `httpError()`
 * 把正文前 300 字拼进 message。上屏点是 `apps/web-next/src/runs-view.ts` 的 `describeError`
 * → `message.error(ServiceError.message)`（`app/runs/page.tsx`）⇒ 密钥会被画在界面上。
 *
 * 判据用一段**带明显标记的假正文**（正控）：只要实现里任何一处把它拼回 message，本组立刻红。
 * 标记同时覆盖「上游返回的 JSON 片段」与「网关回显的请求头」两种真实形状。
 */
describe('callTextApi —— 上游正文只进 context 与服务端日志，绝不进 message（H2）', () => {
  /** 假正文：既有显眼的哨兵串，也有真实网关最危险的那种回显 */
  const ECHOED = '<html>502 Bad Gateway: Authorization: Bearer sk-LEAKED-SENTINEL-9f3c</html>';

  /** 造一个「正文是 ECHOED」的非 2xx 响应 */
  function echoResponse(status: number): Response {
    return {
      ok: false,
      status,
      json: async () => ({ error: { message: ECHOED } }),
      text: async () => ECHOED,
    } as unknown as Response;
  }

  /** 跑一次并把抛出的 ServiceError 拿回来（不成立时抛出可读的原因） */
  async function catchError(protocolType: ProtocolType, status: number): Promise<ServiceError> {
    // 这几条用例的正文里带着哨兵串，WARN 会把它打到 stderr 上把输出淹掉；
    // 「WARN 里确实有正文」由单独一条用例断言（那里自己装 spy）
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(echoResponse(status));
    try {
      await callTextApi(route(protocolType), { prompt: 'x' });
    } catch (error) {
      return error as ServiceError;
    }
    throw new Error('预期抛出 ServiceError，但调用成功了');
  }

  it.each([
    ['401（AUTH_FAILED）', 'openai' as ProtocolType, 401],
    ['403（AUTH_FAILED）', 'anthropic' as ProtocolType, 403],
    ['429（RATE_LIMITED）', 'openai' as ProtocolType, 429],
    ['500（INTERNAL）', 'anthropic' as ProtocolType, 500],
  ])('%s：message 里没有正文哨兵，host 与模型名都在', async (_label, protocolType, status) => {
    const caught = await catchError(protocolType, status);

    expect(caught.message).not.toContain('LEAKED-SENTINEL');
    expect(caught.message).not.toContain('Authorization');
    expect(caught.message).not.toContain('Bearer');
    // 归因能力不降级：中文 + host + 模型名（终审 H2 的「message 只留中文归因 + host + modelId」）
    expect(caught.message).toContain('api.deepseek.com');
    expect(caught.message).toContain('deepseek-chat');
    // 正文照旧进 context（诊断能力只在**去处**上变了，内容一字未减）
    expect(caught.context).toMatchObject({ host: 'api.deepseek.com', status, body: ECHOED.slice(0, 300) });
  });

  it('非 2xx 时正文也会落一条服务端 WARN（移出 message 后不能连日志也没了）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await catchError('openai', 502);

    const logged = warn.mock.calls
      .flat()
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(' ');
    expect(logged).toContain('LEAKED-SENTINEL');
    expect(logged).toContain('api.deepseek.com');
  });

  it('2xx 但正文不可解析 / 没有文本内容时，message 里同样没有正文', async () => {
    // 这两条出口原来是 `${host}）：${raw.slice(0,300)}`——同一个泄漏面的另外两个入口
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => ECHOED,
    } as unknown as Response)));
    let caught: unknown;
    try {
      await callTextApi(route('openai'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as Error).message).not.toContain('LEAKED-SENTINEL');
    expect((caught as Error).message).not.toContain('Authorization');
    expect((caught as Error).message).toContain('api.deepseek.com');
  });
});

/**
 * 多轮对话（2026-09-27）：评分结构检查不合格时把**错误 + 它自己的原文**发回去重问。
 * 这一组钉两件事：
 *   ① 对话按顺序进请求体，两种协议各自的形状都对（system 的位置不同，故两条都要钉）；
 *   ② 单轮路径是它的特例（`callTextApi` 与 `callTextApiConversation` 共用同一个请求体构造点）——
 *      只钉多轮的话，「单轮的 prompt 被丢掉」这种漂移无人发现。
 */
describe('callTextApiConversation —— 多轮对话', () => {
  it('OpenAI：对话按顺序进 messages，system 仍在最前', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: '修好了' } }] }));
    // 多轮入口交出的是 `{ text, usage }`（2026-10-08 起）：这一条只看正文，用量另有专门一组用例
    const { text } = await callTextApiConversation(route('openai'), {
      system: '只输出 JSON',
      messages: [
        { role: 'user', content: '给个分' },
        { role: 'assistant', content: '{"dimensions":[]}' },
        { role: 'user', content: '维度缺失：代码质量（quality）' },
      ],
    });

    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as { messages: unknown[]; stream: boolean };
    expect(body.messages).toEqual([
      { role: 'system', content: '只输出 JSON' },
      { role: 'user', content: '给个分' },
      { role: 'assistant', content: '{"dimensions":[]}' },
      { role: 'user', content: '维度缺失：代码质量（quality）' },
    ]);
    expect(body.stream).toBe(false);
    expect(text).toBe('修好了');
  });

  it('Anthropic：system 走顶层字段，对话进 messages（与单轮同一构造点）', async () => {
    const fetchMock = stubFetch(jsonResponse({ content: [{ type: 'text', text: '修好了' }] }));
    await callTextApiConversation(route('anthropic'), {
      system: '只输出 JSON',
      messages: [
        { role: 'user', content: '给个分' },
        { role: 'assistant', content: '不是 JSON' },
        { role: 'user', content: '不是合法 JSON' },
      ],
    });

    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as { system: unknown; messages: unknown[] };
    expect(body.system).toBe('只输出 JSON');
    expect(body.messages).toEqual([
      { role: 'user', content: '给个分' },
      { role: 'assistant', content: '不是 JSON' },
      { role: 'user', content: '不是合法 JSON' },
    ]);
  });

  it('空对话在本地就被拦下（不把一次必然 400 的请求发出去）', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [] }));
    await expect(callTextApiConversation(route('openai'), { messages: [] })).rejects.toThrow(/一条消息都没有/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * 多轮入口把**这一次调用自己的用量**一起交出来（2026-10-08）：评分详情要回答「这一分是谁花的、
 * 花了多少」，而那份数据只能从响应体里读——读侧没法事后补采（响应体早就扔了）。
 *
 * 四类判据缺一不可：
 *   ① **归一**：本仓的三元组里 `input` 是「非缓存输入」（与 `UsageTokensSchema` 同一条口径），
 *      而 OpenAI 的 `prompt_tokens` 是**总量**（含命中）⇒ 必须减掉 `cached`；Anthropic 的
 *      `input_tokens` 本来就不含缓存读 ⇒ **不许**减（两边各减一次就是把 Anthropic 的数算小）；
 *   ② **两种缓存字段名都要认**：OpenAI 格式在 DeepSeek 上是 `prompt_cache_hit_tokens`，
 *      在官方 OpenAI 上是 `prompt_tokens_details.cached_tokens`——只认一个，另一家就永远报 0 缓存；
 *   ③ **没采到 = `null`，绝不填 0**（`tokens: {0,0,0}` 会被读成「这一分一个 token 都没花」）；
 *   ④ 单轮入口的形状不变（仍是正文一个字符串）：p2 的「生成 / 识别」那条通路不记账。
 */
describe('callTextApiConversation —— 用量随结果一起交出来', () => {
  it('OpenAI：prompt_tokens 减掉命中，cached 取 prompt_tokens_details.cached_tokens', async () => {
    stubFetch(
      jsonResponse({
        choices: [{ message: { content: '答案' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
      }),
    );

    const result = await callTextApiConversation(route('openai'), { messages: [{ role: 'user', content: '打分' }] });

    expect(result.text).toBe('答案');
    expect(result.usage).toEqual({ input: 60, cached: 40, output: 20 });
  });

  it('OpenAI：认 DeepSeek 原文的 prompt_cache_hit_tokens（另一种缓存字段名）', async () => {
    stubFetch(
      jsonResponse({
        choices: [{ message: { content: '答案' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 70 },
      }),
    );

    const result = await callTextApiConversation(route('openai'), { messages: [{ role: 'user', content: '打分' }] });

    expect(result.usage).toEqual({ input: 30, cached: 70, output: 20 });
  });

  it('Anthropic：input_tokens 不减（它本来就不含缓存读）', async () => {
    stubFetch(
      jsonResponse({
        content: [{ type: 'text', text: '答案' }],
        usage: { input_tokens: 12, cache_read_input_tokens: 340, output_tokens: 7 },
      }),
    );

    const result = await callTextApiConversation(route('anthropic'), { messages: [{ role: 'user', content: '打分' }] });

    expect(result.usage).toEqual({ input: 12, cached: 340, output: 7 });
  });

  it('没报缓存读时记 0（那是「这次没命中」，不是「这家不报用量」）', async () => {
    stubFetch(jsonResponse({ choices: [{ message: { content: '答案' } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }));

    const result = await callTextApiConversation(route('openai'), { messages: [{ role: 'user', content: '打分' }] });

    expect(result.usage).toEqual({ input: 9, cached: 0, output: 3 });
  });

  it('响应里没有 usage / 缺必填格 ⇒ usage 为 null（绝不填 0）', async () => {
    stubFetch(jsonResponse({ choices: [{ message: { content: '答案' } }] }));
    const missing = await callTextApiConversation(route('openai'), { messages: [{ role: 'user', content: '打分' }] });
    expect(missing.usage).toBeNull();

    stubFetch(jsonResponse({ choices: [{ message: { content: '答案' } }], usage: { prompt_tokens: 9 } }));
    const partial = await callTextApiConversation(route('openai'), { messages: [{ role: 'user', content: '打分' }] });
    expect(partial.usage).toBeNull();
  });

  it('上游自相矛盾（命中数大于 prompt 总量）⇒ 整格 null，不减出一个负数输入', async () => {
    stubFetch(
      jsonResponse({
        choices: [{ message: { content: '答案' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 40 },
      }),
    );

    const result = await callTextApiConversation(route('openai'), { messages: [{ role: 'user', content: '打分' }] });

    // 这条不是「上游很罕见地报错」：`input` 一旦是负数，界面上会出现 `输入 -30 tok`，
    // 而读数越界时正确的处置与「没采到」一样——交 null，别把脏值画出去
    expect(result.usage).toBeNull();
  });

  it('单轮入口的形状不变（p2 的生成 / 识别仍只拿正文）', async () => {    stubFetch(jsonResponse({ choices: [{ message: { content: '生成结果' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));

    await expect(callTextApi(route('openai'), { prompt: '写个 LRU' })).resolves.toBe('生成结果');
  });
});

/**
 * 思考强度的**唯一落点**（spec §5.2，2026-10-07）：文本通路只有这一张协议表，
 * 而单轮与多轮共用 `buildBody` ⇒ 强度也必须加在那一处，否则「单轮能跑、多轮没强度」这类漂移
 * 只在一条路径上出现。三档 × 两协议：
 *   · **未指定 = 一个强度键都不加**（不是关闭）：把决定权交给网关的缺省。⚠️ 这与智能体侧
 *     `EvalRow.effort` 的「未选」**不等强、不要互相引用**：那边是走该家适配器自己的缺省
 *     （dsh 会落到 `high`），是**我们这一侧**做的决定，而这里是不下发、由网关定
 *     （口径见 `contracts/src/run.ts` 的 `EvalRow.effort` 与 `text-api.ts` 的 `reasoningFields`）；
 *   · `off` = 显式关闭（两协议都是 `thinking: { type: 'disabled' }`）；
 *   · 其它档 = 按协议翻成 `reasoning_effort`（openai）/ `output_config.effort`（anthropic）。
 *
 * 断言一律读**真实请求体**（`callArgs` + `JSON.parse(init.body)`），而不是「我们调了哪个助手」——
 * 强度是 wire 上的字段，请求体就是唯一的事实来源。前六条走单轮入口（`callTextApi` 会把
 * `effort` 透进它构造的那个 `TextConversationInput`），第七条走多轮入口（它把入参原样交给同一个内核）。
 * 下面两个工厂只是 `jsonResponse` 的夹具（沿用文件既有手法），不含任何断言逻辑。
 */
describe('思考强度落进请求体（唯一一份协议表）', () => {
  const okOpenAI = (): Response => jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  const okAnthropic = (): Response => jsonResponse({ content: [{ type: 'text', text: 'ok' }] });

  it('openai：未指定（整格不传）⇒ 既没有 reasoning_effort 也没有 thinking', async () => {
    const fetchMock = stubFetch(okOpenAI());
    await callTextApi(route('openai'), { prompt: 'x' });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('thinking');
  });

  it('anthropic：未指定（整格不传）⇒ 既没有 output_config 也没有 thinking', async () => {
    const fetchMock = stubFetch(okAnthropic());
    await callTextApi(route('anthropic'), { prompt: 'x' });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('thinking');
  });

  it('openai：普通档走 reasoning_effort（不带 thinking）', async () => {
    const fetchMock = stubFetch(okOpenAI());
    await callTextApi(route('openai'), { prompt: 'x', effort: 'max' });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ reasoning_effort: 'max' });
    expect(body).not.toHaveProperty('thinking');
  });

  it('openai：off 走 thinking.disabled（**不是** reasoning_effort: off）', async () => {
    const fetchMock = stubFetch(okOpenAI());
    await callTextApi(route('openai'), { prompt: 'x', effort: EFFORT_OFF });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ thinking: { type: 'disabled' } });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('anthropic：普通档走 output_config.effort（不带 thinking）', async () => {
    const fetchMock = stubFetch(okAnthropic());
    await callTextApi(route('anthropic'), { prompt: 'x', effort: 'max' });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ output_config: { effort: 'max' } });
    expect(body).not.toHaveProperty('thinking');
  });

  it('anthropic：off 走 thinking.disabled（**不是** output_config: off）', async () => {
    const fetchMock = stubFetch(okAnthropic());
    await callTextApi(route('anthropic'), { prompt: 'x', effort: EFFORT_OFF });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ thinking: { type: 'disabled' } });
    expect(body).not.toHaveProperty('output_config');
  });

  it('多轮入口同样带强度（它与单轮共用 buildBody，是同一个落点）', async () => {
    const fetchMock = stubFetch(okAnthropic());
    await callTextApiConversation(route('anthropic'), {
      messages: [{ role: 'user', content: '给个分' }],
      effort: 'high',
    });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ output_config: { effort: 'high' } });
    // 强度是**顶层**参数，不许混进对话消息里
    expect(body.messages).toEqual([{ role: 'user', content: '给个分' }]);
  });
});

/**
 * 瞬时失败重试（2026-09-27）：本机实测真实网关会回 `500 服务维护中，请稍后重试`，
 * 一次抖动就让整行落 failed 是不划算的。这一组钉三件事：
 *   ① **产品默认值**（一次抖动够用的次数与退避）——只钉注入值等于默认值无人验证；
 *   ② 瞬时面（5xx / 429 / 网络）会重试且**复用同一份请求体**（同一段对话，不是重新组装）；
 *   ③ `AUTH_FAILED`（密钥错）与已中止**一次都不重试**。
 */
describe('文本 API 的瞬时失败重试', () => {
  it('产品默认值：3 次尝试、退避 600ms（数值本身就是口径，用例显式钉住）', () => {
    expect(TEXT_API_RETRY.attempts).toBe(PRODUCTION_ATTEMPTS);
    expect(TEXT_API_RETRY.backoffMs).toBe(PRODUCTION_BACKOFF_MS);
  });

  it('500 → 重试后成功，且两次的请求体逐字相同（重试是同一段对话，不是重新组装）', async () => {
    TEXT_API_RETRY.backoffMs = 1; // 真等 600ms 会让每条负例都慢一秒多
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1
        ? jsonResponse({ type: 'error', error: { message: '服务维护中，请稍后重试' } }, 500)
        : jsonResponse({ choices: [{ message: { content: '第二次成功' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(callTextApi(route('openai'), { prompt: 'x' })).resolves.toBe('第二次成功');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(callArgs(fetchMock, 0).init.body)).toBe(String(callArgs(fetchMock, 1).init.body));
  });

  it('一直 500 → 尝试次数用满后抛出最后一次的错误（不无限重试）', async () => {
    TEXT_API_RETRY.backoffMs = 1;
    const fetchMock = stubFetch(jsonResponse({ error: { message: 'boom' } }, 500));
    const error = await callTextApi(route('openai'), { prompt: 'x' }).catch((caught: unknown) => caught);

    expect((error as ServiceError).code).toBe('INTERNAL');
    expect((error as Error).message).toContain('500');
    expect(fetchMock).toHaveBeenCalledTimes(PRODUCTION_ATTEMPTS);
  });

  it('网络层抛错也算瞬时失败：重试一次就成功（p6 冒烟 A3 的同一类抖动）', async () => {
    TEXT_API_RETRY.backoffMs = 1;
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) throw new TypeError('fetch failed');
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }));

    await expect(callTextApi(route('openai'), { prompt: 'x' })).resolves.toBe('ok');
  });

  it('AUTH_FAILED 不重试：密钥错了再试一百次还是错的（只发一次请求）', async () => {
    TEXT_API_RETRY.backoffMs = 1;
    const fetchMock = stubFetch(jsonResponse({ error: { message: 'invalid key' } }, 401));
    const error = await callTextApi(route('openai'), { prompt: 'x' }).catch((caught: unknown) => caught);

    expect((error as ServiceError).code).toBe('AUTH_FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('已中止（用户终止 / 兜底超时）不重试：重试等于把「按了终止」变成又飞三次请求', async () => {
    TEXT_API_RETRY.backoffMs = 1;
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const fail = (): void => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (init.signal?.aborted === true) { fail(); return; }
        init.signal?.addEventListener('abort', fail, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = callTextApi(route('openai'), { prompt: 'x', signal: controller.signal });
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('已中止');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
