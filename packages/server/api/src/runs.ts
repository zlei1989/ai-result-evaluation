/**
 * 评测服务：创建（含候选池投影）、列表/详情读取、启动与终止。
 * 四条口径：
 *   1. 创建只**落库**，不自动开跑（spec §5.1）——「开始」是评测详情页的显式动作；
 *   2. 供应商名与 baseUrl 在创建时**快照**进行里（spec §7.2）：供应商改名或删除后，
 *      历史评测仍能说清这一行当时用的是什么；
 *   3. 候选池的协议判据来自 agents 注册表元数据（spec §5.6.2 A3）——本文件里**没有**
 *      「哪家智能体配哪种协议」的映射表，那张表只有注册表一份；
 *   4. 开了「使用智能体评分」就在**创建时**把评分配置问题拦下来（spec §6）：
 *      配置不对的表现原本是「候选跑完几分钟后才在评分阶段炸」，两处判定共用
 *      evaluator 的 `resolveJudgeRoute` / `requireJudgeAgent`（评分阶段还会再校验一次，配置可能被改过）。
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_KINDS,
  EFFORT_OFF,
  ServiceError,
  hasLiveRows,
  isRunnableRow,
  isSameRowTarget,
  type AgentKind,
  type EvalRow,
  type EvalRun,
  type MessageCapability,
  type Provider,
  type ProtocolType,
  type Rubric,
  type RunCreate,
  type RunUpdate,
} from '@aieval/contracts';
import { createLogger, rowWorkspaceDir } from '@aieval/core';
import { acceptsProtocol, getProvider, protocolMismatchMessage } from '@aieval/agents';
import {
  abortRow as abortRowInOrchestrator,
  abortRun as abortRunInOrchestrator,
  assertRunMutable,
  deleteRun as deleteRunInOrchestrator,
  getRun as getRunSnapshot,
  listRuns as listRunsFromDisk,
  requireJudgeAgent,
  rescoreRow as rescoreRowInOrchestrator,
  resolveJudgeRoute,
  retryRow as retryRowInOrchestrator,
  saveRun,
  startRun as startRunInOrchestrator,
} from '@aieval/evaluator';
import { getCase } from './cases';
import { listProviders } from './providers';
import { getSettings } from './settings';

const log = createLogger('runs');

/** 候选池里的一个模型：字段与 spec §5.1 的下拉选项一一对应 */
export interface AgentModelOption {
  providerId: string;
  providerName: string;
  /** 供应商侧的模型 id（选它就是选「这个供应商的这个模型」） */
  modelId: string;
  /** 自动拉取 vs 手工维护：界面用 Tag 区分来源（spec §5.1） */
  source: 'fetched' | 'manual';
  /** 上下文窗口（token）；缺省 = 未知（界面显示「未知」，绝不兜底一个数字） */
  contextWindow?: number;
  /**
   * 该组合**可选**的思考强度档位（spec D10；2026-10-06 放宽，规则在 `intersectEfforts` 里）：
   * 上游声明过 ⇒ 交集，再**并上关闭档** `EFFORT_OFF`（关闭不受交集裁剪）；上游**没声明** ⇒
   * 该家**完整档位域**。缺省 = 一个档位都没有（界面只给「默认」）——只有该家档位域为空时才会。
   * 为什么在 api 层求交而不是把上游档位原样给界面：dsh 侧对不支持的档位是**硬报错**，
   * 原样列等于让人选完到运行时才炸；而「就近取整」是静默改语义。
   */
  efforts?: string[];
  /** 上游推荐档，**且落在交集里**时才有值（推荐了一个这家智能体收不了的档 ⇒ 不显示推荐） */
  recommendedEffort?: string;
}

/**
 * 一种智能体的创建期元数据 + 候选池。
 * 这是本计划新增的传输形状（契约 §6 只钉了单 kind 的 `listModelOptions`）：界面除了候选池，
 * 还需要 `usage` / `cancelMidTurn` 才能把「不支持计量」与「关闭运行时」这两处文案做对
 * （spec §5.6.2 / §5.6.3），而它们的唯一来源同样是注册表元数据。
 */
