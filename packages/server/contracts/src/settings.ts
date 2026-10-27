/**
 * 应用设置契约（服务端落盘 + 客户端展示共用）。
 * 注意：这是**服务端真源**——主题偏好虽然也在客户端 localStorage 里留一份用于首帧即时渲染，
 * 但判定真源仍是这里，客户端那份只是缓存。
 */
import { z } from 'zod';
import { AgentKindSchema } from './agent';
import { MCP_HEADER_KEY_PATTERN, McpServersSchema, type McpServerConfig, type McpServers } from './mcp';
import { maskCustomHeaders, preserveUnchangedCustomHeaders } from './custom-headers';
import { maskApiKey } from './provider';
import { SkillsPatchSchema, SkillsSettingsSchema, type SkillsPatch, type SkillsSettings } from './skill';

/** 同名头的报错文案（schema 与界面的行定位共用同一句） */
export const DUPLICATE_HEADER_NAME_MESSAGE = '请求头名不能重复（HTTP 头名不区分大小写）';

/** 值里不许出现的两个字符（CR 与 LF）：Header 注入的唯一入口 */
export const CUSTOM_HEADER_VALUE_PATTERN = /^[^\r\n]*$/;

/** 键名规则的中文原文（schema 报错与界面行内校验说同一句话） */
export const CUSTOM_HEADER_KEY_MESSAGE = '请求头名只能含 HTTP 头名允许的字符（不能含空白或冒号），且不能为空';

/** 值规则的中文原文（同上） */
export const CUSTOM_HEADER_VALUE_MESSAGE = '请求头的值不能包含换行';

/**
 * 挂到智能体**模型请求**上的自定义请求头（设置页「基础」Tab 那一张卡）。
 *
 * 形状为什么是一张 map 而不是一组 `[{name, value}]`：落盘与出站两侧的语义都是 HTTP 头，
 * 而 HTTP 头**同名只有一份**。用数组表示就让「界面两行、发出去一行」成了一个可以在界面上造出来、
 * 却在落盘文件里看不见的假象；map 把这件事提前到契约层——同名（含大小写不同）在 schema 就判非法。
 *
 * 两个必须在这一层拦住的形状，理由都不是「更严谨」：
 *   · **键名**走 HTTP field-name 的 token 语法（与 MCP `headers` 共用 `MCP_HEADER_KEY_PATTERN`）：
 *     含空白或冒号的键根本发不出去，拼进请求就是一句畸形的头；
 *   · **值里不许有 CR / LF**：那是 Header 注入的形状——一个换行就能让后面的字变成一条新头，
 *     而新头会跟着这次请求发到网关。
 *
 * 大小写不敏感去重放在 schema 里而不是交给调用方：`X-Trace` 与 `x-trace` 在同一张表里
 * 是**两行**，发出去却只有一条——落盘与真实行为分家，而这种偏差在界面上完全看不见。
 *
 * ⚠️ 这条 schema 必须写在 `SettingsSchema` **之前**（后者在模块求值期就把它拼进对象）。
 * 同理，`settings.ts` 与 `custom-headers.ts` 之间有一条**求值期成立**的 import 环：环上两侧
 * 在求值期都只碰 zod、常量与函数声明（提升），谁先加载都成立；两个文件头各记了半边口径。
 */
export const CustomHeadersSchema = z
  .record(
    z
      .string()
      .min(1, CUSTOM_HEADER_KEY_MESSAGE)
      .regex(MCP_HEADER_KEY_PATTERN, CUSTOM_HEADER_KEY_MESSAGE),
    z.string().regex(CUSTOM_HEADER_VALUE_PATTERN, CUSTOM_HEADER_VALUE_MESSAGE),
  )
  .refine(hasDistinctHeaderNames, { message: DUPLICATE_HEADER_NAME_MESSAGE });
export type CustomHeaders = z.infer<typeof CustomHeadersSchema>;

/**
 * 表里的头名两两不同（忽略大小写）。用顶层函数声明交给 `refine`：求值期只需要这个名字，
 * 不必提前求出任何常量（理由见上面那条 schema 的「求值顺序」一句）。
 */
function hasDistinctHeaderNames(headers: Record<string, string>): boolean {
  const seen = new Set<string>();
  for (const key of Object.keys(headers)) {
    const folded = key.toLowerCase();
    if (seen.has(folded)) return false;
    seen.add(folded);
  }
  return true;
}

/**
 * 两张表里**撞名的那个键**（后出现的那一个）；没有冲突回 `null`。界面拿它把那两行标红——
 * 只给一句「不能重复」的话，用户要自己在几行里找是哪两行。
 */
