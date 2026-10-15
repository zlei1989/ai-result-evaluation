// @vitest-environment jsdom
/**
 * 「**每一类消息都画得出来**」的守卫：
 * 而它必须由**夹具走真实链路**来验——夹具 → `buildAgentLogModel` → `buildRenderBlocks` → 上屏。
 *
 * 为什么不能只测单个组件：组件各自绿、接线断了（例如某类块在 `buildRenderBlocks` 里
 * 根本没落到任何 arm 上）时，症状是「那一类内容整类消失」而**没有任何用例会红**。
 * 这个文件钉三件事：
 *   1. 三份夹具产出的模型**过得了** `buildRenderBlocks` 的九条 arm，没有一类块被漏掉；
 *   2. `unrecognized`（不认识的厂商载荷）有**独立的渲染路径**，不被当成附件；
 *   3. 夹具本身守三条口径：`null` 不写成 0、覆盖而不是追加、`round` 用统一轮次号。
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { allFixtures, blankThinkingFixture, claudeFixture, codexFixture, dshFixture, followUpFixture } from './fixtures';
import { buildRenderBlocks, nodeIndex, type RenderBlock } from './render-blocks';
import { blockRendererOf, DEFAULT_BLOCK_RENDERERS } from './block-renderer-registry';
import { installResizeObserverStub } from '../../testing/resize-observer';
import { createElement } from 'react';

/**
 * 这些夹具会画出 `Listy`（问答卡片的选项）与 `Table`（计划清单），
 * 两者在 jsdom 里都要 `ResizeObserver`（`Table` 还要 `matchMedia`）——环境缺口，不是被测代码的问题
 * （替身与安装助手的说明见 `testing/resize-observer.ts`）。
 */
installResizeObserverStub();

/** 把一份夹具的**每一轮**都过一遍 `buildRenderBlocks`，收集出现过的 arm */
function armsOf(fixture: ReturnType<typeof dshFixture>): Set<RenderBlock['kind']> {
  const nodes = nodeIndex(fixture.model.nodes);
  const arms = new Set<RenderBlock['kind']>();
  for (const node of fixture.model.nodes) {
    if (node.content.status !== 'ready') continue;
    for (const [turnIndex, turn] of node.content.data.entries()) {
      for (const block of buildRenderBlocks(turn.blocks, nodes, {
        at: turn.at,
        running: turn.running,
        messageId: turn.fallbackMessageId,
        nodeId: node.id,
        firstTurn: turnIndex === 0,
      })) {
        arms.add(block.kind);
      }
    }
  }
  return arms;
}

describe('夹具覆盖：每一类消息都真的画得出来', () => {
  it('四份夹具合起来覆盖 `RenderBlock` 的**全部九条 arm**', () => {
    const arms = new Set<RenderBlock['kind']>();
    for (const fixture of allFixtures()) for (const arm of armsOf(fixture)) arms.add(arm);

    // 九条 arm 逐个点名（漏一条就说明「那一类内容没有任何真实形状的夹具」，
    // 而这类缺口的表现是界面上整类内容消失，没有任何用例会红）
    expect([...arms].sort()).toEqual(
      [
        'ask-user-card',
        'attachment',
        'row-summary',
        'subagent-bar',
        'task-panel',
        'text',
        'thinking',
        'tool-group',
        'unrecognized',
      ].sort(),
    );
  });

  it('九条 arm **每一条都能被默认注册表渲染出来**（不抛、不返回空）', () => {
    const arms = new Set<RenderBlock['kind']>();
    const samples = new Map<RenderBlock['kind'], RenderBlock>();
    for (const fixture of allFixtures()) {
      const nodes = nodeIndex(fixture.model.nodes);
      for (const node of fixture.model.nodes) {
        if (node.content.status !== 'ready') continue;
        for (const [turnIndex, turn] of node.content.data.entries()) {
          for (const block of buildRenderBlocks(turn.blocks, nodes, {
            at: turn.at,
            running: turn.running,
            messageId: turn.fallbackMessageId,
            nodeId: node.id,
            firstTurn: turnIndex === 0,
          })) {
            arms.add(block.kind);
            if (!samples.has(block.kind)) samples.set(block.kind, block);
          }
        }
      }
    }

    const renderBlock = blockRendererOf(DEFAULT_BLOCK_RENDERERS);
    for (const arm of arms) {
      const block = samples.get(arm);
      if (block === undefined) throw new Error(`没有 ${arm} 的样本`);
      const { container, unmount } = render(
        createElement('div', null, renderBlock(block, { open: true, onOpenChange: () => undefined, rawOpen: false, onRawOpenChange: () => undefined })),
      );
      // 「画出来了」的判据是**有节点**：返回 null 的实现同样不抛，但那正是「整类内容消失」
      expect(container.firstChild, `${arm} 什么都没画`).not.toBeNull();
      unmount();
    }
  });
});

