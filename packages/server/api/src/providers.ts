/**
 * 供应商服务：CRUD + 模型清单手工维护 + 全部模型候选（评分配置用）。
 * 自动拉取（/models）在下一个任务里追加到本文件末尾——两者共用同一份清单与同一套落盘口径。
 *
 * 三条不可动摇的口径：
 *   1. **明文密钥只进不出**：落盘的 `Provider.apiKey` 是明文（服务端必须拿原 token 才能代调上游），
 *      但任何对外返回值一律是 `ProviderView` —— 只有 `apiKeyMasked`，没有 `apiKey` 字段；
 *   2. **模型清单的来源只有两个**：手工增删（`source: 'manual'`）与拉取（`source: 'fetched'`），
 *      拉取的合并规则见 `fetchProviderModels`（不冲掉手工条目）；
 *   3. **删除供应商不级联改写 `settings.defaultJudge` 与用例的评分模型**：那会把「删一个供应商」
 *      变成一次跨域事务；悬空引用由设置页显式提示、由评分路由解析时报错兜底。
 *
 * 密钥的安全取舍（spec §6.1 末段，必须留在代码里）：服务端需要原 token 才能代调供应商 API，
 * 无法只存哈希；缓解措施是配置文件写盘时 `chmod 0600`（属主独占，见 core 的 `saveConfig`）
 * 加上对外出口一律掩码。Windows 无 POSIX 权限位，`chmod` 仅能近似切换只读位，
 * 属主独占实际由 NTFS ACL 与用户目录隔离承担 —— 尽力而为、失败不报错、不阻断保存。
 */
import { randomUUID } from 'node:crypto';
import {
  ServiceError,
  maskApiKey,
  type Provider,
  type ProviderCreate,
  type ProviderModel,
  type ProviderModelContextInput,
  type ProviderPatch,
  type ProviderView,
  type ProtocolType,
} from '@aieval/contracts';
import { createLogger, getConfigDir, loadConfig, saveConfig, type AppConfig } from '@aieval/core';

const log = createLogger('api/providers');

/** 落盘 → 下行：剥掉明文密钥、只留掩码。**唯一**的下行出口，所有函数都必须经它返回 */
function toView(provider: Provider): ProviderView {
  const { apiKey, ...rest } = provider;
  return { ...rest, apiKeyMasked: maskApiKey(apiKey) };
}

/** 取错误的人类可读原因（error 不一定是 Error） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 保存整份配置。saveConfig 会抛原始 errno（EPERM / ENOSPC / 只读盘），而契约要求对外错误
 * 一律是可直接展示的中文原因 —— 这里折成 INTERNAL 并带上配置目录，
 * 否则路由层会把英文 errno 原文回给用户（排查方向也被带偏）。
 */
function persist(config: AppConfig): void {
  try {
    saveConfig(config);
  } catch (error) {
    throw error instanceof ServiceError
      ? error
      : new ServiceError('INTERNAL', `供应商配置保存失败（${getConfigDir()}）：${reason(error)}`, { cause: error });
  }
}

/** 按 id 取供应商（含明文密钥，仅服务端内部使用）；不存在抛 NOT_FOUND */
function requireProvider(config: AppConfig, providerId: string): Provider {
  const provider = config.providers.find((item) => item.id === providerId);
  if (provider === undefined) {
    throw new ServiceError('NOT_FOUND', `供应商不存在：${providerId}`);
  }
  return provider;
}

/** 写回单条供应商并落盘 */
function replaceProvider(config: AppConfig, next: Provider): void {
  config.providers = config.providers.map((item) => (item.id === next.id ? next : item));
  persist(config);
}

/**
 * 归一化一批模型 id：去首尾空白、去重（按首次出现顺序），来源一律 `manual`。
 * 为什么来源不能由调用方给：`fetched` 的唯一合法来源是一次真实的拉取调用 ——
 * 允许在这里声明 fetched，用户手工填的模型就会在下一次拉取里被按「上游已下架」清掉。
 */
function manualModels(ids: readonly string[]): Provider['models'] {
  const seen = new Set<string>();
  const models: Provider['models'] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, source: 'manual' });
  }
  return models;
}

export function listProviders(): ProviderView[] {
  return loadConfig().providers.map(toView);
}

