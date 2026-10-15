'use client';

/**
 * 应答宿主：全站唯一一处「智能体正在等人回答」的界面，挂在应用根的 Provider 上（页面壳之外，
 * 因此任何页面、任何路由都能被打断）。
 *
 * 三件事，判定与文案全在数据层（`@aieval/client` 的 `ask-user.ts` / `ask-user-queue.ts` /
 * `run-focus.ts`），这里只做拼装：
 *   · 订阅与队列由 `useAskUserQueue` 持有（快照 + 全局流的信号 → 先来后到的队列）；
 *   · **只弹属于焦点 run 的提问**：焦点由 `useFocusedRun()` 订阅式读（`/runs` 页在右栏选中某一轮时
 *     写它），切走的那一轮的提问因此**暂缓**——不弹、不取消、仍在挂起表计时，切回即重现；
 *     判据在数据层（`currentLeave` 那一层过滤），宿主只把焦点喂进去；
 *   · **面板画的是「有资格弹的那一问」**（不是队首：队首可能正暂缓），并用 `key={askId}` 强制
 *     换题重挂——面板的步进与草稿是它的内部 state，靠重挂归零，才不会把上一题的选择带进下一题
 *     （那种错的症状是「答案配到了另一个问题上」）；
 *   · 「完成」把答案 POST 回去，**收到确认才出队**（数据层）；失败时这一问留在队列里，
 *     原因由这里用 `message` 呈现——面板不认识请求，也就不该由它提示失败。
 *
 * **紧凑密度必须自己包**：全站的紧凑只在 `PageShell` 的子树里生效，而宿主挂在页面壳**外面**
 * （它要全局可见），不包这一层弹层就会按默认密度渲染（正文 14px，而页面上是 12px）。
 * 与 `PageShell` 同源：`compactTheme(mode)` + `useDensityMode()`（后者给的是**已解析**的明暗）。
 *
 * 「关掉弹层」不是「回答」：`close()` 不发请求、队列一条不少，只是这一问不再自动弹——
 * 右下角那个带待答条数的浮动入口是回到它的路。没有它，误点一次就等于这一问再也答不了，
 * 而行侧还在等（最终只能等预算到点收场）。那个入口的条数取**焦点内**有资格弹的条数：
 * 暂缓的提问不该在这里提示（它们由列表与详情的待答徽标提醒），否则点了也没有反应。
 */
import { QuestionCircleOutlined } from '@ant-design/icons';
import { useAskUserQueue, useFocusedRun } from '@aieval/client';
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
  // 焦点是「此刻在看哪一轮」：它一变本组件即重渲染，暂缓 / 重现当场生效
  const focusedRunId = useFocusedRun();
  const { current, answerableCount, waitingCount, submitting, submit, close, reopen } = useAskUserQueue({ focusedRunId });

  return (
    <ConfigProvider theme={COMPACT_THEMES[mode]}>
      <AskUserPanel
        // 题面与重挂载的 key 都取**有资格弹的那一问**（队首可能正暂缓、也可能刚被关掉）
        key={current?.askId ?? 'ask-user-idle'}
        open={current !== null}
        questions={current?.questions ?? []}
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
      {current === null && answerableCount > 0 && (
        <FloatButton
          icon={<QuestionCircleOutlined aria-hidden />}
          badge={{ count: answerableCount }}
          tooltip="还有提问在等你回答"
          aria-label="继续回答待答提问"
          onClick={reopen}
        />
      )}
    </ConfigProvider>
  );
}
