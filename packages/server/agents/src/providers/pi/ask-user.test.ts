// @vitest-environment node
/**
 * pi 的**宿主提问工具**（`providers/pi/ask-user.ts`）的两层判据：
 *
 *  ① **注册面**（假 SDK 装配）：只在有应答面且全权限档时才进会话选项——「不问就不动」这条边界
 *     与既有的结构化输出那一件同形；漏了白名单那一格的表现是**静默**少一件工具（模型永远看不到），
 *     所以两处都要判；
 *  ② **契约面**（纯函数）：工具名落进既有的 `ask-user` 族（族表一行都不用改）、参数形状与契约
 *     逐字同形、答复映射成一条普通工具结果（`content` 是模型读的、`details` 是界面看的、**不给
 *     `terminate`**）。
 *
 * 出站那一层（工具名真的在请求体的 `tools[]` 里）由真包 + 假网关在 `index.test.ts` 判：
 * 那一格只有请求体看得见，假件层看不见厂商拿了名单做什么。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import { createRunInput } from '../../testing/agent-fixtures';
import {
  anthropicText,
  anthropicToolUse,
  runPiConformanceRow,
} from '../../testing/pi-conformance-fixture';
import { createFakePiRecorder, createFakePiSdk } from '../../testing/pi-sdk-fixture';
import { classifyTool } from '../../tool-family';
import { toolPayloadOf } from '../../tool-payload';
import type { AskUserReply, AskUserRequest } from '../../types';
import {
  PI_ASK_USER_GUIDELINES,
  PI_ASK_USER_PARAMETERS,
  PI_ASK_USER_SNIPPET,
  PI_ASK_USER_TOOL,
  buildPiAskUserTools,
  renderPiAskUserAnswer,
  type PiAskUserParams,
} from './ask-user';
import { piProvider } from './index';
import type { PiCustomTool } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

/** 每一行一棵自己的目录：装配会真的往 `configHome` 里建东西，共享目录会让断言互相泄漏 */
function freshRow(): ReturnType<typeof createRunInput> {
  const root = mkdtempSync(join(tmpdir(), 'pi-ask-row-'));
  const cwd = join(root, 'workspace');
  return createRunInput({ cwd, configHome: join(root, '.agenthome') });
}

/** 一份应答面：把回调收到的入参记下来，回一份真答复 */
function answeringSurface(reply: AskUserReply = {
  outcome: 'answered',
  answers: [{ header: '选路径', selected: ['选项 A'], custom: null }],
}): { requests: AskUserRequest[]; onAskUser: (request: AskUserRequest) => Promise<AskUserReply> } {
  const requests: AskUserRequest[] = [];
  return {
    requests,
    onAskUser: async (request) => {
      requests.push(request);
      return reply;
    },
  };
}

/** 会话选项里的工具名单与自定义工具表（装配面唯一两个判据口） */
function sessionToolsOf(options: Record<string, unknown> | null): {
  names: string[];
  custom: PiCustomTool[];
} {
  return {
    names: (options?.['tools'] as string[] | undefined) ?? [],
    custom: (options?.['customTools'] as PiCustomTool[] | undefined) ?? [],
  };
}

