// @vitest-environment node
/**
 * 导航项守卫：脚手架示例页 `/demo` 已随用例页落地而删除（spec §2 末段、接口契约 §9）。
 * 这条守的是「示例页被重新加回来」——那会让新用户点进一个用假数据的页面，
 * 而且它当年就是为了验证布局原语才存在的，现在布局原语已经有了真实消费者。
 */
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from './nav';

describe('NAV_ITEMS', () => {
  // 断言里带着顺序：顶栏顺序也是需求（评测 / 用例 / 设置），不只断言「有这三项」。
  it('只有评测 / 用例 / 设置三项，且顺序为评测 → 用例 → 设置', () => {
    expect(NAV_ITEMS.map((item) => item.key)).toEqual(['runs', 'cases', 'settings']);
  });

  it('不含 /demo（示例页已删除）', () => {
    // 这里必须把 href 放宽成 string 再比：`NAV_ITEMS` 是 `as const`，`item.href` 的类型是
    // `'/cases' | '/runs' | '/settings'` 这个字面量联合，直接与 '/demo' 比较会被 TS 判为
    // 「两个类型没有交集」（TS2367）而让 `pnpm typecheck` 红——brief 的逐字版本编译不过，
    // 这是本项目唯一对它的改动（只加一层类型放宽，断言与语义完全不变）。
    // 放宽之后守卫仍然有效：把 demo 项加回 NAV_ITEMS，本用例与前一条都会失败（变异验证实测）。
    expect(NAV_ITEMS.some((item) => (item.href as string) === '/demo')).toBe(false);
  });

  it('三项都配了图标（顶栏三项形态一致）', () => {
    // 为什么值得钉：漏配一个图标不会报错，只会让顶栏看起来「两个有一个没有」——
    // 这类漂移没有任何自动信号，只能靠断言兜住。TS 也拦不住：`icon` 在 AppTopNavItem 里是可选的，
    // 后加第四项时忘了给图标，类型检查照样通过。
    expect(NAV_ITEMS.map((item) => item.icon === undefined)).toEqual([false, false, false]);
  });
});
