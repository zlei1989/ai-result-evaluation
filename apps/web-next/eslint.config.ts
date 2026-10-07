import { withBoundary } from '../../eslint.shared';

// `next-env.d.ts` 的 ignore 已收进 `withBoundary('web-next')`，理由见 `eslint.shared.ts` 的
// `boundaryConfigs()`：根配置要把同一份配置按目录前缀化后复用，包级配置里不能有「只有包内
// 路径才成立」的散装条目。
export default withBoundary('web-next');
