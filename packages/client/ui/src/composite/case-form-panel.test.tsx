/**
 * CaseFormPanel：表单字段、提交归一化、评分标准项的生成 / 识别回填、仓库校验回显，以及六条守卫。
 *
 * 六条守卫：
 *   1. 手工输入的 commit hash 不在候选列表里也能提交（候选只是便利）；
 *   2. 生成 / 识别**失败**都不动用户已有的东西：表格原样、识别文本原样——
 *      反面写法是「先清空再请求」，一次网络抖动就清掉用户刚调好的表或刚粘进来的长文；
 *   3. **空表能存在、不能提交**：表格常驻可见、新建时就是空表，提交由 rubric 那条规则拦下；
 *   4. **在途的识别可以取消**：按了取消，之后才回来的结果一个字都不回填（取消就是取消）；
 *   5. 仓库信息只在「当前输入框的值 == 校验通过的那次值」时回显（否则会让人以为新路径也校验过了）；
 *   6. 挂载面板不产生 antd 的弃用告警（`addonAfter` 那一类，见文件末尾的 describe）。 * 表单上**没有**「默认评分模型」这一格：评分模型只来自设置页「评分配置」，
 * 所以这份文件里也不再需要任何 provider 清单夹具。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CaseCreate, RepoInfo, Rubric, TestCase } from '@aieval/contracts';
import { CaseFormPanel, type CaseFormPanelProps } from './case-form-panel';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 ResizeObserver，antd 的下拉/虚拟列表内部会直接 new 全局构造器：不打桩，展开下拉即抛。
beforeEach(() => {
  installResizeObserverStub();
});

const HASH_IN_LIST = 'aaa1111';
const HASH_NOT_IN_LIST = 'b'.repeat(40);
const FULL_HASH = 'a1b2c3d4'.repeat(5);

const REPO_INFO: RepoInfo = {
  repoPath: 'D:\\projects\\gateway',
  repoName: 'gateway',
  branch: 'main',
  kind: 'local',
  mirrorPath: null,
  mirrorReady: false,
  mirrorFetchedAt: null,
  tip: null,
};

const INITIAL: TestCase = {
  id: 'case-1',
  title: '为网关补齐转换回归',
  repoPath: 'D:\\projects\\gateway',
  commitHash: FULL_HASH,
  repoBranch: null,
  taskPrompt: '为 anthropic-to-chat 补一条回归用例',
  rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }] },
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

/** props 基线：setup 与 rerender 共用一份，避免两处默认值漂移 */
function defaultProps(): CaseFormPanelProps {
  return {
    mode: 'new',
    initial: null,
    judgeConfigured: true,
    saving: false,
    generating: false,
    validating: false,
    loadingCommits: false,
    commits: [{ hash: HASH_IN_LIST, subject: '初始提交' }],
    repoInfo: null,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onValidateRepo: vi.fn(async () => REPO_INFO),
    onGenerate: vi.fn<CaseFormPanelProps['onGenerate']>(async () => ({
      rubric: { groups: [{ name: 'g', items: [{ id: 'A1', goal: '生成出来的目标', weight: 10 }] }] },
      addedItems: 1,
    })),
    onLoadCommits: vi.fn(),
  };
}

/** 渲染面板：只覆盖本用例关心的 props，其余取基线 */
function setup(overrides: Partial<CaseFormPanelProps> = {}): ReturnType<typeof render> {
  return render(<CaseFormPanel {...defaultProps()} {...overrides} />);
}

/**
 * commit 输入框：**按 label 关联取内层 input**，不按 data-testid 取。
 * 原因：antd 的 Select 系组件（AutoComplete 也属于它）会把额外 props 放到外层容器而不是内层 input，
 * 对着容器 fireEvent.change 不会改变表单值——这条弯路不值得再走一遍。
 */
function commitInput(): HTMLElement {
  return screen.getByLabelText('commit hash');
}

/**
 * 只填三个**文本**必填字段（标题 / 考题提示词 / 仓库路径）——**评分标准项那张表不在这里填**
 * （它的合法一项由 `fillRequired()` 负责）：表格留空正是「空表不能提交」那条用例的前提。
 */
function fillTextFields(): void {
  fireEvent.change(screen.getByTestId('case-title'), { target: { value: '新用例' } });
  fireEvent.change(screen.getByTestId('case-task-prompt'), { target: { value: '补一条回归' } });
  fireEvent.change(screen.getByTestId('case-repo-path'), { target: { value: 'D:\\projects\\gateway' } });
}

