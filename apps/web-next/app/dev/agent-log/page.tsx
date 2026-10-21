'use client';

/**
 * 「执行日志」抽屉的**夹具预览页**（`/dev/agent-log`）：把三家智能体各一份记录序列 + 一份
 * 「题面与追问那一段」的序列（`@aieval/ui` 的 `allFixtures()`）喂进真实的 `AgentLogDrawer`，
 * 用来逐项核对「每一类消息都画得出来」——这是数据结构这一轮唯一能看见结果的地方。
 *
 * 为什么需要一个页面而不是只在单测里验：时间轴的高度补偿、折叠面板展开后下方轮次跳不跳、
 * 动效有没有在动、明暗两态下正文读不读得出来——**jsdom 一件都验不了**（本仓既有纪律：
 * 脱层几何只能靠真实浏览器冒烟）。单测钉「画的是哪一类块」，这里钉「画出来长什么样」。
 *
 * 它**不进顶栏导航**（`nav.test.ts` 明确只有三项），也不读任何接口：
 * 夹具是常量数据，本页只做「选一份夹具 → 传进抽屉」。
 */
import { useState, type ReactNode } from 'react';
import {
  AgentLogDrawer,
  AppTopNav,
  InjectComposer,
  PageShell,
  allFixtures,
  type AgentLogDiagnostics,
  type AgentLogSource,
  type Loadable,
} from '@aieval/ui';
import type { InjectMessage, TurnInjectionCapability } from '@aieval/contracts';
import { Alert, Button, Flex, Segmented, Switch, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { NAV_ITEMS } from '@/src/nav';

/** 输入区预览用的三档声明：`yes`（可用）/ `off-by-adapter`（厂商有、我们还没接）/ 缺席（读不到） */
type InjectDeclarationChoice = 'yes' | 'off-by-adapter' | 'unknown';

const YES_CELL = { state: 'yes' as const, reason: null, channel: 'wire' as const, gate: null, experimental: false, proofDriver: 'real-path' as const, proofDriverReason: null };
const OFF_BY_ADAPTER_CELL = { ...YES_CELL, state: 'off-by-adapter' as const, reason: 'not-observed' as const };

/** 按预览选的那一档拼一份声明；`unknown` 给 `null`（缺席读作「不知道」，不是「不支持」） */
function declarationFor(choice: InjectDeclarationChoice): TurnInjectionCapability | null {
  if (choice === 'unknown') return null;
  const delivery = choice === 'yes' ? YES_CELL : OFF_BY_ADAPTER_CELL;
  return {
    delivery: { round: delivery, idle: delivery },
    // 撤回档固定给 `by-id`（撤回的四个档各有自己的用例，页面预览只看输入区的可用性）
    retract: { round: { state: 'by-id', reason: '按身份撤' }, idle: { state: 'by-id', reason: '按身份撤' } },
    resume: YES_CELL,
    notes: [],
  };
}

/** 输入区预览的初始队列：一条排队、一条已交给厂商、一条已消失（`gone` 应当**看不到**） */
function seedInjectMessages(): InjectMessage[] {
  const base = { attachments: [], requires: 'idle' as const, settledAt: null, outcome: null, reason: null };
  return [
    { ...base, messageId: 'preview-queued', text: '顺便把 changelog 也补上，只写这一版的用户可见变更', state: 'queued', createdAt: '2026-09-22T10:30:00.000Z', deliveredAt: null },
    { ...base, messageId: 'preview-delivered', text: '这条已经交给厂商了（删除会撤回并回填）', state: 'delivered', createdAt: '2026-09-22T10:30:00.000Z', deliveredAt: '2026-09-22T10:31:00.000Z' },
    { ...base, messageId: 'preview-gone', text: '这条等超时被丢弃了（不该出现在队列里）', state: 'gone', createdAt: '2026-09-22T10:32:00.000Z', deliveredAt: null, outcome: 'timed-out', reason: '等太久了' },
  ];
}

export default function Page(): ReactNode {
  const router = useRouter();
  const fixtures = allFixtures();
  const [active, setActive] = useState<string>(fixtures[0]?.name ?? '');
  const [open, setOpen] = useState(true);
  /** 「未提供」与「已提供」两种环境各核对一遍：前者不许停在转圈、后者要把四组画全 */
  const [withEnvironment, setWithEnvironment] = useState(true);
  /**
   * 输入区（`AgentLogLayout` 的 `footer` 槽）的预览开关与夹具。
   *
   * 为什么这一页要有它：**紧凑密度只套输入区**（输入框 12px、抽屉正文 14px）与那条高度链
   * （滚动区按 footer 的实际高度缩水）都只有真实浏览器量得出来——jsdom 没有 CSS 级联，
   * `getBoundingClientRect` 恒为 0。这里用本页自己的桩状态驱动它，四件事各看一遍：
   * 三档声明各自的措辞、排队区默认收起与计数、`gone` 不渲染、撤回之后文本与附件一起回填。
   */
  const [withComposer, setWithComposer] = useState(true);
  const [declarationChoice, setDeclarationChoice] = useState<InjectDeclarationChoice>('yes');
  const [injectMessages, setInjectMessages] = useState<InjectMessage[]>(seedInjectMessages);
  const fixture = fixtures.find((candidate) => candidate.name === active) ?? fixtures[0];

  /**
   * 数据来源只给两个上报口（真实接线里它们去打对应的接口）。
   * 这里刻意**不给** `retryNode`：内容读失败时「不渲染重试按钮」也是要核对的一条。
   */
  const source: AgentLogSource = {
    requestEnvironment: () => undefined,
    requestDiagnostics: () => undefined,
  };

  /** 原始输出面板的内容：直接取这一份夹具的事件文案（真实来源是 `log` 事件原文） */
  const diagnostics: Loadable<AgentLogDiagnostics> = {
    status: 'ready',
    data: {
      lines: (fixture?.events ?? [])
        .filter((event) => event.type === 'log')
        .map((event) => ({
          at: event.at,
          source: event.type === 'log' ? event.stream : ('stdout' as const),
          text: event.type === 'log' ? event.text : '',
          summary: event.type === 'log' ? (event.summary ?? null) : null,
        })),
      truncatedReason: null,
    },
  };

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active="" onNavigate={(href) => router.push(href)} />
      <PageShell scroll="page">
        <Flex vertical gap={16}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            执行日志夹具预览
          </Typography.Title>
          <Alert
            type="info"
            showIcon
            title="这份页面只吃夹具，不读任何接口"
            description="dsh 覆盖全部块类型与两族卡片；codex 证明「补录」；cc 证明「这一类内容没被转发」那一档。"
          />
          <Flex align="center" gap={8} wrap>
            <Segmented
              value={active}
              onChange={(value) => setActive(String(value))}
              options={fixtures.map((item) => ({ label: item.name, value: item.name }))}
            />
            <Button size="small" onClick={() => setOpen(true)} disabled={open}>
              打开抽屉
            </Button>
            <Switch size="small" checked={withEnvironment} onChange={setWithEnvironment} aria-label="提供环境信息" />
            <Typography.Text type="secondary">提供环境信息</Typography.Text>
            <Switch size="small" checked={withComposer} onChange={setWithComposer} aria-label="显示输入区" />
            <Typography.Text type="secondary">输入区</Typography.Text>
            <Segmented
              size="small"
              value={declarationChoice}
              onChange={(value) => setDeclarationChoice(value as InjectDeclarationChoice)}
              options={[
                { label: '声明：能做到', value: 'yes' },
                { label: '声明：我们还没接', value: 'off-by-adapter' },
                { label: '声明：读不到', value: 'unknown' },
              ]}
            />
          </Flex>
          <Typography.Text type="secondary">{fixture?.proves}</Typography.Text>
        </Flex>
      </PageShell>

      {fixture === undefined ? null : (
        <AgentLogDrawer
          open={open}
          onClose={() => setOpen(false)}
          model={fixture.model}
          source={source}
          diagnostics={diagnostics}
          {...(withEnvironment ? { environment: { status: 'ready' as const, data: fixture.environment } } : {})}
          onDownload={() => undefined}
          {...(withComposer
            ? {
              footer: (
                <InjectComposer
                  messages={injectMessages}
                  declaration={declarationFor(declarationChoice)}
                  onSend={(input) =>
                    new Promise<void>((resolve) => {
                      // 桩：不改真表，只把这一条排在队尾（服务端的幂等与四态在 api 的用例里钉）
                      setInjectMessages((previous) => [
                        ...previous,
                        {
                          messageId: input.messageId,
                          text: input.text,
                          attachments: input.attachments,
                          requires: input.requires,
                          state: 'queued',
                          createdAt: new Date().toISOString(),
                          deliveredAt: null,
                          settledAt: null,
                          outcome: null,
                          reason: null,
                        },
                      ]);
                      resolve();
                    })
                  }
                  onPromote={(messageId) =>
                    new Promise<void>((resolve) => {
                      setInjectMessages((previous) =>
                        previous.map((item) => (item.messageId === messageId ? { ...item, requires: 'round' } : item)),
                      );
                      resolve();
                    })
                  }
                  onRetract={(messageId) =>
                    new Promise<void>((resolve) => {
                      // 桩：直接摘掉（真服务端会按状态分派并回一条终态；回填由输入区自己做）
                      setInjectMessages((previous) => previous.filter((item) => item.messageId !== messageId));
                      resolve();
                    })
                  }
                  onUploadAttachment={(input) =>
                    Promise.resolve({ kind: 'file' as const, path: `/preview/${input.file.name}`, mimeType: 'text/markdown' })
                  }
                />
              ),
            }
            : {})}
        />
      )}
    </>
  );
}
