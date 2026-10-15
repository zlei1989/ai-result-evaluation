/**
 * 适配器的错误归因。
 * 注意：这里的 `AgentErrorCode` **不是** contracts 的 `ErrorCode`——它没有对应的 HTTP 状态，落点是
 * 该行的事件日志；不要塞进 `ERROR_CODES`（那会逼 `STATUS_BY_CODE` 为它编造状态码）。
 * 用户可见文案的要求：**只说技术事实**——加载失败点名包名与安装方式、密钥无效带 host、
 * 限流带 host 与本次是哪一家、模型名不存在保留上游响应正文（网关的 404 与模型名拼错在正文之外无法区分）。
 * 「去哪儿改、按哪个按钮」属**产品知识**，由编排层按归因码追加（见 `orchestrator.ts` 的
 * `withProductHint`）：写在这里等于让适配层替产品说话，换一处复用就说不通。
 */
import { SkillMaterializeError } from '@aieval/core';
import { asRecord, readNumber, readString } from './json';
import type { AgentErrorCode, AgentKind } from './types';

/**
 * 厂商的**凭证类**结构化失败码（加方括号的形态是我们自己带进归因文案的前缀，见 `classifyAgentFailure`）。
 * dsh 的两个码都是「这一家的密钥要人去核对」，与 HTTP 401 同一处置。
 */
const VENDOR_CREDENTIAL_CODES = /\[(MISSING_CREDENTIAL|INVALID_CREDENTIAL)\]/;

export interface FailureContext {
  kind: AgentKind;
  /** 出错那次运行用的网关地址：AUTH_FAILED / RATE_LIMITED 的文案要带 host */
  baseUrl: string;
}

export interface AgentFailure {
  code: AgentErrorCode;
  message: string;
  stack?: string;
}

/**
 * 加载失败的三类语义。必须分开，因为**补救动作完全相反**：
 *  - `missing`：包没装 / 加载不起来 ⇒ 文案给安装命令（「装什么」+「怎么装」）；
 *  - `shape-mismatch`：包**已经装好**，只是导出面与适配器期望的不一致 ⇒ 安装命令是一条**恒无效**
 *    的指令（dsh 的包在 `dependencies` 里、`node_modules` 完整、镜像无关），它会把用户带向
 *    「检查网络 / 重装」这条错误方向，而真相是「适配器按探测前的假设写的」；
 *  - `node-version`：包与导出面都对，是**运行时太老**（厂商的 `engines` 只是 npm 元数据，装载时
 *    不自查）⇒ 补救动作是升级 Node，重装包同样是恒无效指令。
 */
export type AgentLoadFailureVariant = 'missing' | 'shape-mismatch' | 'node-version';

/** `shape-mismatch` 文案要点名期望入口与实测导出面；`node-version` 要点名要求下限与本机版本 */
export interface AgentLoadErrorOptions {
  /** 省略即 `missing`（默认值保持老调用点逐字不变） */
  variant?: AgentLoadFailureVariant;
  /**
   * `missing` 那一档的**补救层次**：同一种「加载失败」成因不同、该做的事也不同。
   *   · `install`（缺省）：包没装 ⇒ 装它；
   *   · `repair-package`：包在、但里面缺东西（如平台包的 `vendor/` 不全）⇒ **装一次不会有任何变化**，
   *     要重装或修那个包；
   *   · `fix-anchor`：包在、东西也全，只是**解析基准在当前环境无效**（换了机器 / cwd 不对）⇒ 改环境。
   * 为什么不做成第四个 `variant`：枚举是**下游与用例键**，加值会动它们的形状；
   * 而这三条只影响**同一档里的那一句补救动作**。
   */
  remedy?: 'install' | 'repair-package' | 'fix-anchor';
  /** 适配器期望的导出名（例：`createRuntime`） */
  expected?: string;
  /** 实测导出面（`Object.keys(模块命名空间)`）；空数组表示读不到任何导出 */
  actual?: readonly string[];
  /** `node-version`：厂商要求的 Node 下限（例：`≥22.19.0`） */
  required?: string;
  /** `node-version`：本机实测版本（`process.versions.node`） */
  current?: string;
  /**
   * 这一类失败**在同一个进程里重试不会变好**（`missing` 文案据此追加「需要重启服务」）。
   *
   * 判据来自 Node 的模块表：解析类失败（`ERR_MODULE_NOT_FOUND` 等）修好文件后重试就能成功；
   * 而**求值 / 编译期抛错**的模块会被记成 errored 永久缓存，同一个模块 URL 再 import 还是那个错
   * ——把包修好、把依赖补上都不会让当前进程恢复（受控探针逐档核过）。默认 `false`，保持老调用点逐字不变。
   */
  pinned?: boolean;
}