export interface AgentOptionGroup {
  agentKind: AgentKind;
  /** 该智能体接受的协议**集合**（注册表元数据；DSH 两条 wire ⇒ 两个元素），界面据此判断默认评分智能体是否兼容 */
  protocolTypes: readonly ProtocolType[];
  /** false ⇒ 该适配器采不到 token，界面显示「不支持计量」而不是「未采集」/0 */
  usage: boolean;
  /** false ⇒ 「终止」按钮文案退化为「关闭运行时」 */
  cancelMidTurn: boolean;
  /** 该智能体能收的思考强度档位（注册表元数据，spec D11）；界面用它解释「为什么只有这几档」 */
  efforts: readonly string[];
  /**
   * **消息能力声明**（spec v3 §2.5，2026-10-04 收口接上）。
   *
   * 五格（思考文本 / 工具入参 / 工具结果 / 子任务 / 流式增量）各自带 `source` 与 `reason`，
   * 是界面那四句「这家结构上不支持 / 厂商没投送 / 我们还没接 / 没验证过」的**唯一**来源。
   *
   * 为什么必须在这里透出来：三家各自在 `providers/<kind>/index.ts` 里声明了它，而
   * `CapabilityNotes` 与 `AgentLogLayout` 的「这一类没被转发」提示条都吃它。
   * 出口少这一格时，整条链路会在 api 处静默断掉——界面拿不到声明就一律回落成 `unverified`，
   * 三家被说成同一句「没验证过」，而真相是「codex 的思考正文只在会话文件里」这种具体原因
   * （把「没投送」说成「没验证过」正是契约反复禁的那类误读）。
   */
  messageCapability: MessageCapability;
  options: AgentModelOption[];
}

/**
 * 评测列表：最新创建的排在最前。
 * 排序放在服务层而不是页面里——「最新在前」是列表语义的一部分，两个消费方各排一次必然漂移。
 * 用 `[...listRuns()]` 复制再排：原地 sort 会把「读接口不改写入参」这条隐性约定变成陷阱。
 */