/** 填满必填字段（标题 / 考题提示词 / 仓库路径）+ 一项合法的评分标准项 */
function fillRequired(): void {
  fillTextFields();
  // 空表能存在、不能提交（与写侧同一份 validateRubric）：这一项让表单过校验
  fireEvent.click(screen.getByTestId('rubric-add-group'));
  fireEvent.change(screen.getByTestId('rubric-group-name-0'), { target: { value: '一、生产代码' } });
  fireEvent.change(screen.getByTestId('rubric-item-goal-0-0'), { target: { value: '追加 agent 字段' } });
}

describe('CaseFormPanel 提交', () => {
  it('新建模式：提交时把三个文本字段 + 一项评分标准项与空 commitHash 归一化后交给 onSubmit', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit });
    fillRequired();

    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      title: '新用例',
      repoPath: 'D:\\projects\\gateway',
      // 输入框留空 == 默认分支 HEAD == 契约里的 null（空串会被 TestCaseSchema 的 min(1) 拒绝）
      commitHash: null,
      // 本地态的分支恒为 null（服务端对「本地 + 分支」是硬拒绝）：分支输入只在远端态渲染，
      // 这条用例填的是本地路径，所以交回的必然是用远端默认分支的那个 null
      repoBranch: null,
      taskPrompt: '补一条回归',
      rubric: { groups: [{ name: '一、生产代码', items: [{ id: '', goal: '追加 agent 字段', weight: 1 }] }] },
    });
  });

  it('必填没填时不提交，并给出中文提示（不是 antd 默认的英文）', async () => {
    const onSubmit = vi.fn();
    setup({ onSubmit });

    fireEvent.click(screen.getByTestId('case-submit'));

    expect(await screen.findByText('请填写标题')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // 只有空格的标题：antd 的 `required` 会放行，不拦的话它会被 trim 成 '' 交给服务端，
  // 用户白等一次往返、拿到的还是一句与字段无关的笼统报错。
  it('标题只有空格时不提交，并给出字段级中文提示', async () => {
    const onSubmit = vi.fn();
    setup({ onSubmit });
    fillRequired();
    fireEvent.change(screen.getByTestId('case-title'), { target: { value: '   ' } });

    fireEvent.click(screen.getByTestId('case-submit'));

    expect(await screen.findByText('标题不能只有空格')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /**
   * 标题有 `whitespace` 规则，仓库路径却没有时——纯空格能过前端校验，`handleFinish` 的 trim 把它
   * 变成 `''`，服务端 `CaseCreateSchema` 的 `min(1)` 拒绝，用户拿到的是一条「查询参数不合法」的 toast，
   * 表单上**没有任何字段级红字**，也就无从知道该改哪个字段。
   */
  it('仓库路径只有空格时不提交，并给出字段级中文提示', async () => {
    const onSubmit = vi.fn();
    setup({ onSubmit });
    // 新建态默认落在「远端仓库」，这条用例要的是本地那句提示，所以先显式切到本地
    fireEvent.click(screen.getByRole('radio', { name: '本地目录' }));
    fillRequired();
    fireEvent.change(screen.getByTestId('case-repo-path'), { target: { value: '   ' } });

    fireEvent.click(screen.getByTestId('case-submit'));

    expect(await screen.findByText('请填写代码仓库的本地绝对路径')).toBeInTheDocument();
    // 两次都必须是「没发出去」：拦不住就等于又走了一遍服务端往返 + 笼统报错的老路
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('编辑模式：预填已有用例的值，提交时按原值交回', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ mode: 'edit', initial: INITIAL, onSubmit });

    expect(screen.getByTestId('case-title')).toHaveValue(INITIAL.title);
    expect(screen.getByTestId('rubric-item-goal-0-0')).toHaveValue('追加 agent 字段');

    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // 用例上**没有**评分模型这一格：提交里也不该冒出这两个键（否则契约会把它们剥掉，
    // 而界面与落盘就成了两回事）
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('judgeProviderId');
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('judgeModelId');
    expect(onSubmit.mock.calls[0]?.[0]?.commitHash).toBe(INITIAL.commitHash);
  });

  it('点「取消」调 onCancel', () => {
    const onCancel = vi.fn();
    setup({ onCancel });

    fireEvent.click(screen.getByTestId('case-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // 候选只是便利，手工输入的合法 hash 必须能提交。
  it('手工输入的 commit hash 不在候选列表里也能提交', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit });
    fillRequired();
    fireEvent.change(commitInput(), { target: { value: HASH_NOT_IN_LIST } });

    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.commitHash).toBe(HASH_NOT_IN_LIST);
  });

  // 候选为空时必须仍能手工填 hash 提交（新仓库只有 1 个提交、git log 出错都会这样）。
  it('候选为空时仍能提交（下拉只说明「暂无候选」，不阻塞）', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ commits: [], onSubmit });
    fillRequired();
    fireEvent.change(commitInput(), { target: { value: HASH_NOT_IN_LIST } });
    fireEvent.mouseDown(commitInput());

    expect(await screen.findByText('暂无候选提交，可手工输入完整 hash')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.commitHash).toBe(HASH_NOT_IN_LIST);
  });

  // 断言落在**提交值**上而不是输入框的显示文本：显示成什么由 rc-select 决定，
  // 而契约要的是「选中的候选 = 这个 hash」。若这条失败（提交值里混进了提交说明），
  // 把选项的 label 改成只有 hash——说明文字挪到 extra 提示或别的展示位上。
  it('选中候选提交后，提交里带的是那个 hash', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit });
    fillRequired();

    fireEvent.mouseDown(commitInput());
    fireEvent.click(await screen.findByText('aaa1111 初始提交'));
    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.commitHash).toBe(HASH_IN_LIST);
  });
});

