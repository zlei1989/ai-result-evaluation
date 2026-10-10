/**
 * RunCreatePanel：用例 + 执行模式 + 使用智能体评分 + 候选行（`Form.List` + small Table）。
 * 四件事必须成立：
 *   1. 模型候选池跟着**本行的智能体**变；
 *   2. 池子为空时当场内联 Alert 指出路，而不是让人选完到运行时才失败；
 *   3. 提交校验（至少一行、每行两个 Select 都选了）真的拦得住，且拦下来的请求**一个都不发**；
 *   4. 「使用智能体评分」默认关闭，且开关打开而设置页没配默认评分智能体时当场提示——
 *      判据由 `judgeAgentConfigured` 注入，正反两面都钉住（配了/未知时不许提示）；
 *   5. 执行模式的顺序与默认值（串行在前、默认串行）；
 *   5b. 思考强度：候选的**第一项是关闭档 `off`**（档位一律照上游词汇原样写，
 *      不再加工措辞），而「未指定」是
 *      `allowClear` 的清空态、由 placeholder 承担，**不是候选里的一项**（未选 ≠ 关闭）；
 *   6. 编辑模式：`mode="edit"` 预填当前轮次——执行模式取自 `initial`（不被缺省的
 *      「串行」盖掉）、每个候选行带着**原行 id**与**思考强度**（编辑载荷是行集合的全量替换，
 *      少回传一格就会被服务端判成「改了这一行」而白重置一行），且**只在真有行会被作废时**
 *      才弹保存前确认框（什么都不作废时弹窗就是噪音，噪音会让用户闭眼点确定）；
 *   7. 候选行的**形态**：一行一个候选的小表格、字段名在列头里、
 *      删除是操作列里右对齐的图标 link 按钮 —— 三条形态守卫都在「RunCreatePanel」describe 里。
 *
 * jsdom 环境注意：本文件要打开 Select 的下拉（浮层定位走 @rc-component/resize-observer），
 * 而 jsdom 没有 ResizeObserver —— 必须自己装桩（桩刻意不放进共享 setup，理由见该文件）。
 * 表格同理：antd 的 `Table` 会直接 `new ResizeObserver`，少了这个桩连挂载都过不去。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EFFORT_OFF, type EvalRow, type EvalRun, type Rubric, type TestCase } from '@aieval/contracts';
import { installResizeObserverStub } from '../testing/resize-observer';
import {
  RunCreatePanel,
  effortPlaceholder,
  invalidatedRows,
  type RunCreatePanelProps,
  type RunFormValues,
  type RunModelOption,
} from './run-create-panel';

beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 用例 / 一轮共用的评分表夹具（旧的 `judgePrompt: '按 5 维打分'` 已随重构删除：用例上现在只有
 * **一张表**这一份评分口径）。一组一项、显式 `id`：面板只把标题与仓库名画进下拉，
 * 这一格在本文件里的作用是「让 TestCase / EvalRun 字面量形状合法」，不是断言对象。
 */
const CASE_RUBRIC: Rubric = {
  groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '补齐转换', weight: 100 }] }],
};

const cases: TestCase[] = [
  {
    id: 'c-1',
    title: '多协议入站转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: '71e628091bf7134a6e677a58cc1e0f29b9302e6f',
    repoBranch: null,
    taskPrompt: '补齐转换',
    rubric: CASE_RUBRIC,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  },
  {
    id: 'c-2',
    title: '工具名长度校验',
    repoPath: '/home/me/tool-id',
    commitHash: null,
    repoBranch: null,
    taskPrompt: '加校验',
    rubric: CASE_RUBRIC,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  },
];

const anthropicOptions: RunModelOption[] = [
  { providerId: 'p-anthropic', providerName: 'Anthropic 网关', modelId: 'claude-opus-4-6', source: 'manual' },
];
const openaiOptions: RunModelOption[] = [
  { providerId: 'p-openai', providerName: 'OpenAI 网关', modelId: 'gpt-5', source: 'fetched' },
];

/**
 * 默认的池子：**与注册表元数据一致** —— `codex` 只走 openai；`claude-code` 只走 anthropic；
 * 而 **`dsh` 两条协议都收** ⇒ 它的池子是**并集**。
 * 夹具按最终真值写：把 dsh 写成单协议会让「并集」这件事在界面用例里没有靶子。
 */
function poolFor(agentKind: string): RunModelOption[] {
  if (agentKind === 'codex') return openaiOptions;
  if (agentKind === 'dsh') return [...openaiOptions, ...anthropicOptions];
  return anthropicOptions;
}

/**
 * 默认的「未选档位会落到哪」：**与注册表元数据一致**——只有 DSH 声明 `defaultEffort: 'high'`
 * （`registry.test.ts` 钉着「声明了就必须落在自家档位域里」），Claude Code / Codex 不声明
 * ⇒ 由厂商推断、界面只说「未指定」。占位符用例靠它把三档文案都取到（见 `effortPlaceholder`）。
 */
function defaultEffortFor(agentKind: string): string | undefined {
  return agentKind === 'dsh' ? 'high' : undefined;
}

/**
 * 编辑模式的「当前轮次」夹具（`initial`）：一行**跑过**的候选
 * （`judged` + `attempts: 1` = 有东西可丢，才可能进作废名单）。
 * 两格是刻意选的：
 *   · `executionMode: 'parallel'` —— 与表单缺省的「串行」不同，取值来源不对时用例当场红；
 *   · 行带着 `id` —— 丢了它，保存时所有行都被当成新行，已经跑出来的结果静默清零。
 * 放在模块作用域：「编辑模式」与 `invalidatedRows` 两组共用它。
 */
const editRun: EvalRun = {
  id: 'run-1',
  caseId: 'c-1',
  caseTitle: '多协议入站转换',
  repoPath: 'D:\\projects\\gateway',
  commitHash: '71e628091bf7134a6e677a58cc1e0f29b9302e6f',
  repoBranch: null,
  // 轮级评分表**快照**（必填）：编辑这一轮时保存的原样回传，它不随用例现取的那张表变
  rubric: CASE_RUBRIC,
  status: 'done',
  // 故意与「默认串行」不同：取值来源不对时这一条会红
  executionMode: 'parallel',
  useAgentJudge: false,
  rows: [
    {
      id: 'r-1',
      agentKind: 'claude-code',
      providerId: 'p-anthropic',
      providerName: 'Anthropic 网关',
      baseUrl: 'https://gw.example.com/anthropic',
      modelId: 'claude-opus-4-6',
      status: 'judged',
      branch: 'test/r-1',
      workspacePath: 'D:\\runs\\run-1\\rows\\r-1\\workspace',
      baselineCommit: 'a'.repeat(40),
      tokens: null,
      turns: null,
      durationMs: null,
      diff: null,
      score: null,
      error: null,
      attempts: 1,
    },
  ],
  workspaceBase: 'D:\\runs',
  createdAt: '2026-09-22T08:00:00.000Z',
  startedAt: '2026-09-22T08:00:00.000Z',
  finishedAt: '2026-09-22T09:00:00.000Z',
};

/**
 * 取夹具里那一行。`noUncheckedIndexedAccess` 下 `rows[0]` 是 optional，
 * 而「这条夹具必须有且只有一行」是夹具自己的承诺——写成取值函数比到处 `as` 诚实。
 */
function firstRowOf(run: EvalRun): EvalRow {
  const row = run.rows[0];
  if (row === undefined) throw new Error('夹具至少要有一行');
  return row;
}

/**
 * 编辑模式的**两行**夹具：行增删与行换位两条守卫共用。
 * 第二行的 `modelId` 与第一行不同（且两行都在池子里）——「换了位」才看得出来。
 */
function twoRowRun(): EvalRun {
  return {
    ...editRun,
    rows: [firstRowOf(editRun), { ...firstRowOf(editRun), id: 'r-2', modelId: 'claude-haiku' }],
  };
}

/** 上面那个夹具要的两行都在池子里（不在池子里时 Select 会显示编码值，换位就看不出来了） */
const twoModelPool: RunModelOption[] = [
  { providerId: 'p-anthropic', providerName: 'Anthropic 网关', modelId: 'claude-opus-4-6', source: 'manual' },
  { providerId: 'p-anthropic', providerName: 'Anthropic 网关', modelId: 'claude-haiku', source: 'manual' },
];

/** 表格里每一行「模型」那一格显示的文字，**按行的顺序**给出（增删 / 换位都靠它断言） */
function modelCellTexts(): string[] {
  return (screen.getAllByLabelText('模型') as HTMLElement[]).map(
    (input) => input.closest('.ant-select')?.textContent ?? '',
  );
}

/**
 * 渲染面板：默认 props + 覆盖。
 *
 * ⚠️ 合并后的对象要**断言**回 `RunCreatePanelProps`：它是**判别联合**（`mode` 与 `initial` 同进同出），
 * 而 `Partial<…>` 一展开判别性就丢了——TS 无法证明「`mode: 'edit'` 且 `initial: EvalRun`」这条相关性
 * 还在，于是直接展开会被拒（TS2322）。这个断言只放开**夹具自己的**入口：真实 JSX 调用点仍由组件
 * 自己的 props 类型把着关（少给 `initial` 在那边是编译错误）。
 */
function renderPanel(overrides: Partial<Parameters<typeof RunCreatePanel>[0]> = {}): ReturnType<typeof render> {
  const props = {
    cases,
    modelOptionsFor: poolFor,
    defaultEffortOf: defaultEffortFor,
    saving: false,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  } as RunCreatePanelProps;
  return render(<RunCreatePanel {...props} />);
}