describe('夹具：不认识的载荷与认识的附件是两条路', () => {
  it('`unrecognized` 块渲染成折叠的原文，且**不出现图片路径那一套**', () => {
    const renderBlock = blockRendererOf(DEFAULT_BLOCK_RENDERERS);
    const samples: RenderBlock[] = [];
    const fixture = dshFixture();
    const nodes = nodeIndex(fixture.model.nodes);
    for (const node of fixture.model.nodes) {
      if (node.content.status !== 'ready') continue;
      for (const [turnIndex, turn] of node.content.data.entries()) {
        samples.push(
          ...buildRenderBlocks(turn.blocks, nodes, {
            at: turn.at,
            running: turn.running,
            messageId: null,
            nodeId: node.id,
            firstTurn: turnIndex === 0,
          }),
        );
      }
    }
    const attachment = samples.find((block) => block.kind === 'attachment');
    const unrecognized = samples.find((block) => block.kind === 'unrecognized');
    if (attachment === undefined || unrecognized === undefined) throw new Error('夹具里应同时有附件与未识别载荷');

    const attached = render(createElement('div', null, renderBlock(attachment, { open: true, onOpenChange: () => undefined, rawOpen: false, onRawOpenChange: () => undefined })));
    // 附件：有「图片」标签与路径，**不加载缩略图**（本期口径）
    expect(attached.container.textContent).toContain('图片');
    expect(attached.container.querySelector('img')).toBeNull();
    attached.unmount();

    const fallback = render(createElement('div', null, renderBlock(unrecognized, { open: true, onOpenChange: () => undefined, rawOpen: false, onRawOpenChange: () => undefined })));
    // 未识别载荷：是「未识别的厂商载荷」+ 原始类型，**不出现附件的路径措辞**
    expect(fallback.container.textContent).toContain('未识别的厂商载荷');
    expect(fallback.container.textContent).toContain('session/title');
    expect(fallback.container.textContent, '未识别载荷被画成了附件').not.toContain('内联内容，无路径');
    fallback.unmount();
  });
});

