// @vitest-environment node
/**
 * cc 的提问接线两层判据（`providers/cc/ask-user.ts` 与 `providers/cc/index.ts` 的装配那一格）：
 *
 *  ① **装配面**（假 SDK 记下 `query` 的 options）：应答面缺席 ⇒ `canUseTool` 一格都不加、其余逐字不变；
 *     应答面在场 ⇒ **只多这一格**——权限档不动。「这一轮能不能被问」在这一家不靠权限档表达：
 *     全权档只遮蔽普通工具，提问工具带 `requires_user_interaction`，照样进回调。
 *  ② **钩子面**（直接调那个回调）：只有厂商的提问工具走应答面，其余工具原样放行；答复装进
 *     `updatedInput.answers`（键＝题目文本），单选给标签串、多选给数组。
 *  ③ **自由输入面**：厂商的提问入参里没有「允不允许自由输入」这一格，而它自己的 schema 写明
 *     「'Other' 选项由界面自动提供」⇒ 这一家的题面恒 `allowOther: true`（弹层据此画输入框）；
 *     用户写的那句话则**经选项值那一格**进 `answers`（单选取代选项、多选并入数组）——真机读数
 *     `The user answered: "<题面>"="<自由输入>"` 出自探针 `probe/v11/cc-ask-answer.mjs` 的
 *     `answer-custom` 臂。`updatedInput.response` 也能到模型眼里，但它**会盖掉全部选项答案**，
 *     故本仓不用它：自由输入是可选项值的一种，不必另开一条盖掉另一半的路。
 *
 * 「厂商的提问真的到了我们手里、答复真的回到了厂商」那两条只由真路径证（真 CLI + 假上游，见
 * `conformance.test.ts` 的「真路径挂载」一组）；这里用假 SDK，**不 spawn 任何进程**。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createAskUserPort, type AskUserPort } from '../../ask-user';
import { CLAUDE_PERMISSION_OPTIONS } from '../../permission';
import { setAgentRuntimeForTesting } from '../../runtime';
import { createFakeClaudeSdk, createRecorder, createRunInput } from '../../testing/agent-fixtures';
import type { AgentPermission, AgentRunInput, AskUserReply, AskUserRequest } from '../../types';
import { CC_ASK_USER_TOOL, ccAnswersOf, ccAskUserPermission, ccQuestionsOf } from './ask-user';
import { claudeCodeProvider } from './index';
import { CLAUDE_PACKAGE_NAME } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

/**
 * 厂商提问工具那一帧的入参（逐字是厂商 schema 的字段名：`question` 而不是契约的 `prompt`）。
 * 题面文本是递答案的键，断言里与它逐字对照。
 */
const ASK_FRAME_INPUT = {
  questions: [
    {
      question: '用哪条路径？',
      header: '选路径',
      multiSelect: false,
      options: [
        { label: '选项 A', description: '快一点' },
        { label: '选项 B', description: '慢一点但稳' },
      ],
    },
  ],
};

/** 一份「真答了」的答复：单选选中第一个选项 */
const ASK_REPLY: AskUserReply = {
  outcome: 'answered',
  answers: [{ header: '选路径', selected: ['选项 A'], custom: null }],
};

/** 一次装配（假 SDK，只吐空事件流），交出 `query` 收到的 options 原文 */
async function optionsOf(input: AgentRunInput): Promise<Record<string, unknown>> {
  const recorder = createRecorder();
  setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
  await claudeCodeProvider.run(input);
  if (recorder.options === null) throw new Error('假 SDK 没记到 query 的 options：这一次装配没有走到厂商那一层');
  return recorder.options;
}

/**
 * 权限相关的三格（键取自唯一的权限档表）：两臂比对的共同口径。
 *
 * 为什么按表的键现取而不是手列三个键名：表里增删一格时这一份会跟着动——
 * 手列的话「新加的权限键在两臂间不一致」不会有任何判据看得见。
 */
function permissionOptionsOf(options: Record<string, unknown>, permission: AgentPermission): Record<string, unknown> {
  return Object.fromEntries(Object.keys(CLAUDE_PERMISSION_OPTIONS[permission]).map((key) => [key, options[key]]));
}

