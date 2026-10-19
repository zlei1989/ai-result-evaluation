/**
 * JudgeSettingsCard：未配置提示、两种协议都能选、悬空默认值的显式提示、单位换算与清空语义，
 * 外加「思考强度」那一格（档位域 = 模型声明 ∩ 评分智能体的域，候选即写下侧的安全边界）。
 * 注意测试数据里的候选保持少量（≤ 5 条）：antd 的 Select 用虚拟列表，
 * 选项总高度超过 listHeight 时只渲染可视切片，而 jsdom 量不出高度。
 */
import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  CANONICAL_EFFORT_LEVELS,
  EFFORT_OFF,
  SETTINGS_DEFAULTS,
  type ProviderView,
  type Settings,
  type SettingsPatch,
} from '@aieval/contracts';
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

/**
 * 注册表投影夹具：协议**集合** + 档位域。两者都**按最终真值写**，而不是按某个演化阶段的临时值——
 * 否则「双协议不被禁用」那条用例会在真值翻转时**静默变成另一件事**
 * （用单元素夹具时它测的其实是单协议路径）。
 * 档位域同理，且它是「思考强度」那一格最要紧的判据：dsh 的域里**没有** `medium`（它收不了这一档），
 * 夹具少写这一格，那组用例就退化成「某个四元素列表」。
 * 类型直接取自组件的 props ⇒ 改 props 形状时这里跟着红（不必再抄一份形状）。
 */