/**
 * 实测导出面（`Object.keys`），只喂 `shape-mismatch` 文案里那句「实测有 …」。
 *
 * 为什么住在这一层：三家懒加载的厂商 SDK **各写过一份**（dsh / pi），第三份（cc）就差一次复制
 * ——而它的用途与 `AgentLoadError` 的变体文案是同一条口径（「导出面不匹配」那句话要一份可读的实测清单），
 * 抄三遍必然漂（一处改了排序、另一处忘了防 `null`）。
 *
 * 先做形状检查：读导出面的动作本身不能成为新的崩溃点（`Object.keys(null)` 会抛）。
 */
export function exportedNames(raw: unknown): string[] {
  return typeof raw === 'object' && raw !== null ? Object.keys(raw).sort() : [];
}

/**
 * 厂商 SDK 加载失败（厂商包缺失 / 加载失败）。
 * 文案必须回答使用者下一句会问的问题：`missing` → 「装什么、怎么装」；`shape-mismatch` → 「装了为什么不匹配、
 * 该找谁」——后者绝不能出现 `pnpm add`（见 `AgentLoadFailureVariant` 的说明）。
 */
export class AgentLoadError extends Error {
  readonly code = 'AGENT_LOAD_FAILED';
  readonly packageName: string;
  readonly variant: AgentLoadFailureVariant;

  constructor(packageName: string, cause: unknown, options: AgentLoadErrorOptions = {}) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const variant = options.variant ?? 'missing';
    super(loadFailureMessage(packageName, reason, options), { cause });
    this.name = 'AgentLoadError';
    this.packageName = packageName;
    this.variant = variant;
  }
}

/**
 * 按变体选文案：三类失败的补救动作不同，文案必须跟着换。
 * `missing` 那条模板逐字保持原样（老调用点的用例按它断言）。
 */
function loadFailureMessage(packageName: string, reason: string, options: AgentLoadErrorOptions): string {
  switch (options.variant ?? 'missing') {
    case 'shape-mismatch':
      return shapeMismatchMessage(packageName, reason, options);
    case 'node-version':
      return nodeVersionMessage(packageName, options);
    default: {
      const hint = options.pinned === true
        ? '。⚠️ 这一档是**模块求值 / 编译期抛错**：Node 的模块表会把它记成 errored 永久缓存，'
          + '修好文件或补上依赖之后**需要重启服务**才能在同一个进程里生效'
        : '';
      const act = options.remedy === 'repair-package'
        ? '包已经装上了，但里面缺东西 ⇒ **装一次不会有任何变化**：请重装该包（或修好平台包），'
          + `再确认 ${packageName} 的目录完整`
        : options.remedy === 'fix-anchor'
          ? '包与文件都在，是**解析基准在当前环境无效**（换了机器或工作目录）⇒ 请在原构建路径下运行，'
            + '或从应用目录启动（详见《Codex 接入》的《部署约束》）'
          : `请在 packages/server/agents 下执行 pnpm add ${packageName}；若已安装，检查网络镜像与 node_modules 完整性`;
      return `厂商 SDK 加载失败：${packageName}（原因：${reason}）。${act}${hint}`;
    }
  }
}

/**
 * 「Node 太老」的文案：点名**要求的下限**与本机实测版本，并明确否定「重装包」这条猜想。
 * 为什么必须与 `shape-mismatch` 分开：包在、导出面也对，用户照着安装命令做一遍不会有任何变化。
 */