describe('CaseFormPanel 的评分标准项', () => {
  it('「智能生成」把当前表格一起交出去（AI 靠它做只增不改）', async () => {
    // 替身**必须带类型参数**：不写的话 `mock.calls[0]` 是空元组（`[]`），下面对入参的断言连编译都过不去
    const onGenerate = vi.fn<CaseFormPanelProps['onGenerate']>(async () => ({
      rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }, { id: 'A2', goal: '补 Javadoc', weight: 4 }] }] },
      addedItems: 1,
    }));
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-generate-rubric'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect(onGenerate.mock.calls[0]?.[0]).toMatchObject({ prompt: '', repoPath: 'D:\\projects\\gateway' });
    expect((onGenerate.mock.calls[0]?.[0] as { rubric: Rubric }).rubric.groups[0]?.items).toHaveLength(1);
    // 成功后表格被替换成返回的那一份。**用 testid 而不是 getByDisplayValue**：
    // 识别弹窗打开时页面上会有两个含同一段文本的输入框，`getByDisplayValue` 会命中多个而报错
    await waitFor(() => expect(screen.getByTestId('rubric-item-goal-0-1')).toHaveValue('补 Javadoc'));
  });

  it('生成失败不动已有的表格（一次失败的点击不能清掉用户刚调好的表）', async () => {
    const onGenerate = vi.fn(async () => {
      throw new Error('评分模型返回的不是合法 JSON');
    });
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-generate-rubric'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('rubric-item-goal-0-0')).toHaveValue('追加 agent 字段'));
  });

  // 标题只说这条**真正**断言的三件事：「弹窗里只有一个文本域」由 rubric-recognize-modal.test.tsx 守
  it('「智能识别」只把用户粘的文本交出去，成功后整表替换并关窗', async () => {
    const onGenerate = vi.fn(async () => ({
      rubric: { groups: [{ name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] }] },
      addedItems: 0,
    }));
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-recognize-rubric'));
    fireEvent.change(await screen.findByTestId('rubric-recognize-text'), { target: { value: '## 一、生产代码 48 分' } });
    fireEvent.click(screen.getByTestId('rubric-recognize-submit'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledWith({ mode: 'recognize', rubric: { groups: [] }, taskPrompt: '', prompt: '## 一、生产代码 48 分', repoPath: '' }));
    await waitFor(() => expect(screen.queryByTestId('rubric-recognize-text')).toBeNull());
    expect(screen.getByTestId('rubric-item-goal-0-0')).toHaveValue('补透传用例');
  });

  it('识别失败时弹窗不关、文本与原表格都原样保留', async () => {
    const onGenerate = vi.fn(async () => {
      throw new Error('识别失败');
    });
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-recognize-rubric'));
    fireEvent.change(await screen.findByTestId('rubric-recognize-text'), { target: { value: '很长的一段要求' } });
    fireEvent.click(screen.getByTestId('rubric-recognize-submit'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    // 弹窗没关（文本还在、且原样），表格也没被清——反面写法是「先清空再请求」：
    // 一次抖动就同时毁掉用户刚粘进来的长文与之前调好的表
    expect(screen.getByTestId('rubric-recognize-text')).toHaveValue('很长的一段要求');
    expect(screen.getByTestId('rubric-item-goal-0-0')).toHaveValue('追加 agent 字段');
  });

  /**
   * 守卫：识别**在途**时按取消 ⇒ 这次请求的结果作废、一个字都不回填。
   *
   * 为什么值得一条：取消按钮在识别期间**不禁用**（把不想再等的用户锁在慢请求后面比白花一次调用更糟），
   * 而请求一旦发出去就一定会回来。少了代次那道闸，用户按完取消、表格仍会在**他看不见的地方**被换掉——
   * 屏幕上只剩一份他没要过的新表，且没有任何提示说这是刚才那次识别的结果。
   */
  it('识别在途时按「取消」：结果回来也不回填（取消就是取消）', async () => {
    const pending: ((value: { rubric: Rubric; addedItems: number }) => void)[] = [];
    const onGenerate = vi.fn<CaseFormPanelProps['onGenerate']>(
      () => new Promise<{ rubric: Rubric; addedItems: number }>((resolve) => {
        pending.push(resolve);
      }),
    );
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-recognize-rubric'));
    fireEvent.change(await screen.findByTestId('rubric-recognize-text'), { target: { value: '很长的一段要求' } });
    fireEvent.click(screen.getByTestId('rubric-recognize-submit'));
    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));

    // 请求还在途：用户按取消关掉弹窗，之后那一次才成功返回
    fireEvent.click(screen.getByTestId('rubric-recognize-cancel'));
    pending[0]?.({ rubric: { groups: [{ name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] }] }, addedItems: 0 });

    // 等一拍，确保回填那一步有机会发生（否则这条断言没有区分力）
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('rubric-item-goal-0-0')).toHaveValue('追加 agent 字段');
  });

  it('未配置评分模型时两个按钮都禁用，悬停给出「去设置页」的指引', async () => {
    setup({ judgeConfigured: false });
    expect(screen.getByTestId('case-generate-rubric')).toBeDisabled();
    expect(screen.getByTestId('case-recognize-rubric')).toBeDisabled();
    fireEvent.mouseOver(screen.getByTestId('case-generate-wrapper'));
    expect(await screen.findByText('请先到设置里配置默认评分模型')).toBeInTheDocument();
  });

  /**
   * 守卫：**按钮禁用是唯一的第一道闸，但「点了也不会发」要有第二条**。
   *
   * 两处都不能省：
   *   · 先把三个文本字段填满——`handleGenerate` 的第一步是 `validateFields(['taskPrompt','repoPath'])`，
   *     空表单会让它在**到达 `onGenerate` 之前**就返回，那样这条用例在按钮被误改成可用时照样绿；   * · 断言前**等一拍**——`handleGenerate` 是 async 的，同步断言跑在校验 resolve 之前，
   * 同样会让上面那种回归溜过去。
   */
  it('未配置评分模型时点两个按钮都不会触发生成', async () => {
    const onGenerate = vi.fn();
    setup({ judgeConfigured: false, onGenerate });
    fillTextFields();
    fireEvent.click(screen.getByTestId('case-generate-rubric'));
    fireEvent.click(screen.getByTestId('case-recognize-rubric'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onGenerate).not.toHaveBeenCalled();
  });

  /**
   * 只看全局默认：编辑模式下的禁用提示与新建模式**逐字相同**。
   * 这条钉的是「删除之后不许有残留的第二条去处文案」——用例上已经没有评分模型这一格，
   * 若还提示「本用例的评分模型配置不完整」，用户会去找一个界面上不存在的字段。
   * 改名换形之后它照样成立（两个按钮共用同一把全局尺子），故随卡片一起保留。
   */
  it('编辑已有用例时，禁用提示仍是「去设置里配全局默认」那一条', async () => {
    setup({ mode: 'edit', initial: INITIAL, judgeConfigured: false });

    expect(screen.getByTestId('case-generate-rubric')).toBeDisabled();
    expect(screen.getByTestId('case-recognize-rubric')).toBeDisabled();
    fireEvent.mouseOver(screen.getByTestId('case-generate-wrapper'));

    expect(await screen.findByText('请先到设置里配置默认评分模型')).toBeInTheDocument();
  });

  /**
   * 守卫：**空表能存在、不能提交**。判别力全部落在 `onSubmit` 上。
   *
   * 为什么这里**不**断言「页面上有『评分标准项不能为空』」：那句中文由 `RubricTable` 在**挂载时**就显示
   * （空表必然过不了 `validateRubric`），而 `Form.Item` 是 `noStyle`、根本不渲染自己的 error——
   * 那样一行断言在**规则被删掉之后照样绿**（红只可能来自下面这行）。
   * 那句话本身的显示由 `rubric-table.test.tsx` 守（`rubric-validation-error`）。
   */
  it('空表提交被拦下（空表能存在、不能提交）', async () => {
    const onSubmit = vi.fn();
    setup({ mode: 'new', initial: null, onSubmit });
    // 只填文本字段：表格留空 ⇒ **唯一**的拦截者就是 rubric 那条规则，
    // 少填一个文本字段的话「没提交」就不再是这条规则的功劳了
    fillTextFields();
    fireEvent.click(screen.getByTestId('case-submit'));
    // 等一拍：antd 的校验是异步的，`onSubmit` 若会被调用就在这一拍里（不等的话「没调用」是空转）
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('CaseFormPanel 的仓库校验', () => {
  it('点「校验」把路径交给 onValidateRepo，并在回显区显示仓库名与分支', async () => {
    const onValidateRepo = vi.fn(async () => REPO_INFO);
    const view = setup({ onValidateRepo, repoInfo: null });
    fillRequired();

    fireEvent.click(screen.getByTestId('case-validate-repo'));
    // 交出去的是「来源 + 分支」对象（页面的校验入参形状）：这条用例填的是本地路径，
    // 本地态的分支恒为 null（留空的分支输入框也归一成 null）
    await waitFor(() =>
      expect(onValidateRepo).toHaveBeenCalledWith({ repoPath: 'D:\\projects\\gateway', repoBranch: null }),
    );

    // 页面在校验成功后把 repoInfo 传回来（这里用 rerender 模拟那次状态更新）
    view.rerender(<CaseFormPanel {...defaultProps()} onValidateRepo={onValidateRepo} repoInfo={REPO_INFO} />);

    expect(await screen.findByTestId('case-repo-info')).toHaveTextContent('gateway');
    expect(screen.getByTestId('case-repo-info')).toHaveTextContent('main');
  });

  it('改了仓库路径之后不再显示上一次的校验回显（否则会以为新路径也校验过了）', async () => {
    const onValidateRepo = vi.fn(async () => REPO_INFO);
    setup({ onValidateRepo, repoInfo: REPO_INFO });
    fillRequired();

    fireEvent.click(screen.getByTestId('case-validate-repo'));
    await waitFor(() => expect(screen.getByTestId('case-repo-info')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('case-repo-path'), { target: { value: 'D:\\projects\\other' } });

    await waitFor(() => expect(screen.queryByTestId('case-repo-info')).toBeNull());
  });

  it('校验失败（onValidateRepo 抛错）时不留「已校验」的假状态', async () => {
    const onValidateRepo = vi.fn(async () => {
      throw new Error('不是 git 仓库');
    });
    setup({ onValidateRepo, repoInfo: REPO_INFO });
    fillRequired();

    fireEvent.click(screen.getByTestId('case-validate-repo'));

    await waitFor(() => expect(onValidateRepo).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('case-repo-info')).toBeNull();
  });

  it('「加载候选」按钮调 onLoadCommits', () => {
    const onLoadCommits = vi.fn();
    setup({ onLoadCommits });

    fireEvent.click(screen.getByTestId('case-load-commits'));

    expect(onLoadCommits).toHaveBeenCalledTimes(1);
  });

  it('提示词输入框用 antd 的等宽字体 token（不是写死的字体名）', () => {
    setup();

    // 「评分提示词」那个文本域已换成评分标准项表格：
    // 这条守卫守的是 `monoStyle`（`theme.useToken().fontFamilyCode`）真的落在提示词文本域上，
    // 而考题提示词仍是同一个语义（交出去的是题面正文），故改指它、保留这条守卫。
    const textarea = screen.getByTestId('case-task-prompt');
    // 默认 token 是 'SFMono-Regular', Consolas, … monospace：断言落在「等宽」这个语义上，
    // 而不是某一个具体字体名（换 token 不该让测试红）
    expect(/mono/i.test(textarea.style.fontFamily)).toBe(true);
  });
});

/**
 * 守卫：antd 6 弃用了 `Input` 的 `addonAfter` / `addonBefore`（提示改用 `Space.Compact`），
 * 每次挂载都会打一条 **error 级**的 `[antd: Input] \`addonAfter\` is deprecated…`。
 *
 * 为什么值得一条守卫：这类告警**只在开发/测试环境**出现（`process.env.NODE_ENV !== 'production'`），
 * 生产构建里静默——于是它既不会被用户报障发现，又会长期淹没控制台里真正的错误，而「弃用」迟早变成「移除」。
 * 断言刻意不写「不许出现 addonAfter」，而是「不许出现**任何** antd 弃用告警」：
 * 后人换成 `addonBefore` / 再引入别的弃用写法，一样会红。
 * 注意 `devUseWarning` 在 `NODE_ENV === 'test'` 下每条告警后都会 `resetWarned()`（rc-util 的打印去重），
 * 所以这条断言与「本文件里第几个渲染面板」无关，不会因为用例顺序而变成空转。
 */
describe('CaseFormPanel 的控制台告警', () => {
  it('挂载面板不产生 antd 的弃用告警（error 级）', () => {
    // 只 spy 不吞：告警照常打到控制台，用例变红时能直接看到是哪一条
    const errorSpy = vi.spyOn(console, 'error');
    try {
      setup({ mode: 'edit', initial: INITIAL });

      const deprecated = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes('[antd:') && text.includes('deprecated'));

      expect(deprecated).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/**
 * 形态守卫：提交按钮的**两态**。
 *
 * 两态**同形**：实心主按钮 + 无图标——它只提交这张已经写着「创建用例 /
 * 编辑用例」的右栏表单，按钮不必再复述动作（新建态不用「加号 + 虚线 + 创建」那一套）；
 * 下面两条同时钉住「别把图标加回来」：图标没被 `aria-hidden` 时，可访问名会变成
 * 「plus 确定」，按名字定位（含屏读器）全部失配。
 *
 * 文案仍分两态：新建「确定」（确认这张新表单）、编辑「保存」（保存对已有用例的改动）。
 */
describe('CaseFormPanel 提交按钮的形态', () => {
  it('新建态：实心主按钮 + 「确定」，无图标', () => {
    setup({ mode: 'new', initial: null });

    const submit = screen.getByTestId('case-submit');
    expect(submit).toHaveTextContent('确定');
    expect(submit.className).toContain('ant-btn-variant-solid');
    expect(submit.querySelector('.anticon')).toBeNull();
  });

  it('编辑态：同为实心主按钮，文案是「保存」，无图标', () => {
    setup({ mode: 'edit', initial: INITIAL });

    const submit = screen.getByTestId('case-submit');
    expect(submit).toHaveTextContent('保存');
    expect(submit.className).toContain('ant-btn-variant-solid');
    expect(submit.querySelector('.anticon')).toBeNull();
  });
});

const REMOTE_INFO: RepoInfo = {
  repoPath: 'git@host:group/repo.git',
  repoName: 'repo',
  branch: 'main',
  kind: 'remote',
  mirrorPath: 'C:/runs/remotes/repo-1a2b3c4d',
  mirrorReady: true,
  mirrorFetchedAt: '2026-09-26T04:00:00.000Z',
  tip: 'abc1234',
};

/** 远端初值：编辑一条远端用例（来源态必须从初值判定出来，否则编辑远端用例会渲染成本地态） */
const REMOTE_CASE: TestCase = { ...INITIAL, repoPath: 'git@host:group/repo.git', repoBranch: 'feat/x' };

describe('CaseFormPanel 来源切换（远端）', () => {
  /** 远端在前、本地在后，且新建态默认选中远端 */
  it('新建态：远端仓库排在前且默认选中', () => {
    setup({ mode: 'new' });

    expect(screen.getAllByRole('radio').map((node) => (node as HTMLInputElement).value)).toEqual(['remote', 'local']);
    expect((screen.getByRole('radio', { name: '远端仓库' }) as HTMLInputElement).checked).toBe(true);
  });

  it('默认按初值判定来源：本地初值没有分支字段，远端初值有', () => {
    const { unmount } = setup({ mode: 'edit', initial: INITIAL });
    expect(screen.queryByTestId('case-repo-branch')).not.toBeInTheDocument();
    unmount();

    setup({ mode: 'edit', initial: REMOTE_CASE });
    expect(screen.getByTestId('case-repo-branch')).toBeInTheDocument();
  });

  it('切回本地必须清空分支：提交的分支恒为 null（服务端对「本地 + 分支」是硬拒绝）', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit, mode: 'edit', initial: REMOTE_CASE });
    expect((screen.getByTestId('case-repo-branch') as HTMLInputElement).value).toBe('feat/x');

    fireEvent.click(screen.getByRole('radio', { name: '本地目录' }));
    expect(screen.queryByTestId('case-repo-branch')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('case-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      repoPath: 'git@host:group/repo.git',
      repoBranch: null,
    });
  });

  /**
   * 守卫（走查口径 3 的可观察后果）：切到本地**就是**丢掉分支，不是把值藏起来。
   *
   * antd 的 `Form.Item` 卸载时默认 `preserve: true`——值仍留在 store 里，再切回远端会被重新渲染出来。
   * 用户「切到本地」这个动作的含义就是不要分支了；把旧值藏起来再放回去，等于让他下一次保存时
   * 用回一个自己以为已经清掉的分支（或反过来，以为清掉了其实没有）。
   */
  it('远端 → 本地 → 远端：分支输入框已经是空的（切到本地即清空）', () => {
    setup({ mode: 'edit', initial: REMOTE_CASE });

    fireEvent.click(screen.getByRole('radio', { name: '本地目录' }));
    fireEvent.click(screen.getByRole('radio', { name: '远端仓库' }));

    expect((screen.getByTestId('case-repo-branch') as HTMLInputElement).value).toBe('');
  });

  it('校验把来源与分支一起交给页面', async () => {
    const onValidateRepo = vi.fn(async () => REMOTE_INFO);
    setup({ onValidateRepo, mode: 'edit', initial: REMOTE_CASE });

    fireEvent.click(screen.getByTestId('case-validate-repo'));

    await waitFor(() =>
      expect(onValidateRepo).toHaveBeenCalledWith({ repoPath: 'git@host:group/repo.git', repoBranch: 'feat/x' }),
    );
  });

  it('远端提交时带上归一后的分支（两侧空白不算分支名）', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit, mode: 'edit', initial: REMOTE_CASE });

    fireEvent.change(screen.getByTestId('case-repo-branch'), { target: { value: '  feat/x  ' } });
    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.repoBranch).toBe('feat/x');
  });

  it('远端留空分支时提交 null（空串会被契约的 min(1) 拒掉）', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit, mode: 'edit', initial: REMOTE_CASE });

    fireEvent.change(screen.getByTestId('case-repo-branch'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.repoBranch).toBeNull();
  });

  it('远端回显含仓库名 / 分支 / tip / 镜像更新时间；本地回显逐字不变', async () => {
    // 校验成功的那次「回显」必须由 `onValidateRepo` 交回来（面板以回显的 repoPath 为准决定要不要显示），
    // 所以远端这一半也得给出返回远端信息的替身——沿用默认替身（本地信息）的话，路径对不上，回显本来就不该出现
    const { unmount } = setup({ mode: 'edit', initial: REMOTE_CASE, onValidateRepo: vi.fn(async () => REMOTE_INFO), repoInfo: REMOTE_INFO });
    fireEvent.click(screen.getByTestId('case-validate-repo'));
    await waitFor(() => expect(screen.getByTestId('case-repo-info')).toBeInTheDocument());
    const remoteText = screen.getByTestId('case-repo-info').textContent ?? '';
    expect(remoteText).toContain('仓库：repo');
    expect(remoteText).toContain('分支：main');
    expect(remoteText).toContain('tip abc1234');
    expect(remoteText).toContain('镜像：已就绪');
    expect(remoteText).toContain('更新于');
    unmount();

    setup({ mode: 'edit', initial: INITIAL, repoInfo: REPO_INFO });
    fireEvent.click(screen.getByTestId('case-validate-repo'));
    await waitFor(() => expect(screen.getByTestId('case-repo-info')).toBeInTheDocument());
    expect(screen.getByTestId('case-repo-info').textContent).toBe('仓库：gateway · 当前分支：main');
  });

  /**
   * 守卫：回显对应的是**校验通过的那一对**（路径 + 分支），任一项变了都必须收起来。
   *
   * 只比路径的那版会在用户改了分支之后继续显示「分支：feat/x」，而输入框里已经是别的分支——
   * 这正是「不要让界面显示没校验过的信息」这条口径，分支那一半与路径那一半同等适用。
   * 口径仍是**条件**而非一次性作废：把输入改回校验过的那一对，回显回来（与改路径那半条同口径）。
   */
  it('改了分支之后不再显示上一次的校验回显（路径与分支都要对得上）', async () => {
    const onValidateRepo = vi.fn(async () => REMOTE_INFO);
    setup({ mode: 'edit', initial: REMOTE_CASE, onValidateRepo, repoInfo: REMOTE_INFO });

    fireEvent.click(screen.getByTestId('case-validate-repo'));
    await waitFor(() => expect(screen.getByTestId('case-repo-info')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('case-repo-branch'), { target: { value: 'main' } });
    await waitFor(() => expect(screen.queryByTestId('case-repo-info')).toBeNull());

    fireEvent.change(screen.getByTestId('case-repo-branch'), { target: { value: 'feat/x' } });
    await waitFor(() => expect(screen.getByTestId('case-repo-info')).toBeInTheDocument());
  });

  /**
   * 页面拿不到表单里的值（它在面板内部），所以由面板把「当前选中的来源」报上去。
   * 页面据此让上一次校验的结果与 commit 候选一起失效——上报的必须是**归一后**的值：
   * 分支两侧空白不算分支名、切到本地时分支是 null（服务端对「本地 + 分支」是硬拒绝）。
   */
  it('把当前选中的来源报给页面（归一后的路径与分支，切换即上报）', async () => {
    const onRepoSelectionChange = vi.fn();
    setup({ mode: 'edit', initial: REMOTE_CASE, onRepoSelectionChange });

    await waitFor(() =>
      expect(onRepoSelectionChange).toHaveBeenLastCalledWith({ repoPath: 'git@host:group/repo.git', repoBranch: 'feat/x' }),
    );

    fireEvent.change(screen.getByTestId('case-repo-branch'), { target: { value: '  main  ' } });
    await waitFor(() =>
      expect(onRepoSelectionChange).toHaveBeenLastCalledWith({ repoPath: 'git@host:group/repo.git', repoBranch: 'main' }),
    );

    fireEvent.click(screen.getByRole('radio', { name: '本地目录' }));
    await waitFor(() =>
      expect(onRepoSelectionChange).toHaveBeenLastCalledWith({ repoPath: 'git@host:group/repo.git', repoBranch: null }),
    );
  });

  it('不传 onRepoSelectionChange 也能正常工作（可选回调，纯展示组件不该强依赖调用方）', () => {
    setup({ mode: 'edit', initial: REMOTE_CASE });

    expect(screen.getByTestId('case-repo-branch')).toBeInTheDocument();
  });

  /**
   * 远端的「校验」与「重新加载候选」在**忙的时候**必须换文案。
   *
   * 为什么值得一条守卫：远端首访这两个按钮都会真的克隆（用户可能跳过校验直接点候选），而克隆期间
   * 整个 Node 进程阻塞——页面上的其它请求、SSE、终止都排在后面。用户看到的若还是
   * 「校验 / 重新加载候选」，他唯一能得出的结论是「点了没反应」，于是再点一次。
   * 判据取 `textContent` **全等**而不是包含：`校验` 是 `正在校验并拉取远端仓库…` 的子串，
   * 包含式断言分不出「换了文案」与「加了一句话」。
   */
  describe('CaseFormPanel 的加载态（远端要说出「正在拉取远端仓库…」）', () => {
    const labelOf = (testId: string): string => screen.getByTestId(testId).textContent ?? '';

    it('远端态 + 忙：校验显示「正在校验并拉取远端仓库…」，候选显示「正在拉取远端仓库…」', () => {
      setup({ mode: 'edit', initial: REMOTE_CASE, validating: true, loadingCommits: true });

      expect(labelOf('case-validate-repo')).toBe('正在校验并拉取远端仓库…');
      expect(labelOf('case-load-commits')).toBe('正在拉取远端仓库…');
    });

    it('本地态 + 同样两个 busy 标志：两句远端文案都不出现（本地一个字节都不上网）', () => {
      setup({ mode: 'edit', initial: INITIAL, validating: true, loadingCommits: true });

      expect(labelOf('case-validate-repo')).toBe('校验');
      expect(labelOf('case-load-commits')).toBe('重新加载候选');
    });

    it('远端态但空闲：文案回到动作本身（加载态不是「远端」的常驻文案）', () => {
      setup({ mode: 'edit', initial: REMOTE_CASE, validating: false, loadingCommits: false });

      expect(labelOf('case-validate-repo')).toBe('校验');
      expect(labelOf('case-load-commits')).toBe('重新加载候选');
    });
  });

  /**
   * 远端「代码仓库」的提示里必须带**协议白名单**（字段级提示逐字）。
   * 填了 `ftp://…` 的用户拿到的是「不支持的 git 地址协议：ftp（支持 ssh:// / http:// / https:// / git:// / file://
   * 与 user@host:path）」，而字段级提示若只说「请填写 git 地址」，他仍然不知道该换成哪种写法——
   * 这句话就是那句拒绝的补救办法。
   */
  it('远端来源的字段级提示带协议白名单（本地那句逐字不变）', async () => {
    const onValidateRepo = vi.fn(async () => REMOTE_INFO);
    setup({ mode: 'edit', initial: REMOTE_CASE, onValidateRepo });
    fireEvent.change(screen.getByTestId('case-repo-path'), { target: { value: '   ' } });

    fireEvent.click(screen.getByTestId('case-validate-repo'));

    expect(await screen.findByText('请填写 git 地址（ssh:// / http(s):// / git:// / file:// / user@host:path）')).toBeInTheDocument();
    // 字段没过就不该发出校验：提示是给用户的补救办法，不是又一次往返
    expect(onValidateRepo).not.toHaveBeenCalled();
  });

  /**
   * 守卫：回显与「当前输入」必须在**同一口径**上比较。
   *
   * 远端 URL 的归一（去尾斜杠）是服务端做的：输入 `https://host/group/repo.git/` 回显的是去掉尾斜杠的那条。
   * 若拿**回显**去和输入框原文比，两条永远不相等 —— 症状是「点了校验、接口也成功了，页面却什么都不显示」
   * （候选也一样取不到）。所以记的是**发出去的那一对**，与「当前输入」同源。
   */
  it('远端 URL 带尾斜杠时回显照样出现（比较与当前输入同口径）', async () => {
    const onValidateRepo = vi.fn(async () => REMOTE_INFO);
    const slashCase: TestCase = { ...REMOTE_CASE, repoPath: 'https://host/group/repo.git/' };
    setup({ mode: 'edit', initial: slashCase, onValidateRepo, repoInfo: REMOTE_INFO });

    fireEvent.click(screen.getByTestId('case-validate-repo'));

    expect(await screen.findByTestId('case-repo-info')).toBeInTheDocument();
    // 交出去的仍是输入原文（归一是服务端的活），回显用的是服务端返回的那一份
    expect(onValidateRepo).toHaveBeenCalledWith({ repoPath: 'https://host/group/repo.git/', repoBranch: 'feat/x' });
    expect(screen.getByTestId('case-repo-info').textContent).toContain('仓库：repo');
  });
});
