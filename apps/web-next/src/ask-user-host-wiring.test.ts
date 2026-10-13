// @vitest-environment node
/**
 * 应答宿主的**接线**守卫。判定与文案在 `@aieval/client`（那些有用例），队列规则在纯函数里，
 * 但「订阅挂上了没有、面板接的是不是队列、紧凑主题包了没有」这三件事只存在于装配处——
 * 而 web-next 不能写 `.tsx` 用例（本应用必须留 `jsx: preserve`，Vite 的 import-analysis 会直接报错），
 * 故沿用同目录既有页面装配守卫的手法：读源码、抠出那一小块断言。
 *
 * 这一层要挡的四种静默死法（每一条都不会让任何别的用例变红）：
 *   ① `providers.tsx` 不再挂 `<AskUserHost />` ⇒ 整个应答面在生产里不存在；
 *   ② 面板接的不是队列的产物（写死 `questions={[]}`、`open={false}`、少了 `onComplete`）⇒ 弹层永远不出现；
 *   ③ 宿主不自己包紧凑主题 ⇒ 弹层在页面上按默认密度渲染（正文 14px，而全站是 12px），
 *      单测看不出来、真机一眼看得出；
 *   ④ 换成 `window` 自定义事件或 `CustomEvent` 派发 ⇒ 绕过类型检查的第二条真相（spec 已裁定不引入）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = join(import.meta.dirname, '..', 'app');
const providersSource = readFileSync(join(appDir, 'providers.tsx'), 'utf8');
const hostSource = readFileSync(join(appDir, 'ask-user-host.tsx'), 'utf8');

/**
 * 抠出某个 JSX 元素的属性区（从 `<Name` 扫到花括号深度为 0 的那一个 `>`）。
 * 不能简单地找 `/>`：属性值里嵌元素（`icon={<X />}`）会先撞上内层的自闭合。
 * 抠不到直接抛，避免守卫变成永远为真的空断言。
 */
function jsxProps(source: string, tag: string): string {
  const start = source.indexOf(`<${tag}`);
  if (start < 0) throw new Error(`找不到 <${tag} …> 这个元素`);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '>' && depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`<${tag} …> 没有在预期处结束`);
}

describe('全局 Provider 挂上应答宿主', () => {
  it('providers.tsx 渲染 <AskUserHost />，且在 DensityProvider 与 AntdApp 的子树里', () => {
    expect(providersSource, '根 Provider 没挂应答宿主').toMatch(/<AskUserHost\s*\/>/);
    // 顺序即嵌套：明暗上下文（DensityProvider）与 message 上下文（AntdApp）都必须先于它出现
    const host = providersSource.indexOf('<AskUserHost');
    expect(providersSource.indexOf('<DensityProvider'), '宿主不在 DensityProvider 子树里').toBeLessThan(host);
    expect(providersSource.indexOf('<AntdApp'), '宿主不在 AntdApp 子树里（拿不到 message 上下文）').toBeLessThan(host);
  });

  it('宿主从数据层取队列，而不是自己订阅或自己拼状态', () => {
    expect(hostSource, '宿主没有用数据层的订阅 hook').toContain('useAskUserQueue()');
    // 订阅与队列都归数据层：宿主里出现 EventSource / fetch 就是又长出了一条真相
    expect(hostSource, '宿主自己开了连接（订阅归数据层）').not.toContain('EventSource');
    expect(hostSource, '宿主自己发了请求（应答动作归数据层）').not.toContain('fetch(');
    expect(hostSource, '引入了 window 自定义事件（spec 已裁定不引入）').not.toMatch(/CustomEvent|dispatchEvent/);
  });

  it('宿主自己包紧凑主题（它在页面壳外面，不包就是默认密度）', () => {
    expect(hostSource, '宿主没读实际明暗').toContain('useDensityMode()');
    expect(hostSource, '宿主没包紧凑主题').toMatch(/<ConfigProvider\s+theme=\{COMPACT_THEMES\[mode\]\}/);
    // 紧凑主题只有一处定义点（ui 包的 compactTheme），宿主不许自己写 algorithm / fontSize
    expect(hostSource, '宿主自己拼了主题（应走 compactTheme）').not.toContain('compactAlgorithm');
  });

  it('面板接的是队列：开合、题面、在途、完成与关闭一个不少', () => {
    const props = jsxProps(hostSource, 'AskUserPanel');

    expect(props, '开合没接队列的当前一问').toContain('open={current !== null}');
    expect(props, '题面没接队首').toContain('questions={head?.questions ?? []}');
    expect(props, '在途标志没接').toContain('submitting={submitting}');
    expect(props, '完成回调没接应答动作').toContain('submit(answers)');
    expect(props, '关闭回调没接').toContain('onClose={close}');
    // 换题必须重挂：面板的步进与草稿是内部 state，不重挂就会把上一题的选择带进下一题
    expect(props, '没有按 askId 强制换题重挂').toContain('key={head?.askId');
  });

  it('「关掉」不是「回答」：关掉之后还有一个回到那一问的入口', () => {
    // 关掉只记本地记号（current 变 null），那一问仍在队列里 —— 没有这个入口，误点一次就再也答不了
    expect(hostSource, '关掉之后没有回到待答提问的入口').toMatch(/current === null && pendingCount > 0/);
    expect(jsxProps(hostSource, 'FloatButton'), '浮动入口没接重新打开').toContain('onClick={reopen}');
  });
});