/**
 * 打开某一个下拉并按显示文本选中一项。
 *
 * **为什么不写 `getByRole('option', { name })`**（最初那么写的，实测点不动）：
 * antd 6 的 Select 在 DOM 里有两份选项——
 *   · 一份是 `.ant-select-item-option`（真正接收点击的可见行，内容在 `.ant-select-item-option-content` 里）；
 *   · 另一份是 `role="listbox"` 下那个 `height:0; width:0; overflow:hidden` 的**可访问性镜像**
 *     （rc-select 为屏幕阅读器准备），它的文本是**选项的 value**、可访问名取 `aria-label`。
 * 于是 `getByRole('option', { name: 'Codex' })` 拿到的是镜像节点，`fireEvent.click` 点它**不会**
 * 改变表单值（aria-hidden 的镜像不接事件）；而模型选项的 label 是 ReactNode（带来源 Tag），
 * 镜像节点连 `aria-label` 都没有，`name: /gpt-5/` 直接查不到。故这里按**可见行**的
 * `textContent` 匹配（可见行的文本就是「模型名 + 来源 Tag」）。
 */
function pickOption(labelText: string, optionText: string | RegExp, trigger?: HTMLElement): void {
  const target = trigger ?? (screen.getAllByLabelText(labelText)[0] as HTMLElement);
  fireEvent.mouseDown(target);
  // 全局查一遍「可见」的浮层：换开另一个下拉时 antd 不卸载上一个、也不给它加 `hidden` 类
  // ⇒ 这份查询其实跨了多个浮层（**脆**，理由见 `visibleOptionTexts` 的注释）。按文案点选仍然稳，
  // 而找不到目标时下面会把**实际选项**列出来，所以「误点选」是响的；别在这里加顺序假设。
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
    ),
  );
  const wanted =
    typeof optionText === 'string'
      ? rows.find((row) => row.textContent === optionText)
      : rows.find((row) => optionText.test(row.textContent ?? ''));
  if (wanted === undefined) {
    throw new Error(
      `下拉「${labelText}」里找不到 ${String(optionText)}；实际选项：${JSON.stringify(
        rows.map((row) => row.textContent),
      )}`,
    );
  }
  fireEvent.click(wanted);
}

/**
 * **所有**浮层合起来的选项文本；断言「列了什么 / 没列什么」（集合语义）用它。
 *
 * ⚠️ **`:not(.ant-select-dropdown-hidden)` 这个过滤在本版本上基本是死的**（见下一个函数的注释）：
 * antd 换开另一个下拉时**不卸载**上一个的浮层，而那个浮层**不带** `hidden` 类 ⇒ 同一个文档里会同时
 * 有多份「可见」的 `.ant-select-item-option`，这个谓词一个都排不掉。它留着只是**没有坏处**（真带上
 * `hidden` 的那些确实该排掉），**不要**把它读成「能排除上一个浮层」的机制。
 *
 * ⚠️ 因此本函数（以及下面 `pickOption` 里同一份全局查询）是**脆的**：它把「此刻文档里所有浮层的选项」
 * 当做一个集合，用例里先开过用例下拉、再开强度下拉时，两份选项会混在一起。集合断言（`toContain`）与
 * 「按文案点选」还稳，`pickOption` 找不到目标时会把**实际选项**列进错误消息里，所以误点选是响的；
 * 但**顺序敏感**的断言（「第一项是 off」）必须改用 `visibleOptionTextsOf`（按 `aria-controls` 认浮层），
 * 否则会张冠李戴地通过。
 */
function visibleOptionTexts(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
    ),
  ).map((row) => row.textContent ?? '');
}

/**
 * **某一个**下拉（按它的 `aria-label` 认）当前可见的选项文本，按渲染顺序。
 *
 * 为什么还需要它：`visibleOptionTexts()` 把**所有**可见浮层合在一起，而 antd 在同一行里换开
 * 另一个下拉时，上一个浮层仍在文档里且**不带** `hidden` 类（实测：先选用例、再选模型、再开强度，
 * 三个浮层同时「可见」）⇒ 它的首项是用例选项，不是强度选项。
 * 「下拉的**第一项**是什么」这种顺序断言必须限定在自己那一个浮层里，否则会张冠李戴地通过。
 * 认浮层的凭据是 antd 自己写下的 `aria-controls` / `aria-owns`（两者只要有其一就够，
 * 不同版本用哪一个都认）——不按 DOM 顺序去猜第几个浮层。
 */
function visibleOptionTextsOf(labelText: string): string[] {
  const input = screen.getAllByLabelText(labelText)[0] as HTMLElement;
  const listId = input.getAttribute('aria-controls') ?? input.getAttribute('aria-owns');
  if (listId === null) throw new Error(`「${labelText}」的输入框上没有指到浮层的 id`);
  const dropdown = document.getElementById(listId)?.closest('.ant-select-dropdown');
  if (dropdown === null || dropdown === undefined) throw new Error(`「${labelText}」下拉的浮层不在文档里`);
  return Array.from(dropdown.querySelectorAll<HTMLElement>('.ant-select-item-option')).map(
    (row) => row.textContent ?? '',
  );
}

