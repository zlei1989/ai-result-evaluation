// @vitest-environment node
/**
 * codex 提问接线的**逐字**契约：厂商 params → 契约问题形状 → 应答帧，以及那条分界线。
 *
 * 为什么不并进 `conformance.test.ts`：那一份走真路径，验的是「厂商真的问了、答复真的回到了厂商」，
 * 一次真二进制的运行跑不出「审批类不回帧」「子线程的提问不落到人面前」「字段缺失怎么兜底」这几格
 * ——它们要么不发生，要么只在异常分支上。本文件用**假端口**把这些帧按原文喂进应答者，跑得动、判得准。
 *
 * 假端口只实现 `AskUserPort` 的两格（`available` / `ask`）：应答者只碰这两格，多实现一层就多一处
 * 「夹具比产品更宽容」的机会。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AskUserPort } from '../../ask-user';
import type { AskUserReply, AskUserRequest } from '../../types';
import {
  asCodexAskParams,
  CODEX_ASK_METHOD,
  codexAnswerFrameOf,
  codexQuestionsOf,
  createCodexAskResponder,
  isCodexAskRequest,
} from './ask-user';

/** 厂商那一帧的原文（字段名逐字是 `ToolRequestUserInputParams`） */
const VENDOR_PARAMS = {
  itemId: 'call_ask_1',
  threadId: 'thread-main',
  turnId: 'turn-1',
  isBlocking: false,
  autoResolutionMs: null,
  questions: [
    {
      id: 'q1',
      header: '选路径',
      question: '用哪条路径？',
      options: [
        { label: '选项 A', description: '快一点' },
        { label: '选项 B', description: '慢一点但稳' },
      ],
      isOther: true,
      isSecret: false,
    },
  ],
};

/** 只记调用、按剧本回一份答复的假端口 */
function fakePort(reply: AskUserReply): { port: AskUserPort; calls: AskUserRequest[] } {
  const calls: AskUserRequest[] = [];
  return {
    calls,
    port: {
      available: true,
      ask: (request) => {
        calls.push(request);
        return Promise.resolve(reply);
      },
    },
  };
}

/** 一条提问请求帧 */
function frame(id: number | string, params: unknown = VENDOR_PARAMS, method: string = CODEX_ASK_METHOD): {
  id: number | string;
  method: string;
  params: unknown;
} {
  return { id, method, params };
}

const ANSWERED: AskUserReply = {
  outcome: 'answered',
  answers: [{ header: '选路径', selected: ['选项 A'], custom: null }],
};

describe('codex 提问参数 → 契约形状', () => {
  it('字段名逐字映过来：`question` → `prompt`、`isOther` → `allowOther`、`isSecret` → `secret`', () => {
    const params = asCodexAskParams(VENDOR_PARAMS);
    expect(params).not.toBeNull();
    expect(codexQuestionsOf(params!)).toEqual([
      {
        header: '选路径',
        prompt: '用哪条路径？',
        options: [
          { label: '选项 A', description: '快一点', recommended: false },
          { label: '选项 B', description: '慢一点但稳', recommended: false },
        ],
        multiSelect: false,
        allowOther: true,
        secret: false,
      },
    ]);
  });

  it('厂商没有的两格如实落 `false`：`recommended` 与 `multiSelect` 都不在这一家的线上', () => {
    const params = asCodexAskParams({
      itemId: 'call_1',
      threadId: 'thread-main',
      questions: [{ id: 'q1', header: 'h', question: 'q' }],
    });
    const [question] = codexQuestionsOf(params!);
    expect(question).toMatchObject({
      options: [],
      multiSelect: false,
      allowOther: false,
      secret: false,
    });
  });

  it('选项缺 `description` 时落 `null`（不编一句文案冒充厂商给过）', () => {
    const params = asCodexAskParams({
      itemId: 'call_1',
      threadId: 'thread-main',
      questions: [{ id: 'q1', header: 'h', question: 'q', options: [{ label: 'A' }] }],
    });
    expect(codexQuestionsOf(params!)[0]?.options).toEqual([{ label: 'A', description: null, recommended: false }]);
  });

  it('形状不认识（没有 `itemId` / `questions` 不是数组 / 不是对象）⇒ `null`，不猜语义', () => {
    expect(asCodexAskParams({ questions: [] })).toBeNull();
    expect(asCodexAskParams({ itemId: 'c', questions: {} })).toBeNull();
    expect(asCodexAskParams(null)).toBeNull();
    expect(asCodexAskParams('x')).toBeNull();
  });

  it('方法名判据只认 `item/tool/requestUserInput`', () => {
    expect(isCodexAskRequest(CODEX_ASK_METHOD)).toBe(true);
    expect(isCodexAskRequest('item/commandExecution/requestApproval')).toBe(false);
  });
});

