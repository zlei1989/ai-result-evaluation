'use client';

/**
 * 设置页：三个 Tab —— 基础（模型供应商 / 界面主题 / 存储目录）/ 评分 / MCP。
 *
 * 本页是全仓唯一把 client hooks 与 ui 组件接起来的地方：组件保持纯展示（不调接口、不认识 message），
 * 数据与回调在这里注入；异步与错误提示也留在这里。
 *
 * 评分配置与存储目录都写同一个 `PUT /api/settings`：它们同属一份 Settings、同一次原子落盘，
 * 不为其中任一块单开路由。存储目录那格里两格根目录的「校验并保存」= `PUT { workspaceRoot }` / `PUT { casesRoot }`，
 * 服务端校验通过才落盘；用例同步的**状态**另走 `GET /api/cases/sync-status`（只读快照），
 * **动作**走 `POST /api/cases/sync`（跑完一轮才答复）。
 *
 * 注意：本页**没有渲染测试**—— `apps/web-next` 保留 `jsx: preserve`，该应用内不能写 `.tsx` 测试
 * （见 AGENTS.md）；`src/settings-page-wiring.test.ts` 那类守卫只读源码钉接线。因此页面逻辑必须薄到
 * 只剩「取值 → 传参 → 把 Promise 折成 message」：业务判断都在 ui 组件与 hooks 里，本页只负责接线
 * 与**三态分支**（就绪 / 仍在读 / 读失败）——组件 props 里没有 error 位（契约冻结），
 * 这三个状态只能由页面分，而「读失败」必须说出来，不能让「还没读到」冒充「你还没配」。
 * 验收靠 `pnpm typecheck` + `pnpm lint` + 冒烟。
 */
import { useEffect, useState } from 'react';
import {
  // 测试连接：无缓存的一次性 POST，两个入口各测一份（已保存的 / 表单当前值）
  probeMcpServer,
  useCaseSyncAction,
  useCaseSyncStatus,
  useCreateProvider,
  useDeleteProvider,
  useFetchProviderModels,
  useProviderModels,
  useProviders,
  useRunModelOptions,
  useSettings,
  useUpdateProvider,
} from '@aieval/client';
import type {
  CaseSyncAction,
  McpProbeResult,
  McpServerConfig,
  McpServers,
  ProviderModelCapability,
  ProviderPatch,
  ProviderView,
  SettingsPatch,
  ThemeMode,
} from '@aieval/contracts';
import {
  AppTopNav,
  JudgeSettingsCard,
  McpPasteModal,
  McpServerFormModal,
  McpServerTable,
  PageShell,
  ProviderFormModal,
  ProviderModelsModal,
  ProviderTable,
  WorkspaceSettingsCard,
  buildMcpConfig,
  removeServer,
  upsertServer,
  type McpServerFormValues,
  type McpServerRow,
  type ProviderFormValues,
} from '@aieval/ui';
import { Alert, Card, Flex, Form, Segmented, Skeleton, Tabs, message } from 'antd';
import { useRouter } from 'next/navigation';
import { NAV_ITEMS, type NavKey } from '@/src/nav';

/** 最近一次根目录校验的结果（工作区 / 用例目录共用一个形状）：null = 还没校验过；ok=false 时 message 是服务端的中文原因 */
interface RootValidation {
  root: string;
  ok: boolean;
  message?: string;
}