export function createProvider(input: ProviderCreate): ProviderView {
  const config = loadConfig();
  const now = new Date().toISOString();
  // 密钥在入口归一：去掉首尾空白，只剩空白则**拒绝**。
  // 为什么纯空白要拒、而不是「trim 成空串照存」：落盘形态必须满足 ProviderSchema 的 `apiKey: min(1)`
  //（config-store 的往返用例盯的正是这条），存空串会写进一条非法记录，掩码也跟着变成空串 ——
  // 界面上看起来「还没配密钥」，实际却多了一条永远 401 的供应商。
  // 为什么必须在服务端拒、不能只靠弹窗的 whitespace 规则：老页面缓存 / 直接打接口都绕得过弹窗
  //（与「Anthropic 协议拒绝拉取」同一条理由）。带首尾空白的密钥一律存 trim 后的形态：
  // 空白进不了 HTTP 头，存原串只会让代调 401，而掩码看起来「明明是配好的」。
  const apiKey = input.apiKey.trim();
  if (apiKey === '') {
    throw new ServiceError('INVALID_QUERY', 'API 密钥不能为空或只有空白字符');
  }
  const provider: Provider = {
    id: randomUUID(),
    name: input.name,
    protocolType: input.protocolType,
    baseUrl: input.baseUrl,
    apiKey,
    models: manualModels(input.models.map((model) => model.id)),
    createdAt: now,
    updatedAt: now,
  };
  config.providers = [...config.providers, provider];
  persist(config);
  log.info('供应商已创建', {
    providerId: provider.id,
    protocolType: provider.protocolType,
    models: provider.models.length,
  });
  return toView(provider);
}

export function updateProvider(providerId: string, patch: ProviderPatch): ProviderView {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);
  const next: Provider = {
    id: provider.id,
    createdAt: provider.createdAt,
    updatedAt: new Date().toISOString(),
    // 逐字段 `??` 合并，**不能写成 `{ ...provider, ...patch }`**：ProviderPatch 的每个字段都是
    // `T | undefined`（ProviderCreateSchema.partial()），显式传 undefined 的补丁会在展开时
    // 把存量字段覆盖成 undefined 后落盘 —— 坏值不在这次响应里，而在下一次读取。
    name: patch.name ?? provider.name,
    protocolType: patch.protocolType ?? provider.protocolType,
    baseUrl: patch.baseUrl ?? provider.baseUrl,
    // 密钥只在补丁给了**非空白**值时替换：编辑弹窗里「留空表示不修改」，把空串写进去等于
    // 把用户已配好的密钥抹掉 —— 此后所有代调都是 401，而界面上只剩一个空掩码。
    // 纯空白（`'   '`）与空串**同一处置**：它同样不是一次真实的密钥替换，但落盘后掩码会变成
    // 一小段星号、看起来「已配置」，比空掩码更难发现（弹窗的 required 只判空串，`'   '` 过得去）。
    // 非空白值一律存 trim 后的形态，与 createProvider 同一口径。
    apiKey: patch.apiKey !== undefined && patch.apiKey.trim() !== '' ? patch.apiKey.trim() : provider.apiKey,
    // 模型清单的整份替换在这里是允许的（契约里 models 是补丁字段），但设置页不发这个字段 ——
    // 清单的日常增删走 addProviderModel / removeProviderModel，那里才带「保留手工条目」的语义。
    // 注意**补丁也是必须归一的入口**：schema 允许客户端在补丁里声明 `source: 'fetched'`，
    // 照抄就会把 fetched 写进清单，下一次拉取按「上游已下架」静默清掉它 —— 与 createProvider 同一口径。
    models: patch.models === undefined ? provider.models : manualModels(patch.models.map((model) => model.id)),
  };
  replaceProvider(config, next);
  // 只记「密钥是否变过」，绝不把密钥本身写进日志
  log.info('供应商已更新', { providerId, apiKeyChanged: next.apiKey !== provider.apiKey });
  return toView(next);
}

export function deleteProvider(providerId: string): void {
  const config = loadConfig();
  // 不存在就抛 NOT_FOUND：静默成功会掩盖前端把 id 传错这类问题
  requireProvider(config, providerId);
  config.providers = config.providers.filter((item) => item.id !== providerId);
  persist(config);
  log.info('供应商已删除', { providerId });
}

export function addProviderModel(providerId: string, modelId: string): ProviderView {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);
  const [normalized] = manualModels([modelId]);
  if (normalized === undefined) {
    throw new ServiceError('INVALID_QUERY', '模型名不能为空');
  }
  // 同 id 已存在时原样返回（幂等）：不改它的 source、不产生重复条目。
  // 把已存在的条目改写成 manual 看似无害，实际会把「上次拉取到的条目」变成永久的手工条目 ——
  // 之后上游下架该模型，清单里也再清不掉它。
  if (provider.models.some((model) => model.id === normalized.id)) {
    return toView(provider);
  }
  const next: Provider = {
    ...provider,
    models: [...provider.models, normalized],
    updatedAt: new Date().toISOString(),
  };
  replaceProvider(config, next);
  log.info('模型已手工添加', { providerId, modelId: normalized.id });
  return toView(next);
}

