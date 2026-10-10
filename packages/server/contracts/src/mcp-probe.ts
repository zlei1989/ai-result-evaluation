/**
 * MCP 探活契约：**请求二选一、结果同一形状、失败分档的中文结论**。
 *
 * 三件事为什么都放在契约里：
 *   1. 请求与结果两端（web-next 路由 / client / ui）都要认同一个形状，照 `SettingsView` 的先例；
 *   2. **失败档位 → 中文结论**这张表是「按钮说什么话」的真源，写成 `Record<FailureTier, string>`
 *      让 tsc 兜住「加了一档却忘了写文案」——那种漏会在界面上以「只剩厂商英文原文」现身；
 *   3. `probeSuccessText` 是**纯函数**，与 `displayRepoName` / `maskApiKey` 同一条边界：
 *      文案在这里可被文本断言钉住（含措辞守卫），而页面那层没有测试面。
 *
 * ⚠️ 口径：成功文案只说**已经验到的三件事**
 * （进程起得来 / 目标讲 MCP / 声明了 N 个工具），**永不**说「配置可用」「配置正常」——
 * key 对不对、浏览器起不起得来、行内首次下载能不能过，这三条探活一条都没验。
 *
 * 本文件只有形状与文案，没有 IO：探活的机制在 `core/src/mcp-probe.ts`，策略在 `api/src/mcp.ts`。
 */
import { z } from 'zod';
import { MCP_NAME_PATTERN, McpServerConfigSchema } from './mcp';

/**
 * 探活请求：**二选一**。
 *   - `{ name }`：用**已保存**的那一份（行内按钮走这条）；
 *   - `{ entry }`：用表单当前值，**不落盘**（表单里那个入口走这条）。
 * 同时给两个时以 `name` 为准（union 的分支顺序就是优先级，zod 默认 strip 掉另一个）。
 * 只给 `{ entry }` 时不校验名字：表单里名字可能还没填，而名字与「连不连得上」无关。
 */
export const McpProbeRequestSchema = z.union([
  z.object({ name: z.string().regex(MCP_NAME_PATTERN, '服务器名只能是字母、数字、下划线或连字符，长度 1–32') }),
  z.object({ entry: McpServerConfigSchema }),
]);
export type McpProbeRequest = z.infer<typeof McpProbeRequestSchema>;

/**
 * 档位：
 *   - `A`：纯握手（`initialize` → `notifications/initialized` → `tools/list`）；
 *   - `http+call`：握手后**再叠一次只读** `tools/call`——它是 http 侧唯一能验 key 的手段。
 * `tier` 记的是**探测真的做到哪一档**：http 端点没有已知的只读探测工具时，档位如实停在 `A`
 * （而不是按传输硬写 `http+call`），并附一条 note 说明为什么没叠。
 */
export const MCP_PROBE_TIERS = ['A', 'http+call'] as const;
export const McpProbeTierSchema = z.enum(MCP_PROBE_TIERS);
export type McpProbeTier = (typeof MCP_PROBE_TIERS)[number];

/**
 * 失败档位。前十档与表格**逐行对应**（判据在 `api/src/mcp.ts`），
 * 后两档是表格没覆盖的兜底（非 2xx 的其它状态码、只读调用返回了认不出的错误）——
 * 没有兜底档时这些失败只能塞进不准确的档位里，那比多两档更坏。
 */
export const MCP_PROBE_FAILURE_TIERS = [
  'spawn',
  'dependency',
  'network',
  'not-found',
  'not-mcp-endpoint',
  'auth',
  'rate-limited',
  'not-mcp',
  'invalid-key',
  'timeout',
  'http-error',
  'tool-call-failed',
] as const;
export const McpProbeFailureTierSchema = z.enum(MCP_PROBE_FAILURE_TIERS);
export type McpProbeFailureTier = (typeof MCP_PROBE_FAILURE_TIERS)[number];

/**
 * 档位 → 中文结论（表格）。界面上这串字是**第一段**，第二段是厂商原文照抄。
 * 具体失败还会在这串字后面补上状态码 / 已等待秒数（见 api 层），这里只给结论本身。
 */
export const MCP_PROBE_FAILURE_LABELS: Record<McpProbeFailureTier, string> = {
  spawn: '命令无法启动',
  dependency: '依赖拉取失败',
  network: '域名解析或网络不可达',
  'not-found': '端点不存在',
  'not-mcp-endpoint': '该地址不是 MCP 端点',
  auth: '需要鉴权',
  'rate-limited': '被上游限流',
  'not-mcp': '响应不是 MCP 协议',
  'invalid-key': 'API key 无效',
  timeout: '超时',
  'http-error': '端点返回了 HTTP 错误',
  'tool-call-failed': '只读调用返回了错误',
};

/**
 * 失败两段式的第一段 + 第二段。`vendorText` **原样照抄**厂商说的那句话（可折叠展示）：
 * FAQ 按报错原文索引，改写成我们自己的话就再也搜不到了（AGENTS.md 的 FAQ 口径）。
 */
