/**
 * JudgeSettingsCard：未配置提示、两种协议都能选、悬空默认值的显式提示、单位换算与清空语义。
 * 注意测试数据里的候选保持少量（≤ 5 条）：antd 的 Select 用虚拟列表，
 * 选项总高度超过 listHeight 时只渲染可视切片，而 jsdom 量不出高度。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SETTINGS_DEFAULTS, type ProviderView, type Settings } from '@aieval/contracts';
import { JudgeSettingsCard } from './judge-settings-card';
import { installResizeObserverStub } from '../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
});

const openai: ProviderView = {
  id: 'p-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyMasked: 'sk-***mnop',
  models: [{ id: 'deepseek-chat', source: 'manual' }],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

const anthropic: ProviderView = {
  ...openai,
  id: 'p-2',
  name: 'Anthropic 官方',
  protocolType: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: [{ id: 'claude-sonnet-5', source: 'fetched' }],
};

const noop = (): void => {};
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...SETTINGS_DEFAULTS, ...patch });

describe('JudgeSettingsCard', () => {
  it('未配置时给出警告与去向', () => {
    render(<JudgeSettingsCard settings={settings()} providers={[]} onChange={noop} saving={false} />);

    expect(screen.getByText('未配置默认评分模型')).toBeInTheDocument();
    expect(screen.getByText(/评分步骤都不可用/)).toBeInTheDocument();
    // 一个供应商都没有时给出明确出路，而不是一个空下拉
    expect(screen.getByText('请先在「模型供应商」页添加供应商')).toBeInTheDocument();
  });

  it('两种协议的模型都能选（这一格不做协议过滤，协议匹配由默认评分智能体那一格约束）', async () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard settings={settings()} providers={[openai, anthropic]} onChange={onChange} saving={false} />,
    );

    // 卡片里有**两个** Select（默认评分模型 / 默认评分智能体），`getByRole('combobox')` 会因
    // 匹配到多个而抛错，故按可访问名定位到这一个
    fireEvent.mouseDown(screen.getByLabelText('默认评分模型'));
    fireEvent.click(await screen.findByText('claude-sonnet-5'));

    expect(onChange).toHaveBeenCalledWith({ defaultJudge: { providerId: 'p-2', modelId: 'claude-sonnet-5' } });
  });

  it('已选中的模型回显它的选项标签', () => {
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-1', modelId: 'deepseek-chat' } })}
        providers={[openai]}
        onChange={noop}
        saving={false}
      />,
    );

    expect(screen.queryByText('未配置默认评分模型')).toBeNull();
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
  });

  // 首次使用最可能停住的状态：供应商建好了、模型还没拉取也还没手工加（新建供应商时还没有 id，
  // 模型清单要保存后才能维护）。应用没有配 antd locale —— 不给 notFoundContent，
  // 下拉里就是英文空态 "No data"，用户看不出下一步该去哪。
  it('有供应商但一个模型都没有时，下拉给中文空态而不是 antd 的 No data', async () => {
    render(
      <JudgeSettingsCard
        settings={settings()}
        providers={[{ ...openai, models: [] }]}
        onChange={noop}
        saving={false}
      />,
    );

    fireEvent.mouseDown(screen.getByLabelText('默认评分模型'));

    expect(await screen.findByText('暂无模型：请先在「模型供应商」里拉取或手工添加')).toBeInTheDocument();
    // antd 的内置空态会渲染两处英文 "No data"（`.ant-empty-description` 与空图 SVG 的 <title>），
    // 故用 queryAllByText：queryByText 在多处匹配时抛错，抛错虽也算失败，但读起来像断言写坏了。
    expect(screen.queryAllByText('No data')).toHaveLength(0);
  });

  // allowClear 的清除按钮：漏掉这条回写，用户就清不掉已配的默认评分模型（只能改不能取消），
  // 而契约里 `defaultJudge: null` 才是「未配置」的合法取值。
  it('清空已选模型（allowClear）回写 defaultJudge: null', () => {
    const onChange = vi.fn();
    const { container } = render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-1', modelId: 'deepseek-chat' } })}
        providers={[openai]}
        onChange={onChange}
        saving={false}
      />,
    );

    // 清除图标是 aria-hidden 的纯图标（role 查询取不到），按 antd 的类名取，与其它用例的类名查询同口径
    const clear = container.querySelector<HTMLElement>('.ant-select-clear');
    expect(clear).not.toBeNull();
    fireEvent.click(clear as HTMLElement);

    expect(onChange).toHaveBeenCalledWith({ defaultJudge: null });
  });

  // 删供应商不级联改写 settings.defaultJudge（Task 1 的决定），所以这里必然出现悬空引用。
  // 静默显示成「未配置」会让人以为只是没选，直到跑评测才发现评分不可用。
  it('默认评分模型已失效时显式提示，且下拉不再回显那个失效的 key', () => {
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-deleted', modelId: 'ghost-model' } })}
        providers={[openai]}
        onChange={noop}
        saving={false}
      />,
    );

    expect(screen.getByText('当前的默认评分模型已失效')).toBeInTheDocument();
    expect(screen.getByText(/p-deleted::ghost-model/)).toBeInTheDocument();
    // 失效的 key 不能出现在选择框的选中项里（否则用户看到的是一个不存在的模型名）
    expect(screen.queryByText('ghost-model')).toBeNull();
  });

  /**
   * 这一格与根 `README.md` 的「输出契约（只读）」是同一条口径：讲的是**要求模型输出什么**
   * （逐项达成 / 未达成 + 一句理由，不给总分）。旧文案列的是 5 个维度名与
   * `round(sum(score) / (5 × 5) × 100)`——那套东西已随重构整体删除，
   * 所以这里整句钉住新文案，并同时断言旧口径的痕迹一个都不许留。
   */
  it('输出契约预览写的是评分标准项的口径（逐项达成 / 未达成 + 理由，不给总分）', () => {
    render(<JudgeSettingsCard settings={settings()} providers={[openai]} onChange={noop} saving={false} />);

    const card = screen.getByTestId('judge-settings-card');
    expect(card).toHaveTextContent(
      '评分模型只输出一个 JSON：对评分标准项里每一项给出「达成 / 未达成 + 一句理由」，不给总分。',
    );
    expect(card).toHaveTextContent('总分 = 达成项的权重之和；满分 = 全部项权重之和（由每个用例的「评分标准项」决定）。');
    // 旧口径的痕迹：维度名、满分 100、那条合成算式——加回来必须红
    expect(card).not.toHaveTextContent('功能正确性');
    expect(card).not.toHaveTextContent('满分 100');
    expect(card).not.toHaveTextContent('round(');
  });

  // 2026-09-28 用户口径：执行与评分都不限时间 ⇒「单行超时（分钟）」这一格连契约字段一起删了。
  // 这条守卫钉的是「它真的不在界面上了」——加回来（或只删 UI 不删契约）都会红。
  it('不再有「单行超时（分钟）」这一格', () => {
    render(<JudgeSettingsCard settings={settings()} providers={[openai]} onChange={noop} saving={false} />);

    expect(screen.queryByRole('spinbutton', { name: '单行超时（分钟）' })).toBeNull();
    expect(screen.queryByText(/单行超时/)).toBeNull();
  });

  it('diff 上限按 KB 显示与回写', () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard
        settings={settings({ diffBudgetBytes: 262_144 })}
        providers={[openai]}
        onChange={onChange}
        saving={false}
      />,
    );

    const budget = screen.getByRole('spinbutton', { name: 'diff 上限（KB）' });
    expect(budget).toHaveValue('256');

    fireEvent.change(budget, { target: { value: '512' } });

    expect(onChange).toHaveBeenCalledWith({ diffBudgetBytes: 524_288 });
  });

  // 清空输入框时 antd 给的是 null。契约要求 diffBudgetBytes 是**正整数**，
  // 把 null 当成 0 写回去会得到一次 400（服务端 zod 拒绝）或一个 0 字节的 diff 预算。
  it('清空输入框不触发改动（null 不得被当成 0）', () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard settings={settings()} providers={[openai]} onChange={onChange} saving={false} />,
    );

    fireEvent.change(screen.getByRole('spinbutton', { name: 'diff 上限（KB）' }), { target: { value: '' } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('saving 时数值输入禁用（避免并发提交把后一次的值盖掉）', () => {
    render(<JudgeSettingsCard settings={settings()} providers={[openai]} onChange={noop} saving />);

    expect(screen.getByRole('spinbutton', { name: 'diff 上限（KB）' })).toBeDisabled();
  });
});

