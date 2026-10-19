/**
 * `XMarkdownText` 外壳自己的验收判据：**共用渲染器**的四条口径（原始 HTML 转义 / 未闭合围栏 /
 * 围栏不折行 / 标题降级 + SSR 首帧）与共用行为（GFM、流式追加、外链）。
 *
 * 为什么这些断言要落在外壳这一层，而不是全交给消费方的用例：外壳是四个消费面（考题提示词、
 * 技能正文、日志正文、用户提示词）**共用的那一档**，口径只写在壳里 → 消费方换一个就少一份证据。
 *
 * **不进这个文件的两类**（jsdom 看不见，只能真机读计算样式 / 连续采样，见冒烟记录）：
 *   · `pre` / 代码块内 `white-space` 的**计算值**与 `overflow-x` 的实际滚动（jsdom 没有 CSS 级联，
 *     这里钉的是「没把 wrap 打开」与承载文本那一层的类名，计算样式那一半进不了 jsdom）；
 *   · 主题配色与「不闪」。
 */
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { XMarkdownText } from './x-markdown';

/** 渲染外壳并取正文根；`[data-slot="markdown"]` 缺席就是外壳没接上，直接抛而不是让后面的断言读 undefined */
function renderShell(
  text: string,
  open: boolean,
): { container: HTMLElement; body: Element; rerender: (next: string, nextOpen: boolean) => void; unmount: () => void } {
  const view = render(<XMarkdownText text={text} open={open} />);
  const body = view.container.querySelector('[data-slot="markdown"]');
  if (body === null) throw new Error('外壳没有渲染出 [data-slot="markdown"]');
  return {
    container: view.container,
    body,
    rerender: (next, nextOpen) => view.rerender(<XMarkdownText text={next} open={nextOpen} />),
    unmount: view.unmount,
  };
}

/**
 * 源串里**该上屏的那些行**：去掉空行与围栏标记行。
 *
 * 为什么按行而不是逐字节比整个源串：markdown 标记（围栏行、`**`）本来就不上屏，解析器还会给
 * 代码块补结尾换行，逐字节比源串永远不等。按行比仍然能拦住三类真缺陷：**少一行**（内容被吞）、
 * **多一行**（流式缓存重置导致前缀重复）、**行内前导空格被改**（靠前导空格对齐的链路图散掉）。
 */
function sourceLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '' && !/^\s*```/.test(line));
}

/**
 * 渲染结果里**看得见的那些行**：只去空行。
 *
 * 刻意**不**在这里滤掉围栏标记：围栏标记漏进正文必须让比对当场变红，滤掉就等于把缺陷一起滤掉。
 */
function renderedLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

/**
 * 正文全文：代码块按行拼回换行。
 *
 * `CodeBlockContent` 里每一行是一个 `[data-slot="code-block-line-content"]` 元素，`textContent`
 * 不带换行；不在这里拼回去，逐行比对会把「代码块的行」当成一行。同时把代码块的表头（语言名）
 * 一起抹掉——它是界面 chrome，不是源串。
 */
function renderedText(body: Element): string {
  const clone = body.cloneNode(true) as Element;
  for (const block of clone.querySelectorAll('[data-slot="code-block"]')) {
    const lines = Array.from(block.querySelectorAll('[data-slot="code-block-line-content"]')).map(
      (line) => line.textContent ?? '',
    );
    block.textContent = lines.join('\n');
  }
  // 块级元素的**前面**补一个换行：`textContent` 不区分块边界，代码块与紧跟的段落会连成一行
  for (const node of clone.querySelectorAll(
    'p, h1, h2, h3, h4, h5, h6, table, ul, ol, blockquote, pre, div[data-slot="code-block"]',
  )) {
    node.prepend('\n');
  }
  return clone.textContent ?? '';
}

/** 围栏代码块那一层（`CodeBlockContent` 的 `<pre>`）：判「有没有把 wrap 打开」的落点 */
function fencePre(body: Element): Element | null {
  return body.querySelector('[data-slot="code-block-content"]');
}

/** 真正承载代码文本的那一层：`CodeBlockContent` 的内层 `<code>` */
function fenceCode(body: Element): Element | null {
  return body.querySelector('[data-slot="code-block-code"]');
}

/** 复制按钮：`useIsCodeFenceIncomplete()` 在这一格的唯一可见产物（未收尾时禁用） */
function copyButton(body: Element): HTMLButtonElement | null {
  return body.querySelector<HTMLButtonElement>('[data-slot="code-block-copy-button"]');
}

/** 围栏代码块的正文（按行拼回换行） */
function fenceText(body: Element): string {
  return Array.from(body.querySelectorAll('[data-slot="code-block-line-content"]'))
    .map((line) => line.textContent ?? '')
    .join('\n');
}

/** 围栏代码块的正文：JSX 字符串里反引号太密，统一从这里取 */
const FENCE = '```';

