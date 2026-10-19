/**
 * 正文块在流式帧序列下的**挂载稳定性**守卫。
 *
 * 要拦的缺陷：装配器（`MessageAssembler.ingest`）对同一条逻辑消息（`mergeKey` 恒定）的
 * **每次投递都发新的 `messageId`**（全局 `seq + 1`）；若界面块的 id 挂在 `messageId` 上，
 * 每帧 React key 全变 ⇒ 正文块整棵重挂 ⇒ 段落与代码块每帧重建，页面上就是「内容一直在
 * 更新、却一直在闪」。渲染器自己的流式缓存（块级 memo、未闭合围栏补齐）也会被整棵重挂清零。
 *
 * 判据落在 **DOM 身份**而不是「传了什么 props」：帧推进后正文段落必须还是同一个节点，
 * 且它的可见文字只增不减（重挂 = 新节点 = 红；前缀被重放 = 文字回退 = 红）。
 * 帧的构造与装配器真实产出同形：`messageId` 每帧递增、`blocks` 是累积值、块收尾快照把
 * `assembly` 翻成 `snapshot`、下一块增量再翻回 `open`。
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { AgentMessage, RowRecord } from '@aieval/contracts';
import { buildAgentLogModel, type AgentLogFactsInput } from './build-model';
import { nodeIndex } from './render-blocks';
import { AgentMessageTimeline } from './agent-message-timeline';

/** 与 `MessageAssembler.ingest` 的产出同形：同 `mergeKey`、`messageId` 每投递 +1、`blocks` 为累积值 */
function frame(seq: number, chunk: 'delta' | 'snapshot', blocks: AgentMessage['blocks']): RowRecord {
  return {
    type: 'message',
    message: {
      messageId: `run-1:${seq}`,
      vendorId: null,
      role: 'assistant',
      source: 'wire',
      origin: 'case-prompt',
      roundTrip: 1,
      turn: null,
      step: null,
      parentCallId: null,
      subagentId: null,
      chunk,
      assembly: chunk === 'delta' ? 'open' : 'snapshot',
      mergeKey: 'main|1|assistant|-',
      blocks,
      raw: null,
    },
  };
}

const FACTS: AgentLogFactsInput = {
  status: { tone: 'pending', label: '执行中' },
  startedAt: '2026-10-02T10:44:31.000Z',
  endedAt: null,
  turns: { current: 1, total: null },
  tokens: null,
  thinking: null,
  domain: [],
  error: null,
  contextWindow: null,
  live: true,
};

/** 一帧 records → 时间轴视图：走真实的 `buildAgentLogModel`（fold 与摊块都在链上），不绕过任何一层 */
function timelineOf(records: readonly RowRecord[]): ReactElement {
  const model = buildAgentLogModel({ records, events: [], facts: FACTS });
  const main = model.nodes.find((node) => node.kind === 'main') ?? model.nodes[0];
  if (main === undefined) throw new Error('模型里没有会话节点');
  const turns = main.content.status === 'ready' ? main.content.data : [];
  return <AgentMessageTimeline turns={turns} nodes={nodeIndex(model.nodes)} />;
}

/** 正文段落的可见文字（markdown 标记不上屏，这里按读到的字比） */
function paragraphText(container: HTMLElement): string {
  return container.querySelector('[data-slot="markdown"] p')?.textContent ?? '';
}

describe('正文块流式挂载稳定性', () => {
  it('帧序列推进（messageId 每帧变化、text 累积、块收尾快照、下一块增量）时正文块不重挂、chunk 只增不减', () => {
    // 帧 1：正文增量（半截；未闭合的行内代码由解析器补齐后照常上屏）
    const view = render(
      timelineOf([frame(1, 'delta', [{ type: 'text', text: '先看看 `package.json' }])]),
    );
    const paragraph = view.container.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraphText(view.container), '正文没渲染出来').toContain('package.json');

    // 帧 2：正文继续累积（仍是增量帧，messageId 换新——这是装配器的真实行为）
    view.rerender(
      timelineOf([
        frame(1, 'delta', [{ type: 'text', text: '先看看 `package.json' }]),
        frame(2, 'delta', [{ type: 'text', text: '先看看 `package.json` 里的脚本。' }]),
      ]),
    );
    // 同一个 <p>：重挂会造出一个新节点
    expect(view.container.querySelector('p')).toBe(paragraph);
    expect(paragraphText(view.container), '追加之后文字没有变长').toContain('里的脚本。');

    // 帧 3：块收尾快照（assembly 翻成 snapshot）——流式档收起、正文是全量
    view.rerender(
      timelineOf([
        frame(1, 'delta', [{ type: 'text', text: '先看看 `package.json' }]),
        frame(2, 'delta', [{ type: 'text', text: '先看看 `package.json` 里的脚本。' }]),
        frame(3, 'snapshot', [{ type: 'text', text: '先看看 `package.json` 里的脚本，然后跑测试。' }]),
      ]),
    );
    expect(view.container.querySelector('p')).toBe(paragraph);
    expect(paragraphText(view.container), '收尾快照把正文换掉了').toContain('然后跑测试。');

    // 帧 4：下一块开始（assembly 翻回 open，消息里多一个思考块）——同一条逻辑消息继续投递
    view.rerender(
      timelineOf([
        frame(3, 'snapshot', [{ type: 'text', text: '先看看 `package.json` 里的脚本，然后跑测试。' }]),
        frame(4, 'delta', [
          { type: 'text', text: '先看看 `package.json` 里的脚本，然后跑测试。' },
          { type: 'thinking', text: '接下来跑测试。', textKind: 'full', signature: null },
        ]),
      ]),
    );
    expect(view.container.querySelector('p')).toBe(paragraph);
    expect(paragraphText(view.container), '新块到达时正文段落被重挂 / 重放了前缀').toContain('然后跑测试。');
    expect(
      (view.container.textContent ?? '').match(/先看看/g)?.length,
      '同一段正文被渲染了两次（前缀重放）',
    ).toBe(1);
  });
});