describe('codex 应答帧：按题目 id 配对', () => {
  it('答复逐题填进 `<question.id>`；某一题没人选时那一格是**空数组**', () => {
    const params = asCodexAskParams({
      itemId: 'call_1',
      threadId: 'thread-main',
      questions: [
        { id: 'q1', header: 'A', question: 'a' },
        { id: 'q2', header: 'B', question: 'b' },
      ],
    });
    const questions = codexQuestionsOf(params!);
    const frame = codexAnswerFrameOf(
      { outcome: 'answered', answers: [{ header: 'A', selected: ['x'], custom: '自己写的' }] },
      questions,
      ['q1', 'q2'],
    );
    // 标签与自由输入都进同一个字符串数组（厂商那一侧没有「自由输入」这个维度）
    expect(frame).toEqual({ answers: { q1: { answers: ['x', '自己写的'] }, q2: { answers: [] } } });
  });

  it('整份答复为 `null`（无人应答 / 等超时 / 取消）⇒ 空表，而不是「每一题都空」', () => {
    const params = asCodexAskParams(VENDOR_PARAMS);
    expect(codexAnswerFrameOf({ outcome: 'timeout', answers: null }, codexQuestionsOf(params!), ['q1']))
      .toEqual({ answers: {} });
  });
});

describe('codex 应答者：谁应答、谁不应答', () => {
  it('有人答 ⇒ 按题目 id 装帧写回（`{answers: {q1: {answers: ["选项 A"]}}}`）', async () => {
    const { port, calls } = fakePort(ANSWERED);
    const respond = createCodexAskResponder({ port, mainThreadId: () => 'thread-main' });
    await expect(respond(frame(7))).resolves.toEqual({ answers: { q1: { answers: ['选项 A'] } } });
    // 端口拿到的入参：工具名是厂商原文、调用 id 是 `itemId`、厂商预算恒 null 就如实 null
    expect(calls).toEqual([
      {
        questions: codexQuestionsOf(asCodexAskParams(VENDOR_PARAMS)!),
        toolName: 'request_user_input',
        callId: 'call_ask_1',
        vendorBudgetMs: null,
        subagentId: null,
      },
    ]);
  });

  /**
   * 「没人答 ⇒ 回空答案帧」这条**必须**钉死：厂商实测不会自己收场（`isBlocking: false` 与
   * `autoResolutionMs: null` 都不让它走），不回帧它会一直等 ⇒ 整轮挂住。
   */
  it('没人答（`unavailable`）⇒ 回的是一帧**空答案**，不是不回帧', async () => {
    const { port } = fakePort({ outcome: 'unavailable', answers: null });
    const respond = createCodexAskResponder({ port, mainThreadId: () => 'thread-main' });
    await expect(respond(frame(7))).resolves.toEqual({ answers: {} });
  });

  it('等超时与随行取消同理：每一档收场都回一帧空答案（厂商在等这一帧）', async () => {
    for (const outcome of ['timeout', 'canceled', 'rejected', 'skipped'] as const) {
      const { port } = fakePort({ outcome, answers: null });
      const respond = createCodexAskResponder({ port, mainThreadId: () => 'thread-main' });
      await expect(respond(frame(7))).resolves.toEqual({ answers: {} });
    }
  });

  it('审批类请求**不回帧**（返回 `null`，由客户端一个字都不写）', async () => {
    const { port, calls } = fakePort(ANSWERED);
    const respond = createCodexAskResponder({ port, mainThreadId: () => 'thread-main' });
    await expect(
      respond(frame(3, { threadId: 'thread-main', command: 'rm -rf /' }, 'item/commandExecution/requestApproval')),
    ).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('子线程发起的提问不落到人面前：不调端口，照旧回一帧空答案', async () => {
    const { port, calls } = fakePort(ANSWERED);
    const respond = createCodexAskResponder({ port, mainThreadId: () => 'thread-main' });
    const childFrame = frame(9, { ...VENDOR_PARAMS, threadId: 'thread-child' });
    await expect(respond(childFrame)).resolves.toEqual({ answers: {} });
    expect(calls).toEqual([]);
  });

  /**
   * 主线程 id 要等 `thread/start` 才落定，而那一瞬间之前的请求在 `null` 上与「不是主线程」不可分。
   * 这一档按主线程处置（厂商侧对子线程本来就有它自己的门禁）：挡掉会把一次真提问静默降级。
   */
  it('主线程 id 还没落定（`null`）⇒ 按主线程处置，照旧问人', async () => {
    const { port, calls } = fakePort(ANSWERED);
    const respond = createCodexAskResponder({ port, mainThreadId: () => null });
    await expect(respond(frame(9))).resolves.toEqual({ answers: { q1: { answers: ['选项 A'] } } });
    expect(calls).toHaveLength(1);
  });

  it('params 形状不认识 ⇒ 回空表（应答者这一层不许抛给客户端）', async () => {
    const { port, calls } = fakePort(ANSWERED);
    const respond = createCodexAskResponder({ port, mainThreadId: () => 'thread-main' });
    await expect(respond(frame(9, { nope: true }))).resolves.toEqual({ answers: {} });
    expect(calls).toEqual([]);
  });

  it('端口的答复原样进帧（应答者不改写答案，只装帧）', async () => {
    const { port } = fakePort({
      outcome: 'answered',
      answers: [{ header: '选路径', selected: [], custom: '都不选' }],
    });
    const respond = createCodexAskResponder({ port, mainThreadId: () => 'thread-main' });
    await expect(respond(frame(7))).resolves.toEqual({ answers: { q1: { answers: ['都不选'] } } });
  });

  it('一次提问只问一次（应答者不重试、不重复调端口）', async () => {
    const ask = vi.fn(() => Promise.resolve(ANSWERED));
    const respond = createCodexAskResponder({
      port: { available: true, ask },
      mainThreadId: () => 'thread-main',
    });
    await respond(frame(7));
    await respond(frame(8));
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
