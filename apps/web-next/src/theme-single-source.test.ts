// @vitest-environment node
/**
 * 主题单一真源的**仓库级 grep 守卫**：组件里不许再取 antd token，
 * 也不许把「静态渲染器」那两条历史通道接回来。
 *
 * 缺口长什么样：组件里再写一次 `useToken` 取颜色，在迁移期「还能用」——
 * 但它读的是最近一层 `ConfigProvider` 下发的 antd token，而底色已经改由
 * `html[data-theme]` 的 CSS 变量决定。两者不同源 ⇒ 半亮主题，且只在切主题时才看得见。
 * 同理，树外渲染器与 `useResolvedTheme()` 里的主题对象一旦残留，
 * 就等于给主题开了第二条真源。
 *
 * 扫源码文本而不是逐组件渲染：这一条要拦的正是「有人图省事又加一处」这类扩散；
 * 渲染级断言只能覆盖眼前调用的那几个组件。命中片段用拼接构造，守卫自己不会命中自己。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
/** 生产代码与测试一起扫：测试里的探针同样会变成「第二条取色路径」 */
const SCAN_ROOTS = [join(repoRoot, 'packages', 'client', 'ui', 'src'), join(repoRoot, 'apps', 'web-next')];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage']);

/** 递归收集 .ts / .tsx 源码 */
function collect(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...collect(path));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(path);
    }
  }
  return files;
}

const sources = SCAN_ROOTS.flatMap(collect).map((path) => ({
  path: path.slice(repoRoot.length + 1),
  text: readFileSync(path, 'utf8'),
}));

/** 去掉注释：说明文字里写 `from 'antd'`（讲为什么拆桥）不是解析请求 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/** 找出命中某片段的所有文件与行号，失败信息里直接给出可点的位置 */
function hits(pattern: string): string[] {
  return sources.flatMap(({ path, text }) =>
    text
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes(pattern))
      .map(({ number }) => `${path}:${number}`),
  );
}

describe('主题单一真源', () => {
  it('antd 的 useToken 取色归零（颜色只从 CSS 变量取）', () => {
    expect(hits(`theme.${'useToken'}`)).toEqual([]);
  });

  it('antd 全局配置的静态写入口归零（不再有第二条主题通道）', () => {
    expect(hits(`ConfigProvider.${'config'}(`)).toEqual([]);
  });

  it('树外渲染器的钩子归零（toast / dialog 宿主住在 React 树里）', () => {
    expect(hits(`holder${'Render'}`)).toEqual([]);
  });

  it('useResolvedTheme 不再产出 themeConfig（只剩 mode / preference）', () => {
    const appTheme = sources.find(({ path }) => path.endsWith('base/app-theme.tsx'));
    if (appTheme === undefined) throw new Error('找不到 base/app-theme.tsx，本守卫无法核对');
    expect(appTheme.text).not.toContain(`Theme${'Config'}`);
    expect(appTheme.text).not.toContain(`theme${'Config'}`);
  });

  /**
   * antd 与「过渡桥」同进同退。
   *
   * 为什么是**双向**的：只钉「桥必须在」，antd 清零之后它就退化成一句永远为真的废话；
   * 只钉「桥必须不在」，过渡期又会悄悄退回「白卡片铺黑底」——而那个症状只在暗色下出现，
   * 开发时默认暗色兜底恰好能看见，一旦有人把默认改回亮色就再也发现不了。
   * 两头都钉，这条守卫才有终点：它会在最后一个 antd 消费者消失的那次提交上要求拆桥。
   */
  it('antd 与明暗过渡桥同进同退', () => {
    const antdConsumers = sources.filter(({ text }) => /from ['"]antd['"]/.test(stripComments(text)));
    const providers = sources.find(({ path }) => path.endsWith('app/providers.tsx'));
    if (providers === undefined) throw new Error('找不到 app/providers.tsx，本守卫无法核对');
    const hasBridge = providers.text.includes('antdTheme.darkAlgorithm');
    if (antdConsumers.length > 0) {
      expect(hasBridge, `还有 ${antdConsumers.length} 个文件 import antd，明暗过渡桥必须在`).toBe(true);
    } else {
      expect(hasBridge, 'antd 已清零，过渡桥要拆掉').toBe(false);
    }
  });

  it('app-theme 的 apply 副作用只写两个属性（不再写 antd 全局单例）', () => {
    const appTheme = sources.find(({ path }) => path.endsWith('base/app-theme.tsx'));
    if (appTheme === undefined) throw new Error('找不到 base/app-theme.tsx，本守卫无法核对');
    expect(appTheme.text).toContain('document.documentElement.dataset.theme = mode');
    expect(appTheme.text).toContain('document.documentElement.dataset.themePreference = preference');
  });
});