/**
 * 两臂比对用的 options 投影：去掉 `canUseTool` 与 `abortController`。
 * `abortController` 是每次装配现造的实例（它的身份按定义两臂不同），不是行为差异。
 */
function comparableOptions(options: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => key !== 'canUseTool' && key !== 'abortController'),
  );
}

/** 一份应答面：把回调收到的入参记下来，回一份真答复 */
function answeringSurface(reply: AskUserReply = ASK_REPLY): {
  requests: AskUserRequest[];
  onAskUser: (request: AskUserRequest) => Promise<AskUserReply>;
} {
  const requests: AskUserRequest[] = [];
  return {
    requests,
    onAskUser: async (request) => {
      requests.push(request);
      return reply;
    },
  };
}

/**
 * 骨架造的提问端口 + 它收到的入参（适配器运行期拿到的就是这一种东西）。
 * 用真端口而不是手搓一个对象：`available` 与「没挂应答面 ⇒ 立即无人应答」两条语义都在它里面。
 */
function surfacePort(reply: AskUserReply = ASK_REPLY): { requests: AskUserRequest[]; port: AskUserPort } {
  const surface = answeringSurface(reply);
  return {
    requests: surface.requests,
    port: createAskUserPort(createRunInput({ onAskUser: surface.onAskUser }), { kind: 'cc' }),
  };
}

describe('cc 的应答面装配：权限档一字不动', () => {
  for (const permission of ['full', 'read-only'] as const) {
    it(`${permission} 档：不传回调 ⇒ 选项里没有 \`canUseTool\`，权限取值逐字是权限表那一份`, async () => {
      const options = await optionsOf(createRunInput({ permission }));
      expect('canUseTool' in options, '没挂应答面时这一格必须缺省：厂商据此不把提问工具提供给模型').toBe(false);
      expect(permissionOptionsOf(options, permission)).toEqual(CLAUDE_PERMISSION_OPTIONS[permission]);
    });

    it(`${permission} 档：传了回调 ⇒ 只多 \`canUseTool\` 这一格（权限选项逐字不变）`, async () => {
      const surface = answeringSurface();
      const withSurface = await optionsOf(createRunInput({ permission, onAskUser: surface.onAskUser }));
      const withoutSurface = await optionsOf(createRunInput({ permission }));

      expect(typeof withSurface['canUseTool'], '挂了应答面就必须把权限钩子交给厂商').toBe('function');
      expect(comparableOptions(withSurface)).toEqual(comparableOptions(withoutSurface));
      // 两臂各自的权限取值都等于表里那一份：只判「两臂相同」的话，表被改坏时这一组会静默全绿
      expect(permissionOptionsOf(withSurface, permission)).toEqual(CLAUDE_PERMISSION_OPTIONS[permission]);
      expect(permissionOptionsOf(withoutSurface, permission)).toEqual(CLAUDE_PERMISSION_OPTIONS[permission]);
    });
  }
});

describe('cc 的权限钩子：只有提问工具进应答面', () => {
  it('提问工具 ⇒ 入参按契约形状归一，答复按题目文本装进 `updatedInput.answers`', async () => {
    const { requests, port } = surfacePort();
    const result = await ccAskUserPermission(port)(CC_ASK_USER_TOOL, ASK_FRAME_INPUT, { toolUseID: 'toolu_ask_1' });

    expect(result).toEqual({
      behavior: 'allow',
      // 原入参逐字保留（厂商会拿这一份过该工具自己的入参 schema），只多一个 answers 键
      updatedInput: { ...ASK_FRAME_INPUT, answers: { '用哪条路径？': '选项 A' } },
      toolUseID: 'toolu_ask_1',
    });
    expect(requests).toEqual([
      {
        questions: [
          {
            header: '选路径',
            prompt: '用哪条路径？',
            options: [
              { label: '选项 A', description: '快一点', recommended: false },
              { label: '选项 B', description: '慢一点但稳', recommended: false },
            ],
            multiSelect: false,
            // 这一家**答案面**恒收得下自由输入（提问工具入参里查不到这一格，见 tool-payload.ts 的模块头）
            allowOther: true,
            secret: false,
          },
        ],
        toolName: CC_ASK_USER_TOOL,
        callId: 'toolu_ask_1',
        // 厂商侧的 askUserQuestionTimeout 缺省是 never ⇒ 这一问的收场只能由我们这一侧的预算产生
        vendorBudgetMs: null,
        // 子智能体的提问到不了宿主（厂商原生拒），故这一格恒 null
        subagentId: null,
      },
    ]);
  });

  it('其余工具 ⇒ 原样放行：应答面一次都不被问，也不给 `updatedInput`', async () => {
    const { requests, port } = surfacePort();
    const result = await ccAskUserPermission(port)('Read', { file_path: '/tmp/notes.txt' }, { toolUseID: 'toolu_read_1' });

    expect(result).toEqual({ behavior: 'allow' });
    expect(requests, '普通工具不该进应答面').toHaveLength(0);
  });
});

