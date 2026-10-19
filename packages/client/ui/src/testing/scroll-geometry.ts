/**
 * 给 jsdom 假一份「可滚动的日志区」。
 *
 * 为什么需要：`Message Scroller` 判「下方还有内容」靠 `getBoundingClientRect` 与
 * `scrollHeight - clientHeight`，`@tanstack/react-virtual` 量行高靠 `offsetHeight`；
 * jsdom 没有布局，这些读数恒为 0 ⇒「读者上翻 ⇒ 释放跟随」这条路径在单测里**永远不可达**
 * （几何全零时库只会认为「没有可滚内容」）。本助手只伪造这几个几何读数，其余属性穿透到原实现。
 *
 * 假布局的形状与浏览器一致：
 *   · 视口高 `viewportHeight`，每行高 `rowHeight`；
 *   · 行根节点带虚拟列表给的 `translateY(start)`，它在文档里的偏移就是 `start`；
 *   · 视口矩形固定在 `top: 0`，行在视口里的顶 = `start - scrollTop`（随滚动上移）。
 *
 * `Element.prototype.scrollTo` 由共享 setup 补（写 `scrollTop`），故库的定位命令在这里同样可观察。
 */

/** 日志滚动视口的选择器：与 `LogScroller` 上的 `data-testid` 同源 */
const VIEWPORT_SELECTOR = '[data-testid="agent-log-scroll-viewport"]';

export interface ScrollGeometryOptions {
  /** 视口高度（px） */
  viewportHeight: number;
  /** 每行高度（px） */
  rowHeight: number;
}

/** 造一个只带本助手会用到的字段的 `DOMRect`（jsdom 里没有布局，其余字段无意义） */
function rectOf(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 0,
    bottom: top + height,
    width: 0,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 内容区（`MessageScrollerContent`）当前的总高度：虚拟列表把 `getTotalSize()` 写成它的内联高度 */
function contentHeightOf(viewport: Element): number {
  const content = viewport.querySelector('[data-slot="message-scroller-content"]');
  const height = content instanceof HTMLElement ? content.style.height : '';
  const parsed = Number.parseFloat(height);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 行根节点上虚拟列表给的位移（`translateY(123px)`）；不是行节点时返回 `null` */
function translateOf(element: HTMLElement): number | null {
  const matched = /translateY\((-?[\d.]+)px\)/.exec(element.style.transform);
  const value = matched?.[1];
  if (value === undefined) return null;
  return Number.parseFloat(value);
}

/**
 * 安装假几何；返回卸载函数（应在用例的 `afterEach` 里调用）。
 *
 * 每个被改写的方法都保留原实现的引用：非视口 / 非行节点的读数照旧走 jsdom，
 * 免得把其它组件的测量一起骗了。
 */
export function installScrollGeometry(options: ScrollGeometryOptions): () => void {
  const { viewportHeight, rowHeight } = options;
  const elementProto = window.Element.prototype;
  const htmlProto = window.HTMLElement.prototype;

  const savedClientHeight = Object.getOwnPropertyDescriptor(elementProto, 'clientHeight');
  const savedScrollHeight = Object.getOwnPropertyDescriptor(elementProto, 'scrollHeight');
  const savedOffsetHeight = Object.getOwnPropertyDescriptor(htmlProto, 'offsetHeight');
  const savedRect = elementProto.getBoundingClientRect;

  Object.defineProperty(elementProto, 'clientHeight', {
    configurable: true,
    get(this: Element): number {
      if (this.matches(VIEWPORT_SELECTOR)) return viewportHeight;
      return savedClientHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(elementProto, 'scrollHeight', {
    configurable: true,
    get(this: Element): number {
      if (this.matches(VIEWPORT_SELECTOR)) return Math.max(viewportHeight, contentHeightOf(this));
      return savedScrollHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(htmlProto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      if (translateOf(this) !== null) return rowHeight;
      return savedOffsetHeight?.get?.call(this) ?? 0;
    },
  });
  elementProto.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
    if (this.matches(VIEWPORT_SELECTOR)) return rectOf(0, viewportHeight);
    if (this instanceof HTMLElement) {
      const offset = translateOf(this);
      if (offset !== null) {
        const viewport = this.closest(VIEWPORT_SELECTOR);
        const scrollTop = viewport instanceof HTMLElement ? viewport.scrollTop : 0;
        return rectOf(offset - scrollTop, rowHeight);
      }
    }
    return savedRect.call(this);
  };

  return (): void => {
    if (savedClientHeight !== undefined) Object.defineProperty(elementProto, 'clientHeight', savedClientHeight);
    if (savedScrollHeight !== undefined) Object.defineProperty(elementProto, 'scrollHeight', savedScrollHeight);
    if (savedOffsetHeight !== undefined) Object.defineProperty(htmlProto, 'offsetHeight', savedOffsetHeight);
    elementProto.getBoundingClientRect = savedRect;
  };
}
