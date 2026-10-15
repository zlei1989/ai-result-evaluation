/**
 * pi 的**请求侧观察者**：把 `before_provider_request` 的 payload 抓下来，作为 L3 判据的取证点。
 *
 * 为什么需要它：pi 的技能面与 MCP 工具面都**只体现在出站请求里**——技能段是 pi 在
 * `system-prompt.js` 里拼进系统提示词的（不在 `getSkills()`，那一格是「装载」不是「送出去」），
 * MCP 工具名是连接建立后才进 payload 的 `tools` 的。没有这一层，「模型侧可见」这句话无处落地。
 *
 * 三条设计口径：
 *   · **只捕获、不解释**：本模块不产出产品事件（那条路在 `index.ts` 的投影里），避免在厂商的
 *     扩展回调里调用发射器——那个时刻不在骨架的 try/catch 里，一次抛错就能带走整行；
 *   · **纯函数读法**：抓到的 payload 是 `unknown`，两条判据（技能装载档、工具表）各是一个纯函数，
 *     可以脱开 SDK 逐字断言；
 *   · **按 wire 分两条**：系统段的位置由协议决定——`openai-responses` 把它当一条 `system` /
 *     `developer` 消息放进顶层 `input[]`（`instructionRole`，模型开推理且 compat 允许时是 `developer`），
 *     `anthropic-messages` 放在顶层 `params.system`（文本块数组）。只写一条会让另一条 wire 必然假红。
 */
/**
 * 本行实际用的 wire（= pi 的 provider `api` 字段，取值见 `wireForProtocol`）。
 * 不引 `index.ts` 的类型是为了让本模块保持零依赖：装配面与取证面各自独立演进。
 */
export type PiWire = 'openai-responses' | 'anthropic-messages';

/** pi 扩展的注册面：只声明我们用到的那一格（收窄到用到的形状，别抄厂商的 `.d.ts`） */
export interface PiExtensionApi {
  on: (event: 'before_provider_request', handler: (event: { payload: unknown }) => void) => void;
}

/** 一次运行的请求侧观察者 */
export interface PiRequestObserver {
  /** 扩展工厂：进 `DefaultResourceLoader({ extensionFactories })` */
  factory: (pi: PiExtensionApi) => void;
  /** 已捕获的**请求条数**（`0` = 一次模型往返都没发出去，与「发了但没读到」是两件事） */
  count: () => number;
  /** 最近一份 payload（尚未捕获到任何请求时是 `null`） */
  latest: () => unknown;
}

/**
 * 造一个观察者。**每行一份**：捕获的是这一行那次会话的请求，跨行共享等于让两行并发的 payload
 * 互相覆盖（与 `PiRunState` 同一条处置）。
 *
 * 特意不在回调里做任何判断：厂商什么时候发这个事件、发几次（每轮一次）都不由我们决定，
 * 回调里多写一行就多一处能把厂商的异常放大成我们异常的地方。
 */
export function createPiObserver(): PiRequestObserver {
  let count = 0;
  let latest: unknown = null;
  return {
    factory: (pi) => {
      pi.on('before_provider_request', (event) => {
        count += 1;
        latest = event.payload;
      });
    },
    count: () => count,
    latest: () => latest,
  };
}

/**
 * 系统段文本（两条 wire 各一处），取不到时给空串。
 *
 * 为什么要拼成一段文本而不是交结构化消息：两条 wire 的形状差得远（一条是消息列表里的角色、
 * 一条是顶层文本块数组），而下游判据只做**逐名匹配**——把差异收在这一处，判据那边就只有一份输入。
 */
export function piSystemText(payload: unknown, wire: PiWire): string {
  const record = asRecord(payload);
  if (record === null) return '';
  if (wire === 'anthropic-messages') return textOf(record['system']);
  /**
   * OpenAI Responses 那条：系统段是顶层 `input[]` 里 **`system` / `developer`** 两条角色之一。
   * `developer` 不是别的什么东西——pi 在「模型开推理 + compat 允许」时就是把同一段文本挂在这个角色上
   * （`instructionRole`），漏掉它等于在自建网关上偶然读不到技能段。
   */
  const messages = record['input'];
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((message) => {
      const role = asRecord(message)?.['role'];
      return role === 'system' || role === 'developer';
    })
    .map((message) => textOf(asRecord(message)?.['content']))
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * 请求里声明的**工具名**（两条 wire 的名字位置不同：Responses 与 Messages 都是在 `tools[]` 的顶层
 * `name`；Chat Completions 那层 `function.name` 的嵌套也一并认，读取侧不依赖 wire）。
 */
export function piRequestToolNames(payload: unknown): string[] {
  const tools = asRecord(payload)?.['tools'];
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    const record = asRecord(tool);
    if (record === null) continue;
    const nested = asRecord(record['function'])?.['name'];
    const name = typeof nested === 'string' ? nested : record['name'];
    if (typeof name === 'string' && name !== '') names.push(name);
  }
  return names;
}

