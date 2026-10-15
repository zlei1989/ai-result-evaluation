/**
 * 厂商 SDK 的懒加载外壳。
 * 三条语义，缺一条都不行：
 *  1. **函数作用域懒加载**：厂商包只在第一次真正用到时才 import——顶层静态导入会把「一家 SDK 故障」
 *     放大成「整包不可用」，一个智能体装坏了会导致全部智能体不可用；
 *  2. **只缓存成功的加载**：失败不缓存，一次镜像抖动不该毒化长驻服务的后续所有行。
 *     ⚠️ 这句话只对**解析类**失败成立（包没装、子模块缺失、镜像换页）：修好文件之后重试确实会成功。
 *     **求值 / 编译期抛错**的模块由 Node 的模块表记成 errored **永久缓存**，同一个模块 URL 再 import
 *     还是那个错 ⇒ 那两档要重启服务（受控探针逐档核过：`ERR_MODULE_NOT_FOUND` 修复后 ok、
 *     `nested missing child` 修复后 ok、求值期抛错修复后仍抛）。失败文案据此分岔（`pinned`）。
 *  3. **注入优先**：`sdkModule` 里有该包名就直接用它（单测因此完全不碰真实包）。
 * packageName 是一等参数：它同时是测试注入表的**查表键**与错误文案里的包名。
 * 注意：注入值**不缓存**——测试要能在同一进程里换模块（见 load-once.test.ts 的用例说明）。
 */
import { AgentLoadError } from './errors';
import { getAgentRuntime } from './runtime';

export function createSdkLoader<T>(load: () => Promise<T>, packageName: string): () => Promise<T> {
  let cached: T | undefined;
  let cachedOk = false;

  return async (): Promise<T> => {
    const injected = injectedModule(packageName);
    if (injected !== undefined) return injected as T;
    if (cachedOk) return cached as T;
    try {
      const module = await load();
      cached = module;
      cachedOk = true;
      return module;
    } catch (cause) {
      // 不缓存失败：这里刻意不写 cachedOk = true
      throw new AgentLoadError(packageName, cause, { pinned: !isResolutionFailure(cause) });
    }
  };
}

/**
 * 这次失败是不是**解析类**（修好文件后同进程重试就能成功）。
 *
 * 只有解析类失败是可重试的：Node 在解析/加载阶段失败时**不**往模块表里留条目，而求值或编译期
 * 抛错会留下一个 errored 条目（再 import 直接重抛同一个错）。判据取 Node 的错误码前缀，
 * 认不出的一律按「不可重试」处置——把不可重试说成可重试，会让人反复重跑同一行。
 */
function isResolutionFailure(cause: unknown): boolean {
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  if (typeof code !== 'string') return false;
  return code === 'MODULE_NOT_FOUND'
    || code === 'ERR_MODULE_NOT_FOUND'
    || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    || code === 'ERR_PACKAGE_IMPORT_NOT_DEFINED'
    || code === 'ERR_UNSUPPORTED_DIR_IMPORT'
    || code === 'ERR_UNKNOWN_FILE_EXTENSION';
}

/** 从注入表里按包名取值；sdkModule 不是对象或没有该键时返回 undefined（走真实加载） */
function injectedModule(packageName: string): unknown {
  const { sdkModule } = getAgentRuntime();
  if (typeof sdkModule !== 'object' || sdkModule === null) return undefined;
  return (sdkModule as Record<string, unknown>)[packageName];
}
