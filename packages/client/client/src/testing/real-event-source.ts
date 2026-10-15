/**
 * 真实 `EventSource` 实现的定位（本仓的 e2e 守卫共用）。
 *
 * 为什么不用本仓那个替身：替身再好也只是「我们以为的浏览器语义」。具名事件的派发、没有 `data`
 * 字段的块不派发、`Last-Event-ID` 自动重连——这几条都得由**规范的实现**来担，e2e 才有区分力
 * （两侧单测可以同时全绿而真实链路全死，见 `row-stream.e2e.test.tsx` 的文件头）。
 *
 * 三条实测口径：
 * 1. **一句 `require.resolve('eventsource')` 解析不到**：它是 `@modelcontextprotocol/sdk` 的传递依赖，
 *    而那个 sdk 是 `@anthropic-ai/claude-agent-sdk` 的 **peer**（由 pnpm 的 `auto-install-peers` 装上），
 *    **没有任何包把它声明成直接依赖** ⇒ pnpm 的严格链接不会把它链进本包，本包自己解析必然
 *    `MODULE_NOT_FOUND`；它真实落在 pnpm 的**隐藏提升目录**`node_modules/.pnpm/node_modules/` 里
 *    （`.pnpm` 内部的包解析得到，工作区源码解析不到）。故从本文件所在目录**逐级向上**找，每一级试两处：
 *    `<该级>/node_modules`（将来把它声明成依赖时的落点）与 `<该级>/node_modules/.pnpm`。
 * 2. **路径基准必须用 `import.meta.dirname`，不能用 `new URL(相对路径, import.meta.url)`**：
 *    jsdom 环境下全局 `URL` 是 jsdom 的实现，它构造出的 URL 对象过不了 Node 的 `fileURLToPath`
 *    （实测抛 `The URL must be of scheme file`，而同一时刻 `import.meta.url` 明明是 `file:///` 开头）。
 * 3. 找不到就**抛错**，绝不静默跳过——守卫消失比守卫变红更坏。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** 真实 `EventSource` 实现的最小形状（只用本仓需要的部分） */
export interface RealEventSource {
  close: () => void;
}
export type RealEventSourceCtor = new (url: string, options?: { fetch?: unknown }) => RealEventSource;

/** 解析不到返回 `null`：失败面（要不要抛、抛什么）由调用方一处给 */
function tryResolve(resolve: () => string): string | null {
  try {
    return resolve();
  } catch {
    return null;
  }
}

/** `eventsource` 包在本仓的实际入口（传递依赖，路径里带版本号） */
export function realEventSourcePath(): string {
  const require = createRequire(join(import.meta.dirname, 'noop.js'));
  let entry: string | null = null;
  for (let dir = import.meta.dirname, level = 0; level < 6 && entry === null; level += 1) {
    // `paths` 给的是「从哪个目录开始找 node_modules」⇒ 两处分别对应
    // `<base>/node_modules/eventsource` 与 `<base>/node_modules/.pnpm/node_modules/eventsource`
    for (const base of [dir, join(dir, 'node_modules', '.pnpm')]) {
      entry = tryResolve(() => require.resolve('eventsource', { paths: [base] }));
      if (entry !== null) break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (entry === null) {
    throw new Error(
      '找不到 eventsource 的真实实现（本仓里它是传递依赖：@modelcontextprotocol/sdk ← ' +
        '@anthropic-ai/claude-agent-sdk 的 peer）。修法：把它声明成 @aieval/client 的 devDependency 后重装。' +
        '**不要为了让 e2e 变绿而跳过守护**：它存在的理由正是「两侧单测可以同时全绿而真实链路全死」。',
    );
  }
  if (!/eventsource@3\./.test(entry)) {
    throw new Error(
      `期望 eventsource@3.x 的真实实现，实际解析到：${entry}。` +
        '依赖升级后请复核它的 SSE 语义（具名事件是否派发给 addEventListener、无名帧是否进 onmessage）再改这条断言。',
    );
  }
  return entry;
}
