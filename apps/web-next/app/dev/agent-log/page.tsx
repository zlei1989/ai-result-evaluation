'use client';

/**
 * 「执行日志」抽屉的**夹具预览页**（`/dev/agent-log`）：把三家智能体各一份记录序列
 * （`@aieval/ui` 的 `allFixtures()`）喂进真实的 `AgentLogDrawer`，用来逐项核对
 * 「每一类消息都画得出来」——这是数据结构这一轮唯一能看见结果的地方。
 *
 * 为什么需要一个页面而不是只在单测里验：时间轴的高度补偿、折叠面板展开后下方轮次跳不跳、
 * 动效有没有在动、明暗两态下正文读不读得出来——**jsdom 一件都验不了**（本仓既有纪律：
 * 脱层几何只能靠真实浏览器冒烟）。单测钉「画的是哪一类块」，这里钉「画出来长什么样」。
 *
 * 它**不进顶栏导航**（`nav.test.ts` 明确只有三项），也不读任何接口：
 * 夹具是常量数据，本页只做「选一份夹具 → 传进抽屉」。
 */
import { useState, type ReactNode } from 'react';
import { AgentLogDrawer, AppTopNav, PageShell, allFixtures, type AgentLogDiagnostics, type AgentLogSource, type Loadable } from '@aieval/ui';
import { Alert, Button, Flex, Segmented, Switch, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { NAV_ITEMS } from '@/src/nav';

export default function Page(): ReactNode {
  const router = useRouter();
  const fixtures = allFixtures();
  const [active, setActive] = useState<string>(fixtures[0]?.name ?? '');
  const [open, setOpen] = useState(true);
  /** 「未提供」与「已提供」两种环境各核对一遍：前者不许停在转圈、后者要把四组画全 */
  const [withEnvironment, setWithEnvironment] = useState(true);
  const fixture = fixtures.find((candidate) => candidate.name === active) ?? fixtures[0];

  /**
   * 数据来源只给两个上报口（真实接线里它们去打对应的接口）。
   * 这里刻意**不给** `retryNode`：内容读失败时「不渲染重试按钮」也是要核对的一条。
   */
  const source: AgentLogSource = {
    requestEnvironment: () => undefined,
    requestDiagnostics: () => undefined,
  };

  /** 原始输出面板的内容：直接取这一份夹具的行级事件文案（真实来源是 `log` 事件原文） */
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
            description="dsh 覆盖全部块类型与两族卡片；codex 证明「补录」与「摘要」；claude-code 证明「这一类内容没被转发」那一档。"
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
        />
      )}
    </>
  );
}