function nodeVersionMessage(packageName: string, options: AgentLoadErrorOptions): string {
  const required = options.required ?? '（未登记）';
  const current = options.current ?? '（读不到版本）';
  return `厂商 SDK 运行环境不满足：${packageName} 需要 Node ${required}，当前 ${current}（厂商的 engines 只是 npm 元数据，装载时不自查）。请在升级 Node 后重启服务；重装该包不会改变这一格`;
}

/**
 * 「已安装但不匹配」的文案：点名**期望的入口**与**实测的导出面**，并明确否定「安装」这条猜想。
 * 为什么不复用 `missing` 的模板：那条模板的第一句（`pnpm add`）在 dsh 的真实路径上恒无效——
 * 包在 `dependencies` 里、装好了、镜像无关，用户照着做一遍不会有任何变化。
 */
function shapeMismatchMessage(packageName: string, reason: string, options: AgentLoadErrorOptions): string {
  const expected = options.expected ?? '（未登记）';
  const actual =
    options.actual === undefined || options.actual.length === 0 ? '（读不到任何导出）' : options.actual.join(' / ');
  return `厂商 SDK 导出面不匹配：${packageName} 已安装，但导出面与适配器期望的不一致（期望 ${expected}；实测有 ${actual}；原因：${reason}）。这是适配器版本/回写问题，不是安装问题——不要重装该包，请更新本应用或把本行日志反馈给维护者；**换版本后需要重启服务**（模块实例已被进程内的模块表记住）`;
}

/** 从错误对象归因（事件流里通常给的是 Error 实例） */
export function classifyAgentFailure(error: unknown, context: FailureContext): AgentFailure {
  if (error instanceof AgentLoadError) {
    return { code: error.code, message: error.message, stack: error.stack };
  }
  /**
   * 技能装不进去：`core` 的物化函数抛的错**自带中文原因与条名**，照原样归因。
   *
   * 为什么必须在这里认它：缺省那条路会把任意未知错误归成 `AGENT_FAILED`，而它在自动重试表里
   * ⇒「源目录读不到」会被静默重跑两遍（每次再等 3 秒），而它重试多少次都是同一个失败。
   */
  if (error instanceof SkillMaterializeError) {
    return { code: 'AGENT_SKILLS_UNAVAILABLE', message: error.message, stack: error.stack };
  }
  const host = hostOf(context.baseUrl);
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  /**
   * **厂商的结构化失败码**（dsh 的 `LlmFailure.code`，由适配器以 `[CODE] 原文` 前缀带进这一格）。
   *
   * 为什么必须在这里认：缺省那条路把这些失败一并归成 `AGENT_FAILED`，而它在
   * `TRANSIENT_ROW_RETRY_CODES` 里 ⇒ 一类**确定性**的失败会被自动重跑两遍（每次再等 3 秒 + 一整轮
   * 模型时间），而界面上的原因还指向「CLI 起不来 / 进程非零退出」这条错方向。真机读数（同一份
   * 探针，`.scratch` 里的 `ctrl-cred-classify.mts`）：
   *   · 空 key ⇒ 厂商 `MISSING_CREDENTIAL`、带换行的 key ⇒ `INVALID_CREDENTIAL` —— 两者都是配置
   *     错误，补救动作是「去核对这一家的密钥」，与 HTTP 401 同一码（`AUTH_FAILED`，**不在**重试表里）；
   *   · `contextWindow` 给小 + 长提示词 ⇒ `CONTEXT_WINDOW_EXCEEDED` —— 同一份输入再发一次还是超，
   *     归 `AGENT_CONTEXT_OVERFLOW`（**不在**重试表里）。
   * 只认**我们自己加的那个方括号前缀**与厂商原文里那两句特征串，且**只对这一家**（`context.kind`）：
   * 这四句特征串全部来自 dsh 侧（`dsh-llm` / `dsh-llm-pi-ai`），但归因函数是四家共用的入口——
   * 不加家别闸，别家的普通错误里只要恰好出现这几个字样就会被顶成「密钥无效 / 超出上下文窗口」，
   * 而这两档**刻意不在重试表里** ⇒ 错误方向的补救建议 + 真因被顶掉。
   */
  const dshVendorCodes = context.kind === 'dsh';
  if (
    dshVendorCodes
    && (VENDOR_CREDENTIAL_CODES.test(message) || /no credential for provider route|contains characters no HTTP header can carry/.test(message))
  ) {
    return {
      code: 'AUTH_FAILED',
      message: `密钥无效或无权访问（${host}）：请核对该供应商的密钥后重试`,
      stack,
    };
  }
  if (dshVendorCodes && (/\[CONTEXT_WINDOW_EXCEEDED\]/.test(message) || /detected context overflow/.test(message))) {
    return {
      code: 'AGENT_CONTEXT_OVERFLOW',
      message: `本次请求超出模型上下文窗口（${host}）：缩短提示词或减少随附内容后重试，或换用窗口更大的模型；重试同一份请求不会成功`,
      stack,
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: 'AUTH_FAILED',
      // 只说技术事实（谁的密钥不对、在哪台上游）：**「去哪儿改」由编排层补**——
      // 那是本产品的知识，适配层替产品说话会让这个包换一处复用就说不通
      message: `密钥无效或无权访问（${host}）：请核对该供应商的密钥后重试`,
      stack,
    };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      message: `上游限流（${host}）：稍后重试，或降低并发后重试（${context.kind}）`,
      stack,
    };
  }
  if (status === 400 || status === 404) {
    return {
      code: 'AGENT_FAILED',
      message: `请求被上游拒绝（HTTP ${status}，${host}）：多为模型名不存在或网关不支持该接口；上游响应正文：${message}`,
      stack,
    };
  }
  if (/spawn\s+\S+\s+ENOENT/.test(message) || /ENOENT/.test(message)) {
    return {
      code: 'AGENT_FAILED',
      message: `${context.kind} 的可执行文件不存在或无法启动（${message}）：请确认对应 CLI 已安装并在 PATH 中`,
      stack,
    };
  }
  return { code: 'AGENT_FAILED', message, stack };
}

