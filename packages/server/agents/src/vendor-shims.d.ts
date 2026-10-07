/**
 * 三个厂商包只以「运行时依赖」身份存在（spec §5.6.2 末段）：这里把它们声明成裸模块，于是
 * `await import('@x')` 的类型是 any，各家 `sdk.ts` 再 `as unknown as <自声明窄结构>`。
 * 为什么这样做：厂商发一个破坏性类型变更不该让本仓 typecheck 失败——它只应该在运行时被加载
 * 降级（§5.6.6）与错误码兜住；顺带让「包还没装」也不影响 typecheck。
 * 硬性约束：**任何地方都不允许 `import type` 厂商包**（有静态断言守着）。
 * 若某家自带类型且 TS 优先采用它，本文件同样无害：我们从不消费厂商类型，一律显式收窄。
 */
declare module '@anthropic-ai/claude-agent-sdk';
declare module '@openai/codex-sdk';
declare module '@deepseek-ai/dsh-sdk-client';