export function customHeaderNameConflict(headers: Record<string, string>): string | null {
  const seen = new Set<string>();
  for (const key of Object.keys(headers)) {
    const folded = key.toLowerCase();
    if (seen.has(folded)) return key;
    seen.add(folded);
  }
  return null;
}

/** 主题偏好：auto=跟随操作系统、light=明亮、dark=暗色 */
export const ThemeModeSchema = z.enum(['auto', 'light', 'dark']);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

/** 默认评分模型：两个 id 必须成对出现，未配置时为 null */
export const DefaultJudgeSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  /**
   * 评分时**要求**的思考强度档位（可选）。缺省 = 未指定 ⇒ 一个强度键都不加（网关默认）。
   * 它的可选域由「模型声明 ∩ 评分智能体域」决定（`contracts/src/effort.ts`），
   * 存的是**上游词汇原样**（关闭档就是 `off`）。
   */
  effort: z.string().min(1).optional(),
});

export const SettingsSchema = z.object({
  theme: ThemeModeSchema,
  /** 工作区根目录（绝对路径）；目录不存在时由服务端创建 */
  workspaceRoot: z.string().min(1),
  /**
   * 用例根目录（绝对路径）：**一用例一文件**存在它下面（`<casesRoot>/<case-id>.json`）。
   * 用例已不再进 `config.json` 的 `cases` 数组，这里是它在磁盘上的唯一落点
   * （口径见 core 的 `case-store.ts`：原子写、容忍 BOM、id 形状校验）。
   * 「默认值从配置里取」这条优先级由服务端 `resolveCasesRoot` 承担：
   * 这一格为空 / 缺失时回落到 `AIEVAL_CASES_ROOT`，再回落到 `~/.aieval-cases`。
   */
  casesRoot: z.string().min(1),
  /**
   * 用例变更时是否自动在后台提交并推送（`casesRoot` 是 git 仓库时才有意义）。
   * 关掉之后用例照常落盘，但要到设置页点「提交」才进 git —— 两态都必须让用户看得见，
   * 不能出现「以为提交了、其实没提交」。
   */
  casesAutoCommit: z.boolean(),
  /** 全局默认评分模型；未配置时为 null（此时用例页的「AI 生成」与评测评分不可用） */
  defaultJudge: DefaultJudgeSchema.nullable(),
  /** 默认评分智能体：null = 未配置（此时「使用智能体评分」的评测会在创建时被拦下） */
  defaultJudgeAgent: AgentKindSchema.nullable(),
  /**
   * 送评分模型的 diff 体积上限（字节），超出按文件裁剪并标注截断。
   *
   * 注意这里**没有**「单行超时」这一格（用户口径）：执行与评分都不限时间，
   * 一行只会因为「跑完 / 失败 / 用户点终止」结束。旧 `config.json` 里多出来的 `candidateTimeoutMs`
   * 在读盘时就被丢掉——**丢键的不是本 schema**：`loadConfig` 故意不做 schema 校验（一条手改坏的
   * 值不该让设置页打不开），它按 `SETTINGS_DEFAULTS` 的键表过滤（多出来的键丢掉，见 core 的
   * `normalizeSettings`）。本 schema 的 strip 语义只在**本文件被 `parse` 时**生效（契约测试走的
   * 正是那条路）。两条路径都不会把旧键带进运行时，故**不需要迁移脚本**。
   */
  diffBudgetBytes: z.number().int().positive(),
  /**
   * MCP 服务器集合（name-keyed map，形状见 `mcp.ts`）。
   *
   * 密钥落**明文**：`${ENV_NAME}` 这类占位存原文、解析只发生在注入时，而用户在界面手填的明文
   * 服务端必须拿得到原值才能注入 ⇒ 出口那一侧（`SettingsView`）负责掩码，落盘这一侧不掩。
   *
   * 这一格必须是**必填**（`SETTINGS_DEFAULTS` 里给出预置两项）：`normalizeSettings` 的键表取自
   * `SETTINGS_DEFAULTS`，缺了它，落盘的 `mcpServers` 会在**读盘时被静默丢掉**。
   */
  mcpServers: McpServersSchema,
  /**
   * 本机 skill 的**停用名单**（形状见 `skill.ts`）：`entries[<名字>] = { disabled: true }`。
   *
   * 为什么只存「停用」而不存「启用」：条目本身是**从磁盘扫出来的**（`<配置目录>/skills/`），
   * 配置里没有条目可挂——落一份「启用」的名单等于给同一个事实造第二份会漂移的真源。
   * 于是「启用」在文件里就是不出现，启用 = **删键**。
   *
   * 这一格必须是**必填**（默认值 `{ entries: {} }`）：`normalizeSettings` 的键表取自
   * `SETTINGS_DEFAULTS`，缺了它，落盘的停用名单会在**读盘时被静默丢掉**（与 `mcpServers` 同一条）。
   * 与 MCP 不同的是**没有预置项**，故那边「键在不在文件里 = 播过没播过」的播种判据在这里无事可做。
   */
  skills: SkillsSettingsSchema,
  /**
   * 挂到智能体**模型请求**上的自定义请求头（形状与两条形状规则见 `custom-headers.ts`）。
   *
   * 四家智能体（cc / codex / dsh / pi）各用各的方言挂同一张表：契约只认这张**中性的** map，
   * 方言翻法留在各适配器里。作用面是「发往网关的那一次请求」——MCP / hosted 工具等子请求不在内。
   *
   * 这一格必须是**必填**（默认值 `{}`），理由与 `skills` 逐字相同：`normalizeSettings` 的键表取自
   * `SETTINGS_DEFAULTS`，缺了它，落盘的头表会在**读盘时被静默丢掉**。与 `mcpServers` 不同的是
   * **没有预置项**，故那边「键在不在文件里 = 播过没播过」的播种判据在这里无事可做。
   */
  customHeaders: CustomHeadersSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * 部分更新：所有字段可选；空对象合法（无改动）。
 *
 * `skills` 单独换成补丁形状（`SkillsPatchSchema`，值收 `disabled: boolean`），**不复用**落盘那条 ——
 * `SettingsSchema.partial()` 会让补丁继承落盘的值形状（只许 `{disabled:true}`），
 * 于是「再打开」（`{disabled:false}` ⇒ 删键）在 API 门口就被判 400。
 * 放宽落盘那条同样不行：「配置里只出现停用」这条不变量就没人守了。
 */
export const SettingsPatchSchema = SettingsSchema.partial().extend({ skills: SkillsPatchSchema.optional() });
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/**
 * 预置的两台 MCP 服务器：context7 是远端 http（密钥走 `${CONTEXT7_API_KEY}` 占位，
 * 明文永不落盘）、playwright 是本地 stdio。
 *
 * 为什么 `--browser=chrome` 与 `--isolated` 不能省（来由见地图 Notes 边界 10）：`edge` 是非法通道值、
 * 会被静默回落到默认浏览器（用户以为在测 Edge，其实跑的是 Chrome）；`--isolated` 让 profile 留在内存
 * 不落盘，否则每次冒烟都在用户的真实浏览器 profile 里留下垃圾。
 */
const PRESET_MCP_SERVERS: McpServers = {
  context7: {
    transport: 'http',
    enabled: true,
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
  },
  playwright: {
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--browser=chrome', '--isolated'],
  },
};

/** 默认值：workspaceRoot / casesRoot 的 `~` 由服务端在读取时展开为真实家目录 */
export const SETTINGS_DEFAULTS: Settings = {
  theme: 'auto',
  workspaceRoot: '~/.aieval-runs',
  casesRoot: '~/.aieval-cases',
  casesAutoCommit: true,
  defaultJudge: null,
  defaultJudgeAgent: null,
  diffBudgetBytes: 262_144,
  /**
   * **播种判据 = 归一化时该键缺失**：`normalizeSettings` 只认 `SETTINGS_DEFAULTS`
   * 里有的键——文件里没有 `mcpServers` ⇒ 用这里的预置两项；文件里有（**哪怕落成 `{}`**）⇒ 用文件里那份。
   * 「首次打开看到两台」与「删光之后刷新不再自动出现」于是由同一条判据承担：**空 map 与没写过在读侧
   * 是两态**，因为「键在不在文件里」可分。不需要迁移脚本，也不需要第二份「播过了没」的标记。
   *
   * ⚠️ 判据**不许**写成「值为空就当作没配过」：那等于删光即复播，用户永远删不掉预置项。
   * 守卫在 `core/src/config-store-mcp.test.ts`（走 `loadConfig` / `saveConfig` 真实读盘路径）。
   */
  mcpServers: PRESET_MCP_SERVERS,
  /**
   * skill 停用名单的默认值：**空**（没有预置项，也没有「播过没播过」这一说）。
   * 它必须在这里给出，否则 `normalizeSettings` 认不出这个键、落盘的名单读不回来。
   */
  skills: { entries: {} },
  /**
   * 自定义请求头的默认值：**空**（没有预置项）。它必须在这里给出，否则 `normalizeSettings`
   * 认不出这个键、落盘的头表读不回来。
   */
  customHeaders: {},
};

/**
 * **出口形态**：`GET /api/settings` 与所有下行响应回的形状。
 * 与落盘形态**同形不同值**——`env` / `headers` 里键名命中敏感模式的值已掩码，其余逐字原样。
 * 为什么不照 `ProviderView` 那样 omit 掉明文那一格：设置里的密钥藏在 `env` / `headers` 的**值**里，
 * 整格 omit 会连非敏感值（`NODE_ENV`、`Accept`）一起丢掉，那是另一句假话。
 * 所以「出口不含明文」这条不变量由 `toSettingsView` + 出口守卫（新增用例）承担，不由类型承担。
 */
export const SettingsViewSchema = SettingsSchema;
export type SettingsView = z.infer<typeof SettingsViewSchema>;

/**
 * 敏感键名：命中即掩码。
 * 判据是**键名**而不是值的形状——值可能是 `${CONTEXT7_API_KEY}` 这类占位、也可能是用户手填的明文，
 * 两者都不该原样下行；而 `NODE_ENV` / `PLAYWRIGHT_BROWSERS_PATH` 这些要看得见（它们是排障信息）。
 */
export const SENSITIVE_KEY_PATTERN = /(key|token|secret|password|auth)/i;

/**
 * 一个键名算不算敏感键（`SENSITIVE_KEY_PATTERN` 的**唯一**读点）。
 * 三个消费方——出口掩码、PUT 的「未改动」消解、界面的「已配置密钥」小标——必须同一把尺：
 * 各自 `SENSITIVE_KEY_PATTERN.test(key)` 一遍，漂移的表现是「界面说有密钥、出口其实没掩」。
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * 这张键值表里有没有一个**已配置**的敏感值：键名命中敏感模式**且值非空**。
 *
 * 两个消费方在相反的两层（`api` 的探活用它决定要不要记「匿名调用」、`ui` 用它决定要不要打
 * 「已配置密钥」小标），问的是同一件事；而 `api` 与 `ui` 之间没有依赖边，契约层是唯一落点。
 * 空串按「没配」处置：界面用它区分「未配置」与「已配置但隐藏」。
 */
export function hasSensitiveValue(values: Record<string, string> | undefined): boolean {
  if (values === undefined) return false;
  return Object.entries(values).some(([key, value]) => isSensitiveKey(key) && value !== '');
}

/** 掩码一张键值表：敏感键走 `maskApiKey`，其余键原样；**新建**对象，不改入参 */
function maskSensitiveValues(map: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    masked[key] = isSensitiveKey(key) ? maskApiKey(value) : value;
  }
  return masked;
}

/** 掩码一条 MCP 条目：只动 `env` / `headers` 的值，其余字段（含 `transport` / `enabled`）逐字保留 */
function toEntryView(entry: McpServerConfig): McpServerConfig {
  // 两张表都没有时也**新建**一份：出口对象与落盘对象共享引用的话，调用方改一下出口那份
  // （例如界面就地整理 args）就会连带改掉落盘那份，而这条路径上没有第二个拷贝兜底。
  if (entry.transport === 'http') {
    return entry.headers === undefined ? { ...entry } : { ...entry, headers: maskSensitiveValues(entry.headers) };
  }
  return entry.env === undefined ? { ...entry } : { ...entry, env: maskSensitiveValues(entry.env) };
}

/**
 * 落盘形态 → 出口形态：把两台 MCP 条目里 `env` / `headers` 与「自定义请求头」的敏感值换成掩码，
 * 其余一字不动。
 * 怎么做到「不泄也**不毁**」：整棵对象**新建**（`{ ...settings }` + 逐条新建条目 + 新建头表），
 * 不改入参——就地改写的话出口是掩码了，可紧接着 `saveConfig` 落盘的就是掩码串，真密钥被顶掉，
 * 而症状要到下一次运行才以 401 现身。
 */
export function toSettingsView(settings: Settings): SettingsView {
  const servers: McpServers = {};
  for (const [name, entry] of Object.entries(settings.mcpServers)) {
    servers[name] = toEntryView(entry);
  }
  return { ...settings, mcpServers: servers, customHeaders: maskCustomHeaders(settings.customHeaders ?? {}) };
}

/** 落盘条目里与 `entry` **同传输**的那张键值表；传输被改过（或本来就没有这条）时返回 undefined */
function storedValuesOf(entry: McpServerConfig, stored: McpServerConfig | undefined): Record<string, string> | undefined {
  if (stored === undefined) return undefined;
  if (entry.transport === 'http') return stored.transport === 'http' ? stored.headers : undefined;
  return stored.transport === 'stdio' ? stored.env : undefined;
}

/**
 * 一条补丁条目的「未改动」消解：敏感键的值是空串、或与本服务端掩码串逐字相同 ⇒ 换回落盘原值。
 * 只对**敏感键**成立：`NODE_ENV: ''` 是用户真填的值（改成空 = 不注入那个变量），不该被当成「没改」。
 * 落盘里没有这个键时不给「原值」（无从保留），补丁值照收——否则用户新填的密钥会被静默吃掉。
 */
function resolveEntrySecrets(entry: McpServerConfig, stored: McpServerConfig | undefined): McpServerConfig {
  const incoming = entry.transport === 'http' ? entry.headers : entry.env;
  if (incoming === undefined) return entry;
  const storedValues = storedValuesOf(entry, stored);
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    const original = storedValues?.[key];
    const unchanged =
      isSensitiveKey(key) && original !== undefined && (value === '' || value === maskApiKey(original));
    resolved[key] = unchanged ? original : value;
  }
  return entry.transport === 'http' ? { ...entry, headers: resolved } : { ...entry, env: resolved };
}