/** 从厂商给出的**文本**归因：事件流里往往只有 message 字符串，没有 Error 对象 */
export function classifyAgentMessage(message: string, context: FailureContext): AgentFailure {
  return classifyAgentFailure(new Error(message), context);
}

/** 取 host 用于文案；URL 不合法时退回原文（绝不因为「文案里放不下 host」而抛） */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 读 HTTP 状态：厂商 SDK 有的挂 status、有的挂 statusCode、有的只写进文案 */
function statusOf(error: unknown): number | null {
  const record = asRecord(error);
  const direct = readHttpStatus(record, 'status') ?? readHttpStatus(record, 'statusCode');
  if (direct !== null) return direct;
  const message = error instanceof Error ? error.message : String(error);
  const match = /\b(400|401|403|404|429)\b/.exec(message);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * 读状态码：**既认 number 也认纯数字字符串**。
 * 为什么不能直接 `Number(value)`：那会把 `'abc'` 变成 `NaN`、把 `''` 变成 `0`——两者都会**凭空造出**
 * 一个上游从未给出的状态，让用户拿到假归因。所以先做「纯数字」形状校验，不纯粹就当「没有状态」。
 * 与 `readNumber` 的分工：那个是通用窄读取，语义是「只认 number」（已给它加了 try/catch），
 * 不改它；这里只是**额外接受一种形状**。
 */
function readHttpStatus(record: Record<string, unknown> | null, key: string): number | null {
  const numeric = readNumber(record, key);
  if (numeric !== null) return numeric;
  const text = readString(record, key)?.trim();
  // 空串必须挡在前面：`Number('')` 是 0，那是「造出来的状态」而不是「没有状态」
  if (text === undefined || text === '') return null;
  const parsed = Number(text);
  // 形状回验：`'4xx'` / `'abc'` / `'1e3'` 都过不了这一关（`String(1e3)` 是 `'1000'`）
  return Number.isInteger(parsed) && String(parsed) === text ? parsed : null;
}