export function removeProviderModel(providerId: string, modelId: string): ProviderView {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);
  // 与 addProviderModel 同一口径：先 trim 再比对。添加路径已把 '  m2  ' 存成 'm2'，
  // 删除路径不 trim 就会出现自相矛盾的状态：清单里明明有 m2，按它发起删除却报 NOT_FOUND。
  const target = modelId.trim();
  const models = provider.models.filter((model) => model.id !== target);
  if (models.length === provider.models.length) {
    throw new ServiceError('NOT_FOUND', `该供应商下没有模型：${modelId}`);
  }
  const next: Provider = { ...provider, models, updatedAt: new Date().toISOString() };
  replaceProvider(config, next);
  log.info('模型已移除', { providerId, modelId });
  return toView(next);
}

/**
 * 设置某条模型的窗口 / 输出上限（设置页的行内编辑器）。三条口径：
 *   ① 按 `{ id, source }` **重建**该条目，只写回 `contextWindow` / `maxOutputTokens` /
 *      `contextWindowSource` 三格——**该条目已声明的 `supportedEfforts` / `recommendedEffort` 会被一并清掉**
 *      （重建的代价：保存一次窗口就退回该家完整档位域；想要保留就得在这里显式带过来，
 *      而那是「窗口编辑该不该动档位声明」的口径变更，别顺手加）；
 *   ② 一律把 `contextWindowSource` 置成 `'manual'` —— **清空也算**（spec D3）；
 *   ③ 清单里没有这条 ⇒ NOT_FOUND（与 removeProviderModel 同口径，不静默新建条目）。
 */
export function setProviderModelContext(providerId: string, input: ProviderModelContextInput): ProviderView {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);
  const target = input.id.trim();
  if (!provider.models.some((model) => model.id === target)) {
    throw new ServiceError('NOT_FOUND', `供应商「${provider.name}」的模型清单里没有 ${input.id}`);
  }

  const models = provider.models.map((model): ProviderModel => {
    if (model.id !== target) return model;
    const next: ProviderModel = { id: model.id, source: model.source };
    if (input.contextWindow !== null) next.contextWindow = input.contextWindow;
    if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null) {
      next.maxOutputTokens = input.maxOutputTokens;
    }
    next.contextWindowSource = 'manual';
    return next;
  });
  const next: Provider = { ...provider, models, updatedAt: new Date().toISOString() };
  replaceProvider(config, next);
  log.info('模型窗口已手工设置', { providerId, modelId: target, contextWindow: input.contextWindow });
  return toView(next);
}

/**
 * 全部可选的评分模型（**两种协议都要**，spec §4.2 / §6.2）：评分模型只被**文本调用**
 *（智能体评分通路复用的也是这一对，协议匹配由「默认评分智能体」那一格反向约束），
 * 因此 anthropic 协议的模型与 openai 协议的一样可选 —— 这里刻意不做协议过滤。
 * 消费方是服务端（用例表单的候选池、评测行的校验）；设置页的 Select 直接由 `ProviderView[]`
 * 在前端派生，不为本函数开 HTTP 路由（见「本计划对 spec / 契约的实现层修正」第 5 条）。
 */
export function listAllModelOptions(): {
  providerId: string;
  providerName: string;
  protocolType: ProtocolType;
  modelId: string;
  source: 'fetched' | 'manual';
}[] {
  return loadConfig().providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      providerName: provider.name,
      protocolType: provider.protocolType,
      modelId: model.id,
      source: model.source,
    })),
  );
}

/** 上游 /models 响应的最小形状：只声明我们真正读的字段（字段名并不统一，见 extractModels） */
interface ModelsPayload {
  data?: unknown;
}

/** 一个模型条目：id 必有；窗口 / 输出上限 / 档位取不到就是 undefined（未知，不是 0） */
interface ExtractedModel {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportedEfforts?: string[];
  recommendedEffort?: string;
}

/** 取 host 用于错误文案：baseUrl 可能根本不是合法 URL（用户填错），取不到就回落整串 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 取 path 用于错误文案（同一个理由：非法 URL 取不到 path 就回落整串）。
 * 404 是唯一会「试了不止一条地址」的分支，文案必须让用户看出到底打了哪几条路径 ——
 * 只写 host 的话，`/models` 与 `/v1/models` 在界面上长得一模一样。
 */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * 窗口 / 输出上限的字段优先级（spec D2）：按顺序取第一个能解析成正整数的。
 * 点号表示嵌套路径 —— 这两组字段实测**同时**出现在 likecode 的一个响应里
 * （`max_input_tokens` / `contextWindow` / `context_window` / `context_length` / `limit.context` /
 * `capabilities.contextWindow`），只认一个就会在别的网关上瞎；而深遍历整个 JSON 会把
 * `top_provider.context_length` 这类「上下文相关」的字段混进来，且无法解释「为什么取了这个数」。
 */