describe('JudgeSettingsCard 的默认评分智能体', () => {
  /**
   * 注册表投影：**dsh 是双协议**（两条 wire 都能收，见契约 R37 的收口）。
   * 夹具按最终真值写，而不是按「形状搬迁阶段」的临时值——否则下面那条「双协议不被禁用」的用例
   * 会在 Task 7 翻转真值时**静默变成另一件事**（用单元素夹具时它测的其实是单协议路径）。
   */
  const protocols = [
    { agentKind: 'claude-code' as const, protocolTypes: ['anthropic'] as const },
    { agentKind: 'codex' as const, protocolTypes: ['openai'] as const },
    { agentKind: 'dsh' as const, protocolTypes: ['openai', 'anthropic'] as const },
  ];

  it('未配置默认评分模型时三个智能体都能选（还没得判协议，不拦）', async () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard
        settings={settings()}
        providers={[openai, anthropic]}
        agentProtocols={protocols}
        onChange={onChange}
        saving={false}
      />,
    );

    fireEvent.mouseDown(screen.getByLabelText('默认评分智能体'));
    fireEvent.click(await screen.findByText('DeepSeek Harness'));

    expect(onChange).toHaveBeenCalledWith({ defaultJudgeAgent: 'dsh' });
  });

  it('默认评分模型是 anthropic 协议时，Codex 选项被禁用（它只吃 openai）', async () => {
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-2', modelId: 'claude-sonnet-5' } })}
        providers={[anthropic]}
        agentProtocols={protocols}
        onChange={noop}
        saving={false}
      />,
    );

    fireEvent.mouseDown(screen.getByLabelText('默认评分智能体'));
    const codex = await screen.findByText('Codex（与当前默认评分模型协议不匹配）');
    // antd 把 disabled 的选项渲染成 aria-disabled 的 .ant-select-item-option-disabled
    expect(codex.closest('.ant-select-item-option')).toHaveClass('ant-select-item-option-disabled');
    // **阳性面对照**（终审 Minor）：只断言「Codex 被禁用」的话，「选了模型就把三家全禁用」这种实现
    // 照样全绿——而那会让这一格彻底不可用。同协议的 claude-code 必须仍可选、标签不带后缀。
    const claude = await screen.findByText('Claude Code');
    expect(claude.closest('.ant-select-item-option')).not.toHaveClass('ant-select-item-option-disabled');
    // **双协议那家也必须可选**（2026-09-30 起 dsh 两条 wire 都能收）：判据是「集合里有没有」，
    // 写成 `accepted[0] !== judgeProtocol`（把集合当单值用）会让这一格当场变红——这是本条的区分力所在
    const dsh = await screen.findByText('DeepSeek Harness');
    expect(dsh.closest('.ant-select-item-option')).not.toHaveClass('ant-select-item-option-disabled');
    expect(dsh.closest('.ant-select-item-option')).toHaveAttribute('aria-disabled', 'false');
  });

  it('默认评分模型是 openai 协议时，只有 Claude Code 被禁用（dsh 双协议仍可选）', async () => {
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-1', modelId: 'gpt-5' } })}
        providers={[openai]}
        agentProtocols={protocols}
        onChange={noop}
        saving={false}
      />,
    );

    fireEvent.mouseDown(screen.getByLabelText('默认评分智能体'));
    const claude = await screen.findByText('Claude Code（与当前默认评分模型协议不匹配）');
    expect(claude.closest('.ant-select-item-option')).toHaveClass('ant-select-item-option-disabled');
    // 另一侧的阳性面：Codex（本就 openai）与 dsh（集合含 openai）都不能被拦
    const codex = await screen.findByText('Codex');
    expect(codex.closest('.ant-select-item-option')).not.toHaveClass('ant-select-item-option-disabled');
    const dsh = await screen.findByText('DeepSeek Harness');
    expect(dsh.closest('.ant-select-item-option')).not.toHaveClass('ant-select-item-option-disabled');
  });

  it('已存的值变成不兼容时给红色告警（与「悬空」同一套模式）', () => {
    render(
      <JudgeSettingsCard
        settings={settings({
          defaultJudge: { providerId: 'p-2', modelId: 'claude-sonnet-5' },
          defaultJudgeAgent: 'codex',
        })}
        providers={[anthropic]}
        agentProtocols={protocols}
        onChange={noop}
        saving={false}
      />,
    );

    const title = screen.getByText('当前的默认评分智能体与评分模型协议不匹配');
    expect(title).toBeInTheDocument();
    // **红色**是这一条的要点（用例名里就写着），而只断言标题文本的话改成 warning / info 也能过：
    // antd 把类型渲染成 `ant-alert-<type>`，按它判。正文按整块文本读（它是模板串拼出来的、
    // 会被 React 拆成多个文本节点，按 `getByText` 的整串匹配读不到——实测踩过）
    const alert = title.closest('.ant-alert');
    expect(alert).toHaveClass('ant-alert-error');
    // 正文点名**两家**的协议（缺一半就看不出该换哪一边）：存的是 codex（只吃 openai），
    // 而当前默认评分模型是 anthropic 协议。文案与 `protocolMismatchMessage` 同构：
    // 集合只一家时不写「两种协议」，故这里是 `只接受 OpenAI 兼容协议`
    expect(alert?.textContent ?? '').toContain('Codex 只接受 OpenAI 兼容协议');
    expect(alert?.textContent ?? '').toContain('属于Anthropic 兼容协议');
  });

  it('清空回写 null（契约里 null 才是「未配置」，不是空串）', () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudgeAgent: 'dsh' })}
        providers={[]}
        agentProtocols={protocols}
        onChange={onChange}
        saving={false}
      />,
    );

    // 清除图标按 antd 的类名取，但**限定在这一格自己身上**（终审 Minor）：`document.querySelector`
    // 取的是整页第一个命中的清除图标——本用例靠「默认评分模型那格没有值 ⇒ 没有清除图标」才碰巧
    // 命中智能体那一格，多一个 Select 或换一下顺序就会点到错的控件上。
    const select = screen.getByLabelText('默认评分智能体').closest('.ant-select');
    const clear = select?.querySelector('.ant-select-clear') ?? null;
    expect(clear).not.toBeNull();
    // **必须点 click**：rc-select 把清除接在 onClick 上（SelectInput 的 `onClick: onClearMouseDown`），
    // 它的 onMouseDown 只 preventDefault 并拦住下拉展开——只发 mouseDown 的话 onChange 一次都不会来。
    fireEvent.click(clear as Element);

    expect(onChange).toHaveBeenCalledWith({ defaultJudgeAgent: null });
  });
});