describe('RunCreatePanel', () => {
  it('用例选项显示「标题 · 仓库名 · commit 短哈希」，无 commit 时显示默认分支', () => {
    renderPanel();
    const caseSelect = screen.getAllByLabelText('用例')[0] as HTMLElement;
    fireEvent.mouseDown(caseSelect);

    // 断言可见选项行（理由见 pickOption 的注释：role="option" 那份是隐藏的可访问性镜像）
    // 仓库名从路径末段取：Windows 反斜杠与 POSIX 斜杠都要能切
    expect(visibleOptionTexts()).toContain('多协议入站转换 · gateway · 71e6280');
    expect(visibleOptionTexts()).toContain('工具名长度校验 · tool-id · 默认分支 HEAD');
  });

  /**
   * 仓库名对**远端 URL**也要取末段：解析口径由 contracts 提供（展示走 `displayRepoName`，
   * 它的合法输入分支就是 `repoNameFromSource`）。
   *
   * 断言刻意钉到**完整一行**而不是 `/rbac-server/`：按路径分隔符切分的旧写法会切出 `rbac-server.git`，
   * 它也匹配 `/rbac-server/`——那样的用例对「.git 没剥掉」这个缺陷没有区分力。
   */
  it('用例下拉里的仓库名对 URL 取末段并剥掉 .git（不按路径分隔符切）', () => {
    const remoteCase: TestCase = {
      id: 'c-remote',
      title: '多协议入站转换',
      repoPath: 'git@coding.jd.com:FlowAI/rbac-server.git',
      commitHash: '71e628091bf7134a6e677a58cc1e0f29b9302e6f',
      repoBranch: 'feat/x',
      taskPrompt: '补齐转换',
      rubric: CASE_RUBRIC,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    };
    renderPanel({ cases: [remoteCase] });
    fireEvent.mouseDown(screen.getAllByLabelText('用例')[0] as HTMLElement);

    expect(visibleOptionTexts()).toContain('多协议入站转换 · rbac-server · 71e6280');
  });

  /**
   * 守卫：**落盘数据里出现判定不认的来源时，下拉必须照样渲染**。
   *
   * 读路径不保证来源合法（`loadConfig()` 不校验 `cases`，本功能之前的用例 schema 是裸的 `z.string()`），
   * 而 `repoNameFromSource` 对非白名单 scheme 是抛错的——在标签拼装里直接用它，一条坏数据就是整页白屏
   * （被替换掉的 `repoNameOf` 从不抛错，它的用例名就叫「列表里不该因为一条坏数据整页崩掉」）。
   * 标签一律走 contracts 的 `displayRepoName`：这类来源仍能退化出一个可读的末段。
   */
  it('用例的来源是判定不认的形态（历史坏数据）时，下拉照样渲染并给出可读名字', () => {
    const legacyCase: TestCase = {
      id: 'c-legacy',
      title: '历史遗留用例',
      repoPath: 'ftp://host/x.git',
      commitHash: null,
      repoBranch: null,
      taskPrompt: '补齐转换',
      rubric: CASE_RUBRIC,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    };
    renderPanel({ cases: [legacyCase] });
    fireEvent.mouseDown(screen.getAllByLabelText('用例')[0] as HTMLElement);

    expect(visibleOptionTexts()).toContain('历史遗留用例 · x · 默认分支 HEAD');
  });

  /**
   * ⚠️ 显式放宽到 90s：本用例要建两行 + 反复开下拉，而每行现在有**三个** antd Select
   * （智能体 / 模型 / 思考强度）。antd 的 Select 在 jsdom 里挂载很贵，本机又有企业杀软在进程创建上收税，
   * 实测这条用例在整套并发下有 40-60s 量级的抖动（同文件其余用例仍在默认预算内）。
   * 放宽的是**等待预算**，不是判据：它断言的东西一个字都没变。
   */
  it('「添加候选」真的加一行（默认 Claude Code + 未选模型），并且两行能一起提交', { timeout: 90_000 }, async () => {
    // 它守的是「多候选」这条主路径（`Form.List` 的 `add`）：只加行不生效（或新行带上了
    // 上一行的模型）时，使用者会提交出一个与自己选择不符的组合。
    const onSubmit = vi.fn();
    renderPanel({ onSubmit });

    // 每行各有「模型」标签 ⇒ 用它数行数
    expect(screen.getAllByLabelText('模型')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '添加候选' }));

    const modelSelects = screen.getAllByLabelText('模型') as HTMLElement[];
    expect(modelSelects).toHaveLength(2);

    // 第一行选 anthropic 的模型并提交
    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    pickOption('模型', /claude-opus-4-6/);
    // 提交按钮是「确定」：它只提交这张已经写着「创建评测」的右栏表单。
    // 名字写成 /确\s*定/ 而不是 '确定'：两个汉字的标签会被 antd 插空格成「确 定」（同本文件的「删除」「取消」）
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    // 第二行还没选模型 ⇒ 校验拦下，一个请求都不发（新行必须是「空的」而不是复制上一行）
    await waitFor(() => expect(screen.getByText('请选择模型')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();

    // 第二行改成 Codex 并选它的模型 ⇒ 这次两行一起提交
    const agentSelects = screen.getAllByLabelText('智能体') as HTMLElement[];
    fireEvent.mouseDown(agentSelects[1] as HTMLElement);
    const codexOption = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option')).find(
      (row) => row.textContent === 'Codex',
    );
    expect(codexOption).toBeDefined();
    fireEvent.click(codexOption as HTMLElement);

    // 第二行的模型池跟着本行的智能体换成 openai 的。
    // 必须显式指定**第二行**的触发器：`getAllByLabelText` 的第 0 个是第一行
    const secondModel = screen.getAllByLabelText('模型')[1] as HTMLElement;
    pickOption('模型', /gpt-5/, secondModel);
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      rows: [
        { agentKind: 'claude-code', modelId: 'claude-opus-4-6' },
        { agentKind: 'codex', modelId: 'gpt-5' },
      ],
    });
  });

  it('执行模式：串行在前、并行在后，默认选中串行', () => {
    renderPanel();

    // 顺序是产品口径的一部分：默认值落在第一个选项上，顺序反了「默认串行」就名不副实
    const labels = screen.getAllByRole('radio').map((node) => node.closest('label')?.textContent ?? '');
    expect(labels).toEqual(['串行', '并行']);
    expect(screen.getByLabelText('串行')).toBeChecked();
    expect(screen.getByLabelText('并行')).not.toBeChecked();
  });

  it('默认执行模式是串行，提交出去的 payload 与默认值一致', async () => {
    const onSubmit = vi.fn();
    renderPanel({ onSubmit });

    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    pickOption('模型', /claude-opus-4-6/);
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      caseId: 'c-1',
      executionMode: 'serial',
      // 智能体评分开关的默认值也要进 payload（默认关闭）：`toEqual` 是**精确**比较，
      // 少了这一格说明提交出去的东西与这张表单显示的不是一回事
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });
  });

  it('选了「并行」后提交出去的 payload 里 executionMode 是 parallel', async () => {
    // 为什么必须有这一条：「改选另一个模式」这条路径只由这里钉住——把实现改成恒发默认值
    // 也能全绿，而串行与并行在编排层是两种完全不同的跑法（一行跑完含评分才起下一行）。
    const onSubmit = vi.fn();
    renderPanel({ onSubmit });

    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    pickOption('模型', /claude-opus-4-6/);
    // antd 的 Radio 把 input 包在 label 里，按 label 文本取即可
    fireEvent.click(screen.getByLabelText('并行'));
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      caseId: 'c-1',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });
  });

  it('模型下拉只列本行智能体协议下的模型，并标出来源与供应商', () => {
    renderPanel();
    pickOption('智能体', 'Codex');

    const openaiTrigger = screen.getAllByLabelText('模型')[0] as HTMLElement;
    fireEvent.mouseDown(openaiTrigger);
    const options = visibleOptionTexts();
    // 标签是「模型名 + 供应商名 + 来源 Tag + 窗口 Tag」（窗口那一格夹具里没声明 ⇒ 显示「未知」；
    // 供应商名见下面那条「同名模型要分得开」的用例）
    expect(options).toContain('gpt-5OpenAI 网关自动拉取未知');
    // 上一行的 anthropic 模型必须**不在**这个池子里（协议不匹配的组合不该被选中后到运行时才失败）
    expect(options.some((text) => text.includes('claude-opus-4-6'))).toBe(false);
  });

  /**
   * 可解释性：双协议智能体（DSH）的池子是**两类协议的并集**，
   * 而选项里必须能看出**每个模型来自哪个供应商**——否则「同一个模型名挂在两个网关」
   * （跨网关同名很常见）时，两个选项长得一模一样，选出来却是不同的行。
   */
  it('双协议智能体的池子是并集，且每个选项都带得出供应商名（同名模型分得开）', () => {
    renderPanel({ modelOptionsFor: poolFor });
    // 智能体下拉的选项文本是**显示名**（`AGENT_LABELS`），不是 kind：写 'dsh' 会当场
    // `下拉「智能体」里找不到 dsh`（实际选项：Claude Code / Codex / DeepSeek Harness）
    pickOption('智能体', 'DeepSeek Harness');

    const trigger = screen.getAllByLabelText('模型')[0] as HTMLElement;
    fireEvent.mouseDown(trigger);
    const options = visibleOptionTexts();
    expect(options).toContain('gpt-5OpenAI 网关自动拉取未知');
    expect(options).toContain('claude-opus-4-6Anthropic 网关手工维护未知');
  });

  it('候选池为空时当场内联 Alert 指出路，且提交被拦住', async () => {
    const onSubmit = vi.fn();
    renderPanel({ modelOptionsFor: () => [], onSubmit });

    expect(screen.getByText(/Claude Code 没有可选的模型/)).toBeInTheDocument();
    expect(screen.getByText(/协议匹配的供应商/)).toBeInTheDocument();

    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => expect(screen.getByText('请选择模型')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('删掉唯一一行后提交：提示「至少需要一个候选行」，且不发请求', async () => {
    const onSubmit = vi.fn();
    renderPanel({ onSubmit });

    // 名字写成 /删\s*除/ 而不是 '删除'：antd 的 Button 对**两个汉字**的标签会自动插一个空格
    // （渲染成 <span>删 除</span>，见 antd button 的 autoInsertSpace），可访问名因此是「删 除」。
    // 用宽松匹配，两侧行为（插空格 / 不插）都能命中——同包 empty-state.test.tsx 已踩过同一条。
    fireEvent.click(screen.getByRole('button', { name: /删\s*除/ }));
    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => expect(screen.getByText('至少需要一个候选行')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /**
   * 形态守卫：候选行是一张 **small Table**，「删除」是**操作列里右对齐的图标
   * link 按钮**。三条钉的都是「省空间」这件事，且各自对应一个会静默退化的写法：
   *   · 退回竖排标签（每个候选白多一行标签高度，右栏只有 ~545px 宽）⇒ 表头那一条会红；
   *   · 按钮里再塞回「删除」两个字（本列近一半宽度被文字吃掉）⇒ textContent 那一条会红；
   *   · 漏掉列级 `align: 'right'`（图标贴左，列宽压不下去）⇒ textAlign 那一条会红。
   * jsdom 不做布局，量不了像素：这里只钉结构，真实几何在浏览器里量。
   */
  it('删除是操作列里右对齐的图标按钮（没有文字，宽度还给内容）（C-DELETE-ICON）', () => {
    renderPanel();

    const del = screen.getByRole('button', { name: /删\s*除/ });
    // 图标按钮：一个文字节点都没有（可访问名只挂在 `aria-label` 上），图标本身是 aria-hidden 的
    expect(del.textContent).toBe('');
    expect(del.querySelector('.anticon-delete')).not.toBeNull();
    expect(del).toHaveAttribute('aria-label', '删除');

    // 右对齐是**列**的属性（antd 落到单元格的内联 textAlign 上）：少了它按钮会贴左
    const cell = del.closest('td');
    expect(cell).not.toBeNull();
    expect(cell?.style.textAlign).toBe('right');

    // 右对齐的前提是它真在最后一列：前面几列只要多一格，这个按钮就不在右边了
    const cells = Array.from(del.closest('tr')?.querySelectorAll('td') ?? []);
    expect(cells[cells.length - 1]).toBe(cell);
  });

  /**
   * 形态守卫：字段名由**列头**承担（`Form.Item` 不再给 `label`，可访问名改挂控件的 `aria-label`）。
   * 这是「一行 = 一行」的前提：三个下拉只要有一个退回带 `label` 的写法，那一行就会比邻行高一截。
   *
   * 为什么**不**在这里钉 `size="small"`（`document.querySelector('.ant-table-small')` 那类断言）：
   * 它没有区分力 —— 紧凑密度是外层 `<Form size="small">` 经 antd 的 size context 传下来的，
   * `<Table>` 上删掉 `size="small"` 也照样小。**没有见过失败的守卫
   * 不算守卫**（AGENTS.md），故这里只留钉得住的三条：列头、单元格里没有标签行、三个控件同一行。
   */
  it('候选行是表格：字段名在列头里（没有竖排标签），三个下拉各自带可访问名（C-TABLE）', () => {
    renderPanel();

    // 最后一列（操作列）的列名**留空**：三个图标按钮各带 Tooltip 与
    // aria-label，表头再写一遍「操作」只是白占这一列的宽度
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '智能体',
      '模型',
      '思考强度',
      '',
    ]);

    // 字段名**只在列头里**：单元格里再冒出一个标签行，每个候选就白多一行高度 —— 这正是改表格要解决的问题。
    // 作用域收在表格内：上面三格（用例 / 执行模式 / 使用智能体评分）本来就有标签，那是另一回事
    expect(document.querySelector('.ant-table')?.querySelectorAll('.ant-form-item-label')).toHaveLength(0);

    // 每行的三个控件都在单元格里，且各自有可访问名（列头 `<th>` 不会成为输入框的可访问名）
    expect(screen.getAllByLabelText('模型')).toHaveLength(1);
    expect(screen.getByLabelText('智能体')).toBeInTheDocument();
    expect(screen.getByLabelText('思考强度')).toBeInTheDocument();
    // 三个控件同处一行（同一张表的一行）：分开量它们所在的行，是「表格化」与「三个散落的下拉」的区别
    const agentCell = screen.getByLabelText('智能体').closest('td');
    expect(agentCell?.parentElement).toBe(screen.getByLabelText('模型').closest('td')?.parentElement);
    expect(agentCell?.parentElement).toBe(screen.getByLabelText('思考强度').closest('td')?.parentElement);
  });

  /**
   * 形态守卫：操作列是 **上移 / 下移 / 删除** 三个图标按钮，列名留空。
   * 三条各对应一个会静默退化的写法：列名又写回去（白占宽度）、顺序被改成「删除」在前
   * （破坏性动作挪到最容易误点的位置）、按钮里塞回文字（三个动作会把这一列撑成半张表）。
   */
  it('操作列是「上移 / 下移 / 删除」三个图标按钮，列名留空（C-ROW-ACTIONS）', () => {
    renderPanel();

    const cell = screen.getAllByRole('button', { name: '上移' })[0]?.closest('td');
    const buttons = Array.from(cell?.querySelectorAll('button') ?? []);

    // 顺序就是用户口径给的
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['上移', '下移', '删除']);
    // 三个都是图标按钮：一个字都不占（文字在 Tooltip 与 aria-label 里）
    expect(buttons.map((button) => button.textContent)).toEqual(['', '', '']);
  });

  /**
   * 形态守卫：右栏**窄到装不下四列**时，表格内部横向滚动，`智能体` 列钉在
   * 左边、操作列钉在右边（中间两列从它们下面滑过）。三处必须同时在场，少一处就静默退回老样子 ——
   * 表格溢到容器外面、`思考强度` 与三个操作按钮落在右栏之外（右栏是 `overflow: auto`，横向没有
   * 滚动条，被挤出去的列**根本够不到**）。三条断言各自对应一处：
   *   · 没有 `scroll={{ x: 数值 }}` ⇒ 内容容器拿不到 `overflow-x: auto`、表格也没有内联宽度；
   *   · 首列没有 `fixed` ⇒ 表头第一格不再带粘性类（滚动时它会被推出视野）；
   *   · 操作列没有 `fixed` ⇒ 表头最后一格不再带粘性类（三个按钮跟着滚走，这一行删不掉）。
   *
   * ⚠️ jsdom **没有布局引擎**：`sticky` 的实际吸边效果、「有没有真的滚起来」都量不出来，钉子只到
   * 类名、内联样式与 `colgroup` 的宽度为止（jsdom 的 `getComputedStyle` 只认内联样式，读不到样式表
   * 里的 `.ant-table-cell-fix { position: sticky }`，故这里断言的是类名而不是算出来的 `position`）。
   * 真实几何（容器 404px 时表格 636px、列宽 130/306/120/80、滚到两端时首列左边缘与末列右边缘
   * 纹丝不动）jsdom 量不出来，只能真机冒烟看，同 `CANDIDATE_COLUMN_WIDTH` 那条注释。
   */
  it('右栏装不下时横向滚动，且首列钉左、操作列钉右（C-COLUMN-FIXED）', () => {
    renderPanel();

    // 收窄到候选项表那一张：面板里还有用例 / 执行模式那些表单行，全局选 `.ant-table-content` 不稳
    const content = document.querySelector('.ant-form .ant-table-content');
    expect(content).not.toBeNull();
    // 有横向滚动才谈得上固定列：给 `scroll.x` 之前这里一个内联样式都没有
    expect(content).toHaveStyle({ overflowX: 'auto' });
    const table = content?.querySelector('table');
    // 最小宽度必须真的落到**表格自己**的宽度上（它才是滚动的那个更宽的盒子）：
    // `min-width: 100%` 保证栏够宽时铺满、不给滚动条，不是恒定的 636
    expect(table).toHaveStyle({ width: '636px', minWidth: '100%', tableLayout: 'fixed' });

    const cells = content?.querySelectorAll('thead th');
    expect(cells).toHaveLength(4);
    // 首列与操作列刚需的两条粘性类（`-fix-start` / `-fix-end` 就是 `position: sticky` 的来源）
    expect(cells?.[0]?.className).toContain('ant-table-cell-fix-start');
    expect(cells?.[3]?.className).toContain('ant-table-cell-fix-end');
    // 中间两列**不许**粘：把模型列也钉住的话，可滚动区域就只剩思考强度那一列
    expect(cells?.[1]?.className).not.toContain('ant-table-cell-fix');
    expect(cells?.[2]?.className).not.toContain('ant-table-cell-fix');
    // 表体跟着一起钉（只钉表头的话，数据行会在固定列底下滑过去 —— 滚动时表头与数据行错位）
    const firstBodyRow = content?.querySelector('tbody tr.ant-table-row');
    expect(firstBodyRow?.querySelectorAll('td')[0]?.className).toContain('ant-table-cell-fix-start');
    expect(firstBodyRow?.querySelectorAll('td')[3]?.className).toContain('ant-table-cell-fix-end');

    // 三列把宽度交出去，剩下的才归模型列（它**刻意不给宽度**，是唯一吃剩余宽度的列）。
    // jsdom 量不出模型列的实测宽度：`colgroup` 里那些数字来自 rc-table 对单元格的 ResizeObserver
    // 测量（`MeasureCell`），而 `installResizeObserverStub` 的替身**从不回调** —— 于是这里只钉得住
    // 「三列各自申报的宽度」与「模型列一列都没申报」。
    const widthsOf = (selector: string) =>
      Array.from(content?.querySelectorAll(selector) ?? []).map((cell) => (cell as HTMLElement).style.width);
    expect(widthsOf('colgroup col')).toEqual(['130px', '', '120px', '80px']);
    // 操作列右对齐也得留着：它和 `fixed` 一起决定按钮贴哪条边（少了它按钮会在列中间浮着）。
    // 读的是内联 `style` 属性而不是 `cell.style`：这里的类型是 `Element`，`style` 只长在 `HTMLElement` 上
    expect(cells?.[3]?.getAttribute('style')).toContain('text-align: right');
  });

  /**
   * 上移 / 下移的行为：候选顺序 = **串行执行顺序**，所以换位必须真的换掉表单值里的行序，
   * 而不是只动 DOM（只动 DOM 的话，一次保存就把顺序又按原样提交回去了）。
   * 用编辑模式造两行（`initial.rows` 预填），不点「添加候选」——省掉一次 antd 的挂载税。
   */
  it('上移 / 下移真的换掉行的顺序（提交顺序跟着变），且边界那一格置灰（C-ROW-MOVE）', async () => {
    const onSubmit = vi.fn();
    renderPanel({ mode: 'edit', initial: twoRowRun(), modelOptionsFor: () => twoModelPool, onSubmit });

    expect(modelCellTexts()[0]).toContain('claude-opus-4-6');
    expect(modelCellTexts()[1]).toContain('claude-haiku');

    // 边界置灰：第一行没有上一行、最后一行没有下一行（置灰而不是隐藏：按钮位置固定，眼睛不用重新找）
    expect(screen.getAllByRole('button', { name: '上移' })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: '下移' })[1]).toBeDisabled();

    // 第一行下移 ⇒ 两行换位
    fireEvent.click(screen.getAllByRole('button', { name: '下移' })[0] as HTMLElement);
    expect(modelCellTexts()[0]).toContain('claude-haiku');
    expect(modelCellTexts()[1]).toContain('claude-opus-4-6');

    // 换位后的**提交顺序**就是新顺序：这一条才是「顺序真的变了」的终局证据 ——
    // 只改渲染顺序（表单值没跟着换）时，上面那两句仍然绿，而这里会把旧顺序原样送出去。
    // 纯换位不作废任何行（行 id 与目标都没变）⇒ 不弹确认框，直接提交
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // `vi.fn()` 的调用参数是 `any`：这里断言回 `RunFormValues`（不然 `.map` 的回调参数会隐式 any，tsc 直接红）
    const submitted = onSubmit.mock.calls[0]?.[0] as RunFormValues | undefined;
    expect(submitted?.rows?.map((row) => row.modelId)).toEqual(['claude-haiku', 'claude-opus-4-6']);

    // 第二行上移 ⇒ 换回来（上下方向写反时这几条会红）
    fireEvent.click(screen.getAllByRole('button', { name: '上移' })[1] as HTMLElement);
    expect(modelCellTexts()[0]).toContain('claude-opus-4-6');
    expect(modelCellTexts()[1]).toContain('claude-haiku');
  });

  /**
   * 图标按钮必须**按行**删：表格里最容易错的一处是拿列渲染的序号去 `remove`（删掉的是别人那一行）。
   * 用编辑模式造两行（`initial.rows` 预填），不点「添加候选」—— 省掉一次 antd 的挂载税。
   */
  it('点第二行的删除只删第二行（按钮认的是本行的 field.name，不是列序号）（C-ROW-REMOVE）', () => {
    renderPanel({ mode: 'edit', initial: twoRowRun(), modelOptionsFor: () => twoModelPool });

    const deleteButtons = screen.getAllByRole('button', { name: /删\s*除/ });
    expect(deleteButtons).toHaveLength(2);
    fireEvent.click(deleteButtons[1] as HTMLElement);

    const remaining = modelCellTexts();
    expect(remaining).toHaveLength(1);
    // 留下的是**第一行**：删错行时这里会变成 claude-haiku
    expect(remaining[0]).toContain('claude-opus-4-6');
  });

  it('切换智能体后该行已选的模型被清空（否则会提交出协议不匹配的组合）', async () => {
    const onSubmit = vi.fn();
    renderPanel({ onSubmit });

    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    pickOption('模型', /claude-opus-4-6/);
    // 换成 openai 协议的智能体：上一行选的 anthropic 模型必须作废
    pickOption('智能体', 'Codex');
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => expect(screen.getByText('请选择模型')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('点取消时把 onCancel 交回去', () => {
    const onCancel = vi.fn();
    renderPanel({ onCancel });

    // 同「删除」那条：两个汉字的标签会被 antd 插空格，用宽松匹配
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * 用例下拉支持**输入文字模糊查询**：按**标题**过滤，
   * 大小写不敏感、空格分词后每个词都要命中（AND），无匹配时给中文空态。
   *
   * 为什么必须自己给 `filterOption`：antd 的默认过滤拿的是**整条 option.label**
   * （本面板拼的是「标题 · 仓库名 · 短哈希」），于是输入仓库名或短哈希也会命中——
   * 那是另一条口径。下面两条用例就是这条口径的正反两面。
   */
  describe('用例下拉的文字模糊查询（只搜标题）', () => {
    /** 打开用例下拉并输入查询串；返回之后**可见**的选项文本 */
    async function searchCases(query: string): Promise<string[]> {
      const caseSelect = screen.getAllByLabelText('用例')[0] as HTMLElement;
      fireEvent.mouseDown(caseSelect);
      fireEvent.change(caseSelect, { target: { value: query } });
      await waitFor(() => {
        // 过滤是 rc-select 的内部状态：等它真的重渲染过一轮再断言
        expect(document.querySelector('.ant-select-dropdown')).not.toBeNull();
      });
      return visibleOptionTexts();
    }

    it('输入标题里的连续文字只剩命中项（不是「全部保留」）', async () => {
      renderPanel();

      const options = await searchCases('长度');

      expect(options).toEqual(['工具名长度校验 · tool-id · 默认分支 HEAD']);
    });

    it('空格分词后每个词都要命中（AND），不是「命中任一」', async () => {
      renderPanel();

      expect(await searchCases('入站 转换')).toEqual(['多协议入站转换 · gateway · 71e6280']);
      // 「入站」命中第一条、「校验」命中第二条，两个词没有同时出现在任何标题里 ⇒ 空
      expect(await searchCases('入站 校验')).toEqual([]);
    });

    it('大小写不敏感（英文标题）', async () => {
      const englishCase: TestCase = {
        id: 'c-en',
        title: 'Fix ToolCall Parsing',
        repoPath: 'D:\\projects\\gateway',
        commitHash: null,
        repoBranch: null,
        taskPrompt: '修解析',
        rubric: CASE_RUBRIC,
        createdAt: '2026-09-22T00:00:00.000Z',
        updatedAt: '2026-09-22T00:00:00.000Z',
      };
      renderPanel({ cases: [englishCase] });

      expect(await searchCases('toolcall')).toEqual(['Fix ToolCall Parsing · gateway · 默认分支 HEAD']);
    });

    it('仓库名与短哈希**不**参与匹配（口径：只搜标题）', async () => {
      renderPanel();

      // 这两项都在选项的可见文本里，但都不是标题 ⇒ 不许命中
      expect(await searchCases('gateway')).toEqual([]);
      expect(await searchCases('71e6280')).toEqual([]);
    });

    /**
     * 「未知态补的那一项」也要进 id → 标题映射。
     *
     * 未知态（`cases === undefined`）下 `caseOptions` 会补一个**可用**的当前用例项，它的标题来自
     * 这一轮的快照、不在 `cases` 里；而 `titleById` 只由 `cases` 造 ⇒ 用户一在这个下拉里打字，
     * **当前用例**（也就是这一格此刻的值）反而是唯一被过滤掉的选项，搜不到自己。
     */
    it('列表未知时补的那一项也搜得到：它就是这一格此刻的值', async () => {
      renderPanel({ mode: 'edit', initial: editRun, cases: undefined });

      expect(await searchCases(editRun.caseTitle)).toEqual([editRun.caseTitle]);
    });

    it('无匹配时给中文空态（应用没配 antd locale，不给它会渲染英文 "No data"）', async () => {
      renderPanel();

      await searchCases('不存在的用例');

      expect(screen.getByText('没有匹配的用例')).toBeInTheDocument();
    });
  });

  /**
   * 「使用智能体评分」开关。两条口径：
   *   1. **默认关闭**（用户口径）——默认开着会让「没配评分智能体」的人一进来就撞墙；
   *   2. 打开它就必须把 `useAgentJudge` 送进 payload：`RunCreateSchema` 有这一格，
   *      界面不发它就等于这一轮悄悄退回「模型评分」。
   */
  it('「使用智能体评分」默认关闭，提交时进 payload', async () => {
    const onSubmit = vi.fn();
    renderPanel({ onSubmit });

    // 默认关闭（用户口径）
    expect(screen.getByRole('switch', { name: '使用智能体评分' })).not.toBeChecked();

    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    pickOption('模型', /claude-opus-4-6/);
    fireEvent.click(screen.getByRole('switch', { name: '使用智能体评分' }));
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ useAgentJudge: true });
  });

  /**
   * 开关打开而设置页没配默认评分智能体 = 必然在评分阶段失败（候选 agent 已经白跑几分钟）。
   * 与「模型池为空」同一条口径：当场说出来，不要等人选完到运行时才炸。
   * `judgeAgentConfigured === undefined`（未知）时**不提示**——未知不等于没配。
   */
  it('开关打开但设置页没配默认评分智能体 → 内联 Alert 指出路（不要等跑完才炸）', () => {
    renderPanel({ judgeAgentConfigured: false });

    fireEvent.click(screen.getByRole('switch', { name: '使用智能体评分' }));

    expect(screen.getByText(/没有配置默认评分智能体/)).toBeInTheDocument();
  });

  it('开关未打开时不提示「没配默认评分智能体」（提示跟着这一格走）', () => {
    renderPanel({ judgeAgentConfigured: false });

    expect(screen.queryByText(/没有配置默认评分智能体/)).toBeNull();
  });

  /**
   * 阴性面：**配了**默认评分智能体时不许提示。
   * 没有这一条，实现里那个 `judgeAgentConfigured === false` 判据被删掉（只看开关）也能全绿——
   * 而那样的提示是错的：用户明明配好了，界面却让他去设置页再配一次。
   */
  it('开关打开且设置页配了默认评分智能体 → 不提示', () => {
    renderPanel({ judgeAgentConfigured: true });

    fireEvent.click(screen.getByRole('switch', { name: '使用智能体评分' }));

    expect(screen.queryByText(/没有配置默认评分智能体/)).toBeNull();
  });

  it('开关打开但「配没配」未知（设置还没读回来）→ 不提示：未知不等于没配', () => {
    // `useSettings()` 的首帧是 `undefined`：把它当成「没配」会在每次打开表单时先闪一条假警告
    renderPanel();

    fireEvent.click(screen.getByRole('switch', { name: '使用智能体评分' }));

    expect(screen.queryByText(/没有配置默认评分智能体/)).toBeNull();
  });
});

/**
 * 思考强度：**逐行**选（第 3 条 /  /）。
 * 三条口径都在这里钉住：下拉只列服务端算好的交集、推荐档只标不预选、换模型作废已选档
 * （交集随模型变，留着一个不在交集里的脏值就会在创建时被服务端 400 拦下）。
 */
describe('RunCreatePanel：思考强度', () => {
  const effortPool: RunModelOption[] = [
    {
      providerId: 'p-anthropic',
      providerName: 'Anthropic 网关',
      modelId: 'three',
      source: 'manual',
      contextWindow: 1_048_576,
      // 关闭档**必须**在候选里且排第一（算法在 `contracts/src/effort.ts` 的 `intersectEfforts`，
      // 由 api 的 `listModelOptions` 投影出来）：
      // 「未选」与「显式关闭」是两件事，而这一条是用户唯一能点「关闭」的地方
      efforts: [EFFORT_OFF, 'low', 'high', 'max'],
      recommendedEffort: 'high',
    },
    // 上游没声明档位 ⇒ 这一行只有「默认」
    { providerId: 'p-anthropic', providerName: 'Anthropic 网关', modelId: 'none', source: 'manual' },
  ];

  it('模型下拉带窗口标签；强度下拉只列交集、标推荐、且不预选；提交时带上选中的档', async () => {
    const onSubmit = vi.fn();
    renderPanel({ modelOptionsFor: () => effortPool, onSubmit });

    pickOption('用例', /多协议入站转换/);
    pickOption('模型', /three/);
    // 窗口标签出现在**选中项**里（1.05M 与 1M 在 [1m] 阈值上分处两侧，不能都显示成 1M）。
    // 断言选中框自己而不是 getByText：下拉浮层不卸载，同一个 '1.05M' 在文档里会有两份。
    const modelSelect = screen.getAllByLabelText('模型')[0] as HTMLElement;
    expect(modelSelect.closest('.ant-select')?.textContent ?? '').toContain('1.05M');

    // 交集之外的档位一个都不出现：`pickOption` 找不到目标时会把**实际选项**列进错误消息里，
    // 所以「抛错」本身就是「这一档没被列出来」的判据（比读浮层 DOM 稳：antd 换开下拉时不卸载上一个）
    expect(() => pickOption('思考强度', 'xhigh')).toThrow(/实际选项/);
    expect(() => pickOption('思考强度', 'medium')).toThrow(/实际选项/);
    // 推荐档的标签确实带「（推荐）」（且它只标不预选）
    pickOption('思考强度', 'high（推荐）');

    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.rows?.[0]).toMatchObject({
      providerId: 'p-anthropic',
      modelId: 'three',
      effort: 'high',
    });
  });

  /**
   * 换**智能体**同样作废已选强度：换智能体会把模型一起清掉（协议可能不匹配），
   * 而强度是「模型 × 智能体」的函数 —— 留着它，界面会显示一个当前组合根本不支持的档，
   * 提交后被服务端 400 拦下（响是响，但对用户来说是一次莫名其妙的失败）。
   */
  it('换智能体也作废已选强度（模型与强度一起清）', async () => {
    const onSubmit = vi.fn();
    // 池子与 agentKind 无关：这样「换智能体后强度是否还在」不会被候选池的变化掩盖
    renderPanel({ modelOptionsFor: () => effortPool, onSubmit });

    pickOption('用例', /多协议入站转换/);
    pickOption('模型', /three/);
    pickOption('思考强度', 'high（推荐）');
    pickOption('智能体', 'Codex');

    const strength = screen.getAllByLabelText('思考强度')[0] as HTMLElement;
    // 清空态说的是「未指定」，
    // 而它具体落到哪个档由该家适配器决定（dsh 走缺省 high）——见「未指定」那一条用例
    expect(strength.closest('.ant-select')?.textContent ?? '').toContain('未指定');
  });

  it('换模型作废已选强度：换成没有档位的模型后提交，行上不带 effort', async () => {
    const onSubmit = vi.fn();
    renderPanel({ modelOptionsFor: () => effortPool, onSubmit });

    pickOption('用例', /多协议入站转换/);
    pickOption('模型', /three/);
    pickOption('思考强度', 'high（推荐）');
    pickOption('模型', /none/);

    // 换模型后强度回到「未指定」占位符 ⇒ 已选档被作废（交集随模型变，脏值会在创建时被服务端 400 拦下）。
    const strength = screen.getAllByLabelText('思考强度')[0] as HTMLElement;
    expect(strength.closest('.ant-select')?.textContent ?? '').toContain('未指定');

    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.rows?.[0]).toMatchObject({ modelId: 'none' });
    expect(onSubmit.mock.calls[0]?.[0]?.rows?.[0]?.effort).toBeUndefined();
  });

  /**
   * 「未指定」不是一个可选档（延伸）：
   * 未选档位的语义由**该家适配器**决定（DSH 走缺省 `high`，Claude Code / Codex 不传、由厂商推断），
   * 与候选里那个 `off`（**显式关闭思考**）是两件事。契约明说未选**不是**「沿用厂商默认档」，
   * 故 placeholder 必须把这件事说出来，否则用户在「我没选」与「我选了推荐档」之间无从分辨
   * （预选被禁掉了，placeholder 是唯一还能说话的地方）。
   *
   * **口径：厂商名与档位都由元数据拼、且写全名。**这条用例的靶子有两个：
   *   · 这一家**没声明**`defaultEffort`（Claude Code 就是） ⇒ 只说「未指定」，**不编**一个档
   * （占位符里那句「claude / codex 不传」正是这一档）；
   *   · 占位符里**不许出现 kind 缩写**（`dsh`）**。
   */
  it('未选档位、且这一家没声明缺省档 ⇒ 占位符只说「未指定」，不编档位也不写 kind 缩写', () => {
    renderPanel({ modelOptionsFor: () => effortPool });

    pickOption('用例', /多协议入站转换/);

    const strength = screen.getAllByLabelText('思考强度')[0] as HTMLElement;
    const text = strength.closest('.ant-select')?.textContent ?? '';
    expect(text).toContain('未指定');
    // 不编档位：没声明 `defaultEffort` 的家（claude-code）不许出现「用 <档>」那半句
    expect(text).not.toMatch(/用 /);
    // 不写缩写：`dsh` 出现在页面上就是本条要拦的那处缺陷（全名走 `AGENT_LABELS`）
    expect(text).not.toContain('dsh');
  });

  /**
   * 声明了缺省档的家（今天只有 DSH）：占位符把「未选会落到哪」说清——**厂商名写全名**、
   * 档位取元数据。
   *
    * 判据落在两处：`dsh`（kind 缩写）出现即红、`DeepSeek Harness 用 high` 消失即红
    * ——后者是「说清后果」这条口径本身。
   */
  it('未选档位、且这一家声明了缺省档 ⇒ 占位符写出全名与该档（不是 kind 缩写）', () => {
    renderPanel({ modelOptionsFor: () => effortPool });

    pickOption('用例', /多协议入站转换/);
    // 换成双协议那一家（`defaultEffortFor` 只给它声明了 `high`，与注册表真值同形）
    pickOption('智能体', 'DeepSeek Harness');

    const strength = screen.getAllByLabelText('思考强度')[0] as HTMLElement;
    const text = strength.closest('.ant-select')?.textContent ?? '';
    expect(text).toContain('未指定（DeepSeek Harness 用 high）');
    expect(text).not.toContain('dsh');
  });

  /**
   * 关闭档与「未指定」是**两件事**：
   *   · `off` = **要求关闭思考**，是候选里的第一项（档位照上游词汇原样写，
   *     关闭档的文案就是 `off` 本身）；
   *   · 「未指定」= Select 的**清空态**（`allowClear`），不是候选里的一项。
   *
   * ⚠️ **「点了 off ⇒ 提交的就是 off」也要在这里钉住**：把这一项的 `option.value` 改坏
   * （例如改成 `'none'`、或改成带括号的文案）不会有别的用例拦下，而症状是「界面选了关闭、
   * 落盘却是服务端不认识的档」。这条断言就是那个靶子（范式见上面「提交时带上选中的档」那条）。
   */
  it('候选第一项是 off，且提交出去的值就是 off', async () => {
    const onSubmit = vi.fn();
    renderPanel({ modelOptionsFor: () => effortPool, onSubmit });

    pickOption('用例', /多协议入站转换/);
    pickOption('模型', /three/);
    // 用既有的 `pickOption` 辅助：它按选项文案点选（文案一旦又长出括号，这里会抛「实际选项」）
    pickOption('思考强度', 'off');

    // 选中的这一项**显示**的就是 `off`（不是 placeholder、也不是别的措辞）
    const strength = screen.getAllByLabelText('思考强度')[0] as HTMLElement;
    expect(strength.closest('.ant-select')?.textContent ?? '').toBe('off');

    // 提交值 = 契约的关闭档名（`option.value` 必须是 `effort`，不是文案、也不是厂商词汇）
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.rows?.[0]?.effort).toBe(EFFORT_OFF);
  });

  /**
   * 「真下拉的第一项就是关闭档」——**不能用 `efforts[0]` 代替**：`efforts[0]` 是服务端元数据
   * 数组的第一格，而用户看得见的下拉来自 **api 的交集投影**（算法是 `contracts/src/effort.ts`
   * 的 `intersectEfforts`）。两者今天恰好同序，所以只断言 `efforts[0]` 的那两条用例
   * **无法区分**「投影把关闭档排到了后面 / 丢掉了」这类缺陷。
   * 下面两条用例把两种候选形态分开钉住：上游**声明过**档位（交集被裁过）、上游**没声明**（本机形态）。
   *
   * ⚠️ 两条**各自挂载**，不要合并成「同一次挂载里换模型再读」：**在 jsdom 里**同一次挂载里换完模型
   * 重开，antd 的浮层仍渲染着上一个模型的旧候选（组件自己的 `options` 已是新的，但浮层 DOM 不刷新），
   * 于是「候选换了一份」这件事在那条路径上读不到。
   * **环境限定（真机实测）**：真浏览器里浮层**会**跟着刷新 —— 把智能体从
   * claude-code（6 项）换成 codex（9 项）、重选模型后重开下拉，读到的是 codex 的那 9 项；换回来又是 6 项
   * （换智能体会重置模型，走的是「同一实例的 `options` 从一份换成另一份」这条路径）。
   * ⇒ 上面那句是 **jsdom 的产物、不是产品缺陷**。两条用例仍然各自挂载（跨环境都稳的写法才留得住），
   * 但别把这条注释读成「真机上也有这个限制」。
   */
  it('真下拉（上游声明过档位）：候选 = 交集，第一项是 off', () => {
    renderPanel({
      modelOptionsFor: () => [
        {
          providerId: 'p-anthropic',
          providerName: 'Anthropic 网关',
          modelId: 'declared',
          source: 'manual',
          // 上游声明过、被裁过的交集：只留高于 medium 的档（高不下探到 low —— 「就近取整」是静默改语义，
          //  禁掉），`off` 仍排第一（`contracts/src/effort.ts` 的 `intersectEfforts` 把它并到最前）
          efforts: [EFFORT_OFF, 'xhigh', 'max'],
          recommendedEffort: 'max',
        },
      ],
    });

    pickOption('用例', /多协议入站转换/);
    pickOption('模型', /declared/);
    // 打开强度下拉（第一次打开 = 浮层按此刻的候选渲染）
    fireEvent.mouseDown(screen.getAllByLabelText('思考强度')[0] as HTMLElement);
    // 整列按序断言（比 slice 更强）：这三个就是全部候选，顺序与文案都是判据
    expect(visibleOptionTextsOf('思考强度')).toEqual([EFFORT_OFF, 'xhigh', 'max（推荐）']);
    // 选中的这一项显示的就是 `off`；选完仍旧落在候选里（不是被当成清空态）
    pickOption('思考强度', EFFORT_OFF);
    const strength = screen.getAllByLabelText('思考强度')[0] as HTMLElement;
    expect(strength.closest('.ant-select')?.textContent ?? '').toBe(EFFORT_OFF);
  });

  /**
   * 本机真实形态：两个 provider 都是 `source: fetched`、模型**没声明 `supportedEfforts`**
   * ⇒ api 给该家的**完整档位域**，首项即关闭档（`off` 排第一靠的是 `contracts/src/effort.ts` 的
 * `intersectEfforts` 的并集）。
   *
   * 只断言「首项是 off」还不够：换一份**同样以 `off` 打头**的候选（比如上游声明过的那份交集）也能全绿，
   * 那样这条用例证明的只是「某个以 off 开头的列表」。故必须同时钉住候选**就是完整档位域**
   * （6 项、含只有它才有的 `medium`）——这才叫「本机形态」。
   */
  it('真下拉（本机形态：上游没声明 supportedEfforts）：第一项是 off，候选是该家完整档位域', () => {
    // 该家（claude-code）的完整档位域，首项是关闭档——与注册表元数据同序
    const fullDomain = [EFFORT_OFF, 'low', 'medium', 'high', 'xhigh', 'max'];
    renderPanel({
      modelOptionsFor: () => [
        {
          providerId: 'p-anthropic',
          providerName: 'Anthropic 网关',
          modelId: 'bare',
          source: 'fetched',
          efforts: [...fullDomain],
        },
      ],
    });

    pickOption('用例', /多协议入站转换/);
    // 先选模型，**再第一次打开**强度下拉：这一次打开读到的必然是 `bare` 这一行此刻的候选
    pickOption('模型', /bare/);
    fireEvent.mouseDown(screen.getAllByLabelText('思考强度')[0] as HTMLElement);
    const bareOptions = visibleOptionTextsOf('思考强度');

    expect(bareOptions[0]).toBe(EFFORT_OFF);
    // 「候选确实是这一份」不是空转：完整档位域 6 项，且含只有它才有的 `medium`
    expect(bareOptions).toHaveLength(6);
    expect(bareOptions).toContain('medium');
    // 关闭档**只出现这一次**且就在首项：只断言首项的话，实现把关闭档同时多列一遍（首项对、后面再挂一个）照样绿
    expect(bareOptions.filter((text) => text.startsWith(EFFORT_OFF))).toEqual([EFFORT_OFF]);
    // 清空态没被当成候选：`off` 说的是「我关掉思考」，「未指定」说的是「我没选」（后者不在浮层里）
    expect(bareOptions.some((text) => text.includes('未指定'))).toBe(false);
  });
});

