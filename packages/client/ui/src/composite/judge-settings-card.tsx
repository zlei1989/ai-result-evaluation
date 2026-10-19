'use client';

/**
 * 评分配置卡：默认评分模型 + 思考强度 + 默认评分智能体 + 输出契约只读预览 + diff 上限。
 * 纯展示：数据从 settings / providers / agentProtocols 三个 props 来，改动以 patch 回调交给调用方
 * （本组件不调接口）。
 *
 * 六处刻意的设计：
 * 1. **两种协议的模型都列**：这一格是**文本调用**的目标，与智能体协议无关，
 *    按协议过滤会平白砍掉一半候选（Anthropic 协议的模型照样能评分）。
 *    「不过滤」只针对**模型**这一格；智能体那一格反过来必须按协议过滤 ——
 *    智能体驱动不了另一种协议的模型（Codex 只吃 OpenAI 兼容），选完再报错就晚了；
 * 2. **悬空的 defaultJudge 要显式提示**：删掉供应商后设置里仍留着它的 id（删除不级联改写设置），
 *    静默显示成「未配置」会让人以为只是没选，直到跑评测才发现评分不可用；
 * 3. **单位换算只在这里做**：配置存字节，界面用 KB（人填的是 256）；
 * 4. **这里没有「单行超时」这一格**：执行与评分都不限时间，
 *    一行只会因为「跑完 / 失败 / 用户点终止」结束——那一格连契约字段一起删了。
 * 5. **「输出契约（只读）」那一格描述的是我们要求模型输出什么**（逐项达成 / 未达成 +
 *    一句理由，**不给总分**）：它是只读预览，真源是评分提示词模板，改一处必须同步另一处。
 * 6. **「思考强度」的候选项是写下侧的安全边界**：`settings.defaultJudge.effort` 在 schema 上
 *    只有 `z.string().min(1).optional()`，档位域**完全**由本组件算出的候选把关 —— 算错一格，用户就能
 *    存下一个会被服务端硬拒的值（`requireJudgeEffort` 连生成 / 识别一起拦）。故它必须与后端**同一个
 *    函数、同一个参数序**：`intersectEfforts(model, agentEfforts, CANONICAL_EFFORT_LEVELS)`。
 *
 * 三个下拉用**原生 `<select>`**：这一屏的候选是短列表（最多三组模型、五档强度、三家智能体），
 * 原生元素的键盘、读屏与「禁用某个选项」语义与需求一一对应，也不需要浮层定位；
 * 值的回显只认「当前选中项」，不会把全部候选文本混进可访问名。
 */
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
  type SettingsView,
  type SettingsPatch,
} from '@aieval/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Field, FieldLabel, FieldTitle } from '../components/ui/field';
import { SettingsAlert } from './settings-alert';

export interface JudgeSettingsCardProps {
  settings: SettingsView;
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

/** 原生下拉的统一样式：高度与 `Input` 对齐（h-8），边框/焦点环走语义变量 */
const SELECT_CLASS =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30';

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
  // 而 DSH **两条都吃** —— 所以判据是「集合里有没有」而不是「等不等于」）。
  const judgeProtocol =
    current === null
      ? undefined
      : providers.find((provider) => provider.id === current.providerId)?.protocolType;
  const protocolsOf = (kind: AgentKind): readonly ProtocolType[] | undefined =>
    agentProtocols?.find((item) => item.agentKind === kind)?.protocolTypes;
  const incompatible = (kind: AgentKind): boolean => {
    const accepted = protocolsOf(kind);
    // 三个「不知道」都要放行（判据缺失时宁可少拦一次，服务端还有两道）：没有默认评分模型、
    // 注册表投影拿不到这一家、或这一家的集合为空。
    return judgeProtocol !== undefined && accepted !== undefined && !accepted.includes(judgeProtocol);
  };
  const currentAgentDangling = settings.defaultJudgeAgent !== null && incompatible(settings.defaultJudgeAgent);