const agentProtocols: NonNullable<ComponentProps<typeof JudgeSettingsCard>['agentProtocols']> = [
  { agentKind: 'cc', protocolTypes: ['anthropic'], efforts: [EFFORT_OFF, 'low', 'medium', 'high', 'xhigh', 'max'] },
  {
    agentKind: 'codex',
    protocolTypes: ['openai'],
    efforts: [EFFORT_OFF, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
  },
  { agentKind: 'dsh', protocolTypes: ['openai', 'anthropic'], efforts: [EFFORT_OFF, 'low', 'high', 'max'] },
];

/** 渲染入口：五个 props 里只改关心的那个，其余按既有用例的默认值给（老的用例逐条写 props 不动） */
function renderCard(overrides: Partial<ComponentProps<typeof JudgeSettingsCard>>): ReturnType<typeof render> {
  return render(
    <JudgeSettingsCard
      settings={settings()}
      providers={[]}
      agentProtocols={agentProtocols}
      onChange={noop}
      saving={false}
      {...overrides}
    />,
  );
}

/**
 * **某一个**下拉（按它的 `aria-label` 认）当前可选的档位文本，按渲染顺序。
 * 空值那一项（「未指定」占位）不计入：它表达的是「没有这一档」，不是候选。
 * 原生 `<select>` 的选项全在文档里，故这里读的就是「用户展开后能看到的那些」。
 */
function visibleOptionTextsOf(labelText: string): string[] {
  const select = screen.getAllByLabelText(labelText)[0] as HTMLSelectElement;
  return Array.from(select.options)
    .filter((option) => option.value !== '')
    .map((option) => option.textContent ?? '');
}

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

    // 按可访问名定位到这一个（卡片里有三个下拉，`getByRole('combobox')` 会因匹配到多个而抛错）
    fireEvent.change(screen.getByLabelText('默认评分模型'), { target: { value: 'p-2::claude-sonnet-5' } });

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
    // 原生 select 的「回显」就是它的 value（全部 option 文本都在 DOM 里，按文本找证明不了选中）
    expect(screen.getByLabelText('默认评分模型')).toHaveValue('p-1::deepseek-chat');
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

    expect(screen.getByText('暂无模型：请先在「模型供应商」里拉取或手工添加')).toBeInTheDocument();
    // 不给这句中文时，浏览器原生的空下拉只是一片空白，用户看不出下一步该去哪
    expect(screen.queryAllByText('No data')).toHaveLength(0);
  });

  // allowClear 的清除按钮：漏掉这条回写，用户就清不掉已配的默认评分模型（只能改不能取消），
  // 而契约里 `defaultJudge: null` 才是「未配置」的合法取值。
  it('清空已选模型（allowClear）回写 defaultJudge: null', () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-1', modelId: 'deepseek-chat' } })}
        providers={[openai]}
        onChange={onChange}
        saving={false}
      />,
    );

    // 清空 = 选空值那一项（原生 select 没有独立的清除按钮；空值项就是「未配置」）
    fireEvent.change(screen.getByLabelText('默认评分模型'), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith({ defaultJudge: null });
  });

  // 删供应商不级联改写 settings.defaultJudge，所以这里必然出现悬空引用。
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
    expect(screen.getByLabelText('默认评分模型')).toHaveValue('');
  });

  /**
   * 这一格讲的是**要求模型输出什么**（逐项达成 / 未达成 + 一句理由，不给总分）。
   * 这里整句钉住文案，并同时断言「按维度打分 / 满分 100」那一套的痕迹一个都不许留
   * ——维度名与合成算式在界面上出现，就说明这一格又走回了按维度打分的旧口径。
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

  // 执行与评分都不限时间 ⇒ 没有「单行超时（分钟）」这一格，契约字段也没有。
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
    expect(budget).toHaveValue(256);

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
  it('未配置默认评分模型时三个智能体都能选（还没得判协议，不拦）', async () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard
        settings={settings()}
        providers={[openai, anthropic]}
        agentProtocols={agentProtocols}
        onChange={onChange}
        saving={false}
      />,
    );

    fireEvent.change(screen.getByLabelText('默认评分智能体'), { target: { value: 'dsh' } });

    expect(onChange).toHaveBeenCalledWith({ defaultJudgeAgent: 'dsh' });
  });

  it('默认评分模型是 anthropic 协议时，Codex 选项被禁用（它只吃 openai）', async () => {
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-2', modelId: 'claude-sonnet-5' } })}
        providers={[anthropic]}
        agentProtocols={agentProtocols}
        onChange={noop}
        saving={false}
      />,
    );

    const codex = screen.getByText('Codex（与当前默认评分模型协议不匹配）');
    expect(codex.closest('option')).toBeDisabled();
    // **阳性面对照**：只断言「Codex 被禁用」的话，「选了模型就把三家全禁用」这种实现
    // 照样全绿——而那会让这一格彻底不可用。同协议的 cc 必须仍可选、标签不带后缀。
    expect(screen.getByText('Claude Code').closest('option')).not.toBeDisabled();
    // **双协议那家也必须可选**（dsh 两条 wire 都能收）：判据是「集合里有没有」，
    // 写成 `accepted[0] !== judgeProtocol`（把集合当单值用）会让这一格当场变红
    expect(screen.getByText('DeepSeek Harness').closest('option')).not.toBeDisabled();
  });

  it('默认评分模型是 openai 协议时，只有 Claude Code 被禁用（dsh 双协议仍可选）', async () => {
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-1', modelId: 'gpt-5' } })}
        providers={[openai]}
        agentProtocols={agentProtocols}
        onChange={noop}
        saving={false}
      />,
    );

    const claude = screen.getByText('Claude Code（与当前默认评分模型协议不匹配）');
    expect(claude.closest('option')).toBeDisabled();
    // 另一侧的阳性面：Codex（本就 openai）与 dsh（集合含 openai）都不能被拦
    expect(screen.getByText('Codex').closest('option')).not.toBeDisabled();
    expect(screen.getByText('DeepSeek Harness').closest('option')).not.toBeDisabled();
  });

  it('已存的值变成不兼容时给红色告警（与「悬空」同一套模式）', () => {
    render(
      <JudgeSettingsCard
        settings={settings({
          defaultJudge: { providerId: 'p-2', modelId: 'claude-sonnet-5' },
          defaultJudgeAgent: 'codex',
        })}
        providers={[anthropic]}
        agentProtocols={agentProtocols}
        onChange={noop}
        saving={false}
      />,
    );

    const title = screen.getByText('当前的默认评分智能体与评分模型协议不匹配');
    expect(title).toBeInTheDocument();
    // **红色**是这一条的要点（用例名里就写着），而只断言标题文本的话改成 warning / info 也能过：
    // antd 把类型渲染成 `ant-alert-<type>`，按它判。正文按整块文本读（它是模板串拼出来的、
    // 会被 React 拆成多个文本节点，按 `getByText` 的整串匹配读不到——实测踩过）
    const alert = title.closest('[data-tone]');
    expect(alert).toHaveAttribute('data-tone', 'error');
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
        agentProtocols={agentProtocols}
        onChange={onChange}
        saving={false}
      />,
    );

    // 清空 = 选空值那一项（原生 select 没有独立的清除按钮）；限定在这一格自己身上
    fireEvent.change(screen.getByLabelText('默认评分智能体'), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith({ defaultJudgeAgent: null });
  });
});

/**
 * 「思考强度」这一格。
 *
 * 为什么这一格的候选列表是**安全边界**而不是「界面偏好」：`settings.defaultJudge.effort` 在**写下侧**
 * 的 schema 只有 `z.string().min(1).optional()`——档位域**完全**由这里的候选列表把关。
 * 算错一格，用户就能在界面上存下一个会被硬拒的值，而那道门连生成 / 识别一起拦
 * （`api/judge.ts` 两处也校验）。故本组的判据就是后端 `requireJudgeEffort` 的那一条：
 * `intersectEfforts(model, agentEfforts, CANONICAL_EFFORT_LEVELS)`，其中 `agentEfforts` 取**默认评分智能体**
 * 的域（未配时传规范五档**本身**）。
 * 最要紧的一格是 dsh：它的域里没有 `medium`，界面就不许列出它——列了就是「选完必被拒」。
 */