/** 围栏里那两行正文（第二行的前导空格是链路图的对齐骨架） */
const BODY_LINES = ['POST /api/open/query-file-change-log', '  OpenController.queryFileChangeLogs   (lc-web:45)'];

/**
 * 流式追加的三帧：半截围栏（开围栏刚到）→ 正文补齐 → 闭围栏 + 收尾段落。
 * 字节序列写死在这里，不录真机 SSE：六条通道的契约会漂移，录制会腐烂成假绿。
 */
const STREAM_STEPS = [
  `先看这段调用链路：\n\n${FENCE}text\nPOST /api/open/query`,
  `先看这段调用链路：\n\n${FENCE}text\n${BODY_LINES.join('\n')}`,
  `先看这段调用链路：\n\n${FENCE}text\n${BODY_LINES.join('\n')}\n${FENCE}\n\n结论如上：这条链路只在发版时走。`,
];

describe('XMarkdownText：原始 HTML 一律转义（口径 ①）', () => {
  const RAW_HTML = '<img src=x onerror="alert(1)">';

  it('出的是 `&lt;img` 文本，且**没有** `<img>` 元素', () => {
    const { body, unmount } = renderShell(RAW_HTML, false);

    // 三条一起断言才拦得住倒退：只断言「元素不存在」时，一个把整段丢掉的实现也会绿
    expect(body.innerHTML, '原始 HTML 没有被转义成文本').toContain('&lt;img');
    expect(body.querySelector('img'), '原始 HTML 被解析成了真实 DOM').toBeNull();
    expect(body.textContent, '转义之后内容本身要看得见').toContain(RAW_HTML);
    unmount();
  });
});

describe('XMarkdownText：未闭合围栏（口径 ②）', () => {
  it('缺闭围栏的流式快照：仍是一个代码块、内容逐行等于源串、围栏标记不漏进正文', () => {
    const text = [`${FENCE}text`, ...BODY_LINES].join('\n');
    const { body, unmount } = renderShell(text, true);

    expect(fencePre(body), '半截围栏没有渲染成代码块（被当成正文吞了）').not.toBeNull();
    expect(fenceText(body), '未闭合围栏把内容吞了').toBe(BODY_LINES.join('\n'));
    expect(fenceText(body), '围栏标记漏进了正文').not.toContain(FENCE);
    // 「这一块还没收尾」在界面上的可见产物：复制按钮禁用（`useIsCodeFenceIncomplete`）
    expect(copyButton(body)?.disabled, '流式未收尾时复制按钮没有禁用').toBe(true);
    unmount();
  });

  it.each([0, 1, 2, 3])('%i 空格缩进的未闭合围栏：同样成块、内容不被吞、对齐空格没被改', (indent) => {
    const pad = ' '.repeat(indent);
    const text = [`${pad}${FENCE}text`, ...BODY_LINES].join('\n');
    const { body, unmount } = renderShell(text, true);

    expect(fencePre(body), `缩进 ${indent} 的未闭合围栏没渲染成代码块`).not.toBeNull();
    const codeText = fenceText(body);
    for (const line of BODY_LINES) {
      expect(codeText, `缩进 ${indent} 的围栏里少了这一行：${line.trim()}`).toContain(line.trim());
    }
    // 行内那段连续空格是链路图的对齐骨架，被折行 / 归一化就散架
    expect(codeText, '代码行里的对齐空格被改了').toContain('queryFileChangeLogs   (lc-web:45)');
    expect(codeText, '围栏标记漏进了正文').not.toContain(FENCE);
    expect(codeText.match(/OpenController/g)?.length, '同一行被渲染了两次').toBe(1);
    unmount();
  });

  it('闭围栏到达后不再是「未收尾」：复制按钮解禁，正文逐行等于源串', () => {
    const text = [`${FENCE}text`, ...BODY_LINES, FENCE].join('\n');
    const { body, unmount } = renderShell(text, true);

    expect(copyButton(body)?.disabled, '闭围栏到了复制按钮还禁用着').toBe(false);
    expect(renderedLines(renderedText(body)), '闭围栏那一档的正文对不上源串').toEqual(sourceLines(text));
    unmount();
  });
});