describe('夹具自身的三条口径', () => {
  it('三家的模型都非空，且 `empty` 为假（夹具是「跑过的行」）', () => {
    for (const fixture of allFixtures()) {
      expect(fixture.model.empty, `${fixture.name} 的夹具被判成空`).toBe(false);
      expect(fixture.model.nodes.length, `${fixture.name} 没有会话节点`).toBeGreaterThan(0);
    }
  });

  it('`round` 是统一轮次号（三家都用同一个字段分组），且每个节点内升序', () => {
    for (const fixture of allFixtures()) {
      for (const node of fixture.model.nodes) {
        if (node.content.status !== 'ready') continue;
        const rounds = node.content.data.map((turn) => turn.round).filter((round): round is number => round !== null);
        expect(rounds, `${fixture.name} 的轮次没有升序`).toEqual([...rounds].sort((left, right) => left - right));
      }
    }
  });

  it('`thinking === null` 时**不显示成 0**（codex 与 claude 各有一份）', () => {
    for (const fixture of [codexFixture(), claudeFixture()]) {
      expect(fixture.model.facts.thinking, `${fixture.name} 的思考 token 应当是 null`).toBeNull();
    }
  });

  it('dsh 夹具同时给出「未收场」的子任务与仍然开着的轮次（两条最容易做错的判据）', () => {
    const fixture = dshFixture();
    const children = fixture.model.nodes.filter((node) => node.kind === 'subagent');
    expect(children.length).toBeGreaterThanOrEqual(2);
    const unsettled = children.find((node) => node.status === 'unknown');
    expect(unsettled, '夹具里应有「未收场」的子任务').toBeDefined();
    expect(unsettled?.statusMissing, '「未收场」必须同时说明为什么采不到').toBe('not-observed');
    // 有一条 `assembly: 'open'` 的块（等待答复那一轮）——夹具是「跑完的行」，
    // 故它的 `Turn.running` 必须全为假：动效停了才说明这块已经确定下来了
    const main = fixture.model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    expect(main.content.data.some((turn) => turn.running), '夹具是终态，不该有「还在流」的轮次').toBe(false);
    expect(
      main.content.data.some((turn) => turn.blocks.some((block) => block.assembly === 'open')),
      '夹具里应有一条「还没收到快照」的块（动效判据的载体）',
    ).toBe(true);
  });

  /**
   * 追问那一份夹具的**段标题**（端到端：夹具 → `buildAgentLogModel`）。
   *
   * 夹具的段 1 刻意按**投递顺序**写（答复先落账本、那句人话后到——真机就是它），
   * 而模型里那句人话必须是**段标题**（`model.segments`），且不再出现在轮次的展示块里。
   * 少了这条，那份夹具的「真机顺序」就只是摆设：把提取规则摘掉，`fixtures.test.tsx` 照旧全绿，
   * 而预览页上那句人话又跑回这一段的正文里。
   */
  it('追问段的标题读得出那句人话（且轮次的展示块里只剩答复），兜底定位键仍取投递第一条', () => {
    const fixture = followUpFixture();
    const main = fixture.model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    // 时刻取这一段**最早的那一条消息**（段首那一轮的派生时刻）
    expect(fixture.model.segments).toEqual([
      { segment: 1, at: '2026-10-02T10:44:32.000Z', text: '顺便把 changelog 补上，只写这一版的用户可见变更。' },
    ]);
    const asked = main.content.data.find((turn) => turn.segment === 1 && turn.round === 1);
    // 段首那一轮的展示块只剩模型答的那三条（思考 / 工具调用 / 工具结果）
    expect(asked?.blocks.map((block) => block.role)).toEqual(['assistant', 'assistant', 'assistant']);
    expect(asked?.blocks.some((block) => block.role === 'user')).toBe(false);
    // 「投递第一条」是那句答复（夹具里 `fixture:m4`）：提取不影响这一格
    expect(asked?.fallbackMessageId).toBe('fixture:m4');
  });

  /**
   * **空白思考那一拍整块不出现**（用户口径：等第一条有正文的思考流消息到了再画）。
   *
   * 走真实链路：夹具（`text: ''` + 信封 `assembly: 'open'`）→ `buildAgentLogModel` → 注册表 → DOM。
   * 只钉模型层的话，「模型里没有它」与「界面上没有它」之间那一格（注册表选到 `ThinkingBlockView`
   * 之后又画出一个空面板）就没人管——而那正是用户看到的那一行空白。
   */
  it('空白思考夹具：模型里没有那一块，渲染出来也不出「思考」/「思考中…」，同轮的正文照常', () => {
    const fixture = blankThinkingFixture();
    const main = fixture.model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    // 那一轮里只剩正文块（空白思考块在模型层就被丢掉了）
    expect(main.content.data.flatMap((turn) => turn.blocks).map((block) => block.kind)).toEqual(['text']);

    // 再走一遍真实链路的后半段：内容块 → 渲染块 → 默认注册表 → DOM
    const nodes = nodeIndex(fixture.model.nodes);
    const rendered = main.content.data.flatMap((turn, index) =>
      buildRenderBlocks(turn.blocks, nodes, {
        at: turn.at,
        running: turn.running,
        messageId: turn.fallbackMessageId,
        nodeId: 'main',
        firstTurn: index === 0,
      }),
    );
    const renderBlock = blockRendererOf(DEFAULT_BLOCK_RENDERERS);
    const options = { open: true, onOpenChange: () => undefined, rawOpen: false, onRawOpenChange: () => undefined };
    const { container } = render(createElement('div', null, ...rendered.map((block) => renderBlock(block, options))));
    // 正文在，思考那一块**连标题都没有**。⚠️ 判据是 `.ant-think` 与「思考中…」这两样，
    // **不是「文本里没有『思考』」**：正文块在流式时新片段会自己淡入，字面上也会有别的「思考」字样
    // ——按字面判会把正常信号误判成缺陷。
    expect(container.textContent).toContain('我先看一眼构建脚本，再动手改。');
    expect(container.querySelector('.ant-think')).toBeNull();
    expect(container.textContent).not.toContain('思考中…');
  });
});