/**
 * 编辑模式：同一张表单，`mode="edit"` 预填当前轮次。
 * 三条各自对应一个真实会咬人的失败：
 *   · 行必须带上原行 id —— 丢了它，保存时所有行都被当新行，已跑出的结果静默清零；
 *   · 执行模式取 `initial.executionMode` —— 被 `initialValues` 的「默认串行」盖掉会让用户
 *     只改了个模型、执行模式却被悄悄改成串行；
 *   · 原用例已被删除时下拉要有一个禁用占位项 —— 否则显示空白，用户一保存就换了个用例。
 */
describe('RunCreatePanel（编辑模式）', () => {
  /**
   * 发送一次提交（表单自己的「确定」）。
   * 名字写成 `/确\s*定/` 而不是 `'确定'`：两个汉字的标签会被 antd 插空格成「确 定」
   * （本文件既有用例同此口径，理由见「删掉唯一一行」那条的长注释）。
   */
  function submitForm(): void {
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
  }

  /** 保存前确认框的浮层根节点（组件挂了 `rootClassName="run-edit-confirm"`）：断言先收窄到这一个浮层 */
  async function saveDialog(): Promise<HTMLElement> {
    await waitFor(() => expect(document.querySelector('.run-edit-confirm')).not.toBeNull());
    return document.querySelector('.run-edit-confirm') as HTMLElement;
  }

  /** 「改模型 ⇒ 有行会被作废」的共同前奏：换智能体（模型那一格会被既有行为清空），再选一个 openai 的模型 */
  function changeModelToGpt5(): void {
    pickOption('智能体', 'Codex');
    pickOption('模型', /gpt-5/);
  }

  /** 一行**已选过强度**的轮次：思考强度必须能预填并原样回传（A-EFFORT） */
  const effortRun: EvalRun = { ...editRun, rows: [{ ...firstRowOf(editRun), effort: 'high' }] };

  /** 仍认这一档的池子（服务端已把交集算好）：没有它，强度下拉里根本没有 `high`，预填无从谈起 */
  const effortEditPool: RunModelOption[] = [
    {
      providerId: 'p-anthropic',
      providerName: 'Anthropic 网关',
      modelId: 'claude-opus-4-6',
      source: 'manual',
      efforts: ['low', 'high'],
      recommendedEffort: 'high',
    },
  ];

  it('预填执行模式与用例，且提交的行带着原行 id', async () => {
    const onSubmit = vi.fn();
    renderPanel({ mode: 'edit', initial: editRun, onSubmit, modelOptionsFor: poolFor });

    // 执行模式取自 initial（并行），不是表单缺省的串行
    expect(screen.getByRole('radio', { name: '并行' })).toBeChecked();
    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      caseId: 'c-1',
      executionMode: 'parallel',
      rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });
  });

  it('只改执行模式 ⇒ 不弹确认框（什么都不作废，弹窗就是噪音）', async () => {
    const onSubmit = vi.fn();
    renderPanel({ mode: 'edit', initial: editRun, onSubmit, modelOptionsFor: poolFor });

    fireEvent.click(screen.getByRole('radio', { name: '串行' }));
    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/作废/)).toBeNull();
  });

  /**
   * 编辑载荷是候选行集合的**全量替换**，而 `isSameRowTarget` 拿 `effort` 一起比
   * （一侧没给就算改了档位）。于是「强度没有被预填 / 没有被回传」的后果不是少一个字段，
   * 而是**一次什么都不改的保存也会重置这一行**（分数与产物当场消失）。
   */
  it('原样保存：预填的思考强度原样回传，且不弹确认框', async () => {
    const onSubmit = vi.fn();
    renderPanel({ mode: 'edit', initial: effortRun, onSubmit, modelOptionsFor: () => effortEditPool });

    // 强度必须**被预填**（不是回到「默认」占位符）
    const strength = screen.getAllByLabelText('思考强度')[0] as HTMLElement;
    expect(strength.closest('.ant-select')?.textContent ?? '').toContain('high');

    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.rows?.[0]).toMatchObject({
      id: 'r-1',
      modelId: 'claude-opus-4-6',
      effort: 'high',
    });
    // 一字未改 ⇒ 没有任何行会被作废 ⇒ 一个确认框都不许弹
    expect(screen.queryByText(/作废/)).toBeNull();
  });

  it('改模型 ⇒ 弹确认框列出将被作废的那一行，确认后才提交', async () => {
    const onSubmit = vi.fn();
    renderPanel({ mode: 'edit', initial: editRun, onSubmit, modelOptionsFor: poolFor });

    // 换智能体（模型那一格会被既有行为清空），再选一个 openai 的模型。
    // 选项必须用本文件既有的 `pickOption`：antd 6 的 Select 在 DOM 里有两份选项，
    // `getByRole('option')` 拿到的是不接事件的可访问性镜像（见该函数的长注释）。
    changeModelToGpt5();
    submitForm();

    // 确认框里必须点名**将被作废的那一行**（列的是这一轮现有的行：智能体 · 模型 · 原状态）
    const dialog = await saveDialog();
    expect(within(dialog).getAllByText(/作废/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Claude Code · claude-opus-4-6/)).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  /**
   * A14：`onOk` 必须**交回在途 promise**，让 antd 的 `ActionButton` 等它；且 `okButtonProps` 里
   * **一个 `loading` 键都不能有**——`ActionButton.js` 把 `buttonProps` 展开在自己的 `loading` 之后，
   * 键只要在场（哪怕是 `undefined`）就会盖掉它内部的转圈状态：确认框照样等，但用户看不到「在保存」。
   */
  it('保存未落定前确认框不关闭、保存按钮在转圈', async () => {
    let finish: (() => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderPanel({ mode: 'edit', initial: editRun, onSubmit, modelOptionsFor: poolFor });

    changeModelToGpt5();
    submitForm();
    const dialog = await saveDialog();
    // 先把节点抓在手里再点：转圈时 antd 会往按钮里塞一个带 `aria-label="loading"` 的图标，
    // 可访问名不再是「保存」，按名字重查会落空（`run-detail-panel.test.tsx` 的删除用例同此写法）。
    const save = within(dialog).getByRole('button', { name: '保存' });
    fireEvent.click(save);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // 保存**还没回来** ⇒ 浮层必须还在（提前关闭 = 用户看到「点一下没反应」，再点一次就是第二次 PUT）。
    // 用 getAllByText 而不是 getByText：antd 的浮层把标题同时放进可见标题与无障碍标签两个节点
    // （`run-detail-panel.test.tsx` 的 startDialog 注释同此口径），单数查询会报「找到多个」。
    expect(within(dialog).getAllByText(/作废/).length).toBeGreaterThan(0);
    await waitFor(() => expect(save.className).toContain('ant-btn-loading'));

    await act(async () => { finish?.(); });
  });

  it('原用例已被删除：下拉里补一个禁用的占位项，保存不会换掉 caseId', async () => {
    const onSubmit = vi.fn();
    const deletedCaseRun = { ...editRun, caseId: 'c-gone', caseTitle: '已被删掉的用例' };
    renderPanel({ mode: 'edit', initial: deletedCaseRun, onSubmit, modelOptionsFor: poolFor });

    expect(screen.getByText(/已被删掉的用例/)).toBeDefined();
    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ caseId: 'c-gone' });
  });

  /**
   * **用例列表未知 ≠ 用例已被删除**。
   *
   * 可达路径正是本页支持的那条：直开 / 刷新 `?panel=edit&id=…`（设计把 URL 当唯一真源，刷新是正常用法）
   * 时这一轮的快照常比 `/api/cases` 先到；它读失败时更是一直不到，而那个错误不在本页展示。
   * 按「已删除」处置就会让下拉显示一句**假话**并且选项被禁用——用例根本换不了。
   * 口径与本页 `judgeAgentConfigured` 的「未知 ≠ 没配」同源：只有**已知**不含它才敢说「已删除」。
   */
  it('用例列表未知（undefined）：不说「原用例已删除」，当前用例仍在下拉里、也仍可提交', async () => {
    const onSubmit = vi.fn();
    renderPanel({ mode: 'edit', initial: editRun, cases: undefined, onSubmit, modelOptionsFor: poolFor });

    // 「未知」的处置必须与「已知为空」看得出区别：这一句一个字都不许出现
    expect(screen.queryByText(/原用例已删除/)).toBeNull();
    // 但这一轮的用例仍要看得见（否则用户会以为用例丢了，或以为下拉坏了）
    expect(screen.getByText(editRun.caseTitle)).toBeDefined();
    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ caseId: 'c-1' });
  });

  it('新增模式：提交里不含 id（创建路径不接受行身份）', async () => {
    const onSubmit = vi.fn();
    renderPanel({ onSubmit, modelOptionsFor: poolFor });

    // 用例是必填的（最初漏了这一步：不选用例连提交都到不了，断言只会停在「一次都没调用」）
    pickOption('用例', /多协议入站转换/);
    pickOption('模型', /claude-opus-4-6/);
    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0].rows[0]).not.toHaveProperty('id');
  });

  /**
   * 退化态守卫（`mode="edit"` 却没给 `initial`）：**整个表单都不渲染**。
   *
   * 为什么这条值得单独钉住：这种组合一旦退化成创建形状（一个空白默认行、行上没有 id、没有
   * 「原用例已删除」的占位项），提交出去的载荷就**没有 id、且省略了这一轮现有的全部行**——
   * 而更新端点是**全量替换**语义（`api/src/runs.ts` 把「没收到某一行」读成「删掉这一行」）⇒
   * 一次误接线就能静默销毁这一轮跑出来的结果，且界面上没有任何征兆（表单长得跟新建一模一样）。
   *
   * 判别联合（`RunCreatePanelProps`）已经让真实的 JSX 调用点过不了编译；这一条验的是**运行期**
   * 那一层兜底——`renderPanel` 吃的是 `Partial<…>`（夹具入口那一次断言），故这个组合喂得进来，
   * 正好当那个「`as` 断言 / JS 调用方」。
   */
  it('mode="edit" 却没给 initial：整个表单都不渲染（没有可提交的路径）', () => {
    const onSubmit = vi.fn();
    const { container } = renderPanel({ mode: 'edit', initial: undefined, onSubmit, modelOptionsFor: poolFor });

    // 不许有任何可提交的东西：连表单本身都不在 DOM 里
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /确\s*定/ })).toBeNull();
    expect(screen.queryByLabelText('用例')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /**
   * 判别联合的**编译期**守卫。
   *
   * 上一条只验运行期兜底（`renderPanel` 走了一次断言，什么组合都喂得进来）；而「`mode: 'edit'` 必须
   * 同时给 `initial`」这条**编译期**保证只由这一条钉住——把 props 拆回两个各自可选的格子，
   * 全套用例照样绿。
   *
   * 做法就是一行「指令必须被用上」的断言：`@ts-expect-error` 只在**紧接的那一行真的报错**时才算数，
   * 否则 `tsc` 报「Unused '@ts-expect-error' directive」。谁把联合拆掉，`pnpm typecheck` 立刻红。
   * `@ts-expect-error` 刻意只放在测试里：它钉的是 props **形状**这件编译期的事，
   * 运行期没有等价的观测点；而少给 `initial` 的后果是全量替换语义下静默销毁一轮已有的结果。
   */
  it('mode="edit" 少给 initial：编译期就过不去（@ts-expect-error 必须被用上）', () => {
    // @ts-expect-error 判别联合要求 mode="edit" 同时给 initial：这一行故意缺它，TS2322 必须在这里报出来
    const invalidEditProps = <RunCreatePanel cases={cases} modelOptionsFor={poolFor} saving={false} onSubmit={vi.fn()} onCancel={vi.fn()} mode="edit" />;

    // 这条用例没有运行期主张：上面那行**编译**不过去才是它的全部内容（断言只是让这个变量真的被用上）
    expect(invalidEditProps).toBeDefined();
  });
});