describe('JudgeSettingsCard 的思考强度', () => {
  /** 默认评分模型选中的那一对；夹具的模型**没声明** `supportedEfforts`（实测 47 条里 21 条如此） */
  const picked = { providerId: 'p-1', modelId: 'deepseek-chat' };

  it('档位域跟着评分智能体：dsh 没有 medium，界面就不列出它', () => {
    renderCard({ settings: settings({ defaultJudge: picked, defaultJudgeAgent: 'dsh' }), providers: [openai] });

    // 恰好四格、**不含 medium**：这正是「界面能存下的值，后端那道门必须收」的判据
    expect(visibleOptionTextsOf('思考强度')).toEqual([EFFORT_OFF, 'low', 'high', 'max']);
  });

  it('未配评分智能体时兜的是规范五档：medium 还在——dsh 少的那格是被筛掉的，不是写死的', () => {
    renderCard({ settings: settings({ defaultJudge: picked }), providers: [openai] });

    // **阳性面对照**：只断言「dsh 没有 medium」的话，把候选写死成那四档照样全绿；
    // 这一条钉住 medium 是被 agentEfforts 筛掉的（与后端同一条 `intersectEfforts` 口径）
    expect(visibleOptionTextsOf('思考强度')).toEqual([...CANONICAL_EFFORT_LEVELS]);
  });

  /**
   * **两种「取不到」不能混为一谈**（本组件要守的核心不变式：
   * 「界面上能选到的任何值，保存后必须能通过 `requireJudgeEffort`」）：
   *   · 用户**没配**评分智能体 ⇒ 兜规范五档（上一条，那是对的）；
   *   · 配了、但注册表投影**还没到**（页面冷加载那一刻 `agentOptions` 还是 undefined ⇒ 传下来是 `[]`）
   *     ⇒ 这是「**还不知道**」。兜规范五档就会让这一格列出 dsh 收不了的 `medium`，
   *     用户选它、保存、然后到生成 / 识别时被硬拒 —— 正是本任务要堵的那类洞。
   * 处置：这一家的域还不知道时**不给选**（禁用）；值照旧回显（禁用只挡「改」，不挡「看」）。
   */
  it('注册表投影还没到时这一格不可选（配了智能体却拿不到它的域 ≠ 用户没配智能体）', () => {
    renderCard({
      settings: settings({ defaultJudge: picked, defaultJudgeAgent: 'dsh' }),
      providers: [openai],
      // 页面冷加载的真实形状：`(agentOptions ?? []).map(…)` ⇒ []
      agentProtocols: [],
    });

    expect(screen.getByLabelText('思考强度')).toBeDisabled();
  });

  it('不传 agentProtocols（库消费方）同样按「还不知道」处置，不兜规范五档', () => {
    renderCard({
      settings: settings({ defaultJudge: picked, defaultJudgeAgent: 'dsh' }),
      providers: [openai],
      agentProtocols: undefined,
    });

    expect(screen.getByLabelText('思考强度')).toBeDisabled();
  });

  it('投影到了之后同一份设置下这一格恢复可选，候选仍是 dsh 的那四档', () => {
    const card = (incoming: ComponentProps<typeof JudgeSettingsCard>['agentProtocols']): ReactElement => (
      <JudgeSettingsCard
        settings={settings({ defaultJudge: picked, defaultJudgeAgent: 'dsh' })}
        providers={[openai]}
        agentProtocols={incoming}
        onChange={noop}
        saving={false}
      />
    );
    const { rerender } = render(card([]));

    expect(screen.getByLabelText('思考强度')).toBeDisabled();

    rerender(card(agentProtocols));

    // 临时禁用不是永久禁用：投影一到就恢复，否则一次慢请求会让这一格再也用不了
    expect(screen.getByLabelText('思考强度')).not.toBeDisabled();
    expect(visibleOptionTextsOf('思考强度')).toEqual([EFFORT_OFF, 'low', 'high', 'max']);
  });

  /**
   * 「还不知道」时**不许下结论**：存着 `medium`、评分智能体是 dsh、投影还没到。
   * 这时按兜底的规范五档算（medium 合法 ⇒ 不报）与按空域算（⇒ 闪一条红告警）**两种都错**，
   * 故 pending 期间一律不判悬空——域都还不知道，说「已失效」就是假消息。
   */
  it('投影没到时不判悬空（域还不知道，说「已失效」就是假消息）', () => {
    renderCard({
      settings: settings({ defaultJudge: { ...picked, effort: 'medium' }, defaultJudgeAgent: 'dsh' }),
      providers: [openai],
      agentProtocols: [],
    });

    expect(screen.queryByText('当前的思考强度已失效')).toBeNull();
    // 值照旧回显：用户要看得到此刻存的是什么（上面那条禁用只挡「改」，不挡「看」）
    expect(screen.getByLabelText('思考强度')).toHaveValue('medium');
  });

  it('投影到了之后如实判为悬空（dsh 收不了 medium）——上一条的阳性对照', () => {
    renderCard({
      settings: settings({ defaultJudge: { ...picked, effort: 'medium' }, defaultJudgeAgent: 'dsh' }),
      providers: [openai],
    });

    expect(screen.getByText('当前的思考强度已失效')).toBeInTheDocument();
  });

  it('上游声明过档位时取交集：智能体收不了的档不出现（不做「就近取整」）', () => {
    renderCard({
      settings: settings({ defaultJudge: picked, defaultJudgeAgent: 'dsh' }),
      providers: [
        {
          ...openai,
          models: [{ id: 'deepseek-chat', source: 'fetched', supportedEfforts: ['low', 'medium', 'xhigh'] }],
        },
      ],
    });

    // medium 是 dsh 收不了的档、xhigh 不在规范五档里 ⇒ 都被筛掉；关闭档由 `intersectEfforts` 并到最前
    expect(visibleOptionTextsOf('思考强度')).toEqual([EFFORT_OFF, 'low']);
  });

  it('选一个档位 ⇒ 回写 defaultJudge.effort（providerId / modelId 一起带上）', async () => {
    const onChange = vi.fn<(patch: SettingsPatch) => void>();
    renderCard({ settings: settings({ defaultJudge: picked, defaultJudgeAgent: 'dsh' }), providers: [openai], onChange });

    fireEvent.change(screen.getByLabelText('思考强度'), { target: { value: 'max' } });

    expect(onChange).toHaveBeenCalledWith({
      defaultJudge: { providerId: 'p-1', modelId: 'deepseek-chat', effort: 'max' },
    });
  });

  it('清空（allowClear）⇒ 不写 effort 这个键：既不是 undefined，也不是 off', () => {
    const onChange = vi.fn<(patch: SettingsPatch) => void>();
    renderCard({
      settings: settings({ defaultJudge: { ...picked, effort: 'max' }, defaultJudgeAgent: 'dsh' }),
      providers: [openai],
      onChange,
    });

    // 选中值回显在这一格上
    expect(screen.getByLabelText('思考强度')).toHaveValue('max');
    // 清空 = 选空值那一项
    fireEvent.change(screen.getByLabelText('思考强度'), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const [patch] = onChange.mock.calls[0] ?? [];
    expect(patch?.defaultJudge).toEqual({ providerId: 'p-1', modelId: 'deepseek-chat' });
    // ⚠️ 上面那条 `toEqual` **抓不到** `{ effort: undefined }`（相等判定把「键缺失」与「键为 undefined」
    // 当同一件事）⇒ 必须显式看键。契约里「未指定」就是**没有这个键**，写成显式的 undefined
    // 等于给「清空」与「未指定」之间留一个多余的中间态。
    expect(Object.keys(patch?.defaultJudge ?? {})).not.toContain('effort');
  });

  it('档位悬空（换了评分模型 / 评分智能体）⇒ 显式提示，且不回显那个失效的档', () => {
    renderCard({
      settings: settings({ defaultJudge: { ...picked, effort: 'xhigh' }, defaultJudgeAgent: 'dsh' }),
      providers: [openai],
    });

    const title = screen.getByText('当前的思考强度已失效');
    // 与另外两条悬空告警同形：红色（error），不是提示性文案
    expect(title.closest('[data-tone]')).toHaveAttribute('data-tone', 'error');
    // 正文把**存着的那个值**写出来（只说「已失效」的话，用户看不出设置里到底记着什么、
    // 也就不知道该去点哪一格）；正文是模板串拼的 ⇒ 按整块文本读，与智能体那条同口径
    expect(title.closest('[data-tone]')?.textContent ?? '').toContain('设置里记的是 xhigh');
    // 失效的档不许出现在选择框里——否则用户看到的是「已经选好了一个用不了的档」
    expect(screen.queryByText('xhigh')).toBeNull();
  });

  it('未配默认评分模型时这一格禁用（没有模型就判不出档位域）', () => {
    renderCard({ settings: settings({ defaultJudgeAgent: 'dsh' }), providers: [openai] });

    expect(screen.getByLabelText('思考强度')).toBeDisabled();
  });

  it('saving 时禁用（与数值输入同一个防并发口径）', () => {
    renderCard({
      settings: settings({ defaultJudge: picked, defaultJudgeAgent: 'dsh' }),
      providers: [openai],
      saving: true,
    });

    expect(screen.getByLabelText('思考强度')).toBeDisabled();
  });
});
