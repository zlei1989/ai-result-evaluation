'use client';

/**
 * 顶栏：横向导航。
 * 纯 props 驱动——ui 包不调接口、不依赖路由库，跳转由应用层注入回调。
 * **刻意不在这里放产品名与主题切换**（用户口径）：产品名是装饰，而主题切换的唯一入口在设置页
 * （「跟随系统 / 明亮 / 暗色」三档，读 useSettings 的持久化偏好）。两处各放一份会变成两个真源，
 * 切换后互相打架——顶栏只保留导航这一件事。
 */
import { Layout, Menu } from 'antd';
import type { ReactNode } from 'react';

export interface AppTopNavItem {
  key: string;
  label: string;
  href: string;
}

export interface AppTopNavProps {
  items: AppTopNavItem[];
  /** 当前激活项的 key */
  active: string;
  onNavigate: (href: string) => void;
}

export function AppTopNav({ items, active, onNavigate }: AppTopNavProps): ReactNode {
  return (
    <Layout.Header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        paddingInline: 16,
        // 为什么必须显式给高（antd 自己的 height 在这层作用域里解析不出值）：
        // antd 6 的 `.ant-layout-header { height: var(--ant-layout-header-height) }`，而这个 CSS 变量
        // 由 Layout 的嵌套 ConfigProvider 作用域提供——顶栏是 PageShell 的**兄弟**节点、渲染在根作用域
        // （浏览器实测根作用域里 `--ant-layout-header-height` 为空字符串），于是该声明在计算值阶段失效，
        // height 退回 auto：实测顶栏塌到内容高度 24.67px、padding-block 0，子元素上下零余量，明显局促。
        // 写死 40 是实测过的确定值；等宽高由 flex + alignItems:center 管，
        // 不需要再调 line-height（antd 的 line-height 也读同一个空变量，本来就是 normal）。
        height: 40,
        // flexShrink:0 不是可选项：顶栏与 PageShell（height:100%）同处 .ant-app 这个纵向 flex，
        // PageShell 的 100% 会把总高顶到「视口 + 顶栏」，浏览器于是按 flex 规则把两者一起压缩——
        // 实测只写 height:40 时顶栏仍被压到 **38.27px**（PageShell 861.73），加上 flexShrink:0 后
        // 顶栏是**确定的 40px**（PageShell 让到 860），页面依然不溢出（900/900）。
        flexShrink: 0,
        // 用主题变量而非写死色值：顶栏底色必须跟着明暗切换，否则又是一处半亮
        background: 'var(--app-bg)',
        borderBottom: '1px solid var(--app-border)',
      }}
    >
      <Menu
        mode="horizontal"
        selectedKeys={[active]}
        style={{ flex: 1, minWidth: 0, background: 'transparent', borderBottom: 'none' }}
        items={items.map((item) => ({
          key: item.key,
          label: (
            // 用原生 a 承接可访问性（aria-current 由 antd 的 selectedKeys 渲染到 li 上，
            // 故这里显式标注在链接上，保证屏幕阅读器与断言都能拿到）
            <a
              href={item.href}
              aria-current={item.key === active ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(item.href);
              }}
            >
              {item.label}
            </a>
          ),
        }))}
      />
    </Layout.Header>
  );
}
