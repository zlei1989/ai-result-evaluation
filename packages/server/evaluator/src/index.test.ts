// @vitest-environment node
/**
 * 导出面守卫：`@aieval/evaluator` 的出口是**跨计划契约**（p5 的 api 层与 web-next 的启动钩子都从这里
 * import），名字一旦漂移，接缝处会在运行时报「不是函数」，而各包自己的单测还是绿的。
 * 断言的是**完整集合**而不是「包含某些名字」：新增出口也要显式改这里。这份摩擦是刻意的——
 * 出口面本来就是需要被看见、被评审的东西。
 * 注意：`Object.keys` 只反映运行期导出，`type` 导出（如 `JudgeInput` / `TextRoute`）不在此列。
 */
import { describe, expect, it } from 'vitest';
import * as evaluator from './index';

describe('@aieval/evaluator 导出面', () => {
  it('恰好导出契约 §5 钉死的这些名字', () => {
    expect(Object.keys(evaluator).sort()).toEqual(
      [
        // p0：文本 API 与评分路由
        'callTextApi',
        'resolveJudgeRoute',
        // 智能体评分（Task 3）：api 层在创建评测时要提前用它拦配置问题（未配置 / 协议不匹配）
        'requireJudgeAgent',
        // 运行快照（Task 1）
        'getRun',
        'listRuns',
        'listRunsForCase',
        'saveRun',
        // 事件总线（Task 2）
        'publishRowEvent',
        'subscribeRowEvents',
        // 记录总线（spec v3 §2）：消息与子任务行共用 messages.jsonl
        'publishRowMessage',
        'publishRowRecord',
        'publishSubagentRecord',
        'subscribeRowRecords',
        // 评分器（Task 3 / Task 4）
        'judgeRow',
        'parseJudgeResponse',
        // 编排（Task 5 / Task 6 / Task 7）
        'abortRow',
        'abortRun',
        // 评测的「修改 / 删除」（2026-09-28）：api 层的 updateRun / deleteRun 从本包取它们
        'assertRunMutable',
        'deleteRun',
        'drainRunningTasks',
        'recoverInterruptedRuns',
        'rescoreRow',
        // 单行重新执行（2026-09-27 引入，内部名 retry，界面文案「重新执行」）：web-next 的 retry 路由从 api 包根取它，api 再从本包取
        'retryRow',
        'startRun',
      ].sort(),
    );
  });

  it('编排内部入口 runRow 不从包出口暴露（它是本包测试与状态机内部用的）', () => {
    expect(Object.keys(evaluator)).not.toContain('runRow');
  });
});
