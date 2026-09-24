/**
 * 最小日志器：统一前缀与级别，禁止各模块自己 console。
 * 级别口径（与设计文档一致）：
 *   ERROR 业务异常 / 外部调用失败——必须带堆栈与业务上下文
 *   WARN  降级、重试、超时、配置缺失但可继续
 *   INFO  请求入口、关键状态变更、外部调用耗时 >500ms
 *   DEBUG 分支走向、中间变量、循环关键节点（生产默认关闭）
 * 注意：DEBUG 门控在**每次调用时**读环境变量（不是模块加载时读一次），
 * 否则测试里无法在同一进程内切换开关。
 */
export interface Logger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

/** DEBUG 是否开启：AIEVAL_DEBUG 为 '1' / 'true' 时开启 */
function debugEnabled(): boolean {
  const value = process.env.AIEVAL_DEBUG;
  return value === '1' || value === 'true';
}

/** 拼日志前缀：`[级别] [scope] message`（上下文不进前缀，见 createLogger 的注释） */
function format(level: string, scope: string, message: string): string {
  return `[${level}] [${scope}] ${message}`;
}

/**
 * 上下文一律作为 console 的**第二个参数**透传，绝不 JSON.stringify：
 * 后者遇到循环引用或 BigInt 直接抛 TypeError，而它是在 console 调用的实参位置求值的，
 * 异常会原样冒进调用方——日志器不该有能力打断业务流程（后续任务要记 SDK / HTTP 请求对象，
 * 里面循环引用是常态）。Node 自带的 inspector 格式化能正确渲染循环引用与 BigInt，且不抛。
 */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, context) => {
      if (debugEnabled()) {
        console.log(format('DEBUG', scope, message), ...(context === undefined ? [] : [context]));
      }
    },
    info: (message, context) => console.log(format('INFO', scope, message), ...(context === undefined ? [] : [context])),
    warn: (message, context) => console.warn(format('WARN', scope, message), ...(context === undefined ? [] : [context])),
    error: (message, context) =>
      console.error(format('ERROR', scope, message), ...(context === undefined ? [] : [context])),
  };
}
