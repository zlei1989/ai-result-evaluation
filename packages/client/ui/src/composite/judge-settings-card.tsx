'use client';

/**
 * 评分配置卡：默认评分模型 + 思考强度 + 默认评分智能体 + 输出契约只读预览 + diff 上限。
 * 纯展示：数据从 settings / providers / agentProtocols 三个 props 来，改动以 patch 回调交给调用方
 * （本组件不调接口）。
 *
 * 六处刻意的设计：
 *   1. **两种协议的模型都列**：这一格是**文本调用**的目标，与智能体协议无关（F3 / §6.2），
 *      按协议过滤会平白砍掉一半候选（Anthropic 协议的模型照样能评分）。
 *      「不过滤」只针对**模型**这一格；智能体那一格反过来必须按协议过滤 ——
 *      智能体驱动不了另一种协议的模型（Codex 只吃 OpenAI 兼容），选完再报错就晚了；
 *   2. **悬空的 defaultJudge 要显式提示**：删掉供应商后设置里仍留着它的 id（删除不级联改写设置），
 *      静默显示成「未配置」会让人以为只是没选，直到跑评测才发现评分不可用；
 *   3. **单位换算只在这里做**：配置存字节，界面用 KB（人填的是 256）；
 *   4. **这里没有「单行超时」这一格**（2026-09-28 用户口径）：执行与评分都不限时间，
 *      一行只会因为「跑完 / 失败 / 用户点终止」结束——那一格连契约字段一起删了。
 *   5. **「输出契约（只读）」那一格与根 `README.md` 的同名条目是同一条口径**：它描述的是我们**要求
 *      模型输出什么**（逐项达成 / 未达成 + 一句理由，**不给总分**），改一处必须同步另一处——
 *      「手册描述一个不存在的界面」正是本次重构评审点出来的那类缺陷。
 *   6. **「思考强度」的候选项是写下侧的安全边界**（2026-10-07）：`settings.defaultJudge.effort` 在 schema 上
 *      只有 `z.string().min(1).optional()`，档位域**完全**由本组件算出的候选把关 —— 算错一格，用户就能
 *      存下一个会被服务端硬拒的值（`requireJudgeEffort` 连生成 / 识别一起拦）。故它必须与后端**同一个
 *      函数、同一个参数序**：`intersectEfforts(model, agentEfforts, CANONICAL_EFFORT_LEVELS)`。
 */
import { Alert, Card, Flex, Form, InputNumber, Select, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  AGENT_KINDS,
  AGENT_LABELS,
  CANONICAL_EFFORT_LEVELS,
  PROTOCOL_LABELS,
  intersectEfforts,
  type AgentKind,
  type ProviderView,
  type ProtocolType,
  type Settings,
  type SettingsPatch,
} from '@aieval/contracts';

export interface JudgeSettingsCardProps {
  settings: Settings;
  providers: ProviderView[];
  /**
   * 每家的注册表投影（来自 `GET /api/runs/model-options`）：协议**集合** + 思考强度**档位域**。
   * 拿不到时的处置**按格不同**，别把两句读成一句：
   *   · 协议那一格**不拦**（列出全部）——判据缺失时宁可少拦一次，服务端在创建与评分两处各有一道校验；
   *   · 档位那一格**禁用**（不是兜规范五档）——兜了就会摆出该家收不了的档，
   *     而「能选到的值必须能通过 `requireJudgeEffort`」是那一格的不变式（见 `effortUnknown`）。
   */
  agentProtocols?: {
    agentKind: AgentKind;
    protocolTypes: readonly ProtocolType[];
    efforts: readonly string[];
  }[];
  onChange: (patch: SettingsPatch) => void;
  saving: boolean;
}

/** KB ↔ 字节：只此一处换算，避免输入框与配置两处各自取整 */
const BYTES_PER_KB = 1024;

