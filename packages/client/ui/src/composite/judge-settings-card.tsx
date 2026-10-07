'use client';

/**
 * 评分配置卡：默认评分模型 + 默认评分智能体 + 输出契约只读预览 + diff 上限。
 * 纯展示：数据从 settings / providers / agentProtocols 三个 props 来，改动以 patch 回调交给调用方
 * （本组件不调接口）。
 *
 * 四处刻意的设计：
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
 */
import { Alert, Card, Flex, Form, InputNumber, Select, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  AGENT_KINDS,
  AGENT_LABELS,
  PROTOCOL_LABELS,
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
   * 每家的协议**集合**元数据（来自 `GET /api/runs/model-options` 的注册表投影）。
   * 不传时**不拦**（列出全部）——注册表才是协议表的唯一真源，界面拿不到数据时不该自己编一份；
   * 服务端在创建与评分两处各有一道校验。
   */
  agentProtocols?: { agentKind: AgentKind; protocolTypes: readonly ProtocolType[] }[];
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
