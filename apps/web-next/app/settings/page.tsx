'use client';

/**
 * 设置页：四个 Tab —— 界面主题 / 模型供应商 / 评分配置 / 工作区。
 *
 * 本页是全仓唯一把 client hooks 与 ui 组件接起来的地方：组件保持纯展示（不调接口、不认识 message），
 * 数据与回调在这里注入；异步与错误提示也留在这里。
 *
 * 评分配置与工作区都写同一个 `PUT /api/settings`：它们同属一份 Settings、同一次原子落盘，
 * 不为其中任一块单开路由。工作区的「校验并保存」= `PUT { workspaceRoot }`，服务端校验通过才落盘（§6.3）。
 *
 * 注意：本页**没有自动化测试** —— `apps/web-next` 保留 `jsx: preserve`，该应用内不能写 `.tsx` 测试
 * （见 AGENT.md）。因此页面逻辑必须薄到只剩「取值 → 传参 → 把 Promise 折成 message」：
 * 业务判断都在 ui 组件与 hooks 里，本页只负责接线与**三态分支**（就绪 / 仍在读 / 读失败）——
 * 组件 props 里没有 error 位（契约冻结），这三个状态只能由页面分，而「读失败」必须说出来，
 * 不能让「还没读到」冒充「你还没配」。验收靠 `pnpm typecheck` + `pnpm lint` + p6 冒烟。
 */
import { useState } from 'react';
import {
  useCreateProvider,
  useDeleteProvider,
  useFetchProviderModels,
  useProviderModels,
  useProviders,
  useRunModelOptions,
  useSettings,
  useUpdateProvider,
} from '@aieval/client';
import type { ProviderModelCapability, ProviderPatch, ProviderView, SettingsPatch, ThemeMode } from '@aieval/contracts';
import {
  AppTopNav,
  JudgeSettingsCard,
  PageShell,
  ProviderFormModal,
  ProviderModelsModal,
  ProviderTable,
  WorkspaceSettingsCard,
  type ProviderFormValues,
} from '@aieval/ui';
import { Alert, Card, Flex, Form, Segmented, Skeleton, Tabs, message } from 'antd';
import { useRouter } from 'next/navigation';
import { NAV_ITEMS, type NavKey } from '@/src/nav';

/** 最近一次工作区校验的结果：null = 还没校验过；ok=false 时 message 是服务端的中文原因 */
interface WorkspaceValidation {
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
  // 界面按 §11 R1 不许自己再抄一份，故从同一份注册表投影里取。
  // 取不到时不拦（空清单 = 每家协议都未知 = 一个都不禁用）：这一格的失败方向必须是「少拦一次」，
  // 而不是拿编出来的协议误禁用，服务端在创建与评分两处还有各自的校验兜着。
  const { options: agentOptions } = useRunModelOptions();

  const [modalOpen, setModalOpen] = useState(false);
  // 弹窗模式**自己记**，不从「列表现取的结果」反推：编辑期间列表一刷新（别的标签页删除、CLI 改配置、
  // SWR 焦点重取），editing 就会变成 null，而 ProviderFormModal 是按 `initial !== null` 判断编辑态的 ——
  // 反推的话弹窗会当场翻成「添加供应商」、清掉用户输入，保存更会从 PUT 退化成 POST（凭空多一个供应商）。
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingId, setEditingId] = useState<string | null>(null);
  // 模型清单对话框（用户口径 2026-09-30：它从编辑弹窗里单独提出来了）用的是同一套「记 id，不记对象」的
  // 口径与同一条理由：增删模型 / 拉取之后列表会重取，对话框必须跟着刷新，而目标消失时要能看出来。
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsId, setModelsId] = useState<string | null>(null);
  const [validation, setValidation] = useState<WorkspaceValidation | null>(null);

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

  const changeSettings = (patch: SettingsPatch): void => {
    void update(patch).catch(onError);
  };

  /**
   * 工作区「校验并保存」：一次 `PUT { workspaceRoot }`，服务端校验通过才落盘（§6.3）。
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

  const activeNav: NavKey = 'settings';

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active={activeNav} onNavigate={(href) => router.push(href)} />
      <PageShell density="default" gap={16} padding={16}>
        <Tabs
          items={[
            {
              key: 'theme',
              label: '界面主题',
              children: (
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
              ),
            },
            {
              key: 'providers',
              label: '模型供应商',
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
                  <ProviderFormModal
                    open={modalOpen}
                    initial={editing}
                    saving={isCreating || isSavingProvider}
                    onSubmit={submitProvider}
                    onCancel={closeModal}
                  />
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
                </Flex>
              ),
            },
            {
              key: 'judge',
              label: '评分配置',
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
              key: 'workspace',
              label: '工作区',
              children: settings ? (
                <WorkspaceSettingsCard
                  settings={settings}
                  saving={isUpdating}
                  lastValidated={validation}
                  onValidate={validateWorkspace}
                />
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
