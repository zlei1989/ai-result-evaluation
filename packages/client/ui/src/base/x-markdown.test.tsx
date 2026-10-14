/**
 * `XMarkdownText` 外壳自己的验收判据：**共用渲染器**的口径（转义 / 未闭合围栏 / GFM / 流式追加）
 * 加两条纪律（`escapeRawHtml` 恒开、明暗类名跟已解析的明暗走）。
 *
 * 为什么这些断言要落在外壳这一层，而不是全交给消费方的用例：外壳是三个消费面（考题提示词、
 * 技能正文、日志正文）**共用的那一档**，口径只写在壳里 → 消费方换一个就少一份证据。这里按外壳的
 * 输入输出钉住之后，消费方那几组用例只需要钉「选型」。
 *
 * **不进这个文件的三类**（jsdom 看不见，只能真机读计算样式 / 连续采样，见冒烟记录）：
 *   · `pre` / 块级 `code` 的 `white-space` **计算值**与 `overflow-x`（jsdom 没有 CSS 级联，
 *     内联声明那一条已由 `skill-detail-drawer.test.tsx` 钉住）；
 *   · 主题配色（「有没有半亮」要读 `getComputedStyle` 并与当前算法的 token 比；这里能钉的只有
 *     **类名选得对不对**，见「明暗类名」那一组）；
 *   · 代码高亮配色与「不闪」。
 */
import { render } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactTheme } from './density';
import { XMarkdownText } from './x-markdown';