/** 请求里的一条技能：`<name>` 与 `<location>` 的逐字读数 */
export interface PiRequestSkill {
  name: string;
  /** `SKILL.md` 的绝对路径（厂商逐字给的那一份，未转义） */
  location: string;
}

/**
 * 请求里一件工具的**受约束采样事实**（`tools[]` 的一棵子树）。
 *
 * 三格缺一不可，因为它们合起来才回答「原生结构化输出通道是不是真的成立了」：
 *   · `name`：**是不是我们那一件**（同名工具可能来自 MCP 或扩展）；
 *   · `strict`：厂商侧的强制开关（`true` 才是「形状由厂商保证」；缺席 = 一件普通工具声明）；
 *   · `parameters`：**逐字出站的那份 schema**——它是「上报走了原生通道 ⇒ 请求里真有那份 schema」
 *     这条互钉判据的请求侧事实，也是「有没有被预先归一化」的判据（归一化过的产物在结构上就不同）。
 */
export interface PiRequestToolDeclaration {
  name: string;
  /** `strict` 字段的原文；缺席给 `null`（与显式 `false` 分得开） */
  strict: boolean | null;
  /** 工具参数的 schema 原文（openai 的 `parameters` / anthropic 的 `input_schema`）；读不到给 `null` */
  parameters: unknown;
}

/**
 * 请求里**指定名字**那一件工具的声明。两条 wire 的名字与参数位置都不同，一次遍历同时认两处
 * （与 `piRequestToolNames` 同一条理由：工具表的读法不随 wire 分叉，多写一份只会多一处漂移）。
 *
 * 与 `piRequestToolNames` 的分工：那一格只回答「有哪些名字」（注入面的判据），
 * 这一格回答「那一件长什么样」——`strict` 与 `parameters` 只在后者里。
 */
export function piRequestToolDeclaration(payload: unknown, name: string): PiRequestToolDeclaration | null {
  const tools = asRecord(payload)?.['tools'];
  if (!Array.isArray(tools)) return null;
  for (const tool of tools) {
    const record = asRecord(tool);
    if (record === null) continue;
    // Responses / Messages 都是平铺 `{type:'function', name, strict, parameters}`；
    // Chat Completions 的 `{type:'function', function:{…}}` 也一并认，读取侧不依赖 wire。
    const fn = asRecord(record['function']);
    const toolName = typeof fn?.['name'] === 'string' ? fn['name'] : record['name'];
    if (toolName !== name) continue;
    const owner = fn ?? record;
    const strict = owner['strict'];
    return {
      name,
      strict: typeof strict === 'boolean' ? strict : null,
      parameters: owner['parameters'] ?? owner['input_schema'] ?? null,
    };
  }
  return null;
}

/**
 * **技能装载档判据**：这一轮请求的系统段里**逐条**列出了哪些技能。
 *
 * 三条判法上的硬要求（每条都对应一类假绿）：
 *   · **按 wire 取系统段**（见 `piSystemText`）——只读一处会让另一条 wire 恒空；
 *   · **匹配 `<name>` 而不是 description**：厂商对 description 做 XML 转义（`&<>"'`），
 *     拿原文去 `includes()` 会在这些字符上静默漏判；
 *   · **逐条解析而不是「段在不在」**：段在、里面没有那一条（被同名裁决顶掉、被
 *     `disable-model-invocation` 藏起来）与「装上了」在这一层必须分得开。
 */
export function piRequestSkills(payload: unknown, wire: PiWire): PiRequestSkill[] {
  const system = piSystemText(payload, wire);
  if (system === '') return [];
  const skills: PiRequestSkill[] = [];
  for (const block of system.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
    const body = block[1] ?? '';
    const name = tagText(body, 'name');
    const location = tagText(body, 'location');
    // 两格缺一不可：只有名字回答不了「这一条属于哪一行」，只有落点回答不了「厂商认的是哪个名」
    if (name !== null && location !== null) skills.push({ name, location });
  }
  return skills;
}

