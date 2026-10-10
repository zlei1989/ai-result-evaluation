// @vitest-environment node
/**
 * **族载荷的归一**：`task` / `ask-user` 两族的厂商原始入参 → 契约的 `payload`。
 *
 * 为什么要单开这一层：这两族的**载荷**过去没有归一，`ToolCallBlock.input` 原样带着厂商形状
 * 一路走到界面，于是「`todos` 还是 `plan`」「`multiSelect` 还是 `multi_select`」这些判断
 * 住在了 `packages/client/ui` 的 `build-model.ts` 里——那是把厂商适配搬进了浏览器，
 * 也正是分层守卫**扫不到**的那一块（那个文件在扫描面之外）。
 *
 * 判据表直接取自三家映射表（dsh `todo_write` 的 `todos[]`、
 * codex `update_plan` 的 `plan[]` + `explanation`、三家的 `questions[]`）。四条口径：
 *   ① 三家的形状**各自都能归一**，且归一到同一份结果；
 *   ② 认不出的形状 ⇒ `null`（**不猜**：`payload: null` 时界面走通用工具行，调用不会消失）；
 *   ③ 缺的格记 `null`，**不编 0 / 空串**（`''` 只允许出现在「厂商就是给了空串」那一档，
 *      例如 `subject` 三家都可能给空 —— 那时它是空串而不是 `null`）；
 *   ④ 归一之后**不再有厂商字段名**：断言的是契约那一份形状。
 */
import { describe, expect, it } from 'vitest';
import { toolPayloadOf } from './tool-payload';

describe('toolPayloadOf：task 族', () => {
  /** dsh 的 `todo_write`：整表覆盖，`{todos: [{content, status}]}`（真机形状） */
  it('dsh 的 todos[] ⇒ plan：content 当 subject、状态归一', () => {
    expect(
      toolPayloadOf('task', {
        todos: [
          { content: '读需求', status: 'completed' },
          { content: '写实现', status: 'in_progress' },
          { content: '补测试', status: 'pending' },
        ],
      }),
    ).toEqual({
      kind: 'plan',
      note: null,
      steps: [
        { id: null, subject: '读需求', status: 'completed', owner: null, blockedBy: null },
        { id: null, subject: '写实现', status: 'inProgress', owner: null, blockedBy: null },
        { id: null, subject: '补测试', status: 'pending', owner: null, blockedBy: null },
      ],
    });
  });

  /** codex 的 `update_plan`：`{explanation?, plan: [{step, status}]}`，`step` 当 subject、`explanation` 当 note */
  it('codex 的 plan[] + explanation ⇒ plan：step 当 subject、explanation 当 note', () => {
    expect(
      toolPayloadOf('task', {
        explanation: '按依赖顺序排',
        plan: [{ step: '先跑通', status: 'in_progress' }],
      }),
    ).toEqual({
      kind: 'plan',
      note: '按依赖顺序排',
      steps: [{ id: null, subject: '先跑通', status: 'inProgress', owner: null, blockedBy: null }],
    });
  });

  /**
   * claude 侧的两套形状同族：`TodoWrite` 的 `todos[]` 与 `Task*` 的逐条 patch。
   * `owner` / `blockedBy` 是 claude 独有的维度，另两家恒 `null`（对上「缺就是缺」）。
   */
  it('claude 的 todos[] 带上 owner 与依赖；状态认 completed / in_progress / pending', () => {
    const payload = toolPayloadOf('task', {
      todos: [
        { content: 'A', status: 'completed', owner: 'alice', blockedBy: ['t-0'] },
        { content: 'B', status: 'pending' },
      ],
    });

    expect(payload).toMatchObject({
      kind: 'plan',
      steps: [
        { subject: 'A', status: 'completed', owner: 'alice', blockedBy: ['t-0'] },
        { subject: 'B', status: 'pending', owner: null, blockedBy: null },
      ],
    });
  });

  /**
   * 状态取值域三家的并集：`completed` / `in_progress` / `inProgress` / `pending` / `todo`
   * 之外的一律 `unknown`——**不猜成成功**（`unknown` 在界面上是第四态，不是「完成」）。
   * `deleted`（claude 的 `TaskUpdate` 独有）刻意落 `unknown`：把它当 `completed` 是撒谎，
   * 当 `pending` 是它明明已经被删掉了。
   */
  it('认不出的状态记 unknown（不猜成成功）；claude 独有的 deleted 也落 unknown', () => {
    const payload = toolPayloadOf('task', {
      todos: [
        { content: 'x', status: 'deleted' },
        { content: 'y', status: 'weird' },
        { content: 'z', completed: true },
        { content: 'w', status: 'todo' },
      ],
    });

    expect(payload).toMatchObject({
      steps: [
        { status: 'unknown' },
        { status: 'unknown' },
        { status: 'completed' },
        { status: 'pending' },
      ],
    });
  });

  it('`subject` 的三种写法都认（subject / text / content），都没有时给空串（厂商就是给了空）', () => {
    const payload = toolPayloadOf('task', { todos: [{ text: 'T' }, { content: 'C' }, {}] });

    expect(payload).toMatchObject({ steps: [{ subject: 'T' }, { subject: 'C' }, { subject: '' }] });
  });

  it('不是清单的形状 ⇒ null（不猜：界面据此走通用工具行，调用不会消失）', () => {
    expect(toolPayloadOf('task', { command: 'npm test' })).toBeNull();
    expect(toolPayloadOf('task', null)).toBeNull();
    // JSON 字符串也认（codex 与 dsh 的 `arguments` 在归一前是字符串）
    expect(toolPayloadOf('task', '{"plan":[{"step":"s","status":"pending"}]}')).toMatchObject({
      steps: [{ subject: 's', status: 'pending' }],
    });
    expect(toolPayloadOf('task', 'not json')).toBeNull();
  });

  it('空清单是「厂商给了空表」⇒ steps: []（与 null 是两件事）', () => {
    expect(toolPayloadOf('task', { todos: [] })).toEqual({ kind: 'plan', note: null, steps: [] });
  });
});