export function JudgeSettingsCard({
  settings,
  providers,
  agentProtocols,
  onChange,
  saving,
}: JudgeSettingsCardProps): ReactNode {
  // 选项的 value 是 `${providerId}::${modelId}` 拼出来的 key，但**点击时不做字符串切分**：
  // 而是回这张表里按 key 精确反查（modelId 里出现 `::` 也不会错位）。
  const optionIndex = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      key: `${provider.id}::${model.id}`,
      providerId: provider.id,
      modelId: model.id,
    })),
  );
  const groups = providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      label: `${provider.name}（${PROTOCOL_LABELS[provider.protocolType]}）`,
      options: provider.models.map((model) => ({ label: model.id, value: `${provider.id}::${model.id}` })),
    }));

  const current = settings.defaultJudge;
  const currentKey = current === null ? undefined : `${current.providerId}::${current.modelId}`;
  // 悬空：设置里写着这一对 id，但供应商或模型已经不在清单里了
  const dangling = current !== null && !optionIndex.some((option) => option.key === currentKey);

  // 默认评分智能体与默认评分模型的协议必须匹配（Codex 只吃 OpenAI 兼容，Claude Code 只吃 Anthropic 兼容，
  // 而 DSH **两条都吃** —— 所以判据是「集合里有没有」而不是「等不等于」）：智能体驱动不了另一种协议的模型。
  // 协议取自注册表投影，本组件不写那张表。
  const judgeProtocol =
    current === null
      ? undefined
      : providers.find((provider) => provider.id === current.providerId)?.protocolType;
  const protocolsOf = (kind: AgentKind): readonly ProtocolType[] | undefined =>
    agentProtocols?.find((item) => item.agentKind === kind)?.protocolTypes;
  const incompatible = (kind: AgentKind): boolean => {
    const accepted = protocolsOf(kind);
    // 三个「不知道」都要放行（判据缺失时宁可少拦一次，服务端还有两道）：没有默认评分模型、
    // 注册表投影拿不到这一家、或这一家的集合为空。写反了会拿编出来的协议误禁用。
    return judgeProtocol !== undefined && accepted !== undefined && !accepted.includes(judgeProtocol);
  };
  const currentAgentDangling = settings.defaultJudgeAgent !== null && incompatible(settings.defaultJudgeAgent);

  /**
   * 思考强度的档位域：模型声明（没声明就兜规范五档）∩ **默认评分智能体**的域。
   *
   * 与后端 `requireJudgeEffort` 是**同一个函数、同一个参数序**（`agentEfforts` 传评分智能体的域，
   * 未配智能体时传 `CANONICAL_EFFORT_LEVELS` 本身）——档位域只有这一处算法，抄第二份必然漂移。
   * 为什么这条口径不能将就：写下侧的 schema 只看「非空字符串」，界面允许存下的值就是服务端收到的值，
   * 算多一格（例如给 dsh 列出 `medium`）用户就会在生成 / 识别时被硬拒。
   */
  // 这一家的档位域。**两种「取不到」刻意分开**：
  //   · 用户**没配**评分智能体 ⇒ 规范五档（契约里「未指定」就是这个状态，兜它是对的，与后端同口径）；
  //   · 配了、但注册表投影还没到（页面冷加载时 `agentOptions` 是 undefined ⇒ 传下来是 `[]`）
  //     ⇒ `undefined` = **还不知道**。这时**不能**兜规范五档：dsh 收不了 `medium`，
  //     兜了就会让用户在这一格选到一个后端硬拒的值（「能选到的值必须能过那道门」是这一格的不变式）。
  const agentEfforts: readonly string[] | undefined =
    settings.defaultJudgeAgent === null
      ? CANONICAL_EFFORT_LEVELS
      : agentProtocols?.find((item) => item.agentKind === settings.defaultJudgeAgent)?.efforts;
  /** 配了评分智能体却还没拿到它那一家的域：这一格先不给选，且**不判悬空**（判不了就别下结论） */
  const effortUnknown = current !== null && agentEfforts === undefined;

  const effortLevels = ((): string[] => {
    if (current === null || agentEfforts === undefined) return [];
    const model = providers
      .find((provider) => provider.id === current.providerId)
      ?.models.find((item) => item.id === current.modelId);
    // 悬空（供应商 / 模型被删）时一个档位都不给：这一格的上一条告警已经在说「默认评分模型已失效」
    if (model === undefined) return [];
    // `undefined` = 一个档位都没有（该家域与规范五档无交集），此时下拉只留「未指定」
    return intersectEfforts(model, agentEfforts, CANONICAL_EFFORT_LEVELS) ?? [];
  })();
  // 悬空：设置里写着这一档，但它已不在当前域里（换了评分模型 / 换了评分智能体）。
  // `effortUnknown` 时不下这个结论——域都还不知道，说「已失效」就是假消息（冷加载那一瞬间会闪一条红告警）
  const effortDangling =
    !effortUnknown && current?.effort !== undefined && !effortLevels.includes(current.effort);

  const pick = (value: string | undefined): void => {
    if (value === undefined) {
      // 清空 = 回到「未配置」（契约里 defaultJudge 的 null 就是未配置，不是空对象）
      onChange({ defaultJudge: null });
      return;
    }
    const option = optionIndex.find((item) => item.key === value);
    // 反查不到（理论上不会发生）：宁可不改，也不要往设置里写进半个 id
    if (option === undefined) return;
    onChange({ defaultJudge: { providerId: option.providerId, modelId: option.modelId } });
  };

  return (
    <Card size="small" title="评分配置" data-testid="judge-settings-card">
      <Flex vertical gap={12}>
        {current === null && (
          <Alert
            type="warning"
            showIcon
            title="未配置默认评分模型"
            description="未配置时，用例页的「智能生成 / 智能识别」与评测的评分步骤都不可用；请在这里选一个——评分模型只有这一个来源，用例上没有可以覆盖它的地方。"
          />
        )}
        {dangling && (
          <Alert
            type="error"
            showIcon
            title="当前的默认评分模型已失效"
            description={`设置里记的是 ${currentKey}，但它已不在供应商清单里（供应商或模型被删了）。请重新选择。`}
          />
        )}
        {/* 布尔变量不带窄化：`currentAgentDangling` 里判过的非 null 传不出来，故下面用 `as AgentKind` 断言。
            协议那两处也直接断言：进入这一支的前提（`incompatible()`）已经把该家的协议**集合**与
            `judgeProtocol` **都判成非 undefined**（两者缺一 `incompatible` 就是 false），
            故**不写** `?? []` / `?? 'openai'` 那种兜底——它不可达，只会给读者「这里可能取不到协议」的假印象
            （终审 Minor 就是这么点出来的）。
            文案与 `@aieval/agents` 的 `protocolMismatchMessage` 同构（列出**集合**而不是单值）：
            DSH 两条 wire 都能收，写成「只接受 Anthropic 协议」会说谎。 */}
        {currentAgentDangling && (
          <Alert
            type="error"
            showIcon
            title="当前的默认评分智能体与评分模型协议不匹配"
            description={`${AGENT_LABELS[settings.defaultJudgeAgent as AgentKind]} 只接受 ${
              (protocolsOf(settings.defaultJudgeAgent as AgentKind) as readonly ProtocolType[])
                .map((one) => PROTOCOL_LABELS[one])
                .join(' / ')
            }协议，而当前的默认评分模型属于${PROTOCOL_LABELS[judgeProtocol as ProtocolType]}协议。请重新选择其中一个。`}
          />
        )}
        {/* 档位悬空（换了评分模型 / 换了评分智能体）与上面两条同一套模式：静默显示成「未指定」
            会让用户以为只是没选，而配置里那个值仍然会在生成 / 识别时把请求硬拒掉。
            ⚠️ 文案只写「请重新选择」：悬空时这一格的值是 `undefined`，rc-select 因此**不渲染**
            清空按钮（`allowClear` 只在有值时出现）⇒ 写「或清空」会指一条界面上够不着的出路。 */}
        {effortDangling && (
          <Alert
            type="error"
            showIcon
            title="当前的思考强度已失效"
            description={`设置里记的是 ${current?.effort}，但它不在当前可选档位里（评分模型或评分智能体换了）。请重新选择。`}
          />
        )}

        <Form layout="vertical" size="small" component={false}>
          <Form.Item label="默认评分模型" style={{ marginBottom: 8 }}>
            <Select
              aria-label="默认评分模型"
              placeholder={providers.length === 0 ? '请先在「模型供应商」页添加供应商' : '未配置'}
              disabled={saving || providers.length === 0}
              allowClear
              // 悬空时不回显那个失效的 key：显示一个不存在的模型名比显示空更糟
              value={dangling ? undefined : currentKey}
              options={groups}
              // 「有供应商但一个模型都没有」是首次使用最可能停住的状态（新建供应商时还没有 id，
              // 模型清单要保存后再拉取/手工加），而应用没有配 antd locale —— 不给这句中文，
              // 下拉里就是英文空态 "No data"，用户看不出下一步该去哪。
              notFoundContent="暂无模型：请先在「模型供应商」里拉取或手工添加"
              onChange={pick}
            />
          </Form.Item>

          {/* 放在「默认评分模型」与「默认评分智能体」之间（用户口径：默认评分模型下方）：
              它同时吃这两格 —— 候选 = 模型声明 ∩ 评分智能体的域 */}
          <Form.Item label="思考强度" style={{ marginBottom: 8 }}>
            <Select
              aria-label="思考强度"
              placeholder="未指定"
              // 还不知道这一家的档位域时也禁用（理由见 `effortUnknown`）：候选为空却给点，
              // 用户只会看到一个英文空态 "No data"，而且会以为自己「选不了是因为没有档」
              disabled={saving || current === null || effortUnknown}
              allowClear
              // 悬空时不回显那个失效值（与上面那条 Alert 同一处置）：显示一个已不在候选里的档，
              // 用户会以为它还能用
              value={effortDangling ? undefined : current?.effort}
              options={effortLevels.map((effort) => ({ value: effort, label: effort }))}
              // 选项文案照上游词汇原样（与创建评测表单那一格同一口径）；关闭档的语义放浮层里说，
              // 不加工选项文字——「关闭」与「低」不是同一维度的东西，改写就等于替上游改语义
              onChange={(value: string | undefined) => {
                if (current === null) return;
                onChange({
                  defaultJudge: {
                    providerId: current.providerId,
                    modelId: current.modelId,
                    // 清空 = 回到「未指定」= **不写这个键**（契约里缺省就是未指定）。
                    // 写成 `effort: undefined` 会凭空多一个「键存在但没值」的中间态
                    ...(value === undefined ? {} : { effort: value }),
                  },
                });
              }}
            />
          </Form.Item>

          <Form.Item label="默认评分智能体" style={{ marginBottom: 8 }}>
            <Select
              aria-label="默认评分智能体"
              placeholder="未配置"
              disabled={saving}
              allowClear
              value={settings.defaultJudgeAgent ?? undefined}
              options={AGENT_KINDS.map((kind) => ({
                value: kind,
                label: incompatible(kind) ? `${AGENT_LABELS[kind]}（与当前默认评分模型协议不匹配）` : AGENT_LABELS[kind],
                // 不兼容的直接禁用而不是选完再报错：这一格没有「先选了再说」的中间态可用
                disabled: incompatible(kind),
              }))}
              // 清空 = 回到「未配置」（契约里 defaultJudgeAgent 的 null 就是未配置）
              onChange={(value: AgentKind | undefined) => {
                onChange({ defaultJudgeAgent: value ?? null });
              }}
            />
          </Form.Item>

          <Form.Item label="输出契约（只读）" style={{ marginBottom: 8 }}>
            <Flex vertical gap={4}>
              <Typography.Text type="secondary">
                评分模型只输出一个 JSON：对评分标准项里<Typography.Text strong>每一项</Typography.Text>给出「达成 /
                未达成 + 一句理由」，不给总分。
              </Typography.Text>
              <Typography.Text type="secondary">
                总分 = 达成项的权重之和；满分 = 全部项权重之和（由每个用例的「评分标准项」决定）。
              </Typography.Text>
            </Flex>
          </Form.Item>

          <Form.Item label="diff 上限（KB）" style={{ marginBottom: 0 }}>
            <InputNumber
              aria-label="diff 上限（KB）"
              min={1}
              step={1}
              precision={0}
              suffix="KB"
              disabled={saving}
              value={Math.round(settings.diffBudgetBytes / BYTES_PER_KB)}
              onChange={(value) => {
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return;
                onChange({ diffBudgetBytes: Math.round(value) * BYTES_PER_KB });
              }}
            />
          </Form.Item>
        </Form>
      </Flex>
    </Card>
  );
}