describe('cc 的自由输入面：题面恒可自由输入，答复经选项值那一格回去', () => {
  it('厂商入参里没有这一格，归一后的题面仍落 `allowOther: true`（答案面恒收得下用户写的话）', () => {
    const questions = ccQuestionsOf(ASK_FRAME_INPUT);

    expect(questions).toHaveLength(1);
    expect(questions[0]?.allowOther).toBe(true);
  });

  it('弹层写下的那句话进 `updatedInput.answers` 的同一个键（单选取代选项）', async () => {
    // 弹层对「单选 + 自由输入」交的就是这一份（`selected` 空数组、`custom` 有值）
    const { requests, port } = surfacePort({
      outcome: 'answered',
      answers: [{ header: '选路径', selected: [], custom: '弹层里写的那句话' }],
    });
    const handler = ccAskUserPermission(port);

    const result = await handler(CC_ASK_USER_TOOL, ASK_FRAME_INPUT, { toolUseID: 'toolu_ask_1' });

    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { '用哪条路径？': '弹层里写的那句话' } },
    });
    expect(requests[0]?.questions[0]?.allowOther).toBe(true);
  });
});

describe('cc 的答复映射：键＝题目文本', () => {
  /**
   * **弹层的单选那一档**（用户口径）：写了自由输入 ⇒ 选项整组禁用、答卷交空 `selected`。
   * 这里钉的是它**在厂商那一侧的形状**——值取 `custom`（不用 `response`，那条路会盖掉选项答案）。
   */
  it('单选的自由输入取代选项：厂商那一格直接是那句话（selected 为空数组）', () => {
    const questions = ccQuestionsOf({ questions: [{ question: '用哪条路径？', header: '选路径' }] });
    const answers = ccAnswersOf(
      { outcome: 'answered', answers: [{ header: '选路径', selected: [], custom: '都不对，走第三条' }] },
      questions,
    );

    expect(answers).toEqual({ '用哪条路径？': '都不对，走第三条' });
  });

  /**
   * **弹层的多选那一档**：自由输入是补充项，勾选标签与它一起交出去。
   * 厂商那一侧只有一格可用（一个字符串数组），故两半**并进同一个数组**——信息不丢。
   */
  it('多选的自由输入并入同一个数组（两半都不丢）', () => {
    const questions = ccQuestionsOf({
      questions: [
        {
          question: '哪几条路径？',
          header: '选路径',
          multiSelect: true,
          options: [{ label: '工作区' }, { label: '系统目录' }],
        },
      ],
    });
    const answers = ccAnswersOf(
      { outcome: 'answered', answers: [{ header: '选路径', selected: ['工作区'], custom: '临时目录' }] },
      questions,
    );

    // 键是题面文本而不是题头：厂商按题面查表，键错了那一题就是「没答」
    expect(answers).toEqual({ '哪几条路径？': ['工作区', '临时目录'] });
  });

  it('题头对不上的答案跳过，不猜', () => {
    const questions = ccQuestionsOf({ questions: [{ question: '用哪条路径？', header: '选路径' }] });
    const answers = ccAnswersOf(
      { outcome: 'answered', answers: [{ header: '另一题', selected: ['选项 A'], custom: null }] },
      questions,
    );

    expect(answers).toEqual({});
  });
});