describe('toolPayloadOf：ask-user 族', () => {
  /** claude 的 `AskUserQuestion`：`{questions: [{id, question, header, options[], multiSelect}]}` */
  it('claude 形状：question 当 prompt、header 原样、选项的 label/description 保留', () => {
    expect(
      toolPayloadOf('ask-user', {
        questions: [
          {
            id: 'q1',
            question: '要不要继续？',
            header: '继续',
            multiSelect: false,
            options: [
              { label: '继续', description: '按原计划走' },
              { label: '停下' },
            ],
          },
        ],
      }),
    ).toEqual({
      kind: 'ask-user',
      questions: [
        {
          header: '继续',
          prompt: '要不要继续？',
          multiSelect: false,
          allowOther: false,
          secret: false,
          options: [
            { label: '继续', description: '按原计划走', recommended: false },
            { label: '停下', description: null, recommended: false },
          ],
        },
      ],
    });
  });

  /**
   * **dsh 的 `multi_select`（下划线）**：它过去没人认——界面只读 `multiSelect`，
   * 于是 dsh 的多选恒显示成单选，而卡片上看起来完全正常（少一个「可多选」Tag）。
   * 这条用例就是那个缺陷的回归网。
   */
  it('dsh 的 `multi_select` 与 `prompt` 写法都认（旧的 `multiSelect` 单写法会漏掉它）', () => {
    const payload = toolPayloadOf('ask-user', {
      questions: [{ id: 'q1', prompt: '选几个', multi_select: true, options: [{ label: 'A' }] }],
    });

    expect(payload).toMatchObject({ questions: [{ prompt: '选几个', multiSelect: true }] });
  });

  it('codex 的 `isOther` / `isSecret` 与 `recommended` 一并认', () => {
    const payload = toolPayloadOf('ask-user', {
      questions: [
        {
          id: 'q1',
          header: '确认',
          question: '继续吗',
          isOther: true,
          isSecret: true,
          options: [{ label: '是', description: '继续', recommended: true }],
        },
      ],
    });

    expect(payload).toMatchObject({
      questions: [
        {
          header: '确认',
          prompt: '继续吗',
          allowOther: true,
          secret: true,
          options: [{ label: '是', description: '继续', recommended: true }],
        },
      ],
    });
  });

  it('没有 header 记空串（这一格是展示标签，契约与答案侧的配对键用同一种「没有」）', () => {
    const payload = toolPayloadOf('ask-user', { questions: [{ question: 'q' }] });

    expect(payload).toMatchObject({ questions: [{ header: '', prompt: 'q', options: [] }] });
  });

  it('没有 questions、或问题数组为空 ⇒ null / 空表（前者是「不是这一族」，后者是「厂商给了空表」）', () => {
    expect(toolPayloadOf('ask-user', { command: 'ls' })).toBeNull();
    expect(toolPayloadOf('ask-user', { questions: [] })).toEqual({ kind: 'ask-user', questions: [] });
  });
});

describe('toolPayloadOf：族与形状的对应', () => {
  /**
   * **只有这两族有载荷**。其余八族一律 `null`——给 `read-file` 猜一个清单出来，
   * 后果是工具行被一张空卡片顶掉（调用看不见了），比「没有卡片」严重得多。
   */
  it('其余族一律 null（不替它们猜载荷）', () => {
    expect(toolPayloadOf('read-file', { file_path: '/tmp/a' })).toBeNull();
    expect(toolPayloadOf('run-shell', { command: 'ls' })).toBeNull();
    expect(toolPayloadOf('spawn-agent', { prompt: 'x' })).toBeNull();
    // `family: null`（适配器不认识的工具）同样 null
    expect(toolPayloadOf(null, { todos: [] })).toBeNull();
  });

  /** 族与载荷必须**对得上**：给 `task` 喂一个问题数组不该产出 ask-user 载荷 */
  it('族与载荷不匹配 ⇒ null（`family` 是权威，不因为形状像就改判）', () => {
    expect(toolPayloadOf('task', { questions: [{ question: 'q' }] })).toBeNull();
    expect(toolPayloadOf('ask-user', { todos: [{ content: 'c' }] })).toBeNull();
  });
});
