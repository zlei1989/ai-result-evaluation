// @vitest-environment node
/**
 * 应答宿主的**接线**守卫。判定与文案在 `@aieval/client`（那些有用例），队列规则在纯函数里，
 * 但「订阅挂上了没有、面板接的是不是队列、紧凑主题包了没有」这三件事只存在于装配处——
 * 而 web-next 不能写 `.tsx` 用例（本应用必须留 `jsx: preserve`，Vite 的 import-analysis 会直接报错），
 * 故沿用同目录既有页面装配守卫的手法：读源码、抠出那一小块断言。
 *
 * 这一层要挡的五种静默死法（每一条都不会让任何别的用例变红）：
 *   ① `providers.tsx` 不再挂 `<AskUserHost />` ⇒ 整个应答面在生产里不存在；
 *   ② 面板接的不是队列的产物（写死 `questions={[]}`、`open={false}`、少了 `onComplete`）⇒ 弹层永远不出现；
 *   ③ 宿主不自己包紧凑主题 ⇒ 弹层在页面上按默认密度渲染（正文 14px，而全站是 12px），
 *      单测看不出来、真机一眼看得出；
 *   ④ 换成 `window` 自定义事件或 `CustomEvent` 派发 ⇒ 绕过类型检查的第二条真相（spec 已裁定不引入）；
 *   ⑤ 宿主不读 run 焦点（把 `useAskUserQueue` 的焦点省掉）⇒ 切走的那一轮的提问照旧弹出来，
 *      「暂缓」在生产里不存在——而客户端那几条暂缓用例**全绿**（它们直接喂焦点，不经过宿主）。
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
  it('providers.tsx 渲染 <AskUserHost />，且在 AntdApp 的子树里', () => {
    expect(providersSource, '根 Provider 没挂应答宿主').toMatch(/<AskUserHost\s*\/>/);
    // 顺序即嵌套：message 上下文（AntdApp）必须先于它出现（提交失败要能弹提示）
    const host = providersSource.indexOf('<AskUserHost');
    expect(providersSource.indexOf('<AntdApp'), '宿主不在 AntdApp 子树里（拿不到 message 上下文）').toBeLessThan(host);
    // 密度不再是 React 上下文：`:root` 就是紧凑档，宿主在页面壳外面也拿到同一组变量
    expect(providersSource, '主题又长出了 React 上下文这条第二真源').not.toContain('<DensityProvider');
  });

  it('宿主从数据层取队列与焦点，而不是自己订阅或自己拼状态', () => {
    expect(hostSource, '宿主没有用数据层的订阅 hook').toContain('useAskUserQueue({ focusedRunId })');
    // 焦点只有一处来源（`run-focus.ts` 那个单例）：宿主自己攒一个 state 就是第二条真相
    expect(hostSource, '宿主没有订阅式读 run 焦点（暂缓在生产里就不存在）').toContain('useFocusedRun()');
    // 订阅与队列都归数据层：宿主里出现 EventSource / fetch 就是又长出了一条真相
    expect(hostSource, '宿主自己开了连接（订阅归数据层）').not.toContain('EventSource');
    expect(hostSource, '宿主自己发了请求（应答动作归数据层）').not.toContain('fetch(');
    expect(hostSource, '引入了 window 自定义事件（spec 已裁定不引入）').not.toMatch(/CustomEvent|dispatchEvent/);
  });

  it('宿主不另包主题（密度取 :root 的紧凑档，字号只有一个来源）', () => {
    expect(hostSource, '宿主又包了一层 ConfigProvider（第二份字号/主题来源）').not.toContain('<ConfigProvider');
    expect(hostSource, '宿主自己拼了主题算法').not.toContain('compactAlgorithm');
    // 面板挂在页面壳外面，但 CSS 变量按文档根继承 ⇒ 拿到的就是紧凑档
    expect(hostSource, '宿主还在读已退役的密度上下文').not.toContain('useDensityMode');
  });

  it('面板接的是队列：开合、题面、在途、完成与关闭一个不少', () => {
    const props = jsxProps(hostSource, 'AskUserPanel');

    expect(props, '开合没接队列的当前一问').toContain('open={current !== null}');
    // 题面取的是**有资格弹的那一问**，不是队首：队首可能正暂缓（别的轮次的），也可能刚被关掉
    expect(props, '题面没接当前可弹的那一问').toContain('questions={current?.questions ?? []}');
    expect(props, '在途标志没接').toContain('submitting={submitting}');
    expect(props, '完成回调没接应答动作').toContain('submit(answers)');
    expect(props, '关闭回调没接').toContain('onClose={close}');
    // 换题必须重挂：面板的步进与草稿是内部 state，不重挂就会把上一题的选择带进下一题
    expect(props, '没有按 askId 强制换题重挂').toContain('key={current?.askId');
  });

  it('「关掉」不是「回答」：关掉之后还有一个回到那一问的入口，且只提示焦点内可答的那些', () => {
    // 关掉只记本地记号（current 变 null），那一问仍在队列里 —— 没有这个入口，误点一次就再也答不了。
    // 条数取 `answerableCount`（焦点内有资格弹的）：暂缓的那些在这里点不到任何东西
    expect(hostSource, '关掉之后没有回到待答提问的入口').toMatch(/current === null && answerableCount > 0/);
    const entry = jsxProps(hostSource, 'Button');
    expect(entry, '常驻入口没接重新打开').toContain('onClick={reopen}');
    // 入口的条数取 `answerableCount`（焦点内有资格弹的）：暂缓的那些在这里点不到任何东西。
    // 断言落在徽标的**正文**上，不是按钮的 aria-label——后者也含这个变量名，改坏徽标照样绿
    expect(hostSource, '入口没把待答条数画出来').toMatch(/<Badge[^>]*>\s*\{answerableCount\}\s*<\/Badge>/);
  });
});