describe('XMarkdownText：围栏不折行（口径 ③）', () => {
  /**
   * 断言的落点是**真正承载文本的那一层**（`code-block-code` 与它下面每行的
   * `code-block-line-content`），不是宿主 `pre`：本仓踩过「把断言挂在宿主上、内层自己在折」
   * 那个坑（`MonoText`）。jsdom 没有 CSS 级联，能钉的是这两件：
   *   1. `pre` 没有 `data-wrap`——`data-wrap:whitespace-pre-wrap` 那条变体因此不可能命中；
   *   2. 文本层的 `code` 是 `min-w-max`（撑到内容宽）且**没有**任何折行类。
   * 计算样式（`getComputedStyle().whiteSpace === 'pre'`）与真实横向滚动只能真机量。
   */
  it('`wrap` 没打开、文本层按内容宽排版、前导空格逐字保留', () => {
    const text = [`${FENCE}text`, ...BODY_LINES, FENCE].join('\n');
    const { body, unmount } = renderShell(text, false);

    const pre = fencePre(body);
    expect(pre, '围栏代码块没有渲染').not.toBeNull();
    expect(pre?.hasAttribute('data-wrap'), '代码块被打开了 wrap（那就开始折行了）').toBe(false);

    const code = fenceCode(body);
    const className = code?.className ?? '';
    expect(className, '文本层没有撑到内容宽（会被容器挤着折行）').toContain('min-w-max');
    expect(className, '文本层写了 pre-wrap，折行发生在它自己那一层').not.toContain('whitespace-pre-wrap');
    expect(className, '文本层写了 break-word，折行发生在它自己那一层').not.toContain('wrap-break-word');

    const lines = Array.from(body.querySelectorAll('[data-slot="code-block-line-content"]')).map(
      (line) => line.textContent,
    );
    expect(lines, '前导空格被归一化了（链路图的对齐骨架会散掉）').toContain(
      '  OpenController.queryFileChangeLogs   (lc-web:45)',
    );
    unmount();
  });
});

describe('XMarkdownText：标题降级 + SSR 首帧（口径 ④）', () => {
  it('h1 落到 h4、h2–h6 落到 h5，正文里不长出页面级标题', () => {
    const text = ['# 一级', '## 二级', '### 三级', '#### 四级', '##### 五级', '###### 六级'].join('\n\n');
    const { body, unmount } = renderShell(text, false);

    expect(body.querySelector('h1'), '正文里长出了 h1（页面级标题）').toBeNull();
    expect(body.querySelector('h2')).toBeNull();
    expect(body.querySelector('h3')).toBeNull();
    expect(body.querySelector('h4')?.textContent).toBe('一级');
    expect(Array.from(body.querySelectorAll('h5')).map((node) => node.textContent)).toEqual([
      '二级',
      '三级',
      '四级',
      '五级',
      '六级',
    ]);
    unmount();
  });

  /**
   * SSR 首帧**有正文**：消毒走纯 JS 的 `rehype-sanitize` + `rehype-harden`，渲染路径不碰 DOM，
   * 所以服务端就能出完整 HTML（旧渲染器「服务端空 div、hydrate 后才有字」那条边界不再存在）。
   * 这条判据要拦的是「又退回服务端空壳」——首屏面无字、内容和布局一起后到。
   */
  it('服务端首帧就有正文与代码块（不是空壳）', () => {
    const text = ['正文第一句', '', `${FENCE}text`, ...BODY_LINES, FENCE].join('\n');
    const html = renderToStaticMarkup(<XMarkdownText text={text} open={false} />);

    expect(html, 'SSR 首帧是空壳：正文不在服务端产物里').toContain('正文第一句');
    expect(html, 'SSR 首帧里没有代码块').toContain('POST /api/open/query-file-change-log');
    expect(html, 'SSR 首帧把代码块渲染成了行内 code').toContain('data-slot="code-block-content"');
  });
});

