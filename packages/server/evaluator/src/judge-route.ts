/**
 * 评分路由解析：**只有一个来源**——设置页「评分配置」的全局默认评分模型；
 * 没有则抛 CONFLICT + 指向设置页的中文原因。
 * 为什么放在 evaluator 而不是 api 层：evaluator 在 p4 的评分阶段也要自己解析一次，
 * 而 evaluator 不能依赖 api（依赖方向单向）。api 层只做转出（契约 §6 的 `judge.ts`）。
 * 三种失败都要给出**具体到 id** 的原因，而不是笼统的「未配置」：
 *   ① 全局默认为空；② 指向的供应商已被删除；③ 模型不在该供应商的清单里。
 * ②③ 的共同点是「配置看起来有、实际用不了」——笼统报「未配置」会让用户去设置页反复确认一个明明填了的字段。
 *
 * 本文件是「这一分是哪把尺子打的」的**两半**：`resolveJudgeRoute` 决定尺子落在哪个模型上，
 * `requireJudgeAgent` 决定谁来驱动它（智能体评分通路）。两者一起被 api 层与编排层复用。
 *
 * **无参**是刻意的：用例上不再有评分模型覆盖（用列表单里那一格已删除），
 * 于是入参里也就没有「覆盖」可传——留一个参数就等于留一条能绕开设置页的旁路。
 */
import { AGENT_KINDS, AGENT_LABELS, ServiceError, type AgentKind, type ProtocolType } from '@aieval/contracts';
import { acceptsProtocol, getProvider, protocolMismatchMessage } from '@aieval/agents';
import { createLogger, loadConfig } from '@aieval/core';
import type { TextRoute } from './text-api';

const log = createLogger('judge-route');

/** 评分配置分区的位置（两种「未配置」的去向共用同一处位置文案，避免各写一份后漂移） */
const SETTINGS_LOCATION = '「设置 → 评分配置」';
/** 评分模型未配置时的统一去向文案（设置页的评分配置分区） */
const GO_SETTINGS = `请先到${SETTINGS_LOCATION}里选择默认评分模型`;
/**
 * 默认评分智能体未配置时的去向文案。
 * 为什么不能直接复用 `GO_SETTINGS`：卡片里那一格叫「默认评分智能体」，与「默认评分模型」是**两格**；
 * 复用会把用户指到错的那一格上（选完模型依然报同一个错）。
 */
const GO_SETTINGS_AGENT = `请先到${SETTINGS_LOCATION}里选择默认评分智能体`;

/**
 * 解析评分路由：恒取设置页的全局默认评分模型。
 * 供应商记录里的 `apiKey` 是明文（服务端要原 token 才能代调），这里原样带进路由；
 * 路由只在服务端内部流转，绝不出现在任何下行响应里（下行一律用 `ProviderView` 的掩码字段）。
 */
export function resolveJudgeRoute(): TextRoute {
  const config = loadConfig();
  const providerId = config.settings.defaultJudge?.providerId ?? null;
  const modelId = config.settings.defaultJudge?.modelId ?? null;

  if (providerId === null || modelId === null) {
    throw new ServiceError('CONFLICT', `未配置评分模型：${GO_SETTINGS}`);
  }

  const provider = config.providers.find((item) => item.id === providerId);
  if (provider === undefined) {
    throw new ServiceError('CONFLICT', `评分模型指向的供应商不存在（${providerId}）：可能已被删除，${GO_SETTINGS}`, {
      context: { providerId, modelId },
    });
  }
  const model = provider.models.find((item) => item.id === modelId);
  if (model === undefined) {
    throw new ServiceError(
      'CONFLICT',
      `供应商「${provider.name}」（${providerId}）的模型清单里没有 ${modelId}：请在设置页拉取或手工添加该模型`,
      { context: { providerId, modelId } },
    );
  }

  const protocolType: ProtocolType = provider.protocolType;
  log.debug('评分路由已解析', { providerId, modelId, protocolType });
  return {
    protocolType,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelId,
    // 窗口两格（spec §4.2 / D1）：这条路由会被智能体评分通路**原样**当适配器路由用，
    // 少了它，cc 驱动的评分模型不会加 `[1m]`、codex 不写 `model_context_window` —— 与候选行的行为不一致。
    // 缺省时不写这两个键（适配器一律按「键不存在 = 未知」处理）。
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
  };
}

/**
 * 解析「这一轮该用哪家智能体评分」，并把三种配置问题折成可直接展示的中文 CONFLICT。
 *
 * 为什么放在本文件：它与 `resolveJudgeRoute` 是同一件事的两半——尺子落在哪个模型上、谁来驱动它。
 * 为什么 api 层也要用它：创建评测时要**提前**拦一次（不要让人选完到评分阶段才失败）。
 *
 * 协议兼容不是可选项：智能体的元数据里只有一个 `protocolType`（agents 注册表 A3），而评分模型那一对
 * 可能来自另一种协议的供应商——两者不匹配时那家 CLI 根本驱动不了它（Codex 走 chat-completions，
 * Claude Code / DSH 走 Messages）。
 *
 * 第三道判据是**枚举之外的值**（终审 Minor）：类型上是 `AgentKind`，但 `loadConfig()` **不做 zod
 * 校验**（它只把磁盘上的 json 与默认值合并），手改过的 config.json 里可以写着 `"gemini"`。
 * 不拦的话它会一路走到 agents 的 `getProvider()`，那里抛的是**裸 Error** ⇒ 路由层折成
 * 500「服务端内部错误」，用户拿着一个指向服务的报错、却该去改评分配置。故这里先判枚举：
 * 折成 CONFLICT + 指向「设置 → 评分配置」。
 */
export function requireJudgeAgent(input: { defaultJudgeAgent: AgentKind | null; route: TextRoute }): AgentKind {
  const kind = input.defaultJudgeAgent;
  if (kind === null) {
    throw new ServiceError(
      'CONFLICT',
      `这一轮启用了智能体评分，但没有配置默认评分智能体：${GO_SETTINGS_AGENT}，或新建评测时关闭「使用智能体评分」`,
      { context: { protocolType: input.route.protocolType, modelId: input.route.modelId } },
    );
  }
  if (!(AGENT_KINDS as readonly string[]).includes(kind)) {
    throw new ServiceError('CONFLICT', `默认评分智能体不是可用的智能体（收到 ${String(kind)}）：${GO_SETTINGS_AGENT}，或新建评测时关闭「使用智能体评分」`, {
      context: { kind, available: AGENT_KINDS },
    });
  }
  const { metadata } = getProvider(kind);
  if (!acceptsProtocol(metadata, input.route.protocolType)) {
    throw new ServiceError(
      'CONFLICT',
      `${protocolMismatchMessage({
        agentLabel: AGENT_LABELS[kind],
        accepted: metadata.protocolTypes,
        subject: `本次评分用的 ${input.route.modelId}`,
        actual: input.route.protocolType,
      })}：请到${SETTINGS_LOCATION}换一个与所选评分模型协议匹配的默认评分智能体`,
      { context: { kind, accepted: metadata.protocolTypes, actual: input.route.protocolType } },
    );
  }
  return kind;
}