  /**
   * 思考强度的档位域：模型声明（没声明就兜规范五档）∩ **默认评分智能体**的域。
   *
   * 与后端 `requireJudgeEffort` 是**同一个函数、同一个参数序**（`agentEfforts` 传评分智能体的域，
   * 未配智能体时传 `CANONICAL_EFFORT_LEVELS` 本身）——档位域只有这一处算法，抄第二份必然漂移。
   */
  // 这一家的档位域。**两种「取不到」刻意分开**：
  //   · 用户**没配**评分智能体 ⇒ 规范五档（契约里「未指定」就是这个状态，兜它是对的，与后端同口径）；
  //   · 配了、但注册表投影还没到（页面冷加载时 `agentOptions` 是 undefined ⇒ 传下来是 `[]`）
  //     ⇒ `undefined` = **还不知道**。这时**不能**兜规范五档：dsh 收不了 `medium`。
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
  // `effortUnknown` 时不下这个结论——域都还不知道，说「已失效」就是假消息。
  const effortDangling =
    !effortUnknown && current?.effort !== undefined && !effortLevels.includes(current.effort);

  const pick = (value: string): void => {
    if (value === '') {
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
    <Card size="sm" data-testid="judge-settings-card">
      <CardHeader>
        <CardTitle>评分配置</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {current === null && (
            <SettingsAlert
              tone="warning"
              title="未配置默认评分模型"
              description="未配置时，用例页的「智能生成 / 智能识别」与评测的评分步骤都不可用；请在这里选一个——评分模型只有这一个来源，用例上没有可以覆盖它的地方。"
            />
          )}
          {dangling && (
            <SettingsAlert
              tone="error"
              title="当前的默认评分模型已失效"
              description={`设置里记的是 ${currentKey}，但它已不在供应商清单里（供应商或模型被删了）。请重新选择。`}
            />
          )}
          {/* 布尔变量不带窄化：`currentAgentDangling` 里判过的非 null 传不出来，故下面用 `as AgentKind` 断言。
              文案与 `@aieval/agents` 的 `protocolMismatchMessage` 同构（列出**集合**而不是单值）：
              DSH 两条 wire 都能收，写成「只接受 Anthropic 协议」会说谎。 */}
          {currentAgentDangling && (
            <SettingsAlert
              tone="error"
              title="当前的默认评分智能体与评分模型协议不匹配"
              description={`${AGENT_LABELS[settings.defaultJudgeAgent as AgentKind]} 只接受 ${
                (protocolsOf(settings.defaultJudgeAgent as AgentKind) as readonly ProtocolType[])
                  .map((one) => PROTOCOL_LABELS[one])
                  .join(' / ')
              }协议，而当前的默认评分模型属于${PROTOCOL_LABELS[judgeProtocol as ProtocolType]}协议。请重新选择其中一个。`}
            />
          )}
          {/* 档位悬空与上面两条同一套模式：静默显示成「未指定」会让用户以为只是没选，
              而配置里那个值仍然会在生成 / 识别时把请求硬拒掉。 */}
          {effortDangling && (
            <SettingsAlert
              tone="error"
              title="当前的思考强度已失效"
              description={`设置里记的是 ${current?.effort}，但它不在当前可选档位里（评分模型或评分智能体换了）。请重新选择。`}
            />
          )}

          <div className="flex flex-col gap-2">
            <Field>
              <FieldLabel htmlFor="judge-default-model">默认评分模型</FieldLabel>
              <select
                id="judge-default-model"
                aria-label="默认评分模型"
                className={SELECT_CLASS}
                disabled={saving || providers.length === 0}
                // 悬空时不回显那个失效的 key：显示一个不存在的模型名比显示空更糟
                value={dangling ? '' : (currentKey ?? '')}
                onChange={(event) => pick(event.target.value)}
              >
                <option value="">
                  {providers.length === 0 ? '请先在「模型供应商」页添加供应商' : '未配置'}
                </option>
                {groups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {/* 「有供应商但一个模型都没有」是首次使用最可能停住的状态：不给这句中文，
                    下拉里就是一片空白，用户看不出下一步该去哪 */}
                {providers.length > 0 && groups.length === 0 && (
                  <option value="" disabled>
                    暂无模型：请先在「模型供应商」里拉取或手工添加
                  </option>
                )}
              </select>
            </Field>

            {/* 它同时吃「默认评分模型」与「默认评分智能体」两格：候选 = 模型声明 ∩ 评分智能体的域 */}
            <Field>
              <FieldLabel htmlFor="judge-effort">思考强度</FieldLabel>
              <select
                id="judge-effort"
                aria-label="思考强度"
                className={SELECT_CLASS}
                // 还不知道这一家的档位域时也禁用（理由见 `effortUnknown`）
                disabled={saving || current === null || effortUnknown}
                // 悬空时不回显那个失效值（与上面那条告警同一处置）
                value={effortDangling ? '' : (current?.effort ?? '')}
                onChange={(event) => {
                  if (current === null) return;
                  const value = event.target.value;
                  onChange({
                    defaultJudge: {
                      providerId: current.providerId,
                      modelId: current.modelId,
                      // 清空 = 回到「未指定」= **不写这个键**（契约里缺省就是未指定）
                      ...(value === '' ? {} : { effort: value }),
                    },
                  });
                }}
              >
                <option value="">未指定</option>
                {/* 「域还不知道」时把已存的值原样摆出来：禁用只挡「改」，不挡「看」——
                    不给这一项的话原生 select 找不到匹配项，会把它静默显示成「未指定」 */}
                {effortUnknown && current?.effort !== undefined && (
                  <option value={current.effort} disabled>
                    {current.effort}
                  </option>
                )}
                {effortLevels.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </Field>

            <Field>
              <FieldLabel htmlFor="judge-agent">默认评分智能体</FieldLabel>
              <select
                id="judge-agent"
                aria-label="默认评分智能体"
                className={SELECT_CLASS}
                disabled={saving}
                value={settings.defaultJudgeAgent ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  // 清空 = 回到「未配置」（契约里 defaultJudgeAgent 的 null 就是未配置）
                  onChange({ defaultJudgeAgent: value === '' ? null : (value as AgentKind) });
                }}
              >
                <option value="">未配置</option>
                {AGENT_KINDS.map((kind) => (
                  <option key={kind} value={kind} disabled={incompatible(kind)}>
                    {incompatible(kind) ? `${AGENT_LABELS[kind]}（与当前默认评分模型协议不匹配）` : AGENT_LABELS[kind]}
                  </option>
                ))}
              </select>
            </Field>

            <Field>
              <FieldTitle>输出契约（只读）</FieldTitle>
              <div className="flex flex-col gap-1">
                <p className="text-sm text-muted-foreground">
                  评分模型只输出一个 JSON：对评分标准项里<strong className="font-medium text-foreground">每一项</strong>
                  给出「达成 / 未达成 + 一句理由」，不给总分。
                </p>
                <p className="text-sm text-muted-foreground">
                  总分 = 达成项的权重之和；满分 = 全部项权重之和（由每个用例的「评分标准项」决定）。
                </p>
              </div>
            </Field>

            <Field>
              <FieldLabel htmlFor="judge-diff-budget">diff 上限（KB）</FieldLabel>
              <input
                id="judge-diff-budget"
                aria-label="diff 上限（KB）"
                type="number"
                min={1}
                step={1}
                className={`${SELECT_CLASS} [appearance:textfield]`}
                disabled={saving}
                value={Math.round(settings.diffBudgetBytes / BYTES_PER_KB)}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  // 清空输入框给的是空串（`Number('') === 0`）：契约要求正整数，不能当成 0 写回去
                  if (event.target.value === '' || !Number.isFinite(value) || value < 1) return;
                  onChange({ diffBudgetBytes: Math.round(value) * BYTES_PER_KB });
                }}
              />
            </Field>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