export const McpProbeFailureSchema = z.object({
  tier: McpProbeFailureTierSchema,
  /** 中文结论（档位文案 + 状态码 / 已等待秒数这类有限细节） */
  message: z.string().min(1),
  /** 厂商原文；没有可照抄的原文时是空串，界面据此不渲染折叠区 */
  vendorText: z.string(),
});
export type McpProbeFailure = z.infer<typeof McpProbeFailureSchema>;

/**
 * 探活结果（成功与失败**同一形状**）：界面只认这一份，不必分两条路径解析。
 * `serverName` / `serverVersion` / `toolCount` 在失败时**缺席**（不是空串、不是 0）——
 * 「没验到」与「验到是 0」是两句话。
 */
export const McpProbeResultSchema = z.object({
  ok: z.boolean(),
  tier: McpProbeTierSchema,
  serverName: z.string().optional(),
  serverVersion: z.string().optional(),
  toolCount: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().int().nonnegative(),
  failure: McpProbeFailureSchema.optional(),
  /** 有限判据的补充说明（npx 要下载、停用不注入、只做了握手…），**不是**第二份结论 */
  notes: z.array(z.string()),
});
export type McpProbeResult = z.infer<typeof McpProbeResultSchema>;

/**
 * 超时预算（两者都**罩住收尾**）：
 *   - http 15 s：实测 1–3.4 s，留够慢网关；
 *   - stdio 30 s：npx 解析层固定 +2.7 s、冷下载实测 3.6 s，而行内 HOME 是全新的（还要重下）。
 * 为什么不能照抄 `api/src/providers.ts` 的 `MODELS_TIMEOUT_MS = 15_000` 给 stdio：那个数
 * 是「网关响应」的预算，与「起一个子进程并等它把依赖下下来」不是一件事。
 */
export const MCP_PROBE_TIMEOUT_MS = { http: 15_000, stdio: 30_000 } as const;

/**
 * 补充说明的文案。放契约里是为了让**文本守卫**能在不 import api / ui 的前提下钉住它们
 * （尤其是 npx 那句与停用那句，它们是验收清单上的两条）。
 */
export const MCP_PROBE_NOTES = {
  /** `command` 含 npx / npm：候选执行时行内 HOME 是新的，缓存为空 */
  npxFirstRun: '候选执行时首次启动还要在本行环境里下载依赖',
  /** 停用条目的结果照样给，但要写明它不会被注入 */
  disabled: '已停用，不会注入',
  /**
   * stdio 侧**保持 A 档**：playwright MCP 没有「只读且不启浏览器」的探测工具
   * （`browser_close` 都会逼出浏览器初始化）。
   * ⇒ stdio 探活对「浏览器通道非法」必然假绿，这句必须出现在结果里，不能只写在文档里。
   */
  stdioHandshakeOnly:
    'stdio 侧只做握手：它证明不了工具真能跑（playwright MCP 没有「只读且不启浏览器」的探测工具，故本档不叠只读调用）',
  /** http 端点不在已知只读工具表里：握手能过，但 key 没被验 */
  noReadonlyTool: '该端点没有已知的只读探测工具，本次只做了握手，未校验密钥',
  /** 一个敏感值都没带（没配、或占位对应的环境变量没设置）：结果是「匿名也能连」，不代表密钥可用 */
  anonymous: '本次没有携带密钥，是匿名探测：连通不代表密钥可用、也不代表有配额',
  /** 占位 `${VAR}` 在宿主环境里没设置时该键被丢掉（口径同注入侧：未设置 ⇒ 跳过） */
  envUnset: (name: string): string => `环境变量 ${name} 未设置，本次探测没有带上它`,
  /**
   * `${VAR:-default}` 这类 shell 写法**不支持**。丢键而不是照发：
   * 把 `${VAR:-x}` 当字面发出去，上游只会回一句「key 无效」，真因永远查不到。
   */
  envUnsupported: (raw: string): string => `值 ${raw} 不是受支持的占位（只支持 \${环境变量名}），本次探测没有带上它`,
} as const;

/**
 * 成功文案：`连通：<server> <version>，声明 N 个工具（耗时 X s）`。
 *
 * 三格都可能缺席，各自的说法**不同**（不许把缺席渲染成 0 或空串）：
 *   - 没自述名称 → 「未自述名称」；没自述版本 → 整段省略（不留一个尾随空格）；
 *   - 没声明工具数 → 「未声明工具数」（与「声明 0 个工具」是两句话）。
 * 耗时统一 1 位小数：秒级以下的差在界面上没有意义，而位数不固定会让同一列的数字跳来跳去。
 */
export function probeSuccessText(result: {
  serverName?: string | undefined;
  serverVersion?: string | undefined;
  toolCount?: number | undefined;
  elapsedMs: number;
}): string {
  const name = result.serverName === undefined || result.serverName === '' ? '未自述名称' : result.serverName;
  const version = result.serverVersion === undefined || result.serverVersion === '' ? '' : ` ${result.serverVersion}`;
  const tools = result.toolCount === undefined ? '未声明工具数' : `声明 ${result.toolCount} 个工具`;
  return `连通：${name}${version}，${tools}（耗时 ${(result.elapsedMs / 1000).toFixed(1)} s）`;
}
