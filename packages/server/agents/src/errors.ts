/**
 * 适配器的错误归因。
 * 注意：这里的 `AgentErrorCode` **不是** contracts 的 `ErrorCode`——它没有对应的 HTTP 状态，落点是
 * 该行的事件日志；不要塞进 `ERROR_CODES`（那会逼 `STATUS_BY_CODE` 为它编造状态码）。
 * 用户可见文案的要求：加载失败点名包名与安装方式；密钥无效带 host 指向设置页；
 * 限流提示改用串行；模型名不存在保留上游响应正文（网关的 404 与模型名拼错在正文之外无法区分）。
 */
import { asRecord, readNumber, readString } from './json';
import type { AgentErrorCode, AgentKind } from './types';

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
 * 加载失败的两种语义。必须分开，因为**补救动作完全相反**：
 *  - `missing`：包没装 / 加载不起来 ⇒ 文案给安装命令（「装什么」+「怎么装」）；
 *  - `shape-mismatch`：包**已经装好**，只是导出面与适配器期望的不一致 ⇒ 安装命令是一条**恒无效**
 *    的指令（dsh 的包在 `dependencies` 里、`node_modules` 完整、镜像无关），它会把用户带向
 *    「检查网络 / 重装」这条错误方向，而真相是「适配器按探测前的假设写的」。
 */
export type AgentLoadFailureVariant = 'missing' | 'shape-mismatch';

/** `shape-mismatch` 文案需要点名的两件事：期望的入口名与实测拿到的导出面 */
export interface AgentLoadErrorOptions {
  /** 省略即 `missing`（默认值保持老调用点逐字不变） */
  variant?: AgentLoadFailureVariant;
  /** 适配器期望的导出名（例：`createRuntime`） */
  expected?: string;
  /** 实测导出面（`Object.keys(模块命名空间)`）；空数组表示读不到任何导出 */
  actual?: readonly string[];
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
    super(
      variant === 'shape-mismatch'
        ? shapeMismatchMessage(packageName, reason, options)
        : `厂商 SDK 加载失败：${packageName}（原因：${reason}）。请在 packages/server/agents 下执行 pnpm add ${packageName}；若已安装，检查网络镜像与 node_modules 完整性`,
      { cause },
    );
    this.name = 'AgentLoadError';
    this.packageName = packageName;
    this.variant = variant;
  }
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
  return `厂商 SDK 导出面不匹配：${packageName} 已安装，但导出面与适配器期望的不一致（期望 ${expected}；实测有 ${actual}；原因：${reason}）。这是适配器版本/回写问题，不是安装问题——不要重装该包，请更新本应用或把本行日志反馈给维护者`;
}

/** 从错误对象归因（事件流里通常给的是 Error 实例） */
export function classifyAgentFailure(error: unknown, context: FailureContext): AgentFailure {
  if (error instanceof AgentLoadError) {
    return { code: error.code, message: error.message, stack: error.stack };
  }
  const host = hostOf(context.baseUrl);
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  if (status === 401 || status === 403) {
    return {
      code: 'AUTH_FAILED',
      message: `密钥无效或无权访问（${host}）：请到「设置 → 模型供应商」核对该供应商的密钥后重跑本行`,
      stack,
    };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      message: `上游限流（${host}）：稍后重试，或把本评测的执行模式改为串行以减少并发（${context.kind}）`,
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
