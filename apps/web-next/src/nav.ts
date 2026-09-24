/** 顶栏导航项：路径与标题的唯一来源（顶栏与页面都用它，避免两处各写一份中文） */
export const NAV_ITEMS = [
  { key: 'cases', label: '用例', href: '/cases' },
  { key: 'runs', label: '评测', href: '/runs' },
  { key: 'settings', label: '设置', href: '/settings' },
] as const;

export type NavKey = (typeof NAV_ITEMS)[number]['key'];
