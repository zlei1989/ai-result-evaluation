/**
 * 顶栏导航项：路径、标题与图标的唯一来源（顶栏与页面都用它，避免两处各写一份中文）。
 *
 * 图标给的是**组件引用**而不是 JSX 元素：本文件是纯 `.ts`（放不下 JSX），而改成 `.tsx` 会被
 * vitest 的 import-analysis 按 tsconfig 的 `jsx: preserve` 拒绝（见 AGENTS.md「测试」表的既定口径）。
 * 渲染与 `aria-hidden` 由 `@aieval/ui` 的 `AppTopNav` 负责——装饰性图标的可访问性处理只留一份。
 */
import { ExperimentOutlined, FileTextOutlined, SettingOutlined } from '@ant-design/icons';

// 顺序即顶栏顺序：评测（主任务）在前，用例（评测的输入）次之，设置（低频）收尾。
export const NAV_ITEMS = [
  // 评测 = 跑一轮并出分，形如一次实验记录
  { key: 'runs', label: '评测', href: '/runs', icon: ExperimentOutlined },
  // 用例 = 仓库 + commit + 考题提示词，是一份「题面文档」
  { key: 'cases', label: '用例', href: '/cases', icon: FileTextOutlined },
  { key: 'settings', label: '设置', href: '/settings', icon: SettingOutlined },
] as const;

export type NavKey = (typeof NAV_ITEMS)[number]['key'];