const CONTEXT_WINDOW_KEYS = [
  'max_input_tokens',
  'contextWindow',
  'context_window',
  'context_length',
  'limit.context',
  'capabilities.contextWindow',
] as const;

/** 单次输出上限的同一条口径（字段名同样不统一） */
const OUTPUT_TOKENS_KEYS = [
  'max_tokens',
  'max_output_tokens',
  'maxTokens',
  'maxOutputTokens',
  'limit.output',
] as const;

/** 按点号路径取值；中途不是对象就返回 undefined（不抛） */
function readPath(entry: unknown, path: string): unknown {
  let cursor: unknown = entry;
  for (const key of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * 正整数才认（'5000000' 这种数字字符串也认——有网关就是这么给的）。
 * 其余一律 undefined：`0` 与「没采到」含义相反（见 §5.6.3 的同一口径），小数与负数更不是窗口。
 */
function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 按优先级取第一个能解析成正整数的字段 */
function firstPositive(entry: unknown, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = positiveInteger(readPath(entry, key));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * 档位表 / 推荐档的字段优先级（spec §5.1.1）：与窗口同一条「按顺序取第一个像档位表的」。
 * 第三种形态是 `capabilities.effort` 的**逐档对象**（实测 likecode 就是这种）：
 * `{ supported: true, low: { supported: true }, high: { supported: true, recommend: true }, … }`。
 */
const EFFORT_LIST_KEYS = ['supportedEffortLevels', 'reasoning.supported_efforts'] as const;
const RECOMMENDED_EFFORT_KEYS = ['recommendEffortLevel', 'reasoning.default_effort'] as const;

/** 非空字符串、按首次出现去重（上游偶尔给重复项） */
function cleanEfforts(value: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    seen.add(item);
  }
  return [...seen];
}

/** 上游**显式**声明的推荐档（按优先级取；空串与非字符串一律当「没声明」） */
function declaredRecommendation(entry: unknown): string | undefined {
  for (const key of RECOMMENDED_EFFORT_KEYS) {
    const value = readPath(entry, key);
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * 档位表：数组形态优先（`supportedEffortLevels` → `reasoning.supported_efforts`），
 * 都没有才看 `capabilities.effort` 的逐档对象；空数组 = 上游没说。
 *
 * ⚠️ **自相矛盾的响应整格不采信**（spec §5.4）：声明了一个推荐档、而它不在档位表里时，
 * 返回空档位表（= 未知）而不是「留着档位表、丢掉推荐」。理由：这说明上游的这份元数据本身不可信，
 * 而档位表是我们唯一会拿去和智能体求交的东西 —— 基于一份自相矛盾的数据选出来的档，
 * 到了运行时就是 dsh 的 `UNSUPPORTED_REASONING_EFFORT`（用户看到的是「选完才炸」）。
 */
function effortLevelsOf(entry: unknown): { efforts: string[]; recommended?: string } {
  const declared = declaredRecommendation(entry);

  for (const key of EFFORT_LIST_KEYS) {
    const value = readPath(entry, key);
    if (!Array.isArray(value)) continue;
    const efforts = cleanEfforts(value);
    if (efforts.length === 0) return { efforts: [] };
    if (declared !== undefined && !efforts.includes(declared)) return { efforts: [] };
    return { efforts, recommended: declared };
  }

  const table = readPath(entry, 'capabilities.effort');
  if (typeof table === 'object' && table !== null) {
    const efforts: string[] = [];
    let flagged: string | undefined;
    for (const [level, detail] of Object.entries(table as Record<string, unknown>)) {
      if (typeof detail !== 'object' || detail === null) continue;
      if ((detail as { supported?: unknown }).supported !== true) continue;
      efforts.push(level);
      if ((detail as { recommend?: unknown }).recommend === true) flagged ??= level;
    }
    if (efforts.length === 0) return { efforts: [] };
    if (declared !== undefined && !efforts.includes(declared)) return { efforts: [] };
    // 推荐优先取显式字段（它必须落在档位表里）；没有才用逐档对象上的 `recommend` 标记
    return { efforts, recommended: declared ?? flagged };
  }

  return { efforts: [] };
}

/**
 * 从 /models 响应里抽出模型条目。
 * 三条口径：
 *   ① 容忍两种形态（spec §6.1 第 1 点）：既有 `{ data: [{ id: 'a' }] }`，也有 `{ data: ['a', 'b'] }`；
 *   ② 判空用 trim，**入库的也是 trim 后的串**：清单的另外三个入口（新建/补丁的 manualModels、
 *      手工添加、按名删除）都按 trim 后的形态比对，这里若存原串，上游的 `' m1 '` 会与手工的 `'m1'`
 *      并存成两条，而按 `' m1 '` 删除时比对的是 `'m1'` —— 删掉的是**手工那条**，清单里剩下一条
 *      用户从没手工加过、又删不掉的带空白条目（下次拉取还会把它原样带回来）；
 *   ③ 窗口 / 档位取不到就是 undefined —— 绝不兜底成 0、空数组或某个「常见值」（spec D8）。
 */
function extractModels(payload: unknown): ExtractedModel[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as ModelsPayload).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry): ExtractedModel[] => {
    if (typeof entry === 'string') return entry.trim() === '' ? [] : [{ id: entry.trim() }];
    if (typeof entry === 'object' && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== 'string' || id.trim() === '') return [];
      const contextWindow = firstPositive(entry, CONTEXT_WINDOW_KEYS);
      const maxOutputTokens = firstPositive(entry, OUTPUT_TOKENS_KEYS);
      const { efforts, recommended } = effortLevelsOf(entry);
      return [
        {
          id: id.trim(),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
          ...(efforts.length === 0 ? {} : { supportedEfforts: efforts }),
          ...(recommended === undefined ? {} : { recommendedEffort: recommended }),
        },
      ];
    }
    // 既不是字符串、也没有可用的 id（null / 数字 / {}）：跳过。
    // 关键是**不能**兜底成 String(entry)，那会把 'null' / '[object Object]' 当成模型名存进去。
    return [];
  });
}