/**
 * 夹具里那一块**流式的正文**（半截围栏）走真实链路渲染出来的样子。
 *
 * 为什么单列一组：`base/x-markdown.test.tsx` 钉的是外壳对半截围栏的行为，这里钉的是
 * 「日志这条链路上真的有一块半截围栏的正文」——中间那两格（`buildAgentLogModel` 的
 * `assembly` 转发、注册表选到 `TextBlockView`）断了的话，外壳那组用例照旧全绿，
 * 而界面上是「流式正文里没有围栏这一档」。缩进 2 空格的围栏是 X 2.9.0 最容易漏的一档。
 */
describe('夹具：流式正文块的半截围栏', () => {
  const RENDERER_OPTIONS = { open: true, onOpenChange: () => undefined, rawOpen: false, onRawOpenChange: () => undefined };

  /** 取 dsh 夹具里唯一那块 `assembly === 'open'` 的正文块 */
  function openTextBlock(): RenderBlock {
    const fixture = dshFixture();
    const nodes = nodeIndex(fixture.model.nodes);
    for (const node of fixture.model.nodes) {
      if (node.content.status !== 'ready') continue;
      for (const [turnIndex, turn] of node.content.data.entries()) {
        for (const block of buildRenderBlocks(turn.blocks, nodes, {
          at: turn.at,
          running: turn.running,
          messageId: null,
          nodeId: node.id,
          firstTurn: turnIndex === 0,
        })) {
          if (block.kind === 'text' && block.block.assembly === 'open') return block;
        }
      }
    }
    throw new Error('夹具里应有一块流式的正文（半截围栏的载体）');
  }

  it('半截围栏进 loading 档、内容不被吞、围栏标记不漏进正文', () => {
    const block = openTextBlock();
    const renderBlock = blockRendererOf(DEFAULT_BLOCK_RENDERERS);
    const view = render(createElement('div', null, renderBlock(block, RENDERER_OPTIONS)));

    const code = view.container.querySelector('code');
    expect(code?.getAttribute('data-state'), '流式那块正文的围栏没有被标成「还没收尾」').toBe('loading');
    // 围栏标记（```）是 markdown 语法，不该出现在正文里；它与正文一起被吞掉就是「内容没了」的形态
    const codeText = code?.textContent ?? '';
    expect(codeText, '围栏里的内容被吞了').toContain('POST /api/open/query-file-change-log');
    expect(codeText, '缩进围栏的代码行没保住（对齐骨架散了）').toContain('queryFileChangeLogs   (lc-web:45)');
    expect(codeText, '围栏标记漏进了正文').not.toContain('```');
    view.unmount();
  });

  /**
   * **末行不再有「正在写」那一行**（用户口径：删掉那个持续动效）。
   *
   * 判据取「那一行与它的转圈都不在」：它与正文无关，在一段已经读得通的正文底下只会被读成空白。
   * `assembly === 'open'` 仍是动效的唯一判据，但它只驱动 `XMarkdownText` 的新片段淡入
   * （上面那条半截围栏的用例已经钉住 `data-state="loading"`，那是判据仍在起作用的证据）。
   */
  it('流式那一块底下不再有「正在思考」那一行（也没有 Spin）', () => {
    const renderBlock = blockRendererOf(DEFAULT_BLOCK_RENDERERS);
    const view = render(createElement('div', null, renderBlock(openTextBlock(), RENDERER_OPTIONS)));

    expect(view.container.textContent).not.toContain('正在思考');
    expect(view.container.querySelector('.ant-spin')).toBeNull();
    view.unmount();
  });
});