describe('XMarkdownText：共用渲染器行为', () => {
  it('GFM：表格生成 `<table>`、`**粗体**` 生成 `<strong>`', () => {
    const text = ['| 项 | 值 |', '| --- | --- |', '| 首数 | 1 |', '', '**只推荐一首**'].join('\n');
    const { body, unmount } = renderShell(text, false);

    expect(body.querySelector('table'), 'GFM 表格没生成 table').not.toBeNull();
    expect(body.querySelector('th')?.textContent).toBe('项');
    expect(body.querySelector('td')?.textContent).toBe('首数');
    expect(body.querySelector('strong')?.textContent, '粗体没生成 strong').toBe('只推荐一首');
    unmount();
  });

  it('外链：新标签打开并挡掉 `window.opener`', () => {
    const { body, unmount } = renderShell('[文档](https://example.com/doc)', false);

    const link = body.querySelector('a');
    expect(link?.getAttribute('target'), '外链没有新标签打开').toBe('_blank');
    expect(link?.getAttribute('rel'), '外链没有挡掉 window.opener').toContain('noopener');
    expect(link?.getAttribute('rel'), '外链没有挡掉 referrer').toContain('noreferrer');
    unmount();
  });

  /**
   * 三次追加就是「打字」在 DOM 上的结果：每一次都必须**只多不少**地等于当时的源串。
   * 流式缓存（未闭合围栏补齐 / 块缓存）出问题时症状是前缀重复或尾巴丢掉，
   * 两者都会让这里的逐行比对变红。
   */
  it('逐次追加：每一步正文逐行等于当时的源串，闭围栏到达后「未收尾」解除', () => {
    const last = STREAM_STEPS.length - 1;
    const { container, rerender, unmount } = renderShell(STREAM_STEPS[0] ?? '', true);
    const bodyOf = (): Element => {
      const body = container.querySelector('[data-slot="markdown"]');
      if (body === null) throw new Error('追加之后正文根不见了');
      return body;
    };
    const incompleteFlags: boolean[] = [];

    STREAM_STEPS.forEach((text, index) => {
      // 第一次已经在 `renderShell` 里渲染过，追加从第二次开始
      if (index > 0) rerender(text, index < last);
      incompleteFlags.push(copyButton(bodyOf())?.disabled ?? false);
      expect(renderedLines(renderedText(bodyOf())), `第 ${index + 1} 次追加之后正文对不上源串`).toEqual(
        sourceLines(text),
      );
    });

    // 最后一帧闭围栏到了 ⇒ 这一块收尾了；前两帧还在流式档
    expect(incompleteFlags).toEqual([true, true, false]);
    unmount();
  });
});

describe('XMarkdownText：`open` 必填、安全口径不交给调用方', () => {
  /**
   * 判据是**外壳源码**，不是行为：行为那一条只能证明「今天开着」，而这一条要拦的是
   * 「把安全口径做成可传的 prop」——那等于把它交给调用方，迟早有人为了「让某个标签生效」
   * 把 raw HTML 放回来，而正文是外部输入（厂商输出、随被测仓库克隆进来的 `SKILL.md`）。
   */
  const shellSource = readFileSync(join(import.meta.dirname, 'x-markdown.tsx'), 'utf8');
  // 注释里会写到这几个名字（说明为什么不用它们），判据只看**代码**
  const shellCode = shellSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('裸写 sanitize + harden 两个插件（不传 raw），且没有 skipHtml / rehypePlugins prop', () => {
    expect(shellCode, '外壳没有显式声明「只消毒、不放 raw HTML」的插件表').toMatch(
      /rehypePlugins=\{\[defaultRehypePlugins\.sanitize, defaultRehypePlugins\.harden\]/,
    );
    // 「做成 prop」的三种形态：写在 props 接口里、从调用方透传、或按名字拼一份
    expect(shellCode, '`rehypePlugins` 出现在 props 接口里（安全口径交给了调用方）').not.toMatch(
      /interface XMarkdownTextProps\s*\{[^}]*rehypePlugins/,
    );
    const streamdownTag = /<Streamdown\b[\s\S]*?>/.exec(shellCode)?.[0] ?? '';
    expect(streamdownTag, '外壳把调用方的 props 透传给了渲染器').not.toContain('...');
    expect(shellCode, '用了 skipHtml（那是删节点，不是转义成文本）').not.toMatch(/skipHtml/);
    expect(shellCode, '把 raw HTML 的插件加回来了').not.toMatch(/defaultRehypePlugins(\.|\[['"])raw/);
  });

  it('`open` 必填、不给默认值（静默拿到 `false` 就等于静默丢掉「还在写」）', () => {
    expect(shellSource, '`open` 被改成了可选').not.toMatch(/open\s*\?/);
    expect(shellSource, '`open` 被给了默认值').not.toMatch(/open\s*=\s*(false|true)/);
    expect(shellSource, '`open` 不再是必填的 boolean').toMatch(/open:\s*boolean;/);
  });
});