/** 读上游 JSON：解析失败要给含 host 的中文原因（网关返回登录页 HTML 是常见情形），而不是抛 SyntaxError */
async function readJson(res: Response, url: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (error) {
    throw new ServiceError(
      'INTERNAL',
      `拉取模型失败：${hostOf(url)} 返回的不是合法 JSON（可能被网关或登录页拦截）`,
      { cause: error },
    );
  }
}

/**
 * 上游非 2xx → 契约错误码：401/403 → AUTH_FAILED（context 带 host），
 * 429 → RATE_LIMITED（§10 要求限流提示改用串行），其余 INTERNAL 并带上状态码与 host。
 *
 * 上游正文只留在 `context` 与服务端日志里，**绝不进 message**：message 会被页面
 * `message.error(error.message)` 原样渲染给用户，而网关的正文既可能是一整页登录 HTML，
 * 也可能回显了我们的请求头（`Authorization: Bearer <明文密钥>`）—— 那等于把密钥画在界面上。
 * 诊断能力不降级：正文片段（内容与旧实现逐字相同，仍是前 200 字）同时进 context 与一条 WARN 日志；
 * 路由层那条 error 日志只打 message，片段移出 message 后就只剩状态码，故这里自己落一条。
 * 注意 WARN 里同样只有片段本身，不带请求头（服务端从不把密钥写进日志）。
 *
 * **本口径是两条上游调用路径的共用契约**（终审 H2 点名它们曾经相反）：`@aieval/evaluator` 的
 * `callTextApi` 走同一套规则——上游正文同样只进 context 与服务端日志，message 只留中文归因 +
 * host + `modelId`。两侧各有一条「假正文不得出现在 message 里」的守卫钉住这条口径。
 *
 * `attempted` 只用来补 404 的路径说明（见 `pathOf`）：试了不止一条候选地址时，message 要能看出
 * 哪几条都不存在。别的状态码不带它——401 只可能是密钥问题，列一串路径只会把真因说糊。
 */
async function upstreamError(res: Response, url: string, attempted: readonly string[] = [url]): Promise<ServiceError> {
  const host = hostOf(url);
  if (res.status === 401 || res.status === 403) {
    return new ServiceError('AUTH_FAILED', `${host} 拒绝了该密钥（HTTP ${res.status}），请到设置里检查 API 密钥`, {
      context: { host },
    });
  }
  if (res.status === 429) {
    return new ServiceError('RATE_LIMITED', `${host} 触发限流（HTTP 429），请稍后重试`, { context: { host } });
  }
  // 上游正文可能是一整页 HTML：只留前 200 字，且只往 context / 日志走（见上方 JSDoc）
  const detail = await res.text().catch(() => '');
  const body = detail.slice(0, 200);
  log.warn('上游返回非 2xx', { host, status: res.status, body });
  // 路径是**我们自己拼的**，不含密钥，可以进 message；上游正文仍然只进 context
  const suffix =
    res.status === 404 && attempted.length > 1
      ? `（${attempted.map(pathOf).join(' 与 ')} 都不存在，请检查 API 地址）`
      : '';
  return new ServiceError('INTERNAL', `拉取模型失败：${host} 返回 HTTP ${res.status}${suffix}`, {
    context: { host, status: res.status, body },
  });
}