/**
 * `invalidatedRows`：确认框的内容，也是它「不该弹时不弹」的判据。
 * 判据是 contracts 的 `isSameRowTarget`——与服务端的重置判据**同一份**。
 */
describe('invalidatedRows', () => {
  /** 一行「跑过、有东西可丢」的行 */
  function rowOf(overrides: Partial<EvalRow> = {}): EvalRow {
    return {
      id: 'r-1',
      agentKind: 'claude-code',
      providerId: 'p-anthropic',
      providerName: 'Anthropic 网关',
      baseUrl: 'https://gw.example.com/anthropic',
      modelId: 'claude-opus-4-6',
      status: 'judged',
      branch: 'test/r-1',
      workspacePath: 'D:\\runs\\run-1\\rows\\r-1\\workspace',
      baselineCommit: 'a'.repeat(40),
      tokens: null,
      turns: null,
      durationMs: null,
      diff: null,
      score: null,
      error: null,
      attempts: 1,
      ...overrides,
    };
  }

  const judged = rowOf();
  /** 「没跑过」那一档的覆写：`pending` + 没有基线 + 零尝试（没有任何东西可丢） */
  const neverRanOverrides: Partial<EvalRow> = { id: 'r-2', status: 'pending', baselineCommit: '', attempts: 0 };
  const neverRan = rowOf(neverRanOverrides);
  const run = { ...editRun, rows: [judged, neverRan] };

  /** 把一组行拼成表单会交回的形状（`id` 原样带着） */
  function submitOf(rows: EvalRow[], overrides: Partial<RunFormValues> = {}): RunFormValues {
    return {
      caseId: run.caseId,
      executionMode: run.executionMode,
      useAgentJudge: run.useAgentJudge,
      rows: rows.map((row) => ({ id: row.id, agentKind: row.agentKind, providerId: row.providerId, modelId: row.modelId })),
      ...overrides,
    };
  }

  it('只改执行模式 ⇒ 空数组（不弹）', () => {
    expect(invalidatedRows(run, submitOf([judged, neverRan]))).toEqual([]);
  });

  it('改模型 ⇒ 只有那一行，且**没跑过的行不算**（它没有东西可丢）', () => {
    const changed = invalidatedRows(run, submitOf([rowOf({ modelId: 'claude-haiku' }), neverRan]));
    expect(changed.map((row) => row.id)).toEqual(['r-1']);
    // 「没跑过的行不算」必须让那一行**自己也改了目标**才算真的测到：目标没变时它被
    // `isSameRowTarget` 判成「同一件事」而排除，与 `lostSomething` 那条判据无关
    //（实测：删掉 `if (!lostSomething) return false;` 时上面那句照样绿）。它没有分数也没有产物，
    // 重置它什么都不丢——拿它去弹确认框就是噪音（下面的 A15 用例守着「有噪音就不该弹」）。
    const alsoChanged = invalidatedRows(
      run,
      submitOf([rowOf({ modelId: 'claude-haiku' }), rowOf({ ...neverRanOverrides, modelId: 'gpt-5' })]),
    );
    expect(alsoChanged.map((row) => row.id)).toEqual(['r-1']);
  });

  it('删掉一行 ⇒ 它在作废名单里；换来用例 ⇒ 全部（含没跑过的）', () => {
    expect(invalidatedRows(run, submitOf([neverRan])).map((row) => row.id)).toEqual(['r-1']);
    expect(invalidatedRows(run, submitOf([judged, neverRan], { caseId: 'c-2' })).map((row) => row.id)).toEqual(['r-1']);
  });

  /**
   * **强度变了 = 这一行不再同一件事**（同一个模型、同一家供应商，
   * high 改成 low 跑出来的是另一次评测），所以它必须进作废名单；而强度**没变**时不许进
   * （只在两侧都写死成「有强度就重置」的实现会让后一条红）。
   */
  it('改强度 ⇒ 那一行；强度没变 ⇒ 空数组（缺省一侧算改了）', () => {
    const high = rowOf({ effort: 'high' });
    const runWithHigh = { ...editRun, rows: [high] };
    const keep = (effort: string | undefined): RunFormValues => ({
      caseId: runWithHigh.caseId,
      executionMode: runWithHigh.executionMode,
      useAgentJudge: runWithHigh.useAgentJudge,
      rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6', ...(effort === undefined ? {} : { effort }) }],
    });

    expect(invalidatedRows(runWithHigh, keep('low')).map((row) => row.id)).toEqual(['r-1']);
    expect(invalidatedRows(runWithHigh, keep('high'))).toEqual([]);
    // 表单没回传强度（旧客户端 / 预填漏了）＝ 「未指定档位」，按改了处理（安全方向，contracts 有注释）
    expect(invalidatedRows(runWithHigh, keep(undefined)).map((row) => row.id)).toEqual(['r-1']);
  });
});