export function listRunsView(): EvalRun[] {
  return [...listRunsFromDisk()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 单轮评测快照；不存在时由编排层抛 NOT_FOUND（api 不重复造这个判定） */
export function getRunView(runId: string): EvalRun {
  return getRunSnapshot(runId);
}

/** 校验链解析出来的一行：候选行本身 + 服务端快照（供应商名 / baseUrl）+ 编辑才有的原行 id */
export interface ResolvedRunRow {
  /** 编辑时指认「原来那一行」；创建路径恒为 undefined */
  id?: string;
  agentKind: AgentKind;
  providerId: string;
  providerName: string;
  baseUrl: string;
  modelId: string;
  /**
   * 这一行要求的思考强度（可选，spec D12）：创建与编辑共用同一条校验链，故也由这里带出来。
   * 缺省 = 表单没选——「没说」与「说了 high」在快照里必须分得开，落盘时**不写这个键**。
   */
  effort?: string;
}

/**
 * 候选行的校验链 + 供应商快照：**创建与编辑共用一份**。
 * 顺序逐字沿用创建时的口径（供应商存在 → 模型在该供应商清单里 → 协议兼容 → 强度在候选里）：
 * 顺序反了会把「供应商不存在」报成「模型不存在」，让用户往错误的方向排查。
 * 四个判定**都不在这里重写**：协议判据来自 agents 注册表元数据（spec §5.6.2 A3），强度候选来自
 * `intersectEfforts`（交集并上关闭档；上游未声明时给该家完整域）——本文件里没有
 * 「哪家智能体配哪种协议」的映射表。
 */
export function resolveRunRows(
  rows: RunUpdate['rows'],
  // 只要求校验链真正读到的字段：`listProviders()` 下行的是脱敏后的 `ProviderView`（没有 `apiKey`），
  // 而落盘的 `Provider` 与测试夹具同样满足这个形状。写成 `readonly Provider[]` 会让真实调用方
  // （创建 / 编辑都传 `listProviders()`）传不进来——它缺的是明文密钥，而校验链一个字节都不需要它。
  providers: readonly Pick<Provider, 'id' | 'name' | 'protocolType' | 'baseUrl' | 'models'>[],
): ResolvedRunRow[] {
  return rows.map((row) => {
    const provider = providers.find((item) => item.id === row.providerId);
    if (provider === undefined) {
      throw new ServiceError('NOT_FOUND', `供应商不存在或已被删除（${row.providerId}），请重新选择模型`);
    }
    const model = provider.models.find((item) => item.id === row.modelId);
    if (model === undefined) {
      throw new ServiceError(
        'NOT_FOUND',
        `供应商「${provider.name}」的模型清单里没有 ${row.modelId}，请重新选择，或到设置里为它补上这个模型`,
      );
    }
    const { displayName, metadata } = getProvider(row.agentKind);
    if (!acceptsProtocol(metadata, provider.protocolType)) {
      throw new ServiceError(
        'CONFLICT',
        protocolMismatchMessage({
          agentLabel: displayName,
          accepted: metadata.protocolTypes,
          subject: `供应商「${provider.name}」的模型`,
          actual: provider.protocolType,
        }),
      );
    }
    // 强度校验（spec D10 的第二道闸）：表单只列候选，这里拦的是**绕过表单直接打接口**。
    // 2026-10-06：**未选也要校验**——dsh 的「未选」会真的落到缺省档（`metadata.defaultEffort`），
    // 那个档不在候选里时必须**建行就拒**，否则要跑到 dsh 的硬校验处才失败
    // （`UNSUPPORTED_REASONING_EFFORT`，症状离真因很远）。
    const allowed = intersectEfforts(model, metadata.reasoningEfforts) ?? [];
    const declared = row.effort ?? metadata.defaultEffort;
    if (declared !== undefined && !allowed.includes(declared)) {
      const implicit = row.effort === undefined ? `（未选档位时 ${displayName} 会用 ${declared}）` : '';
      throw new ServiceError(
        'INVALID_QUERY',
        `${displayName} 不能按 ${declared} 跑 ${row.modelId}${implicit}：该模型支持的档位是 ` +
          `${model.supportedEfforts?.join(' / ') ?? '（上游未声明）'}，${displayName} 能收的是 ` +
          `${metadata.reasoningEfforts.join(' / ')}，可选的是 ${allowed.join(' / ') || '（只有默认）'}` +
          `（其中 ${EFFORT_OFF} = 显式关闭思考）`,
        {
          context: {
            effort: declared,
            explicit: row.effort !== undefined,
            modelSupported: model.supportedEfforts,
            agentSupported: metadata.reasoningEfforts,
          },
        },
      );
    }
    return {
      ...(row.id === undefined ? {} : { id: row.id }),
      agentKind: row.agentKind,
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      modelId: row.modelId,
      ...(row.effort === undefined ? {} : { effort: row.effort }),
    };
  });
}

/**
 * 候选行的初值：创建与「编辑新增」**共用这一处**。
 *
 * 为什么必须共用：两条路径的那十几格初值必须永远一致——`effort` 落地时它就被迫在三处各改一遍；
 * 而漏掉一格（或写歪一格）的后果不是「少显示一个字段」：`EvalRowSchema` 的必填格缺失会让 `saveRun` 拒绝，
 * 或让 `listRuns()` **静默跳过整轮**（使用者看到的是「我的评测记录凭空少了几轮」）。
 * 两条路径唯一该有的差别由入参表达：`rowId`（新行 id）与 `workspaceBase`（这一行的工作区根）——
 * 创建时是**创建那一刻**的 `settings.workspaceRoot`（与落库的 `run.workspaceBase` 是同一个值），
 * 编辑新增时是 `run.workspaceBase`（spec §3 D13：按当前设置算会让新行的产物落在另一个根里，两边都不报错）。
 *
 * 注意「缺省」在这里有**两种写法**、各有理由：`effort` 缺省时**不写这个键**（可选展开，落盘物干净，
 * 且「没说」与「说了 high」要分得开），其余可空格则**显式写 null**（`baselineCommit` 写空串、
 * `attempts` 写 0 也是显式）——前者是「键在不在这件事」，后者是「值是什么」。
 * 移进来之前先读一遍各自的行内注释。
 */
function buildRow(input: {
  rowId: string;
  runId: string;
  workspaceBase: string;
  agentKind: AgentKind;
  providerId: string;
  providerName: string;
  baseUrl: string;
  modelId: string;
  effort?: string;
}): EvalRow {
  return {
    id: input.rowId,
    agentKind: input.agentKind,
    providerId: input.providerId,
    providerName: input.providerName,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    // 强度进快照（spec D12）：它是**这一行的配置**，必须跟着行一起被重跑、被展示、被比较。
    // 缺省时**不写这个键**（而不是写 undefined）：落盘物要干净，且「没说」与「说了 high」要分得开。
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    status: 'pending',
    branch: `test/${input.rowId}`,
    // 工作区路径在创建时就能算出来：编排层建目录时用的是同一个 core 函数，不会漂移。
    // 落进去省掉「还没准备」这一种额外的空值状态（按需读产物时要按它定位）。
    workspacePath: rowWorkspaceDir(input.workspaceBase, input.runId, input.rowId),
    // 基线在准备阶段才解析成 40 位 hash（§11 R2），创建时还没有
    baselineCommit: '',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
    // 还没跑过 ⇒ 0 次尝试（契约里这一格的缺省值也是 0，显式写出来是为了让落盘物自解释）
    attempts: 0,
  };
}

/**
 * 创建一轮评测：校验 → 快照 → 落库 idle。
 * 校验顺序固定为「**用例 → 评分通路 → 供应商 → 模型 → 协议**」（终审 Minor 纠正：原注释把
 * 「评分通路」写在「用例」前面，而代码里 `getCase` 是最先跑的那一步），因为它们是递进的：
 * 先确认用例还在（题面与仓库来源都要它——评分表随创建快照进这一轮，不再回头查用例；
 * 后面每一步都拿它的字段），再确认这一轮
 * **怎么评分**这件事本身成立（它只看用例与设置，与候选行无关），然后逐行确认「谁来跑、跑哪个模型」
 * 可行，最后才用注册表元数据判协议兼容。
 * 顺序反了会把「供应商不存在」报成「模型不存在」，让用户往错误的方向排查。
 */
export function createRun(input: RunCreate): EvalRun {
  const testCase = getCase(input.caseId);
  const providers = listProviders();
  const settings = getSettings();
  const runId = randomUUID();
  const now = new Date().toISOString();

  if (input.useAgentJudge) {
    // 「不要让人选完到运行时才失败」：智能体评分需要设置页那一格，而评分模型只有全局默认这一个来源
    // （用例上不再有覆盖）。评分阶段还会再校验一次（配置可能被改过），两处都留——
    // 与 F2 的协议过滤「创建时拦一次、编排层再拦一次」同一模式。
    const route = resolveJudgeRoute();
    requireJudgeAgent({ defaultJudgeAgent: settings.defaultJudgeAgent, route });
  }

  const rows: EvalRow[] = resolveRunRows(input.rows, providers).map((row) =>
    buildRow({
      rowId: randomUUID(),
      runId,
      // 创建这一刻的根就是这一轮的 workspaceBase：落库的那一格取的是同一个 settings.workspaceRoot
      workspaceBase: settings.workspaceRoot,
      agentKind: row.agentKind,
      providerId: row.providerId,
      providerName: row.providerName,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
      effort: row.effort,
    }),
  );

  const run: EvalRun = {
    id: runId,
    caseId: testCase.id,
    caseTitle: testCase.title,
    repoPath: testCase.repoPath,
    commitHash: testCase.commitHash,
    // 与 caseTitle / commitHash 同为一轮评测的冗余快照；旧配置里的用例没有这一列，故 ?? null 兜住 undefined
    repoBranch: testCase.repoBranch ?? null,
    // 与 caseTitle / repoPath 同一套冗余快照：这一轮用的是哪张评分表。
    // 评分阶段读的是它而不是 testCase.rubric——改了用例的评分表之后，历史记录与「重新评分」仍按当初那把尺子
    rubric: testCase.rubric,
    status: 'idle',
    executionMode: input.executionMode,
    // 这一轮**怎么评分**的快照：不写这一格，`EvalRunSchema` 的 `.default(false)` 会在落盘时
    // 悄悄把它变成 false——界面显示着「使用智能体评分」，跑的却是模型评分，两端都不报错
    useAgentJudge: input.useAgentJudge,
    rows,
    workspaceBase: settings.workspaceRoot,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };

  saveRun(run);
  log.info('创建评测', { runId, caseId: testCase.id, executionMode: input.executionMode, rows: rows.length });
  return run;
}

/**
 * 启动：只跑未完成的行（spec §5.3 的「开始」语义）。
 * 「没有可执行的行」在 api 层就拦掉并抛 CONFLICT：编排层的 startRun 只承诺「已有运行中的行则抛
 * CONFLICT」，全是 judged 时它会安静地什么都不做——而界面刚点过「开始」，静默无反应是最难排查的反馈。
 */
export function startRun(runId: string): EvalRun {
  const before = getRunSnapshot(runId);
  const runnable = before.rows.filter((row) => isRunnableRow(row.status));
  if (runnable.length === 0) {
    throw new ServiceError('CONFLICT', '这一轮没有可执行的候选行：全部行都已评分，或正在运行中');
  }

  const run = startRunInOrchestrator(runId);
  log.info('启动评测', { runId, runnable: runnable.length });
  return run;
}

/** 终止整轮：在跑的行 → canceled、串行未轮到的 → skipped（两者的划分由编排层负责） */
export function abortRun(runId: string): EvalRun {
  // 先做存在性检查：编排层的 abortRun 对未知 id 的行为没有契约保证，而界面必须拿到 404
  getRunSnapshot(runId);

  const run = abortRunInOrchestrator(runId);
  log.info('终止评测', { runId });
  return run;
}

/** 终止单行：全开并发下某一行明显跑歪时不必等它超时（spec §5.3） */
export function abortRow(runId: string, rowId: string): EvalRun {
  const before = getRunSnapshot(runId);
  if (!before.rows.some((row) => row.id === rowId)) {
    throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${rowId}）`);
  }

  const run = abortRowInOrchestrator(runId, rowId);
  log.info('终止候选行', { runId, rowId });
  return run;
}

/**
 * 重新评分：只重跑评分步骤（spec §9）。
 * 判据（`canRescoreRow`）与拒绝原因是编排层的活——api 层只做存在性检查与转出，
 * 与 `abortRow` 同一条分工（界面不该给它按钮，真调到了要明确报出来，而不是静默成功）。
 */
export function rescoreRow(runId: string, rowId: string): EvalRun {
  const before = getRunSnapshot(runId);
  if (!before.rows.some((row) => row.id === rowId)) {
    throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${rowId}）`);
  }

  const run = rescoreRowInOrchestrator(runId, rowId);
  log.info('重新评分', { runId, rowId });
  return run;
}

/**
 * 单行**执行**（内部名 retry；界面文案按行态分叉：没跑过 = 「开始执行」、跑过 = 「重新执行」）：
 * 只把这一行的候选 agent 与评分整段跑一遍，本轮其他行一律不动。
 * 可用判据 `canRunRow` 只要求「不在跑」（2026-09-29 起**包含没跑过的行**——用户口径
 * 「只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」）；
 * 「跑过没跑过」只决定界面文案与确认框措辞（`canRetryRow`），不再决定能不能跑。
 * 与 `rescoreRow` 同一条分工：存在性检查在 api 层，可用性判据与拒绝原因在编排层
 * （界面不该给它按钮，真调到了要明确报出来）。
 */
export function retryRow(runId: string, rowId: string): EvalRun {
  const before = getRunSnapshot(runId);
  if (!before.rows.some((row) => row.id === rowId)) {
    throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${rowId}）`);
  }

  const run = retryRowInOrchestrator(runId, rowId);
  log.info('单行执行候选行', { runId, rowId });
  return run;
}

/**
 * 候选池投影：某种智能体可用的全部模型（spec §5.1 F2）。
 * 过滤判据是注册表元数据的**协议集合**（`protocolTypes` + `acceptsProtocol`）——**不硬编码**
 * 「Codex 用 openai」这类对应关系（A3）：将来加第四家智能体、或某一家从单协议变成双协议
 * （DSH 就是这样），这里一行都不用改。
 */
export function listModelOptions(agentKind: AgentKind): AgentModelOption[] {
  const { metadata } = getProvider(agentKind);
  return listProviders()
    .filter((provider) => acceptsProtocol(metadata, provider.protocolType))
    .flatMap((provider) =>
      provider.models.map((model) => {
        const efforts = intersectEfforts(model, metadata.reasoningEfforts);
        return {
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          source: model.source,
          // 三格都按「有意义才出现」写：缺省 = 未知 / 无可选档，界面据此只给「默认」
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(efforts === undefined ? {} : { efforts }),
          // 推荐档只在**交集里**才有意义：推荐一个这家智能体收不了的档，界面会把它当可选档显示
          ...(model.recommendedEffort !== undefined && (efforts ?? []).includes(model.recommendedEffort)
            ? { recommendedEffort: model.recommendedEffort }
            : {}),
        };
      }),
    );
}

/**
 * 候选档位（spec D10；2026-10-06 放宽）。
 *
 * 两个变化，各自都有靶子：
 *   · **上游没声明 ⇒ 给该家完整档位域**：本机两个 provider 都是 `source: fetched` 且不带
 *     `supportedEfforts` ⇒ 旧写法让候选为空、界面只给「默认」，用户**连档位都点不到**
 *     （更别说点「关闭」）；
 *   · **关闭档不受交集裁剪**：它表达的是「我们这一侧关掉思考」，不是模型声明的能力
 *     ⇒ 上游即使声明过、且不含它，也照样出现在候选里。
 *
 * 返回 `undefined` 仍表示「一个档位都没有」（该家档位域为空——正常不会发生）。
 */
function intersectEfforts(
  model: { supportedEfforts?: string[] },
  agentEfforts: readonly string[],
): string[] | undefined {
  const supported = model.supportedEfforts ?? [];
  const base =
    supported.length === 0 ? [...agentEfforts] : supported.filter((effort) => agentEfforts.includes(effort));
  const off = agentEfforts.includes(EFFORT_OFF) && !base.includes(EFFORT_OFF) ? [EFFORT_OFF] : [];
  const allowed = [...off, ...base];
  return allowed.length === 0 ? undefined : allowed;
}

/** 三种智能体的元数据 + 候选池，一次取全：创建表单与候选卡片共用同一份真源 */
export function listAgentModelOptions(): AgentOptionGroup[] {
  return AGENT_KINDS.map((agentKind) => {
    const { metadata } = getProvider(agentKind);
    return {
      agentKind,
      protocolTypes: metadata.protocolTypes,
      usage: metadata.capability.usage,
      cancelMidTurn: metadata.capability.cancelMidTurn,
      efforts: metadata.reasoningEfforts,
      // 能力声明**逐格原样透出**（含每格自己的 source / reason 与 notes）：api 不做任何裁剪，
      // 裁一格就等于替厂商重写一句「为什么没有」（见 `AgentOptionGroup.messageCapability`）
      messageCapability: metadata.messageCapability,
      options: listModelOptions(agentKind),
    };
  });
}

/** 编辑时这一轮指向的用例（五格冗余快照的来源，spec §7.2） */
export interface RunTargetCase {
  caseId: string;
  caseTitle: string;
  repoPath: string;
  commitHash: string | null;
  repoBranch: string | null;
  /**
   * 这张评分表（`EvalRunSchema.rubric` 的来源）。
   * 与其余五格同一个来路：换用例时重取、`caseId` 没变时**逐字保留**——
   * 「改了用例的评分表不许改写历史」这条不变式在**换用例**这条路上同样成立，
   * 而换过去的那张表必须跟着走（否则新用例的行会拿旧用例的尺子评分）。
   */
  rubric: Rubric;
}

/**
 * 重置一行：保留行身份（id / 分支 / 工作区路径），清掉它的全部结果。
 *
 * 为什么必须清干净而不是只把 status 打回 pending：留着一份旧分数，界面就会出现
 * 「待开始的行挂着上一轮的分数」——正是本仓最反对的「把旧数据渲染成新数据」。
 * `attempts` **也清零**，与 `retryRow` 刻意不清零**相反**：重试重跑的是同一件事（同一模型、同一用例），
 * 尝试次数是那一行的累计事实；而编辑换掉的是**被评对象**，留着「尝试 3 次」等于让新模型凭空背上
 * 旧模型的账（编排层的注释写明了 retryRow 那一条的理由，两处的差别是刻意的）。
 */
function resetRow(current: EvalRow, row: ResolvedRunRow): EvalRow {
  const next: EvalRow = {
    ...current,
    agentKind: row.agentKind,
    providerId: row.providerId,
    providerName: row.providerName,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    status: 'pending',
    baselineCommit: '',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
    attempts: 0,
  };
  // 强度**不能**跟着 `...current` 留下：用户可能正是把它清回「默认」（表单不再带这一格），
  // 留着等于让这一行继续按旧档位跑，而界面显示的是「默认」——静默的错配。
  // 故按 resolved 的那一格重建，与 `createRun` 同为「缺省不写这个键」。
  delete next.effort;
  if (row.effort !== undefined) next.effort = row.effort;
  return next;
}

/**
 * 新增一行：新 id、新分支、新工作区路径，其余字段与 `createRun` 的行初值逐字相同（含强度的写法）。
 *
 * ⚠️ `workspacePath` 必须按 **`run.workspaceBase`**（这一轮自己记录的根）算，**不能**用当前
 * `settings.workspaceRoot`：`prepareRowWorkspace` 拿的就是 `run.workspaceBase`，按当前设置算会让新行
 * 的工作区落在另一个根里——这一轮的产物裂成两半，而两边都不报错（spec §3 D13 / run-store 口径 4）。
 */
function newRow(run: EvalRun, row: ResolvedRunRow): EvalRow {
  return buildRow({
    rowId: randomUUID(),
    runId: run.id,
    // ⚠️ 必须按 **`run.workspaceBase`**（这一轮自己记录的根）算，**不能**用当前 `settings.workspaceRoot`：
    // `prepareRowWorkspace` 拿的就是 `run.workspaceBase`，按当前设置算会让新行的工作区落在另一个根里——
    // 这一轮的产物裂成两半，而两边都不报错（spec §3 D13 / run-store 口径 4）。
    workspaceBase: run.workspaceBase,
    agentKind: row.agentKind,
    providerId: row.providerId,
    providerName: row.providerName,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    effort: row.effort,
  });
}

/**
 * 编辑之后的轮级状态（spec §5.1 口径 3）。
 * **不复用编排层的 `finalizeRun`**：它对「全行 pending」会落 `partial`，把一个从没跑过的轮次
 * 显示成「部分完成」。三条分支：
 *   · 全行 judged ⇒ `done`（`finishedAt` 已是非 null 就保留原值，否则填当前时刻）；
 *   · 一次都没跑过（`startedAt === null`）⇒ `idle`、`finishedAt = null`；
 *   · 其余（跑过一轮、现在又有行待跑）⇒ `partial`、`finishedAt = null`。
 */
function settleRunAfterEdit(run: EvalRun, rows: readonly EvalRow[], now: string): Pick<EvalRun, 'status' | 'finishedAt'> {
  const allJudged = rows.length > 0 && rows.every((row) => row.status === 'judged');
  if (allJudged) return { status: 'done', finishedAt: run.finishedAt ?? now };
  if (run.startedAt === null) return { status: 'idle', finishedAt: null };
  return { status: 'partial', finishedAt: null };
}

/**
 * 算「编辑之后这一轮长什么样」（spec §5.1 的逐行处置表）：行对齐 → 原地重置 / 新增 / 删除 → 轮级收敛。
 *
 * 纯函数：不读盘、不查配置与注册表、**不写盘**（调用方负责 `saveRun`）。唯一的外部状态是
 * 新增行的 `randomUUID()` 与时间戳——用例对新增行只断言「id 非空且不等于任何原行 id」。
 * 抽出它的理由：页面与组件层的间接断言盖不住「哪一行被重置了」，这条规则必须能被**直接**测到。
 *
 * 行对齐的**唯一键是行 id**（spec §3 D3）：
 *   · 带 id 且命中 ⇒ 原地更新（目标没变就逐字保留，变了就重置）；
 *   · 带 id 但不命中 ⇒ `NOT_FOUND`，**不静默当新行**（静默会造出一行用户没打算要的候选）；
 *   · 带 id 但**重复** ⇒ `INVALID_QUERY`（见下面的 `seen`）；
 *   · 不带 id ⇒ 新增；
 *   · 现有行不在入参里 ⇒ 删除（从快照移除；它的磁盘产物留给整轮删除时回收）。
 * 「改了才重置」按**值**判：表单交回来的永远是全量行集合，按「字段出现没有」判会把每次保存
 * 都变成全行清空重来（与 `updateCase` 同口径，判据是 contracts 的 `isSameRowTarget`）。
 *
 * 轮级那六格用例快照（`caseId` / `caseTitle` / `repoPath` / `commitHash` / `repoBranch` / `rubric`）**只在换用例时**
 * 重取；`caseId` 没变就逐字保留这一轮的原快照，理由见函数体里那段注释（无条件重写会让一轮里出现两条基线）。
 */
export function planRunUpdate(
  run: EvalRun,
  input: RunUpdate,
  resolved: readonly ResolvedRunRow[],
  target: RunTargetCase,
): EvalRun {
  const caseChanged = target.caseId !== run.caseId;
  const currentById = new Map(run.rows.map((row) => [row.id, row]));
  // 同一个行 id 出现两次 ⇒ 拒绝：两条会落到**同一个**现有行上，快照里那一行就出现两次——
  // 候选数、进度分母、排名全部多算一份，而两端都不报错。放在这里而不是契约的 schema 里，
  // 是因为孪生的那条（id 不在这一轮里 ⇒ NOT_FOUND）本来就只能在这里判，两条 id 完整性检查同一处。
  const seen = new Set<string>();

  const rows: EvalRow[] = resolved.map((row) => {
    if (row.id !== undefined) {
      if (seen.has(row.id)) {
        throw new ServiceError('INVALID_QUERY', `编辑入参里重复引用了同一行（${row.id}）：每一行只能出现一次`, {
          context: { runId: run.id, rowId: row.id },
        });
      }
      seen.add(row.id);
    }
    const current = row.id === undefined ? undefined : currentById.get(row.id);
    if (row.id !== undefined && current === undefined) {
      throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${row.id}），请刷新后重试`, {
        context: { runId: run.id, rowId: row.id },
      });
    }
    if (current === undefined) return newRow(run, row);
    // 换用例 ⇒ 题面与基线都变了，**所有行**作废；否则只看这一行的目标变没变
    if (caseChanged || !isSameRowTarget(current, row)) return resetRow(current, row);
    return current;
  });

  const now = new Date().toISOString();
  return {
    ...run,
    // 用例快照（`caseId` + 五格冗余字段）**只在换了用例时**重取——spec §5.1 的逐行处置表里，
    // 只有「换来用例」那一行写了「重取 caseTitle / repoPath / commitHash / repoBranch 快照」，
    // `rubric` 与它们同路：换过去的那张评分表必须跟着走，否则新用例的行会拿旧用例的尺子评分。
    // 无条件按 `target` 重写的后果（终审 Important）：用户改的是**用例自己**的 `commitHash` / `repoPath`
    // （`CasePatchSchema` 是 `CaseCreateSchema.partial()`，允许改），此后哪怕只是把这一轮的执行模式
    // 从串行改成并行，这一轮的「复现条件」也会悄悄变成新 commit，而每一行还挂着在**旧** commit 上
    // 挣来的分；再点「开始」时 pending / failed 的行按 `run.commitHash` 重跑（编排层 prepare 用的就是它）
    // ⇒ 一轮里出现两条基线，而两端都不报错。`rubric` 同理：无条件重写会把「这一轮当初那把尺子」
    // 换成用例当前那张表，历史分数与自己那一轮的满分不再自洽。
    // 也不改成「按值比较这几格」：那要连带改客户端的 `invalidatedRows`（「同一用例」的第二份判据），
    // 而 §4.3 只允许「改了才重置」这一条判据只有一份（那一份是**行**的 `isSameRowTarget`）。
    ...(caseChanged
      ? {
        caseId: target.caseId,
        caseTitle: target.caseTitle,
        repoPath: target.repoPath,
        commitHash: target.commitHash,
        repoBranch: target.repoBranch,
        rubric: target.rubric,
      }
      : {}),
    executionMode: input.executionMode,
    useAgentJudge: input.useAgentJudge,
    rows,
    ...settleRunAfterEdit(run, rows, now),
  };
}

