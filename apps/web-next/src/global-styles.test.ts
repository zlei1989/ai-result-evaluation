// @vitest-environment node
/**
 * 全局样式 × ui 组件的**跨包字符串契约**守卫。
 *
 * 缺口长什么样：这些动效全靠 `app/globals.css` 里的类名与 `@keyframes`，而组件那一侧
 * 只是把一个字符串挂到 `className` 上。**两边对不上时浏览器不会报错**——表现只是「文字静止」，
 * 组件用例与其余守卫都不会红，这样的静默漂移在本仓已经发生过多次。
 *
 * 三条断言各有各的靶子：
 * ① 自绘高光的类名与 `@keyframes` 已删——动效只留 `Trace` 的 shimmer 一份；
 * ② 活动行走 `TraceLine status="running"` 取动效，不再自己挂类名；
 * ③ 全仓的 shimmer 关键帧只有 `tw-shimmer` 一份（自绘那一份删干净了）。
 *
 * **为什么读源码抠字面量、而不是 `import { … } from '@aieval/ui'`**：
 * 后者会把整条 antd 依赖图拖进这个 node 环境文件（实测 `import` 阶段 27.6s），而本仓的墙钟
 * 「由最长的那个文件决定」，一个字符串不值得当那个长杆。抠不到就**抛**——
 * 守卫不许静默失效（与 `runs-page-wiring.test.ts` 抠调用实参块同一套做法）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 应用根目录（`apps/web-next`）：用文件自身位置推导，不依赖 `process.cwd()`（同 `runs-page-wiring.test.ts`） */
const appRoot = join(import.meta.dirname, '..');
const cssPath = join(appRoot, 'app', 'globals.css');
const tailwindCssPath = join(appRoot, 'app', 'shadcn-tailwind.css');
const componentPath = join(appRoot, '..', '..', 'packages', 'client', 'ui', 'src', 'base', 'agent-activity-line.tsx');
const uiSrc = join(appRoot, '..', '..', 'packages', 'client', 'ui', 'src');

/** 递归收集 `.css`；`node_modules` 与点目录不算（上游产物里的关键帧不是本仓的动效来源） */
function cssFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return cssFilesUnder(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

/** 一份 CSS 里声明的全部关键帧名 */
function keyframeNames(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/@keyframes\s+([\w-]+)/g)].map((matched) => matched[1] ?? '');
}

/**
 * 活动行的高光**只有一份来源**：`Trace` 的 `shimmer`（关键帧 `tw-shimmer`）。
 *
 * 自绘那一份（`.aieval-activity-sweep` + 同名 `@keyframes`）已经删掉：同一行挂两份动效时，
 * 谁在动、按什么节奏动取决于层叠顺序，而这种叠加没有行为断言能看出来。
 * 判据落在**两份文件的字面**上：组件侧不许再挂那个类、也不许再写动画；CSS 侧一个关键帧都不许剩，
 * 全仓按名字过滤只剩 `tw-shimmer`。
 */
describe('活动行高光的唯一来源（Trace 的 shimmer）', () => {
  it('自绘高光的类名与 @keyframes 都已从 globals.css 删除', () => {
    const css = readFileSync(cssPath, 'utf8');
    expect(css).not.toContain('aieval-activity-sweep');
    expect(css).not.toContain('@keyframes aieval-activity-sweep');
  });

  it('活动行走 `TraceLine status="running"` 取动效，不再自己挂类名或写动画', () => {
    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain('TraceLine');
    expect(source).toContain('status="running"');
    expect(source).not.toContain('ACTIVITY_SWEEP_CLASS');
    // 注释里解释「为什么只剩一份动效」是说明文字，不是可执行的动画声明 ⇒ 先剥注释再判
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    expect(code).not.toMatch(/@keyframes|animation:/);
  });

  it('全仓只剩一份 shimmer 关键帧：Trace 的 tw-shimmer', () => {
    const files = [cssPath, tailwindCssPath, ...cssFilesUnder(uiSrc)];
    const shimmer = files.flatMap(keyframeNames).filter((name) => /shimmer/i.test(name));
    expect(shimmer, '自绘高光与 Trace 的 shimmer 叠成了两份动效来源').toEqual(['tw-shimmer']);
    // 反过来钉存在性：只剩一份不等于它是对的（Trace 依赖这个关键帧名）
    expect(keyframeNames(tailwindCssPath)).toContain('tw-shimmer');
  });
});

/**
 * 正文流末尾**闪烁光标**的跨包字符串契约。
 *
 * 缺口与上面那条同形：类名由 `@aieval/ui` 的 `TextBlockView` 挂在容器上，
 * 样式只在 `globals.css` 里。**两边对不上时浏览器不报错**——表现只是「光标不出现」，
 * 而它的语义是「这一块还没写完」（`assembly === 'open'`），
 * 一次被中断的回复与一次还在流的回复因此长得一样。
 *
 * 三条断言各有各的靶子：
 * ① 类名本身在（`.aieval-stream-cursor::after`）；
 * ② `content` 是那个字符——删掉它只剩一个空的伪元素，肉眼什么都看不到；
 * ③ 同名 `@keyframes` 在——少了它光标常亮，「闪烁」这个信号消失。
 */