/**
 * 「思考强度」占位符的**三档文案**。
 *
 * 为什么单独测这个纯函数而不是只从 Select 的 `textContent` 反推：那是**一句说出口的话**，
 * 三档的判据（没选智能体 / 这家没声明缺省档 / 声明了）必须逐档可证；组件层那两条用例只能
 * 覆盖到夹具给的那两家，而「没选智能体」这一档在组件上要先造一个空智能体的行才够得着。
 */
describe('effortPlaceholder', () => {
  const declared: (agentKind: 'claude-code' | 'codex' | 'dsh') => string | undefined = (agentKind) =>
    agentKind === 'dsh' ? 'high' : undefined;

  it('这一家声明了缺省档 ⇒ 写全名与该档（**不是** kind 缩写）', () => {
    const text = effortPlaceholder('dsh', declared);
    expect(text).toBe('未指定（DeepSeek Harness 用 high）');
    // 靶子：那句缩写 `dsh` 出现在页面上就是这条用例要拦下的缺陷
    expect(text).not.toContain('dsh');
  });

  it('这一家没声明缺省档（claude-code / codex）⇒ 只说「未指定」，不编一个档', () => {
    // 编一个「沿用厂商默认档」是契约明禁的误读：我们没作出那个承诺
    expect(effortPlaceholder('claude-code', declared)).toBe('未指定');
    expect(effortPlaceholder('codex', declared)).toBe('未指定');
  });

  it('还没选智能体 / 调用方没给这一格（元数据没到）⇒ 只说「未指定」', () => {
    expect(effortPlaceholder(undefined, declared)).toBe('未指定');
    expect(effortPlaceholder('dsh', undefined)).toBe('未指定');
  });
});