/** 渲染外壳并取正文根；`.x-markdown` 缺席就是外壳没接上，直接抛而不是让后面的断言读 undefined */
function renderShell(text: string, open: boolean): { container: HTMLElement; body: Element; rerender: (next: string, nextOpen: boolean) => void; unmount: () => void } {
  const view = render(<XMarkdownText text={text} open={open} />);
  const body = view.container.querySelector('.x-markdown');
  if (body === null) throw new Error('外壳没有渲染出 .x-markdown');
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
 * 为什么按行而不是逐字节比整个源串：markdown 标记（围栏行、`**`）本来就不上屏，X 还会给代码块
 * 补一个结尾换行，逐字节比源串永远不等。按行比仍然能拦住三类真缺陷：**少一行**（内容被吞）、
 * **多一行**（流式缓存重置导致前缀重复）、**行内前导空格被改**（靠前导空格对齐的链路图散掉）。
 */
function sourceLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '' && !/^\s*```/.test(line));
}

/**
 * 渲染结果里**看得见的那些行**：只去空行。
 *
 * 刻意**不**在这里滤掉围栏标记：围栏标记漏进正文（X 2.9.0 缩进围栏那一档）必须让比对当场变红，
 * 滤掉就等于把缺陷一起滤掉了。
 */
function renderedLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
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

describe('XMarkdownText：原始 HTML 一律转义', () => {
  const RAW_HTML = '<img src=x onerror="alert(1)">';

  it('出的是 `&lt;img` 文本，且**没有** `<img>` 元素', () => {
    const { body, unmount } = renderShell(RAW_HTML, false);

    // 两条一起断言才拦得住倒退：只断言「元素不存在」时，一个把整段丢掉的实现也会绿
    expect(body.innerHTML, '原始 HTML 没有被转义成文本').toContain('&lt;img');
    expect(body.querySelector('img'), '原始 HTML 被解析成了真实 DOM').toBeNull();
    expect(body.textContent, '转义之后内容本身要看得见').toContain(RAW_HTML);
    unmount();
  });
});

describe('XMarkdownText：未闭合围栏', () => {
  it('0 空格开围栏 + 缺闭围栏：`code[data-state="loading"]` 在场，内容逐行等于源串', () => {
    const text = [`${FENCE}text`, ...BODY_LINES].join('\n');
    const { body, unmount } = renderShell(text, true);

    const code = body.querySelector('code');
    expect(code?.getAttribute('data-state'), '还没收尾的围栏没有进流式档').toBe('loading');
    expect(renderedLines(body.textContent ?? ''), '未闭合围栏把内容吞了').toEqual(sourceLines(text));
    unmount();
  });

  /**
   * 0–3 空格缩进的围栏是 X 2.9.0 流式走线最容易漏的一档（`feedFenceState` 逐字符判围栏）。
   * 这里钉的是**未闭合**档：必须不挂，正文一字不漏、`data-state` 是 `loading`。
   * 缩进会被 marked 从正文行里剥掉（开围栏缩进几格就剥几格），故只断言「内容在场且不重复、
   * 行内对齐用的连续空格没被改」——按缩进写死剥几格会把 marked 的正常行为当成缺陷钉住。
   */
  it.each([0, 1, 2, 3])('%i 空格缩进的未闭合围栏：进 loading 档、内容不被吞、围栏标记不漏进正文', (indent) => {
    const pad = ' '.repeat(indent);
    const text = [`${pad}${FENCE}text`, ...BODY_LINES].join('\n');
    const { body, unmount } = renderShell(text, true);

    const code = body.querySelector('code');
    expect(code?.getAttribute('data-state'), `缩进 ${indent} 的未闭合围栏没进 loading 档`).toBe('loading');
    const codeText = code?.textContent ?? '';
    for (const line of BODY_LINES) {
      expect(codeText, `缩进 ${indent} 的围栏里少了这一行：${line.trim()}`).toContain(line.trim());
    }
    // 行内那段连续空格是链路图的对齐骨架，被折行 / 归一化就散架
    expect(codeText, '代码行里的对齐空格被改了').toContain('queryFileChangeLogs   (lc-web:45)');
    expect(codeText, '围栏标记漏进了正文').not.toContain(FENCE);
    expect(codeText.match(/OpenController/g)?.length, '同一行被渲染了两次').toBe(1);
    unmount();
  });

  it.each([0, 1, 2, 3])('闭围栏缩进 %i 空格：认得出，正文逐行等于源串', (indent) => {
    const pad = ' '.repeat(indent);
    const text = [`${FENCE}text`, ...BODY_LINES, `${pad}${FENCE}`].join('\n');
    const { body, unmount } = renderShell(text, true);

    expect(body.querySelector('code')?.getAttribute('data-state'), '闭围栏没被认出来').toBe('done');
    expect(renderedLines(body.textContent ?? ''), '闭围栏那一档的正文对不上源串').toEqual(sourceLines(text));
    unmount();
  });

  /**
   * **已知会挂**：开围栏缩进 1–3 空格、且源串**以缩进的闭围栏收尾**（流式下就是「闭围栏刚到、
   * 后面还没有字符」的态）。X 2.9.0 在这里认不出闭围栏：`data-state` 停在 `loading`，
   * 闭围栏的反引号被当成正文漏进代码块。依据是紧邻的这条对照用例——同一份源串在非流式下
   * 是 `done` 且正文干净 ⇒ 差异在 `hasNextChunk` 走的流式走线，不是围栏文本本身写错。
   *
   * 用 `it.fails` 而不是把缺陷写成期望值：X 修好这一档的那天这条会**转红**，逼着把判据更新成
   * 正向断言（而不是留一条把 bug 说成正确的绿用例）。本仓不为它自绘兜底——消费面的提示词与
   * SKILL.md 里的围栏都不缩进，代价是「缩进围栏 + 流式收尾」这一格暂时读不出收没收尾。
   */
  it.fails.each([1, 2, 3])('【已知会挂】%i 空格缩进的开围栏 + 缩进闭围栏收尾（流式）该被认出', (indent) => {
    const pad = ' '.repeat(indent);
    const text = [`${pad}${FENCE}text`, ...BODY_LINES, `${pad}${FENCE}`].join('\n');
    const { body, unmount } = renderShell(text, true);

    const code = body.querySelector('code');
    expect(code?.getAttribute('data-state'), '缩进闭围栏没被认出来（X 2.9.0 已知缺陷）').toBe('done');
    expect(code?.textContent ?? '', '闭围栏的反引号漏进了正文').not.toContain(FENCE);
    unmount();
  });

  it('同一份源串在**非流式**下是 done 且干净（上一条的对照：差异在流式走线，不在围栏文本）', () => {
    const text = [` ${FENCE}text`, ...BODY_LINES, ` ${FENCE}`].join('\n');
    const { body, unmount } = renderShell(text, false);

    const code = body.querySelector('code');
    expect(code?.getAttribute('data-state'), '非流式下缩进闭围栏也认不出来').toBe('done');
    const codeText = code?.textContent ?? '';
    expect(codeText, '非流式下围栏标记漏进了正文').not.toContain(FENCE);
    for (const line of BODY_LINES) {
      expect(codeText, `非流式下少了这一行：${line.trim()}`).toContain(line.trim());
    }
    expect(codeText, '代码行里的对齐空格被改了').toContain('queryFileChangeLogs   (lc-web:45)');
    unmount();
  });
});

describe('XMarkdownText：GFM', () => {
  it('表格生成 `<table>`、`**粗体**` 生成 `<strong>`', () => {
    const text = ['| 项 | 值 |', '| --- | --- |', '| 首数 | 1 |', '', '**只推荐一首**'].join('\n');
    const { body, unmount } = renderShell(text, false);

    expect(body.querySelector('table'), 'GFM 表格没生成 table').not.toBeNull();
    expect(body.querySelector('th')?.textContent).toBe('项');
    expect(body.querySelector('td')?.textContent).toBe('首数');
    expect(body.querySelector('strong')?.textContent, '粗体没生成 strong').toBe('只推荐一首');
    unmount();
  });
});

describe('XMarkdownText：流式追加', () => {
  /**
   * 三次追加就是「打字」在 DOM 上的结果：每一次都必须**只多不少**地等于当时的源串。
   * 流式缓存（X 的 `useStreaming` 按前缀判增量）出问题时症状是前缀重复或尾巴丢掉，
   * 两者都会让这里的逐行比对变红。
   */
  it('逐次追加：每一步正文逐行等于当时的源串，闭围栏到达后 data-state 转 done', () => {
    const last = STREAM_STEPS.length - 1;
    const { container, rerender, unmount } = renderShell(STREAM_STEPS[0] ?? '', true);
    const bodyOf = (): Element => {
      const body = container.querySelector('.x-markdown');
      if (body === null) throw new Error('追加之后 .x-markdown 不见了');
      return body;
    };
    const states: Array<string | null> = [];

    STREAM_STEPS.forEach((text, index) => {
      // 第一次已经在 `renderShell` 里渲染过，追加从第二次开始
      if (index > 0) rerender(text, index < last);
      states.push(bodyOf().querySelector('code')?.getAttribute('data-state') ?? null);
      expect(renderedLines(bodyOf().textContent ?? ''), `第 ${index + 1} 次追加之后正文对不上源串`).toEqual(
        sourceLines(text),
      );
    });

    // 最后一帧闭围栏到了 ⇒ 这一块收尾了；前两帧还在流式档
    expect(states).toEqual(['loading', 'loading', 'done']);
    // 追加的观感来源是 X 的「新片段淡入」（`streaming.enableAnimation`），不是打字机：
    // jsdom 不做 CSS 动画，能读到的只有它挂上来的那层内联 animation 声明
    expect(
      bodyOf().querySelector('[style*="x-markdown-fade-in"]'),
      '新片段淡入没开（关掉它「追加」就成了硬切）',
    ).not.toBeNull();
    unmount();
  });
});

describe('XMarkdownText：明暗类名', () => {
  /**
   * X 的两份主题 CSS 靠 `.x-markdown-light` / `.x-markdown-dark` 二选一，选错就是**半亮主题**
   * ——亮色主题下正文挂 `.x-markdown-dark` 会算出白字，而页面底色是白的，正文直接读不出来。
   *
   * 这一格为什么必须**套一层紧凑密度作用域**来测：`PageShell` 给内容包的是
   * `<ConfigProvider theme={compactTheme(mode)}>`（`algorithm: [底色算法, compactAlgorithm]`），
   * 而外壳曾经拿 `theme.useToken().theme.id === 0` 判明暗——那个 `id` 是 `@ant-design/cssinjs`
   * 的 Theme **实例计数器**，只有「单给 `defaultAlgorithm`」命中 antd 模块级 `defaultTheme` 时
   * 才是 0，紧凑档是另一个实例。于是紧凑作用域里恒判为暗：在根作用域测是绿的，真实页面是白底白字。
   */
  it.each([
    ['light', 'x-markdown-light', 'x-markdown-dark'],
    ['dark', 'x-markdown-dark', 'x-markdown-light'],
  ] as const)('紧凑密度作用域 + %s：类名跟已解析的明暗走，两套类名不同时出现', (mode, expected, forbidden) => {
    document.documentElement.dataset.theme = mode;
    const view = render(
      <ConfigProvider theme={compactTheme(mode)}>
        <XMarkdownText text="正文" open={false} />
      </ConfigProvider>,
    );

    const body = view.container.querySelector('.x-markdown');
    expect(body, '外壳没有渲染出 .x-markdown').not.toBeNull();
    expect(body?.className, `紧凑作用域里明暗判错了（${mode} 下挂错主题类名＝半亮）`).toContain(expected);
    expect(body?.className, '两套主题类名同时挂上了').not.toContain(forbidden);

    view.unmount();
    delete document.documentElement.dataset.theme;
  });
});

describe('XMarkdownText：`escapeRawHtml` 恒开', () => {
  /**
   * 判据是**外壳源码**，不是行为：行为那一条（上一组）只能证明「今天开着」，
   * 而这一条要拦的是「把转义做成可传的 prop」——那等于把这条安全口径交给调用方，
   * 迟早有人为了「让某个标签生效」把它关掉，而正文是外部输入（厂商输出、随被测仓库
   * 克隆进来的 `SKILL.md`），一关就是三个消费面同时变成活元素。
   */
  const shellSource = readFileSync(join(import.meta.dirname, 'x-markdown.tsx'), 'utf8');

  it('裸写 `escapeRawHtml`（布尔简写）＝恒开，且**没有** `escapeRawHtml=` 这个 prop 形态', () => {
    expect(shellSource, '外壳没把 escapeRawHtml 打开').toMatch(/^\s*escapeRawHtml$/m);
    expect(shellSource, '转义被做成了可传的 prop').not.toMatch(/escapeRawHtml\s*=/);
  });
});