/**
 * 上游 /models 的等待上限（含正文读取）。
 * 没有上限的 fetch 在「只挂不断」的网关上会永远不返回 —— 界面既不报错也不结束，
 * 用户只能刷新页面重来，而内网网关与登录页跳转最常见的失败形态正是挂住。
 *
 * 为什么用自建的 AbortController + setTimeout，而不是 `AbortSignal.timeout(15_000)`：
 * 后者的计时器不在全局 `setTimeout` 上（本机 Node v24 + vitest 4 实测：`vi.useFakeTimers()`
 * 把假时钟推进 15 秒后它仍未 abort，见 fix wave 报告的探针输出），于是「15 秒」这个真实的配置值
 * 在测试里无法验证，只能退化成一个「signal 存在吗」的结构断言；自建计时器还给出一个与运行时
 * 无关的超时判据 —— 各家实现的 abort 拒绝物分别是 TimeoutError / AbortError 与自定义 reason，
 * 按 name 猜会漏，而「我们自己掐的那一次」必然让 `controller.signal.aborted` 为真。
 */
const MODELS_TIMEOUT_MS = 15_000;

/**
 * 把用户填的地址拆成「配置地址」与「站点根」两段（根回退要按 origin 重建候选）。
 *
 * 为什么不在 `modelListCandidates` 里直接切字符串：`URL` 顺手做掉三件事 —— 主机名小写化、
 * 去掉结尾斜杠、丢掉 `?query` 这类不该跟路径拼在一起的东西；而「`origin` 相等判定」也只有在
 * 解析过之后才可靠（`https://HOST` 与 `https://host` 是同一个根，字符串比会判成两处，
 * 于是多打两次注定 404 的请求）。
 *
 * 取不到根的情形照旧只有配置地址一条链路：地址不是合法 URL（用户填成一句话），
 * 或 scheme 不是特殊 scheme（`ssh://` 之类，`origin` 是字符串 `'null'`）。
 */
