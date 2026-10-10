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
import { allFixtures, claudeFixture, codexFixture, dshFixture } from './fixtures';
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
        messageId: turn.blocks[0]?.messageId ?? null,
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
  it('三份夹具合起来覆盖 `RenderBlock` 的**全部九条 arm**', () => {
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
            messageId: turn.blocks[0]?.messageId ?? null,
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
});