describe('globals.css 里的流式光标', () => {
  /** 从 `base/stream-cursor.ts` 源码里抠出类名；抠不到直接抛（守卫不许静默失效） */
  function cursorClass(): string {
    const path = join(appRoot, '..', '..', 'packages', 'client', 'ui', 'src', 'base', 'stream-cursor.ts');
    const matched = /export const STREAM_CURSOR_CLASS = '([^']+)'/.exec(readFileSync(path, 'utf8'));
    const value = matched?.[1];
    if (value === undefined) {
      throw new Error('stream-cursor.ts 里找不到 STREAM_CURSOR_CLASS 的字面量定义，本守卫无法核对');
    }
    return value;
  }

  it('定义了组件带上的那个类名（用伪元素挂光标，正文一个字都不改）', () => {
    expect(readFileSync(cssPath, 'utf8')).toContain(`.${cursorClass()}::after {`);
  });

  it('伪元素有内容（少了 `content` 就只剩一个看不见的空盒子）', () => {
    const source = readFileSync(cssPath, 'utf8');
    const start = source.indexOf(`.${cursorClass()}::after {`);
    const block = source.slice(start, source.indexOf('}', start));
    expect(block, '光标伪元素没有 content').toContain('content: \'▍\'');
  });

  it('定义了同名 @keyframes（少了它光标常亮，「还在写」这个信号就没了）', () => {
    expect(readFileSync(cssPath, 'utf8')).toContain(`@keyframes ${cursorClass()} {`);
  });
});

/**
 * 活动行**打字态**的跨包字符串契约。
 *
 * 缺口与上面两条同形，但**症状不同**：这条动画挂在 `key={段号}` 重挂的那个 `span` 上，
 * 类名或 `@keyframes` 少一个，浏览器都不报错——少类名 = 换段时文字直接跳变（观感退化成
 * 「整行被替换」），少 `@keyframes` = 动画声明指向一个不存在的关键帧，元素停在最终态。
 * 两者都只有肉眼看得出，而「看得出」正是本仓不接受的判据。
 *
 * 三条断言各有各的靶子：
 * ① 类名在 CSS 里（且是 `> span` 这一层：动画要落在**重挂的那个元素**上才叫「重打」）；
 * ② 同名 `@keyframes` 在——删掉它元素停在最终态，与没有动画长得一样；
 * ③ 「减少动态效果」兜底在——动画只是入场装饰，关掉之后内容必须照旧显示。
 */
describe('globals.css 里的活动行打字态', () => {
  /** 从 `AgentActivityLine` 源码里抠出类名；抠不到直接抛（守卫不许静默失效） */
  function typingClass(): string {
    const matched = /export const ACTIVITY_TYPING_CLASS = '([^']+)'/.exec(readFileSync(componentPath, 'utf8'));
    const value = matched?.[1];
    if (value === undefined) {
      throw new Error('agent-activity-line.tsx 里找不到 ACTIVITY_TYPING_CLASS 的字面量定义，本守卫无法核对');
    }
    return value;
  }

  it('动画挂在 `> span` 上（换段重挂的正是那个元素）', () => {
    expect(readFileSync(cssPath, 'utf8')).toContain(`.${typingClass()} > span {`);
  });

  it('定义了同名 @keyframes（少了它元素停在最终态，动画等于没有）', () => {
    expect(readFileSync(cssPath, 'utf8')).toContain(`@keyframes ${typingClass()} {`);
  });

  it('「减少动态效果」下关掉入场动画（内容照旧，只是不播那一下）', () => {
    const source = readFileSync(cssPath, 'utf8');
    // 逐个媒体块找：写死「最后一个」的话，将来在其后追加任何媒体查询都会误报
    const blocks = source.split('@media (prefers-reduced-motion: reduce)').slice(1);
    const guard = blocks.find((block) => block.includes(`.${typingClass()} > span`));
    expect(guard, 'globals.css 里没有针对活动行打字态的减少动效兜底').toBeDefined();
    expect(guard ?? '', '兜底里没有关掉动画').toContain('animation: none');
  });
});

/**
 * 日志滚动区的两条样式判据。
 *
 * ① **rc-virtual-list 的滚动条补丁退役了**：虚拟化换成了 `@tanstack/react-virtual`，滚动条是浏览器原生的，
 *    那条 `--rc-virtual-list-scrollbar-bg` 补丁没有任何消费者。留着它不会报错，只会让下一个人以为
 *    还有一份自绘滚动条要维护，故这条守卫钉「不许再出现」。
 * ② **首次定位期间不可见**：`Message Scroller` 在定位完成前给 Root 标 `data-pending-scroll`，
 *    不藏起来就会看到内容从顶部闪到底部。标记名由库给，样式只能落在这里。
 */
describe('globals.css 里的日志滚动区', () => {
  it('rc-virtual-list 的滚动条变量补丁已退役（没有消费者，也不许回来）', () => {
    const css = readFileSync(cssPath, 'utf8');
    expect(css).not.toContain('--rc-virtual-list-scrollbar-bg');
    // 类名也一并不许出现：它是那条补丁的挂点
    expect(css).not.toContain('.aieval-virtual-list');
  });

  it('首次定位期间藏起滚动区（`data-pending-scroll` 由 Message Scroller 标）', () => {
    const css = readFileSync(cssPath, 'utf8');
    const rule = /\[data-slot='message-scroller'\]\[data-pending-scroll\]\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule, 'globals.css 里没有针对 data-pending-scroll 的规则').toBeDefined();
    // 只藏可见性：display:none 会让库量到的滚动几何变成 0，首次定位就再也算不准
    expect(rule ?? '', '规则里没有把元素藏起来').toContain('visibility: hidden');
  });
});