function baseAndRoot(baseUrl: string): { base: string; root: string } {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin === 'null') return { base: trimmed, root: trimmed };
    return { base: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`, root: parsed.origin };
  } catch {
    return { base: trimmed, root: trimmed };
  }
}

/**
 * 模型清单的候选地址，按尝试顺序（spec §6.1，2026-09-26 修订 + 2026-09-30 补根回退）。
 *
 * 为什么不止一条：用户在设置页填的「API 地址」有四种都合理的形态 ——
 *   - `https://api.deepseek.com/v1`（OpenAI 文档口径：版本段写在地址里）；
 *   - `https://gw.example.com`（Anthropic 口径：版本段由客户端补，见 `text-api` 的 `endpoint()`）；
 *   - `https://api.deepseek.com/anthropic`（Anthropic **Messages 根**，README 就是这么教的）；
 *   - `https://gw.example.com/api/v1`（网关自己的前缀 + 版本段）。
 * 后两种在「只按配置地址拼」的口径下会打成 `/anthropic/models`、`/api/v1/models`，
 * 而清单接口往往仍挂在**站点根**上 —— 于是地址没错、密钥没错，却拿回一个 404。
 *
 * 顺序是「先配置地址的两条，再站点根的两条」：配置地址是用户照着文档填的那个，命中时最省一次往返；
 * 根只是兜底，绝不在前面抢跑。
 *
 * 两条构造规则：
 *   - 已带版本段的地址不再补一次 `/v1`：那只会打出 `/v1/v1/models`；
 *   - 根与配置地址相同时（地址本来就填到站点根）不重复出候选 —— 那也是今天最常见的一种填法，
 *     候选必须仍然是 `/models` 与 `/v1/models` 两条，不能凭空多出两条同形地址。
 *
 * 返回类型写成非空元组，调用方因此不必再为「一条都没有」写兜底分支。
 */
function modelListCandidates(baseUrl: string): [string, ...string[]] {
  const { base, root } = baseAndRoot(baseUrl);
  const candidates = [
    `${base}/models`,
    ...(/\/v1$/.test(base) ? [] : [`${base}/v1/models`]),
    ...(root === base ? [] : [`${root}/models`, `${root}/v1/models`]),
  ];
  // 去重（`https://host/v1` 这种地址：根的 `/v1/models` 与配置地址那条是同一个 URL）
  return [...new Set(candidates)] as [string, ...string[]];
}

/**
 * 按候选顺序取模型清单：返回第一个能解析出 id 的响应。
 *
 * 回退判据**只有 404**（路径不存在）。401/403/429/5xx 说明这条路径是通的，问题在密钥、限流或
 * 上游自己 —— 换条地址再打一次既是白跑，还会把真因盖成「地址不存在」，用户照着改地址越改越远。
 * 全都不通时由 `upstreamError` 把试过的每一条路径一起写进 message。
 *
 * 注意「2xx 但一条 id 都认不出」**不会**换下一条：那是上游的响应形状问题，不是地址形态问题，
 * 换地址只会把「响应里没有可识别的模型」这层真因盖成 404（`fetchProviderModels` 单独给这条原因）。
 *
 * 整段尝试共用调用方那一个超时信号：候选变四条不等于把等待上限翻四倍（见 `MODELS_TIMEOUT_MS`）。
 */
async function fetchModelIds(
  candidates: readonly [string, ...string[]],
  apiKey: string,
  signal: AbortSignal,
): Promise<ExtractedModel[]> {
  const headers = { authorization: `Bearer ${apiKey}` };
  // 非空元组 ⇒ 循环至少跑一轮，`failure` 必然在抛出前被赋值
  let failure: { error: ServiceError; retryable: boolean } | undefined;

  for (const [index, url] of candidates.entries()) {
    const res = await fetch(url, { headers, signal });
    if (res.ok) return extractModels(await readJson(res, url));

    failure = { error: await upstreamError(res, url, candidates), retryable: res.status === 404 };
    if (!failure.retryable) throw failure.error;

    const next = candidates[index + 1];
    // 最后一条也 404：没有下一条可换，跳出后把这条 404 的原因原样抛出
    if (next === undefined) break;
    log.debug('清单地址返回 404，回退到下一条候选', { from: url, to: next });
  }

  if (failure !== undefined) throw failure.error;
  throw new ServiceError('INTERNAL', '拉取模型失败：没有可用的清单地址');
}

/**
 * 只挑「窗口」那几格，缺席的键**不写 undefined**：落盘物要干净，而且 `{ contextWindow: undefined }`
 * 会让 `toEqual` 断言与调试输出都变吵。传入 undefined 就是空对象（条目缺失的情形）。
 * 注意它与 `pickEfforts` 是**两个**函数：窗口这一格有「用户手工覆盖」这一说，档位没有（spec D3）。
 */
function pickWindow(
  source:
    | { contextWindow?: number; maxOutputTokens?: number; contextWindowSource?: 'fetched' | 'manual' }
    | undefined,
): { contextWindow?: number; maxOutputTokens?: number; contextWindowSource?: 'fetched' | 'manual' } {
  if (source === undefined) return {};
  return {
    ...(source.contextWindow === undefined ? {} : { contextWindow: source.contextWindow }),
    ...(source.maxOutputTokens === undefined ? {} : { maxOutputTokens: source.maxOutputTokens }),
    ...(source.contextWindowSource === undefined ? {} : { contextWindowSource: source.contextWindowSource }),
  };
}

/** 只挑「档位」那两格（同一个理由：缺席的键不写）。它们**只有上游一个来源**，没有手工覆盖。 */
function pickEfforts(
  source: { supportedEfforts?: string[]; recommendedEffort?: string } | undefined,
): { supportedEfforts?: string[]; recommendedEffort?: string } {
  if (source === undefined) return {};
  return {
    ...(source.supportedEfforts === undefined ? {} : { supportedEfforts: source.supportedEfforts }),
    ...(source.recommendedEffort === undefined ? {} : { recommendedEffort: source.recommendedEffort }),
  };
}

/**
 * 拉取供应商的模型清单并**合并**进现有清单（spec §6.1）。
 *
 * 合并规则（三条，缺一条都会丢用户的数据）：
 *   - `source: 'manual'` 的条目**原样保留**（位置在前、来源不变），拉取结果里同 id 的条目不会顶掉它；
 *   - 上一轮 `fetched` 的条目这次没再返回，视为上游已下架，清掉 —— 这才是「刷新」的语义；
 *   - 其余新 id 追加为 `fetched`。
 *
 * 返回 `Promise<ProviderView>`：契约 §6 把本函数写成同步返回，但它必须发一次 HTTP 请求，
 * 只能是异步（契约 §7 的客户端 `fetchModels` 也返回 Promise）。不改名、不改参数，只把返回值包成 Promise。
 *
 * 协议**不参与**本函数的判定，地址形态由 `modelListCandidates` 兜底（2026-09-26 修订 + 2026-09-30 补根回退）：
 * 原先「Anthropic 协议一律拒绝」那条判断只对 api.anthropic.com 成立，而多数自建网关在版本段上
 * 同时提供 OpenAI 风格的清单接口 —— 把协议当判据，等于替这类用户少拉一次清单。
 * 同理，地址填成 Messages 根（`/anthropic`）或带网关前缀（`/api/v1`）时清单接口仍在站点根上，
 * 故候选里也含根的 `/models` 与 `/v1/models`。
 */
export async function fetchProviderModels(providerId: string): Promise<ProviderView> {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);

  const candidates = modelListCandidates(provider.baseUrl);
  // 只记地址，不记密钥
  log.debug('拉取模型清单', { providerId, candidates });

  // 超时保护罩住**整段上游等待**（fetch 与读正文），不只是拿到响应头那一刻：
  // 拿到头之后挂住正文的网关同样会让拉取永远转下去。计时器在 finally 里清掉，不留悬挂定时器。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);

  let extracted: ExtractedModel[];
  try {
    extracted = await fetchModelIds(candidates, provider.apiKey, controller.signal);
  } catch (error) {
    // 自己掐的那一次 → 超时，给含 host 的中文原因（不是「无法连接」，也不是把上游正文带出来）
    if (controller.signal.aborted) {
      throw new ServiceError(
        'INTERNAL',
        `拉取模型失败：连接 ${hostOf(candidates[0])} 超时（超过 ${MODELS_TIMEOUT_MS / 1000} 秒没有响应），请检查网关是否可达`,
        { cause: error },
      );
    }
    // 非 2xx（upstreamError）与「响应不是合法 JSON」（readJson）已经折成中文原因，原样抛；
    // 只有连接层失败（DNS / TLS / 拒绝连接）要在这里折 —— 它抛的是原始 TypeError。
    throw error instanceof ServiceError
      ? error
      : new ServiceError('INTERNAL', `拉取模型失败：无法连接 ${hostOf(candidates[0])}（${reason(error)}）`, {
        cause: error,
      });
  } finally {
    clearTimeout(timer);
  }

  if (extracted.length === 0) {
    // 一条都认不出时**不落盘**：把空清单写回去会静默清掉用户手工维护的模型，
    // 而「上游这次返回了空」与「我们没看懂它的响应」在界面上完全无法区分（§10）。
    throw new ServiceError(
      'INTERNAL',
      `拉取模型失败：${hostOf(candidates[0])} 的响应里没有可识别的模型（data 字段缺失或为空）`,
    );
  }

  // 写回用的是**重新读到的最新配置**，不是上面那份 await 之前的快照：本函数跨了两次 await
  //（fetch 与读正文），窗口期内任何落盘改动都可能发生 —— 另一个请求手工加模型、设置页保存、
  // 另一个客户端/标签页。拿快照整份写回会把这些改动静默回滚，症状正是本函数要防的那类
  // 「用户的数据被冲掉」，只不过丢的是**别的**改动（lost update）。所以只有目标供应商的
  // models / updatedAt 被替换，最新配置里的其余部分原样保留。
  //
  // 已知取舍：窗口期内**同一个供应商**模型清单的并发修改仍会被本次合并结果覆盖 ——
  // 没有锁就不可避免，接受它；跨供应商与跨域（settings/cases）的改动必须存活。
  // 供应商若已在窗口期内被删掉，这里按 NOT_FOUND 失败（而不是复活一个已被删除的条目）。
  const fresh = loadConfig();
  const current = requireProvider(fresh, providerId);
  const manual = current.models.filter((model) => model.source === 'manual');
  const manualIds = new Set(manual.map((model) => model.id));
  const byId = new Map(extracted.map((model) => [model.id, model]));
  const previousById = new Map(current.models.map((model) => [model.id, model]));
  const fetchedIds = [...byId.keys()].filter((id) => !manualIds.has(id));
  const next: Provider = {
    ...current,
    models: [
      ...manual,
      ...fetchedIds.map((id) => {
        const previous = previousById.get(id);
        // 「用户改过（或清空过）这一格就别动它」：没有这条，用户修好的窗口会在下一次拉取时**静默打回**，
        // 而他以为改生效了 —— 本仓最忌讳的静默丢用户数据（与 manualModels 的注释同一条口径）。
        // ⚠️ 只保护**窗口**：档位（`pickEfforts`）永远以上游为准 —— 它是上游声明的**能力**，
        // 用户手工留住一个上游已经取消的档位，只会让创建评测时选出一个跑不通的组合。
        const keep = previous?.contextWindowSource === 'manual';
        return {
          id,
          source: 'fetched' as const,
          ...pickWindow(keep ? previous : byId.get(id)),
          ...pickEfforts(byId.get(id)),
        };
      }),
    ],
    updatedAt: new Date().toISOString(),
  };
  replaceProvider(fresh, next);
  log.info('模型清单已更新', {
    providerId,
    manual: manual.length,
    fetched: fetchedIds.length,
    // 「这次补齐了多少条窗口」在服务端要可观测：用户报「窗口还是未知」时第一个要看的数就是它
    withWindow: next.models.filter((model) => model.contextWindow !== undefined).length,
  });
  return toView(next);
}
