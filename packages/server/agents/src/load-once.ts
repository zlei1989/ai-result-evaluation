/**
 * 厂商 SDK 的懒加载外壳。
 * 三条语义，缺一条都不行：
 *  1. **函数作用域懒加载**：厂商包只在第一次真正用到时才 import——顶层静态导入会把「一家 SDK 故障」
 *     放大成「整包不可用」，一个智能体装坏了会导致全部智能体不可用；
 *  2. **只缓存成功的加载**：失败不缓存，一次镜像抖动不该毒化长驻服务的后续所有行；
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
      throw new AgentLoadError(packageName, cause);
    }
  };
}

/** 从注入表里按包名取值；sdkModule 不是对象或没有该键时返回 undefined（走真实加载） */
function injectedModule(packageName: string): unknown {
  const { sdkModule } = getAgentRuntime();
  if (typeof sdkModule !== 'object' || sdkModule === null) return undefined;
  return (sdkModule as Record<string, unknown>)[packageName];
}