describe('pi 的宿主提问工具：注册面', () => {
  it('不传回调 ⇒ 会话选项逐字不变（工具不进名单、`customTools` 那一格都不给）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    await piProvider.run({ ...freshRow(), onEvent: () => {} });

    const { names, custom } = sessionToolsOf(recorder.sessionOptions);
    expect(names).toEqual(['read', 'bash', 'edit', 'write', 'Agent', 'get_subagent_result', 'steer_subagent', 'mcp__*']);
    expect(recorder.sessionOptions?.['customTools'], '没有应答面时 `customTools` 那一格必须缺省').toBeUndefined();
    expect(custom).toEqual([]);
  });

  it('传了回调 ⇒ 工具同时进白名单与 `customTools`（漏了名单那一格是静默少一件）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const surface = answeringSurface();
    await piProvider.run({ ...freshRow(), onEvent: () => {}, onAskUser: surface.onAskUser });

    const { names, custom } = sessionToolsOf(recorder.sessionOptions);
    expect(names).toEqual([
      'read', 'bash', 'edit', 'write', 'Agent', 'get_subagent_result', 'steer_subagent', 'mcp__*', PI_ASK_USER_TOOL,
    ]);
    // 注册面与白名单是**两件事**：名字不在名单里的自定义工具连声明都不会发出去，而厂商一个字都不报
    expect(custom.map((tool) => tool.name)).toEqual([PI_ASK_USER_TOOL]);
  });

  it('只读档即使有应答面也不装这一件（评分阶段不向人提问）', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const surface = answeringSurface();
    await piProvider.run({
      ...freshRow(),
      permission: 'read-only',
      onEvent: () => {},
      onAskUser: surface.onAskUser,
    });

    const { names, custom } = sessionToolsOf(recorder.sessionOptions);
    // 只读档的名单里**没有** `mcp__*`：那一个通配只进全权限档（见 `allowlist.test.ts` 的只读档用例）
    expect(names).toEqual(['read', 'grep', 'find', 'ls']);
    expect(custom).toEqual([]);
  });

  /**
   * 结构化输出那一件与提问那一件共用 `customTools` 一格：两件同时在场时**每一件都要在**。
   * 合成一格时漏掉一件的写法（后者覆盖前者）在这里当场红。
   */
  it('两件自定义工具同时在场：各占名单一格、`customTools` 里两件都在', async () => {
    const recorder = createFakePiRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakePiSdk({ recorder }) });
    const surface = answeringSurface();
    await piProvider.run({
      ...freshRow(),
      onEvent: () => {},
      onAskUser: surface.onAskUser,
      outputSchema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
    });

    const { names, custom } = sessionToolsOf(recorder.sessionOptions);
    expect(names).toEqual([
      'read', 'bash', 'edit', 'write', 'Agent', 'get_subagent_result', 'steer_subagent', 'mcp__*',
      'submit_result', PI_ASK_USER_TOOL,
    ]);
    expect(custom.map((tool) => tool.name).sort()).toEqual(['ask_user_question', 'submit_result']);
  });
});