/**
 * **技能行为档判据**：模型真的读过这条技能的正文。
 *
 * 与装载档的分工：装载档证明「厂商把它写进了这一轮的提示词」，行为档证明「模型据此去读了它」。
 * 行为档**只作冒烟与抽查**：模型这一轮没想用这条技能是正常的，不构成任何失败。
 *
 * 判据两格缺一不可（照真机读数）：`read` 的实参 `path` 与 `<location>` **逐字相等**，
 * 且这次 `tool_result` 的正文**含** `SKILL.md` 的原文（工具结果可能被截断，故用包含而不是相等）。
 *
 * ⚠️ **今天没有产品调用点**：它只被 `observer.test.ts` 用着（知识库《四家横向对比》里
 * 「认它真去读 `SKILL.md`」那一格说的是**判据长什么样**，不是「运行期会算出这一格」）。
 * 要接上得先定口径——在哪一步算、算出来落在哪一格产物、拿它做什么（现在的答案都是「没有」），
 * 那是新功能不是修缺陷。在那之前**别把它当成已经在跑的判据**：产物里没有任何一格回答
 * 「模型是否读了这条技能的正文」。
 */
export function piSkillReadSatisfied(
  calls: readonly PiSkillReadCall[],
  skill: { location: string; body: string },
): boolean {
  const body = normalizeNewlines(skill.body).trim();
  if (body === '') return false;
  return calls.some(
    (call) =>
      call.toolName === 'read'
      && call.isError !== true
      && readPathOf(call.args) === skill.location
      && typeof call.resultText === 'string'
      && normalizeNewlines(call.resultText).includes(body),
  );
}

/**
 * 一次工具调用在行为档判据里用得到的三格事实。
 * 形状刻意与厂商事件解耦（`index.ts` 那一侧从 `tool_execution_*` 的负载里取），
 * 于是这条判据可以脱开 SDK 逐条断言。
 */
export interface PiSkillReadCall {
  toolName: string | null;
  /** 工具入参（`read` 的 `path` 在这里） */
  args: unknown;
  /** `tool_result` 的正文；读不到给 `null` */
  resultText: string | null;
  isError: boolean;
}

/**
 * `read` 的路径实参。只认 `path`：那是 pi 内置 `read` 工具的参数名（`readSchema`），
 * 顺手认 `file_path` 会把别的家的方言悄悄放进来，而这一格是「逐字相等」的判据——
 * 认错一个键就等于把「模型读了别的文件」读成「读了这条技能」。
 */
function readPathOf(args: unknown): string | null {
  const path = asRecord(args)?.['path'];
  return typeof path === 'string' ? path : null;
}

/**
 * 取一个 XML 标签里的文本（`<location>…</location>`）。
 * 读到的值**反转义**：厂商对技能名与落点做了 XML 转义（`&` / `<` / `"` …），
 * 而这两格在下游是「与实际路径逐字相等」的判据——带着 `&amp;` 的路径永远匹配不上本行的目录。
 */
function tagText(body: string, tag: string): string | null {
  const matched = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return matched === null ? null : unescapeXml(matched[1] ?? '');
}

/**
 * 厂商 `escapeXml` 的五种实体（`&` 必须最后还原，否则 `&amp;lt;` 会被还原两次）。
 *
 * ⚠️ 单引号那一格厂商写的是 `&apos;`（`skills.js` 的 `escapeXml`：`'` → `&apos;`），
 * 不是 HTML 里同样合法的 `&#39;`——只认后者会让**含单引号的落点**（macOS 用户名 `o'brien` 那一类）
 * 反转义不出来，而这正是 `piSkillReadSatisfied` 的「与实际路径逐字相等」判据 ⇒ 该技能恒判「没读过」。
 * 两种形态都还原，免得将来厂商换写法再踩一次。
 */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&');
}

/** 一段系统段内容的两种形态：纯字符串，或文本块数组（anthropic 的 `system` 就是后者） */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const text = asRecord(block)?.['text'];
      return typeof text === 'string' ? text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/** 厂商载荷里的对象（数组与非对象一律当「没有这一格」） */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 只归一换行：判据是「正文送到了」，不是「逐字节相等」（CRLF 与厂商的裁剪都不该让判定翻面） */
function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}