/**
 * 更新一轮评测（「修改」，spec §5.1）：校验 → 算新快照 → 落盘。
 *
 * 顺序与失败语义都是承重的：
 *   1. **先判「能不能改」**（`hasLiveRows`）：正在跑的行有自己的生命周期，处置是「先终止」，
 *      与后面那几条「改法不成立」完全不同，必须先分开；
 *   2. **再全校验**（用例存在 → 评分通路 → 每行的供应商 / 模型 / 协议），任何一步抛都**一个字节
 *      都不写**——半份快照比「什么都没发生」危险得多（与 `retryRow` 的「入口区必须能整体回退」同源）；
 *   3. **最后才落盘**，且落盘前再调一次编排层的 `assertRunMutable`，位置在 `planRunUpdate`
 *      **之前**：规划器自己没有活性守卫，读的又是上面那一份快照，而行刚落终态、任务还在收尾的那一拍
 *      快照上确实「没有活」——按它规划出来的新快照会盖掉编排层正在写的那一份。
 *
 * 「使用智能体评分」的判定与创建**共用同一份**（`resolveJudgeRoute` 无参读全局默认 + `requireJudgeAgent`）：
 * 判据只有那一处，这里抄第二份必然漂移（评分阶段还会再校验一次，配置可能被改过）。
 * 指向的用例只取 `input.caseId` 那一份，`planRunUpdate` 的四格快照与换用例判定都由它来，
 * 故「行引用了一个这一轮并不拥有的用例」不需要另一条一致性检查。
 */