describe('pi 的宿主提问工具：契约面', () => {
  /** 工具**入参**里那一问（厂商 wire 的字段名：`question`） */
  const QUESTION = {
    header: '选路径',
    question: '用哪条路径？',
    options: [
      { label: '选项 A', description: '先做小的', recommended: true },
      { label: '选项 B', description: null, recommended: false },
    ],
    multiSelect: false,
    allowOther: true,
    secret: false,
  };

  /** 同一问在**契约**里的形状（字段名是 `prompt`）：族载荷归一的产物要与它逐字相同 */
  const CONTRACT_QUESTION = {
    header: '选路径',
    prompt: '用哪条路径？',
    options: [
      { label: '选项 A', description: '先做小的', recommended: true },
      { label: '选项 B', description: null, recommended: false },
    ],
    multiSelect: false,
    allowOther: true,
    secret: false,
  };

  it('工具名落进既有的 `ask-user` 族，载荷按契约归一（族表一行都不用改）', () => {
    // 族表已识别的那个名字：与 dsh 同名是**有意**的——归一、卡片与七态因此全部复用
    expect(PI_ASK_USER_TOOL).toBe('ask_user_question');
    expect(classifyTool(PI_ASK_USER_TOOL)).toBe('ask-user');

    const payload = toolPayloadOf(classifyTool(PI_ASK_USER_TOOL), { questions: [QUESTION] }, 'pi');
    expect(payload).toEqual({ kind: 'ask-user', questions: [CONTRACT_QUESTION] });
  });

  /**
   * 参数形状与契约的 `AskUserQuestion` **逐字同形**：整份字面量比对（不是「含有那几个键」）。
   *
   * 为什么写死字面量而不是从契约 schema 现推：现推的话两边同一个来源，改一处两边一起变、
   * 用例照样绿。这里写死之后，契约加一格而工具没跟、或工具自己多一格，都当场红。
   * `questions` 是唯一必填根键——族载荷归一正是靠它认这一族。
   */
  it('参数形状与契约的问题形状逐字同形（整份字面量）', () => {
    expect(PI_ASK_USER_PARAMETERS).toEqual({
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: '这一问的短标题，也是回填答案时的配对键' },
              question: { type: 'string', description: '要问用户的那句话' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: ['string', 'null'] },
                    recommended: { type: 'boolean' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean' },
              allowOther: { type: 'boolean' },
              secret: { type: 'boolean' },
            },
            required: ['header', 'question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    });
  });

  /**
   * **空 `questions` 数组必须被厂商的参数校验拒掉**（真跑一行，判两件事：端口一次都不被调 +
   * 模型拿到的是一个错误结果）。
   *
   * 为什么必须真跑：`minItems` 是**厂商的校验器**在执行前读的，纯函数层只判得到「schema 里写了它」；
   * 而这一格写漏的后果是一次纯噪声往返（人被问一道空题、模型读到一句空的「用户已答复」）。
   * 变异体：把 `minItems` 去掉 ⇒ 端口被调一次（本用例当场红）。
   */
  it('模型给空 `questions: []` ⇒ 厂商拒在 `execute` 之前（端口零调用）', async () => {
    let portCalls = 0;
    const run = await runPiConformanceRow({
      prompt: '问用户一件事。',
      script: [
        anthropicToolUse(PI_ASK_USER_TOOL, { questions: [] }, 'toolu_ask'),
        anthropicText('按答复继续。'),
      ],
      onAskUser: async () => {
        portCalls += 1;
        return { outcome: 'answered', answers: null };
      },
    });
    expect(portCalls, '空数组不该问到人（端口被调用了）').toBe(0);
    const toolResults = run.product.messages
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.blocks)
      .map((block) => (block.type === 'tool-result' ? block.text : ''))
      .join('\n');
    expect(toolResults.length, '模型必须拿到一段可读的拒绝原因，而不是一个静默的成功').toBeGreaterThan(0);
  });

  it('提示词三格都给（这家没有厂商给的时机提示，「什么时候该问」只能自己写）', () => {
    const tool = buildPiAskUserTools(async () => ({ outcome: 'answered', answers: null }))[0];
    expect(tool).toBeDefined();
    expect(tool?.label).toBe('向用户提问');
    expect(tool?.description.length).toBeGreaterThan(0);
    expect(tool?.promptSnippet).toBe(PI_ASK_USER_SNIPPET);
    expect(tool?.promptGuidelines).toEqual([...PI_ASK_USER_GUIDELINES]);
    // 提问不需要厂商侧强制：给了这一格就会走 strict 转换，而那份 schema 的可空字段不在其子集里
    expect(tool?.constrainedSampling).toBe(false);
  });

  it('没有应答面 ⇒ 一件工具都不造', () => {
    expect(buildPiAskUserTools(null)).toEqual([]);
  });

  it('`execute` 把答复映射成普通工具结果：content 给模型、details 给界面、**不给 terminate**', async () => {
    const seen: PiAskUserParams[] = [];
    const calls: string[] = [];
    const tool = buildPiAskUserTools(async (params, callId) => {
      seen.push(params);
      calls.push(callId);
      return {
        outcome: 'answered',
        answers: [{ header: '选路径', selected: ['选项 A'], custom: '另外再补一句' }],
      };
    })[0];

    const result = await tool!.execute(
      'toolu_ask',
      { questions: [CONTRACT_QUESTION] } satisfies PiAskUserParams,
    );

    expect(calls, '调用 id 要原样带进回调：答案按它回填进消息账本').toEqual(['toolu_ask']);
    expect(seen).toEqual([{ questions: [CONTRACT_QUESTION] }]);
    // 模型读的是这一段文本：收场方式必须点名，逐问按 header 回填
    expect(result.content).toEqual([{
      type: 'text',
      text: '用户已答复（收场方式：answered）：\n- 选路径：选项 A、另外再补一句',
    }]);
    expect(result.details).toEqual({
      outcome: 'answered',
      answers: [{ header: '选路径', selected: ['选项 A'], custom: '另外再补一句' }],
    });
    // 提问只是这一轮里的一件事：给了它就会把「答完继续干活」变成「答完就停」
    expect(result.terminate).toBeUndefined();
  });

  it('收场了但没有答案（超时 / 无人应答）⇒ 文本点名收场方式、details 如实为 null', async () => {
    const tool = buildPiAskUserTools(async () => ({ outcome: 'timeout', answers: null }))[0];
    const result = await tool!.execute('toolu_ask', { questions: [CONTRACT_QUESTION] });

    expect(result.content).toEqual([{
      type: 'text',
      text: '没有人回答（收场方式：timeout）。请按你的最佳判断继续，不要重复提问。',
    }]);
    expect(result.details).toEqual({ outcome: 'timeout', answers: null });
    // 「没人答」是正常收场，不是这一行失败：它不许把工具结果标成错误
    expect(result).not.toHaveProperty('isError');
  });

  it('逐问回填：没有答复的那一问也要有一行（否则看不出是没人答还是漏了）', () => {
    const second = { ...CONTRACT_QUESTION, header: '另一问' };
    expect(renderPiAskUserAnswer(
      { outcome: 'answered', answers: [{ header: '选路径', selected: ['选项 A'], custom: null }] },
      [CONTRACT_QUESTION, second],
    )).toBe('用户已答复（收场方式：answered）：\n- 选路径：选项 A\n- 另一问：（没有答复）');
  });
});
