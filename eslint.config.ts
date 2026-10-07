/**
 * 仓库根 ESLint 配置：`pnpm lint` / `pnpm format` 靠它在**一个**进程里覆盖全部 8 个包。
 * 逐包跑（`pnpm -r lint`）时每个包都要重新起 Node、重新加载 TS parser 与三个插件，
 * 实测 14.5s 里约 12s 是启动税，而 94 个源文件本身跑完不到 1s。
 *
 * 各包自己的 `eslint.config.ts` 仍然保留（`pnpm --filter @aieval/<包> lint` 走那条路径），
 * 两边都由 `eslint.shared.ts` 的同一份 `boundaryConfigs()` 派生，不存在规则抄两遍的漂移。
 */
import { workspaceConfig } from './eslint.shared';

export default workspaceConfig;