/**
 * 补丁的「未改动」消解：把 `mcpServers` 里那些「空串 / 与本服务端掩码串逐字相同」的敏感值
 * 换回**落盘原值**，其余字段（含非敏感键）一字不动。服务端在合并补丁**之前**调它。
 *
 * 为什么必须有这一步：`mcpServers` 是**整份 map 替换**，而界面拿到的是掩码——原样回传就会把真密钥
 * 覆盖成掩码串（错误要到下次运行才以 401 现身）；同时表单那句「留空 = 不修改」也要保住。
 * 为什么放在 contracts 而不是 api：它是纯函数（无 IO），与 `maskApiKey` / 掩码口径同一处，
 * 两个方向（出掩码 / 进原值）才不会各自漂移。
 *
 * `customHeaders` 是**第二张要掩码的表**，同一趟里消解（判据与实现在 `custom-headers.ts`）：
 * 两张表各写一遍就会漂移成「MCP 的密钥保住了、请求头的密钥被掩码覆盖」。
 */
export function preserveUnchangedSecrets(current: Settings, patch: SettingsPatch): SettingsPatch {
  const { mcpServers: incoming, customHeaders, ...rest } = patch;
  const resolved: SettingsPatch = { ...rest };
  if (incoming !== undefined) {
    const servers: McpServers = {};
    for (const [name, entry] of Object.entries(incoming)) {
      servers[name] = resolveEntrySecrets(entry, current.mcpServers[name]);
    }
    resolved.mcpServers = servers;
  }
  if (customHeaders !== undefined) {
    resolved.customHeaders = preserveUnchangedCustomHeaders(current.customHeaders ?? {}, customHeaders);
  }
  return resolved;
}

