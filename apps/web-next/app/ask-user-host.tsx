'use client';

/**
 * 应答宿主：全站唯一一处「智能体正在等人回答」的界面，挂在应用根的 Provider 上（页面壳之外，
 * 因此任何页面、任何路由都能被打断）。
 *
 * 三件事，判定与文案全在数据层（`@aieval/client` 的 `ask-user.ts` / `ask-user-queue.ts`），
 * 这里只做拼装：
 *   · 订阅与队列由 `useAskUserQueue` 持有（快照 + 信号流 → 先来后到的队列）；
 *   · **一次只画队首那一问**，并用 `key={askId}` 强制换题重挂——面板的步进与草稿是它的内部
 *     state，靠重挂归零，才不会把上一题的选择带进下一题（那种错的症状是「答案配到了另一个问题上」）；
 *   · 「完成」把答案 POST 回去，**收到确认才出队**（数据层）；失败时这一问留在队列里，
 *     原因由这里用 `message` 呈现——面板不认识请求，也就不该由它提示失败。
 *
 * **紧凑密度必须自己包**：全站的紧凑只在 `PageShell` 的子树里生效，而宿主挂在页面壳**外面**
 * （它要全局可见），不包这一层弹层就会按默认密度渲染（正文 14px，而页面上是 12px）。
 * 与 `PageShell` 同源：`compactTheme(mode)` + `useDensityMode()`（后者给的是**已解析**的明暗）。
 *
 * 「关掉弹层」不是「回答」：`close()` 不发请求、队列一条不少，只是这一问不再自动弹——
 * 右下角那个带待答条数的浮动入口是回到它的路。没有它，误点一次就等于这一问再也答不了，
 * 而行侧还在等（最终只能等预算到点收场）。
 */
import { QuestionCircleOutlined } from '@ant-design/icons';
import { useAskUserQueue } from '@aieval/client';
import { ServiceError } from '@aieval/contracts';
import { AskUserPanel, compactTheme, useDensityMode, type DensityMode } from '@aieval/ui';
import { App as AntdApp, ConfigProvider, FloatButton } from 'antd';
import type { ReactNode } from 'react';

/** 紧凑主题按明暗预生成一次：避免每次渲染重建 ThemeConfig（与 `PageShell` 同一份口径） */
const COMPACT_THEMES: Record<DensityMode, ReturnType<typeof compactTheme>> = {
  light: compactTheme('light'),
  dark: compactTheme('dark'),
};

export function AskUserHost(): ReactNode {
  const { message } = AntdApp.useApp();
  const mode = useDensityMode();
  const { current, pending, pendingCount, waitingCount, submitting, submit, close, reopen } = useAskUserQueue();
  // 面板画的是**队首**（题面与重挂载的 key 都取它）；开不开由 `current` 决定——
  // 被用户关掉的那一问仍是队首，只是暂时不弹
  const head = pending[0] ?? null;

  return (
    <ConfigProvider theme={COMPACT_THEMES[mode]}>
      <AskUserPanel
        key={head?.askId ?? 'ask-user-idle'}
        open={current !== null}
        questions={head?.questions ?? []}
        submitting={submitting}
        // 面板标题右侧的「还有 N 个待答」不含正在答的这一条
        pendingCount={waitingCount}
        onComplete={(answers) => {
          void submit(answers).catch((cause: unknown) => {
            // 失败原因归宿主呈现（`ServiceError` 的 message 已是中文，其余不透内部细节）
            void message.error(cause instanceof ServiceError ? cause.message : '提交答案失败，请稍后重试');
          });
        }}
        onClose={close}
      />
      {current === null && pendingCount > 0 && (
        <FloatButton
          icon={<QuestionCircleOutlined aria-hidden />}
          badge={{ count: pendingCount }}
          tooltip="还有提问在等你回答"
          aria-label="继续回答待答提问"
          onClick={reopen}
        />
      )}
    </ConfigProvider>
  );
}