export function updateRun(runId: string, input: RunUpdate): EvalRun {
  const before = getRunSnapshot(runId);
  if (hasLiveRows(before)) {
    throw new ServiceError('CONFLICT', `这一轮还有候选行在运行（${runId}）：请先终止它，再修改`);
  }

  const testCase = getCase(input.caseId);
  const providers = listProviders();
  const settings = getSettings();
  if (input.useAgentJudge) {
    // 与 createRun 逐字同一份判定：智能体评分需要设置页那一格，而评分模型只有全局默认这一个来源
    const route = resolveJudgeRoute();
    requireJudgeAgent({ defaultJudgeAgent: settings.defaultJudgeAgent, route });
  }

  const resolved = resolveRunRows(input.rows, providers);
  assertRunMutable(runId);
  const next = planRunUpdate(before, input, resolved, {
    caseId: testCase.id,
    caseTitle: testCase.title,
    repoPath: testCase.repoPath,
    commitHash: testCase.commitHash,
    repoBranch: testCase.repoBranch ?? null,
    rubric: testCase.rubric,
  });

  saveRun(next);
  log.info('评测已修改', { runId, caseId: next.caseId, rows: next.rows.length, executionMode: next.executionMode });
  return next;
}

/**
 * 删除一轮评测（spec §5.3）：存在性检查 → 转编排层（那里才有在途任务表与产物路径）。
 * 为什么存在性检查在这里而不是只靠编排层：编排层的 `getRunForWrite` 有「按进程内记忆兜底」的
 * 分支，直接转过去的话，一个**别的根**下的同名轮次可能被解析到——而删除的语义是
 * 「删掉**当前工作区根里可见的这一轮**」（与读侧口径一致，R10）。
 */
export function deleteRun(runId: string): { workspaceRemoved: boolean } {
  getRunSnapshot(runId);
  const result = deleteRunInOrchestrator(runId);
  log.info('评测已删除', { runId, workspaceRemoved: result.workspaceRemoved });
  return result;
}