/**
 * 停用名单的**逐条合并 + 规范化**：返回合并后的 `entries`（落盘形态），不改成入参。
 *
 * 与 `mcpServers` 的差别是这一格的全部要害：那边是**整份 map 替换**（浅合并自然产生的语义），
 * 这边只动补丁里出现的名字 —— 补丁里没有的条目一字不动，于是「目录已删、键还在」的残条目
 * 由合并语义**结构性**保住，而不是靠界面每次都记得把它们回传（漏一条就是静默丢数据）。
 *
 * 规范化也落在这一处：`true` ⇒ 写 `{ disabled: true }`（值由这里构造，不是把补丁那份塞回去），
 * `false` ⇒ **删键**（启用 = 键不出现）。写侧 schema 只认字面量 `true`，所以「规范化」与
 * 「逐条合并」必须是同一次改写——分成两处就会出现「合法但没人调用」的那一步。
 *
 * 纯函数（无 IO）且放在契约层：服务端的合并点只是调用方，两个方向（补丁形态 ↔ 落盘形态）
 * 才不会各自漂移，与 `preserveUnchangedSecrets` 同一条理由。
 */
export function mergeSkillsEntries(
  current: SkillsSettings['entries'],
  patch: SkillsPatch['entries'],
): SkillsSettings['entries'] {
  const merged: SkillsSettings['entries'] = { ...current };
  for (const [name, entry] of Object.entries(patch)) {
    if (entry.disabled) {
      merged[name] = { disabled: true };
      continue;
    }
    delete merged[name];
  }
  return merged;
}