export default function Page(): React.ReactNode {
  const router = useRouter();
  // error 必须接住：读失败时 data 仍是 undefined，不区分「还在读」与「读失败」，
  // 界面会把一次网络故障说成「你还没配」甚至「你的默认评分模型已失效」（都是假结论）。
  const { settings, update, isUpdating, error: settingsError } = useSettings();
  const { providers, isLoading: providersLoading, error: providersError } = useProviders();
  const { create, isCreating } = useCreateProvider();
  // useUpdateProvider 的 update 在这里改名：settings 的 update 才是本页的主角，两个都叫 update 会撞名
  const { update: saveProvider, isUpdating: isSavingProvider } = useUpdateProvider();
  const { remove: removeProvider, isDeleting } = useDeleteProvider();
  const { fetchModels, isFetching } = useFetchProviderModels();
  // 不取 isMutating：模型清单的增删没有对应的「卡片级」加载态，弹窗里按按钮粒度给反馈即可
  const { add: addModel, remove: removeModel, setContext: setModelContext } = useProviderModels();
  // 评分卡要拿「智能体 → 协议」这张表来禁用协议不匹配的智能体。表只有服务端的注册表有真源，
  // 界面不许自己再抄一份，故从同一份注册表投影里取。
  // 取不到时不拦（空清单 = 每家协议都未知 = 一个都不禁用）：这一格的失败方向必须是「少拦一次」，
  // 而不是拿编出来的协议误禁用，服务端在创建与评分两处还有各自的校验兜着。
  const { options: agentOptions } = useRunModelOptions();

  /**
   * 供应商表单弹窗要**挂载后**才渲染：它内部是 antd `Modal` + `forceRender`（表单必须常挂 useForm
   * 实例，见 `provider-form-modal.tsx`），而它住在默认激活的「基础」Tab 里、会参与首屏 SSR——
   * 服务端渲染不出 Modal 的 portal 容器、客户端首帧却会渲染，于是每次打开设置页都报一条
   * hydration mismatch（React 之后会整棵重渲染，用户看不出，但控制台都是红的）。
   * 首帧两边都渲染 null 才一致：effect 跑完置 true，此后 Modal 常挂，`forceRender` 的语义不变；
   * 用户点开弹窗前必然已经挂载。
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [modalOpen, setModalOpen] = useState(false);
  // 弹窗模式**自己记**，不从「列表现取的结果」反推：编辑期间列表一刷新（别的标签页删除、CLI 改配置、
  // SWR 焦点重取），editing 就会变成 null，而 ProviderFormModal 是按 `initial !== null` 判断编辑态的 ——
  // 反推的话弹窗会当场翻成「添加供应商」、清掉用户输入，保存更会从 PUT 退化成 POST（凭空多一个供应商）。
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingId, setEditingId] = useState<string | null>(null);
  // 模型清单对话框用的是同一套「记 id，不记对象」的
  // 口径与同一条理由：增删模型 / 拉取之后列表会重取，对话框必须跟着刷新，而目标消失时要能看出来。
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsId, setModelsId] = useState<string | null>(null);
  const [validation, setValidation] = useState<RootValidation | null>(null);
  // 用例目录那一格的校验结果**独立一格**：两格共用一份会让「刚校验过工作区」把用例目录的结果顶掉
  const [casesValidation, setCasesValidation] = useState<RootValidation | null>(null);
  // 用例同步：状态是只读快照（不轮询），动作的成功/失败提示与缓存回写都在 hook 里
  const { status: syncStatus, error: syncError } = useCaseSyncStatus();
  const { run: runSync, isRunning: syncing } = useCaseSyncAction();

  /**
   * MCP 弹窗记的是**被编辑那条的名字**（不是对象）：名字住在 map 的键上，而列表每次刷新都会给出新对象。
   * 记对象会在刷新后与列表脱节；记名字则天然对上，且改名时正好用它当 `previousName`。
   */
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [editingMcpName, setEditingMcpName] = useState<string | null>(null);
  // 「粘贴 JSON」弹窗自己一格开关：它与表单弹窗**互斥**地开（两个弹窗叠着开只会互相挡，
  // 同供应商那张卡的处置）
  const [mcpPasteOpen, setMcpPasteOpen] = useState(false);
  // MCP 集合走同一份 `settings.mcpServers`；读不到时给空 map —— 界面这一侧**不替服务端播种**：
  // 配置文件里没有这个键时，预置两项由服务端的读盘路径（`normalizeSettings`）补上，
  // 页面再抄一份就等于「播种」有两个实现，而契约里那句「键缺失才播」会在界面这里悄悄变宽
  const mcpServers: McpServers = settings?.mcpServers ?? {};

  // 被编辑的那条从列表里现取：列表一刷新，弹窗里的字段跟着走（编辑的是哪一条由 editingId 记着）
  const editing = providers?.find((provider) => provider.id === editingId) ?? null;
  // 模型对话框的目标：null = 它已不在列表里（对话框自己会给一句可见原因）
  const modelsTarget = providers?.find((provider) => provider.id === modelsId) ?? null;

  /** 统一错误出口：服务端的 message 已是可直接展示的中文，别在这里再包一层 */
  const onError = (error: unknown): void => {
    void message.error(error instanceof Error ? error.message : String(error));
  };

  /**
   * GET 失败的呈现：SWR 的 error 就是 getJson 抛出的 ServiceError，message 已是服务端中文，页面不再包一层。
   * 为什么每个 GET 都必须有自己的错误出口（而不是让 data 为 undefined 自己说话）：
   * 供应商列表会退化成「还没有供应商」的空态引导（读起来像「你还没配」）；
   * 评分卡拿到空清单会对着完好的 defaultJudge 报「当前的默认评分模型已失效」（假结论）；
   * 设置读不出则永远停在 Skeleton 上，用户既等不到也没有任何解释。
   */
  const loadFailure = (error: unknown, subject: string): React.ReactNode => (
    <Alert
      type="error"
      showIcon
      title={`${subject}加载失败`}
      description={error instanceof Error ? error.message : String(error)}
    />
  );

  /** 未就绪时的占位：读失败给错误（带服务端中文原因），仍在读给骨架屏 —— 两者不能混为一谈 */
  const settingsPending =
    settingsError === undefined ? <Skeleton active /> : loadFailure(settingsError, '设置');
  const providersPending =
    providersError === undefined ? <Skeleton active /> : loadFailure(providersError, '模型供应商');

  const openCreate = (): void => {
    closeModels();
    setModalMode('create');
    setEditingId(null);
    setModalOpen(true);
  };
  const openEdit = (provider: ProviderView): void => {
    closeModels();
    setModalMode('edit');
    setEditingId(provider.id);
    setModalOpen(true);
  };
  const closeModal = (): void => {
    setModalOpen(false);
    setEditingId(null);
  };
  /** 「模型」按钮：打开清单对话框，并把编辑弹窗收起来 —— 两个弹窗叠着开只会互相挡 */
  const openModels = (provider: ProviderView): void => {
    closeModal();
    setModelsId(provider.id);
    setModelsOpen(true);
  };
  const closeModels = (): void => {
    setModelsOpen(false);
    setModelsId(null);
  };

  /**
   * 编辑态的目标在列表里查无此条时的统一处置（三个编辑态才可达的动作 + 保存都用它）：
   * 静默 return 会让用户「点了没反应」，而退化成 POST 更糟 —— 用户以为在改原来那条，结果凭空多一个供应商。
   */
  const reportTargetGone = (): void => {
    onError(new Error('这条供应商已不在列表里（可能已被删除或改名），请关闭弹窗后重新打开'));
  };

  /**
   * 保存供应商：新建走 POST，编辑走 PUT —— 走哪条**只看打开弹窗时记下的 mode**，不看列表现取的结果。
   * 编辑时密钥框留空 = 不修改：**空串绝不能下发**（ProviderPatchSchema 的 apiKey 是 min(1)，
   * 空串会被 zod 判成非法补丁；即便放过也会把用户的密钥抹成空）。
   */
  const submitProvider = (values: ProviderFormValues): void => {
    if (modalMode === 'create') {
      void create({
        name: values.name,
        protocolType: values.protocolType,
        baseUrl: values.baseUrl,
        apiKey: values.apiKey,
        models: [],
      }).then(closeModal, onError);
      return;
    }
    if (editing === null) {
      reportTargetGone();
      return;
    }
    const patch: ProviderPatch = {
      name: values.name,
      protocolType: values.protocolType,
      baseUrl: values.baseUrl,
    };
    if (values.apiKey !== '') patch.apiKey = values.apiKey;
    void saveProvider(editing.id, patch).then(closeModal, onError);
  };

  const deleteProvider = (provider: ProviderView): void => {
    void removeProvider(provider.id).catch(onError);
  };

  // 模型清单的四个动作（它们今天只从模型对话框发起；目标消失时不静默 return）
  const fetchProviderModels = (): void => {
    if (modelsTarget === null) {
      reportTargetGone();
      return;
    }
    void fetchModels(modelsTarget.id).catch(onError);
  };
  const addProviderModel = (modelId: string): void => {
    if (modelsTarget === null) {
      reportTargetGone();
      return;
    }
    void addModel(modelsTarget.id, modelId).catch(onError);
  };
  const removeProviderModel = (modelId: string): void => {
    if (modelsTarget === null) {
      reportTargetGone();
      return;
    }
    void removeModel(modelsTarget.id, modelId).catch(onError);
  };
  /**
   * 设置模型能力两格（窗口 / 输出上限）：两格都 `null` = 清空（服务端据此记住「用户手工改过」，
   * 下一次拉取不覆盖窗口）。与上面三个动作同口径：目标消失时不静默 return。
   */
  const setProviderModelContext = (modelId: string, capability: ProviderModelCapability): void => {
    if (modelsTarget === null) {
      reportTargetGone();
      return;
    }
    void setModelContext(modelsTarget.id, modelId, capability).catch(onError);
  };

  /**
   * 供应商 / MCP 两条列表之外的第五个动作口：**MCP 的增删改**
   * 保存语义：条目增删改都走弹窗的「确定」，提交时**整份**`settings.mcpServers` 走
   * `PUT /api/settings`（浅合并、整份替换，不做深合并）；只有开关是即时落盘。
   */
  const openMcpCreate = (): void => {
    closeMcpPaste();
    setEditingMcpName(null);
    setMcpModalOpen(true);
  };
  const openMcpEdit = (row: McpServerRow): void => {
    closeMcpPaste();
    setEditingMcpName(row.name);
    setMcpModalOpen(true);
  };
  const closeMcpModal = (): void => {
    setMcpModalOpen(false);
    setEditingMcpName(null);
  };

  /** 「粘贴 JSON」：先把表单弹窗收起来（同供应商卡片的 `openModels`，两个弹窗叠着开只会互相挡） */
  const openMcpPaste = (): void => {
    closeMcpModal();
    setMcpPasteOpen(true);
  };
  const closeMcpPaste = (): void => {
    setMcpPasteOpen(false);
  };

  /**
   * 粘贴导入的落盘：弹窗交出的已经是**算好的整份 map**（覆盖 / 跳过 / 先清空都在它内部定了），
   * 页面这一层只做**一次** `PUT { mcpServers }`，不再合并第二次 —— 再合并一次的话
   * 「预览说导入 3 台、落盘 4 台」这类偏差会重新出现（而那正是预览这道工序要消灭的东西）。
   */
  const submitMcpPaste = (next: McpServers): void => {
    void update({ mcpServers: next }).then(closeMcpPaste, onError);
  };

  /**
   * 保存一条（新增或编辑）：表单值 → 契约条目由 `buildMcpConfig` 做（与组件共用同一份语义）。
   * `enabled` 沿用**当前那条**的值：表单里没有启停这一格（它在表格的开关上即时改），
   * 而 `buildMcpConfig` 给出的是新条目的缺省 true —— 直接用会把用户停用的那条悄悄打开。
   * 新建时没有「当前那条」，才用缺省的 true。
   *
   * `current` 还兼任 `buildMcpConfig` 的第二个参数（**同一条**，别分两次取）：值格留空时，
   * 只有「这一格原来就在」的行才交空串（服务端据此认「未改动」并换回落盘原值）——不喂的话那些行被
   * 整条丢掉，于是「打开编辑弹窗、一个字不改直接保存」就把原密钥从补丁里删掉了（`mcpServers` 是整份替换）。
   */
  const submitMcpServer = (values: McpServerFormValues): void => {
    const current: McpServerConfig | undefined = mcpServers[editingMcpName ?? values.name];
    const built = buildMcpConfig(values, current);
    const config: McpServerConfig = { ...built, enabled: current?.enabled ?? built.enabled };
    void update({ mcpServers: upsertServer(mcpServers, editingMcpName, values.name, config) }).then(
      closeMcpModal,
      onError,
    );
  };

  /** 单项启停：即时落盘（与「自动提交」开关同口径，不做乐观翻转——失败时保持原值并说出来） */
  const toggleMcpServer = (name: string, enabled: boolean): void => {
    const entry = mcpServers[name];
    if (entry === undefined) {
      onError(new Error('这条 MCP 服务器已不在列表里（可能已被删除），请刷新后重试'));
      return;
    }
    void update({ mcpServers: upsertServer(mcpServers, null, name, { ...entry, enabled }) }).catch(onError);
  };

  const deleteMcpServer = (row: McpServerRow): void => {
    void update({ mcpServers: removeServer(mcpServers, row.name) }).catch(onError);
  };

  /**
   * 测试连接——两个入口各测一份，**都不写盘**：
   *   · 行内：`{ name }`，服务端读**已保存**的那份（表格里显示的就是它）；
   *   · 表单：`{ entry }`，用**当前表单值**（还没保存的输入），保存仍然只由「保存」按钮触发。
   * 探活的 loading 与结果状态留在两个组件内部（逐行逐弹窗），这一层只负责把请求接上。
   *
   * 表单那条的 `enabled` 沿用被编辑那条的值（与 `submitMcpServer` 同口径）：表单里没有启停这一格，
   * 而 `buildMcpConfig` 给的是缺省 true —— 直接用会把「已停用，不会注入」这条结论说反。
   */
  const testMcpServer = (row: McpServerRow): Promise<McpProbeResult> => probeMcpServer({ name: row.name });

  /**
   * 表单入口**刻意不**把 `current` 喂给 `buildMcpConfig`（与保存那条不同）：探活拿的是**要发出去的**
   * 那一份，而「留空 = 不修改」只在落盘那一跳成立——探活里交空串会把一个空值的请求头发给上游，
   * 换回一句「需要鉴权」，比这里少一个头发出去更容易看错。要测带密钥的那一份就用行内入口（读已保存的配置）。
   */
  const testMcpForm = (values: McpServerFormValues): Promise<McpProbeResult> => {
    const built = buildMcpConfig(values);
    const current: McpServerConfig | undefined = mcpServers[editingMcpName ?? values.name];
    return probeMcpServer({ entry: { ...built, enabled: current?.enabled ?? built.enabled } });
  };

  const changeSettings = (patch: SettingsPatch): void => {
    void update(patch).catch(onError);
  };

  /**
   * 工作区「校验并保存」：一次 `PUT { workspaceRoot }`，服务端校验通过才落盘。
   * 用 then 的两个参数而不是 try/catch：失败既不吞掉、也不留下未处理的 rejection，
   * 结果交给卡片展示（失败时卡片会保留用户输入）。
   */
  const validateWorkspace = (root: string): void => {
    update({ workspaceRoot: root }).then(
      (next) => setValidation({ root: next.workspaceRoot, ok: true }),
      (error: unknown) =>
        setValidation({ root, ok: false, message: error instanceof Error ? error.message : String(error) }),
    );
  };

  /**
   * 用例目录「校验并保存」：与工作区那一格**逐字同一套**（`PUT { casesRoot }`，服务端校验通过才落盘）。
   * 结果记进独立那一格：两格共用一份 state 会让「刚校验过工作区」把用例目录的结果顶掉，
   * 而两格的可访问名一样，界面上分不出哪条结论属于哪一格。
   */
  const validateCasesRoot = (root: string): void => {
    update({ casesRoot: root }).then(
      (next) => setCasesValidation({ root: next.casesRoot, ok: true }),
      (error: unknown) =>
        setCasesValidation({ root, ok: false, message: error instanceof Error ? error.message : String(error) }),
    );
  };

  /**
   * 自动提交开关：直接落盘（`PUT { casesAutoCommit }`）。
   * 不做乐观翻转——开关的 `checked` 读的是 `settings.casesAutoCommit`，失败时保持原值，
   * 而失败原因由 `onError` 说出来：翻转了再翻回去会让用户以为是自己点错了。
   */
  const toggleAutoCommit = (value: boolean): void => {
    void update({ casesAutoCommit: value }).catch(onError);
  };

  /**
   * 用例同步的人工动作（提交 / 拉取）。`run` 等到服务端跑完才 settle：结果提示按**跑完之后**的快照说话
   * ——「提交完了」与「还剩 N 个没提交」是两句话，不能都报成功。
   * 失败走统一的 `onError`（服务端已给中文原因，这里不再包一层）。
   */
  const runSyncAction = (action: CaseSyncAction): void => {
    void runSync(action).then(
      (next) => {
        if (next.pendingCount > 0) {
          void message.success(`同步已完成；仍有 ${next.pendingCount} 个用例文件待提交`);
        } else {
          void message.success(action === 'commit' ? '用例变更已提交' : '已与远端对齐');
        }
      },
      onError,
    );
  };

  const activeNav: NavKey = 'settings';

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active={activeNav} onNavigate={(href) => router.push(href)} />
      <PageShell density="default" gap={16} padding={16}>
        <Tabs
          items={[
            {
              key: 'basic',
              // 基础 = 「开始评测之前先配一次」的三块，按配的先后排：模型从哪来（供应商）、
              // 这块界面长什么样（主题）、评测产物落哪（存储目录）
              label: '基础',
              children: (
                <Flex vertical gap={12}>
                  {/* 读失败必须显式说清：ProviderTable 的 props 是按契约冻结的（没有 error 位），
                      少了这条 Alert，一次 GET 失败在界面上就是「还没有供应商」—— 假结论 */}
                  {providersError !== undefined && loadFailure(providersError, '模型供应商')}
                  <ProviderTable
                    providers={providers ?? []}
                    loading={providersLoading || isDeleting}
                    onCreate={openCreate}
                    onModels={openModels}
                    onEdit={openEdit}
                    onDelete={deleteProvider}
                  />
                  {/* 挂载后才渲染（见 mounted 的注释）：SSR 与客户端首帧都渲染 null，Modal 的 portal
                      才不会撞出 hydration mismatch */}
                  {mounted && (
                    <ProviderFormModal
                      open={modalOpen}
                      initial={editing}
                      saving={isCreating || isSavingProvider}
                      onSubmit={submitProvider}
                      onCancel={closeModal}
                    />
                  )}
                  <ProviderModelsModal
                    open={modelsOpen}
                    provider={modelsTarget}
                    fetchingModels={isFetching}
                    onClose={closeModels}
                    onFetchModels={fetchProviderModels}
                    onAddModel={addProviderModel}
                    onRemoveModel={removeProviderModel}
                    onSetModelContext={setProviderModelContext}
                  />
                  <Card title="界面主题" size="small" data-testid="theme-card">
                    {settings ? (
                      <Form layout="vertical" size="small" component={false}>
                        <Form.Item label="主题偏好" style={{ marginBottom: 0 }}>
                          <Segmented
                            data-testid="theme-segmented"
                            size="small"
                            value={settings.theme}
                            options={[
                              { label: '跟随系统', value: 'auto' },
                              { label: '明亮', value: 'light' },
                              { label: '暗色', value: 'dark' },
                            ]}
                            onChange={(value) => void update({ theme: value as ThemeMode }).catch(onError)}
                          />
                        </Form.Item>
                      </Form>
                    ) : (
                      settingsPending
                    )}
                  </Card>
                  {/* 存储目录：两格根目录 + 自动提交开关 + 同步状态与两个动作全部由一张卡承担。
                      同步状态读不出来必须显式说清 —— 卡片的 props 里没有 error 位（契约冻结），
                      少了这条 Alert，一次 GET 失败就只剩一个永远转不完的骨架屏 */}
                  {settings ? (
                    <Flex vertical gap={12}>
                      {syncError !== undefined && loadFailure(syncError, '用例同步状态')}
                      <WorkspaceSettingsCard
                        settings={settings}
                        saving={isUpdating}
                        lastValidated={validation}
                        onValidate={validateWorkspace}
                        onValidateCasesRoot={validateCasesRoot}
                        lastValidatedCases={casesValidation}
                        onToggleAutoCommit={toggleAutoCommit}
                        syncStatus={syncStatus}
                        syncError={syncError}
                        syncing={syncing}
                        onSyncAction={runSyncAction}
                      />
                    </Flex>
                  ) : (
                    settingsPending
                  )}
                </Flex>
              ),
            },
            {
              key: 'judge',
              // Tab 名「评分」说的是动作（这一页决定怎么评），卡片标题仍叫「评分配置」——那说的是配置本身
              label: '评分',
              // 评分卡要的是**已保存的**清单：只有拿到它才能判 defaultJudge 是否悬空。
              // 清单没到时不能拿 `?? []` 顶替 —— 空清单会被卡片读成「供应商或模型被删了」，
              // 对着完好的 defaultJudge 报一条红色的失效告警（假消息）。等或报错，二者选一。
              children: settings ? (
                providers ? (
                  <JudgeSettingsCard
                    settings={settings}
                    providers={providers}
                    agentProtocols={(agentOptions ?? []).map((group) => ({
                      agentKind: group.agentKind,
                      protocolTypes: group.protocolTypes,
                      // 档位域要用它（同一个注册表投影，不新增端点）：评分卡片靠它把「思考强度」的候选
                      // 交到「模型声明 ∩ 这家智能体的域」上——漏这一格，候选会退化成规范五档，
                      // 而 dsh 收不了 medium（界面上能存、生成 / 识别时被硬拒）
                      efforts: group.efforts,
                    }))}
                    saving={isUpdating}
                    onChange={changeSettings}
                  />
                ) : (
                  providersPending
                )
              ) : (
                settingsPending
              ),
            },
            {
              key: 'mcp',
              // 第 3 个 Tab，排在最后：基础与评分是日常要动的两处，MCP 是「接入外部能力」的配置，
              // 配一次就很少再进来。顺序即导航路径，别随手调
              // （`settings-page-wiring.test.ts` 有守卫钉着）
              label: 'MCP',
              children: settings ? (
                <Flex vertical gap={12}>
                  {/* 与仓库自带条目的关系那条**静态说明**（spec §3）**已移进卡片**：落点是 `McpServerTable`
                      表格上方那一行（`data-testid="mcp-priority-note"`，`Typography.Text type="secondary"`）。
                      为什么不再摆页面这一层：它说的是这张卡片里这些条目的事，摆在页面层会读成「在说整个设置页」，
                      而规格要求的落点本来就是「卡片头部」。
                      ⚠️ **别在这里再印一份**：两处都印就是两处真源，措辞迟早漂移成两句不同的话 */}
                  <McpServerTable
                    servers={mcpServers}
                    loading={isUpdating}
                    onToggle={toggleMcpServer}
                    onEdit={openMcpEdit}
                    onDelete={deleteMcpServer}
                    onCreate={openMcpCreate}
                    onPasteJson={openMcpPaste}
                    onTest={testMcpServer}
                  />
                  <McpServerFormModal
                    open={mcpModalOpen}
                    initialName={editingMcpName}
                    // 目标从当前集合里现取：弹窗开着时列表一刷新（别的标签页删了它），这里跟着变 null，
                    // 而 `initialName` 仍记着那个名字 —— 保存会走 upsert 把旧键挪走（不静默失联）
                    initial={editingMcpName === null ? null : (mcpServers[editingMcpName] ?? null)}
                    servers={mcpServers}
                    saving={isUpdating}
                    onSubmit={submitMcpServer}
                    onCancel={closeMcpModal}
                    onTest={testMcpForm}
                  />
                  {/* 粘贴导入：贴进去 → 预览 → 确认。弹窗自己算好整份 map，页面只落盘一次（见 submitMcpPaste） */}
                  <McpPasteModal
                    open={mcpPasteOpen}
                    servers={mcpServers}
                    saving={isUpdating}
                    onImport={submitMcpPaste}
                    onCancel={closeMcpPaste}
                  />
                </Flex>
              ) : (
                settingsPending
              ),
            },
          ]}
        />
      </PageShell>
    </>
  );
}
