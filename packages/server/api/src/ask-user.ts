/**
 * 应答面的读写入口（功能服务层）：待答快照、应答提交。
 *
 * 两条口径来自挂起表（`@aieval/evaluator` 的 `ask-user.ts`），这里只做「转形状 + 加时刻」：
 *   · **快照是唯一读侧**：清单直接来自挂起表，本层不缓存、不排序——表按提问顺序给，
 *     界面要的「先来后到」就是那一刻的顺序；
 *   · **应答只有一个写入口**：`resolveAskUser` 的校验与幂等（首个 200 / 后到 409 / 未知 404）
 *     全在表里，本层不重复判一遍。同一件事写两遍必然漂移，而漂移时先抛的那一份说了算。
 *
 * 为什么返回体里要带 `answeredAt`：一次应答只有「问的时刻」与「答的时刻」两个事实，
 * 等待时长由消费方相减得出。服务端补这一格比让客户端拿本地时钟相减可靠——
 * 后者在页面开得晚、或时钟不同步时给出的是负等待。
 */
import type { AskUserAnswer, AskUserAnswerAccepted, PendingAskUser } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { listPendingAskUser, resolveAskUser } from '@aieval/evaluator';

const log = createLogger('ask-user');

/** 当前待答清单（全部轮次）：快照路由的产出 */
export function getPendingAskUser(): PendingAskUser[] {
  const pending = listPendingAskUser();
  log.debug('读待答快照', { count: pending.length });
  return pending;
}

/**
 * 提交一份答案（应答面的唯一写入口）：按 `askId` 幂等收场这一问。
 *
 * 「答案与问题逐问对不上」由挂起表校验并抛 `INVALID_QUERY`（400）——
 * 那里同时是唯一知道问题清单的地方；本层只接住它的返回值。
 *
 * 出参**不跑 zod**：它由返回类型在编译期钉住（同一份契约类型派生自同一份 schema），
 * 而运行期解析会把「我们自己拼错了响应」折成 `ZodError` ⇒ 路由层映射成「查询参数不合法」的 400，
 * 把服务端的编程错误伪装成客户端的入参问题。响应形状的守卫归用例，不归请求解析那条通路。
 */
export function answerAskUser(askId: string, answers: AskUserAnswer[]): AskUserAnswerAccepted {
  const { answeredAt } = resolveAskUser(askId, answers);
  log.info('应答已受理', { askId, answerCount: answers.length });

  return { askId, answer: { outcome: 'answered', answers }, answeredAt };
}
