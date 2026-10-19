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
 *     原因由这里用 `toast` 呈现——面板不认识请求，也就不该由它提示失败。
 *
 * **密度不需要自己包**：宿主挂在页面壳**外面**，拿到的就是 `:root` 的紧凑档
 * （与 `PageShell` 缺省密度同一组变量），字号与页面一致。封装 `ConfigProvider` 会引入
 * 第二份字号来源，这里不再那么做。
 *
 * 「关掉弹层」不是「回答」：`close()` 不发请求、队列一条不少，只是这一问不再自动弹——
 * 右下角那个带待答条数的常驻入口是回到它的路。没有它，误点一次就等于这一问再也答不了，
 * 而行侧还在等（最终只能等预算到点收场）。那个入口的条数取**焦点内**有资格弹的条数：
 * 暂缓的提问不该在这里提示（它们由列表与详情的待答徽标提醒），否则点了也没有反应。
 */
import { useAskUserQueue, useFocusedRun } from '@aieval/client';
import { ServiceError } from '@aieval/contracts';
import { AskUserPanel, Badge, Button, toast } from '@aieval/ui';
import type { ReactNode } from 'react';

export function AskUserHost(): ReactNode {
  // 焦点是「此刻在看哪一轮」：它一变本组件即重渲染，暂缓 / 重现当场生效
  const focusedRunId = useFocusedRun();
  const { current, answerableCount, waitingCount, submitting, submit, close, reopen } = useAskUserQueue({ focusedRunId });

  return (
    <>
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
            void toast.error(cause instanceof ServiceError ? cause.message : '答案没能提交：请重试；仍然失败请刷新页面后重答');
          });
        }}
        onClose={close}
      />
      {current === null && answerableCount > 0 && (
        // 常驻入口：不抢焦点、不遮正文，只在右下角占自己的位置。
        // 条数用 `Badge` 而不是按钮文案的一部分——它只是提示，不该改可访问名。
        <Button
          variant="outline"
          className="fixed right-6 bottom-6 z-40 gap-tight bg-background shadow-lg"
          aria-label={`继续回答待答提问（还有 ${answerableCount} 个）`}
          title="还有提问在等你回答"
          onClick={reopen}
        >
          待答提问
          <Badge variant="secondary" aria-hidden>
            {answerableCount}
          </Badge>
        </Button>
      )}
    </>
  );
}
