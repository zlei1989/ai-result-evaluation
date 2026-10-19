'use client';

/**
 * 用例页：左栏列表 + 右栏（详情 / 创建表单 / 编辑表单）。
 *
 * 右栏三种内容**共用一个栏位**，由 `?panel=detail|new|edit&id=…` 决定（不叠加、不弹层）。
 * 把状态放进 URL 换来两件事：刷新后还在这一屏、链接可以直接发给别人；代价是右栏的
 * 「这一次编辑」的临时状态（`validatedRepo` / `currentRepo` / `repoInfo` 三格）必须在切换面板时复位——
 * 留在那里会把上一个用例的校验结果显示给下一个用例，让人以为新用例也校验过了。
 * 评分标准项**不在**这份清单里：它的真源是表单自己，靠面板重挂载 + `initialValues` 复位（见 `go()` 里的注释）。
 *
 * 为什么整块内容包在 `<Suspense>` 里：`useSearchParams` 会让最近的 Suspense 边界退化成客户端渲染，
 * Next 16 的生产构建在缺少边界时直接以「Missing Suspense boundary with useSearchParams」失败
 * （apps/web-next/node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md）。
 */
import {
  matchesCommitsKey,
  useCases,
  useCommitCandidates,
  useCreateCase,
  useDeleteCase,
  useGenerateRubric,
  useProviders,
  useSettings,
  useTestCase,
  useUpdateCase,
  useValidateRepo,
} from '@aieval/client';
import {
  type CaseCreate,
  type GenerateRubricInput,
  type GenerateRubricResult,
  type RepoInfo,
  type TestCase,
} from '@aieval/contracts';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AppTopNav,
  Button,
  Card,
  CardContent,
  CaseDetailPanel,
  CaseFormPanel,
  CasesTable,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  ListDetailLayout,
  PageHeader,
  Skeleton,
  toast,
  requestCommandPalette,
} from '@aieval/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';
import { resolveCasePanel, type PanelKind } from '@/src/case-panel-state';
import {
  candidatesQueryFor,
  isValidationCurrent,
  normalizeSelection,
  type RepoSelection,
} from '@/src/case-repo-validation';
import { isJudgeConfigured } from '@/src/judge-gate';
import { NAV_ITEMS, type NavKey } from '@/src/nav';
import { usePageTitle } from '../use-page-title';

const ACTIVE_NAV: NavKey = 'cases';

export default function Page(): React.ReactNode {
  return (
    <Suspense fallback={<CasesFallback />}>
      <CasesWorkspace />
    </Suspense>
  );
}

/** 预渲染期的兜底：只画壳与占位，**不读 search params**（读它正是需要 Suspense 的原因） */
function CasesFallback(): React.ReactNode {
  const router = useRouter();
  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active={ACTIVE_NAV} onNavigate={(href) => router.push(href)} onSearch={requestCommandPalette} />
      <Card size="sm" className="m-4">
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    </>
  );
}

/**
 * 空态：一句说清「用例是什么」的说明 + 一个引导动作。
 * 空列表是新用户唯一会看到的界面，只写「暂无数据」而不给出路，等于让人自己猜下一步。
 */
function CasesEmpty({ onCreate }: { onCreate: () => void }): React.ReactNode {
  return (
    <Empty className="flex-1 border">
      <EmptyHeader>
        <EmptyTitle>还没有用例</EmptyTitle>
        <EmptyDescription>用例 = 仓库 + 提交 + 考题提示词，是评测的输入</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onCreate}>
          创建用例
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** 右栏的空态：与列表空态同形，只是文案按场景换 */
function PanelEmpty({
  title,
  description,
  onCreate,
}: {
  title: string;
  description: string;
  onCreate?: () => void;
}): React.ReactNode {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {onCreate !== undefined && (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onCreate}>
            创建用例
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

/** URL → 右栏状态；非法值一律当「不显示右栏」，不抛错（链接可能被人手改） */
function readPanel(raw: string | null): PanelKind | null {
  return raw === 'detail' || raw === 'new' || raw === 'edit' ? raw : null;
}

/** 错误 → 可展示文案：ServiceError 的 message 已经是中文，其余情况兜底成 String(error) */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CasesWorkspace(): React.ReactNode {
  usePageTitle('用例');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { mutate: mutateCache } = useSWRConfig();

  const panel = readPanel(searchParams.get('panel'));
  const id = searchParams.get('id');
  const caseIdForQuery = panel === 'detail' || panel === 'edit' ? id : null;

  const { cases, warnings, error: listError } = useCases();
  const { testCase, error: caseError } = useTestCase(caseIdForQuery);
  const { create, isCreating } = useCreateCase();
  const { update, isUpdating } = useUpdateCase();
  const { remove, isDeleting } = useDeleteCase();
  const { validate, isValidating } = useValidateRepo();
  const { generate, isGenerating } = useGenerateRubric();
  const { providers } = useProviders();
  const { settings } = useSettings();
  // 未配置评分模型时「智能生成 / 智能识别」两个按钮都必须禁用。判定本身（**拿全局默认那一对 id 对着 providers 解析**，
  //）抽在 src/judge-gate.ts：本页没有自动化测试面，决策留在页面里就等于没有守卫。
  // 只看全局默认：用例上不再有评分模型覆盖（表单里那一格已删除），服务端 `resolveJudgeRoute()` 同样无参。
  const judgeConfigured = isJudgeConfigured(settings, providers);

  /**
   * 已校验通过的**那一对**（来源 + 分支）：commit 候选按它取（按来源，不带 caseId；远端另带分支）。
   * 三个决策（记什么 / 什么时候还算数 / 递给候选什么）都在 `@/src/case-repo-validation` 里，
   * 本页只接线——页面没有测试面，决策留在页面里就等于没有守卫。
   */
  const [validatedRepo, setValidatedRepo] = useState<RepoSelection | null>(null);
  /** 表单当前选中的来源（面板上报的归一值）：判断上一次校验是否还作数的另一半 */
  const [currentRepo, setCurrentRepo] = useState<RepoSelection>({ repoPath: '', repoBranch: null });
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const candidatesQuery = candidatesQueryFor(validatedRepo, currentRepo);
  // `isLoading` 必须交到面板上：远端首访的候选会真的克隆（镜像还没建时），克隆期间整个进程阻塞
  //，按钮上那句「正在拉取远端仓库…」就是那段时间里唯一的反馈
  const { commits, isLoading: commitsLoading } = useCommitCandidates(candidatesQuery.repoPath, candidatesQuery.repoBranch);
  /**
   * 交给面板的回显：只在「当前输入 == 校验过的那一对」时给。
   * 面板内部也会比一次（它不能显示自己没校验过的输入的回显），这里是页面这一侧的同一条口径——
   * 任何一侧漏掉分支那一半，用户就会看到「分支：feat/x」而输入框里已经是别的分支。
   */
  const echoInfo = isValidationCurrent(validatedRepo, currentRepo) ? repoInfo : null;

  /**
   * 切换右栏：状态只存在 URL 里，同时复位「属于这一次编辑」的临时状态（见文件头）。
   */
  const go = useCallback(
    (next: { panel: PanelKind | null; id?: string }): void => {
      setValidatedRepo(null);
      setCurrentRepo({ repoPath: '', repoBranch: null });
      setRepoInfo(null);
      // 评分标准项**不在这里复位**：它的真源是表单自己（`rubric` 那一格），
      // 而面板的 key 是按用例给的（`case-edit-${id}` / `case-new`）——切用例即重挂载，
      // `defaultValues` 会重新播一次种。在页面里再存一份「当前表格」只会多出一份必然漂移的副本。
      const params = new URLSearchParams();
      if (next.panel !== null) params.set('panel', next.panel);
      if (next.id !== undefined) params.set('id', next.id);
      const query = params.toString();
      router.push(query === '' ? '/cases' : `/cases?${query}`);
    },
    [router],
  );

  /**
   * 校验仓库：成功才记下来源（commit 候选按它取）；失败原因在这里统一提示，并把错误抛回面板。
   *
   * 记的是**发出去的那一对**（面板已经归一过，这里再归一一次是幂等的）：回显与候选都要与
   * 面板上报的「当前输入」比较，两边同口径才比得动——拿服务端回显的归一路径去比会永远不相等
   * （远端 URL 去掉尾斜杠之后与输入框原文不同），症状是「校验成功了，回显与候选却都不出现」。
   */
  const handleValidateRepo = async (input: { repoPath: string; repoBranch: string | null }): Promise<RepoInfo> => {
    try {
      const info = await validate(input);
      setRepoInfo(info);
      setValidatedRepo(normalizeSelection(input));
      return info;
    } catch (error) {
      void toast.error(errorMessage(error));
      // 失败的校验不得留下上一次的成功回显
      setRepoInfo(null);
      setValidatedRepo(null);
      throw error;
    }
  };

  /** 表单里的来源变了（面板上报）：候选与回显是否还作数由上面的纯函数判，这里只存下来 */
  const handleRepoSelectionChange = useCallback((selection: RepoSelection): void => {
    setCurrentRepo(selection);
  }, []);

  /**
   * 生成 / 识别评分标准项：提示文案在这里统一给，**回填表格由面板做**（它才是表格的持有者）。
   * 失败提示原因并把错误抛回面板（面板据此不改表格）。
   *
   * `note` 与 `addedItems` 只在**生成**分支有意义（识别分支 `addedItems` 恒为 0，见 `GenerateRubricResult`）：
   * 识别成功了却弹一句「已新增 0 项」是错的——那段文案属于生成侧，识别侧只该闭嘴。
   */
  const handleGenerate = async (input: GenerateRubricInput): Promise<GenerateRubricResult> => {
    try {
      const generated = await generate(input);
      // 提示只在**该说的时候**说：调整分支的产出是弹窗里那份改动清单（页面再弹一句「已新增 0 项」是错的），
      // 它只有 note（「模型认为不需要修改」）值得转达；生成分支照旧在真的补了条目时报数
      if (generated.note !== undefined) void toast.info(generated.note);
      else if (input.mode === 'generate' && generated.addedItems > 0) {
        void toast.success(`已新增 ${generated.addedItems} 项`);
      }
      return generated;
    } catch (error) {
      void toast.error(errorMessage(error));
      throw error;
    }
  };

  /** 重新加载候选提交：用户刚在仓库里提交了代码，想让新提交出现在候选里 */
  const reloadCommits = useCallback((): void => {
    // 没有「当前输入对应的一次校验」就没有候选可重取（改了输入而没重新校验时同理）
    if (candidatesQuery.repoPath === null) return;
    // 按 key 前缀过滤重取（而不是复刻 hook 内部的 key 形状）：候选按「来源 + 分支」缓存，
    // SWR 默认去重不会因为再点一次就重取，所以这里显式 revalidate。
    // 过滤器仍然只看 key 的**第一段**（`matchesCommitsKey`）：分支是第几段由 client 包决定，
    // 页面不该知道——本页再写一份 URL 字面量一旦漂移，过滤器就匹配不到任何 cache key，
    // 症状是「点了没反应」，一个请求都不发、也不报错。
    void mutateCache(matchesCommitsKey, undefined, { revalidate: true });
  }, [mutateCache, candidatesQuery.repoPath]);

  const handleSubmit = (values: CaseCreate): void => {
    if (panel === 'edit' && id !== null) {
      void update(id, values)
        .then(() => {
          void toast.success('用例已保存');
          go({ panel: 'detail', id });
        })
        .catch((error: unknown) => void toast.error(errorMessage(error)));
      return;
    }
    void create(values)
      .then((created) => {
        void toast.success('用例已创建');
        go({ panel: 'detail', id: created.id });
      })
      .catch((error: unknown) => void toast.error(errorMessage(error)));
  };

  /**
   * 删除用例。**必须把在途的 promise 交回确认条**：详情面板要等它结束才收起确认条，
   * 返回 undefined（`() => { void remove(id) }`）会让确认条在请求落地前就消失——用户看到的是
   * 「点一下就没反应」，再点一次就是第二次 DELETE。
   * 受影响评测数来自 DELETE 的响应（契约里没有「按用例查评测数」的路由）：
   * 数字在这里回显，删除本身不阻塞。
   */
  const handleDelete = (): Promise<void> | undefined => {
    if (id === null) return undefined;
    return remove(id)
      .then((result) => {
        void toast.success(
          result.affectedRuns === 0
            ? '用例已删除'
            : `用例已删除；${result.affectedRuns} 个评测记录的冗余快照仍可查看`,
        );
        go({ panel: null });
      })
      // 失败要在这里收束：把 reject 交回确认条只会在控制台留一条未处理的 rejection，
      // 用户已经在 toast.error 里拿到了中文原因
      .catch((error: unknown) => void toast.error(errorMessage(error)));
  };

  const listNode = (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* 与 /runs 同形：页标题 24 / 描述 14 + muted，动作靠右；不跟密度档（见 PageHeader 文件头） */}
      <PageHeader
        title="用例"
        description={
          cases === undefined ? '正在加载…' : `共 ${cases.length} 份 · 用例 = 仓库 + 提交 + 考题提示词`
        }
        actions={
          <Button size="sm" data-testid="cases-create" onClick={() => go({ panel: 'new' })}>
            <span aria-hidden>+</span>
            创建用例
          </Button>
        }
      />
      {/* `!= null` 一次挡住 undefined 与 null：SWR 用 undefined 表示「没有错误」，写法越多越容易漏掉一个 */}
      {listError != null && (
        <Alert variant="destructive" className="mb-1" data-testid="cases-error">
          <AlertTitle>用例列表读不出来：{errorMessage(listError)}</AlertTitle>
          <AlertDescription>列表显示的可能还是上一次读到的内容；刷新页面会重新请求。</AlertDescription>
        </Alert>
      )}
      {/* 用例一文件一落后，坏文件是**跳过**的（一条坏文件不能让整页列表 500）。跳过而不说，
          用户的症状是「我的用例不见了」却查不到原因——这条例外清单就是那句话的唯一出口 */}
      {warnings.length > 0 && (
        <Alert
          data-testid="cases-warnings"
          className="mb-1 border-warning/40 bg-warning/10 [&_[data-slot=alert-title]]:text-warning"
        >
          <AlertTitle>有 {warnings.length} 个用例文件被跳过，这些用例没有显示出来</AlertTitle>
          <AlertDescription>{warnings.join('；')}</AlertDescription>
        </Alert>
      )}
      {cases === undefined ? (
        <Card size="sm">
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : cases.length === 0 ? (
        <CasesEmpty onCreate={() => go({ panel: 'new' })} />
      ) : (
        // 滚动容器在表格套件里（工具栏不跟着滚走）；外框与 /runs 同形，
        // 主标识列由 `fillColumnId` 吃掉剩余宽度，表格不再只占左边一段
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
          <CasesTable
            cases={cases}
            selectedId={caseIdForQuery}
            onSelect={(caseId) => go({ panel: 'detail', id: caseId })}
          />
        </div>
      )}
    </div>
  );

  /**
   * 右栏渲染什么由 `resolveCasePanel` 决定（纯函数 + 有测试面，见 src/case-panel-state.ts）。
   * 其中一条最容易写错：「详情刷新失败」不等于「用例不存在」——只要手上还有上一次成功读到的用例，
   * 就必须继续渲染它（另加一条非破坏性提示）。原先这里把任何详情错误都当成「用例不存在」，
   * 于是一次 500 / 网络抖动就会把用户正在编辑的表单整个卸载掉，输入一起没。
   */
  const panelView = resolveCasePanel({ panel, id, testCase, caseError });

  const renderPanel = (): React.ReactNode => {
    const sharedFormProps = {
      judgeConfigured,
      saving: isCreating || isUpdating,
      generating: isGenerating,
      validating: isValidating,
      loadingCommits: commitsLoading,
      commits: commits ?? [],
      repoInfo: echoInfo,
      onSubmit: handleSubmit,
      onCancel: () => go({ panel: null }),
      onValidateRepo: handleValidateRepo,
      onRepoSelectionChange: handleRepoSelectionChange,
      onGenerate: handleGenerate,
      onLoadCommits: reloadCommits,
    };

    /** 详情 / 编辑共用同一段渲染：`stale` 分支也必须走这里，换一条渲染路径等于把表单卸载掉 */
    const renderCase = (target: TestCase, kind: 'detail' | 'edit'): React.ReactNode => {
      if (kind === 'edit') {
        // key 带上 id：表单的 `defaultValues` 只在挂载时读一次，切换用例必须重挂载
        return <CaseFormPanel key={`case-edit-${target.id}`} mode="edit" initial={target} {...sharedFormProps} />;
      }
      return (
        <CaseDetailPanel
          testCase={target}
          // 拿不到删前的引用数（契约里没有对应路由）；数字在删除成功的提示里回显
          referencedRuns={null}
          onEdit={() => go({ panel: 'edit', id: target.id })}
          onDelete={handleDelete}
          deleting={isDeleting}
        />
      );
    };

    switch (panelView.kind) {
      case 'none':
        return null;
      case 'new':
        // key 固定为 'case-new'：新建面板每次都是全新的空表单
        return <CaseFormPanel key="case-new" mode="new" {...sharedFormProps} />;
      case 'no-selection':
        return <PanelEmpty title="没有选中用例" description="从左侧列表点一个用例，或点右上「创建用例」" />;
      case 'not-found':
        // 一次都没取到数据 + 有错误：手改 URL 里的 id、或用例已被别的标签页删掉——给出路，而不是空白右栏
        return (
          <PanelEmpty
            title="用例不存在"
            description="它可能已经被删除；也可以直接用右上「创建用例」新建一个"
            onCreate={() => go({ panel: 'new' })}
          />
        );
      case 'loading':
        return (
          <Card size="sm">
            <CardContent>
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        );
      case 'stale':
        // 真正保住表单实例（用户输入不丢）的是 `renderCase` 给 `CaseFormPanel` 的**稳定 key**
        // （`case-edit-${id}` / `case-new`）：多子节点协调走 key 匹配，所以这里多一个 Alert 也不会让它卸载。
        // **不许删那个 key**——删掉之后 edit → stale 的切换会卸载面板、正在输入的内容全丢。
        // 注意「位置不变」是**错的**、也不是承重结构：stale 分支里面板在 index 1，
        // edit / detail 分支里在 index 0，位置本来就不同；承重的只有 key。
        // 另一条边界仍然成立：别把 Alert 包在面板**外面**（父元素类型一变，整棵子树照样卸载），它必须是兄弟节点。
        return (
          <div className="flex flex-col gap-2">
            <Alert
              data-testid="case-detail-stale"
              className="border-warning/40 bg-warning/10 [&_[data-slot=alert-title]]:text-warning"
            >
              <AlertTitle>用例详情刷新失败：{errorMessage(caseError)}</AlertTitle>
              <AlertDescription>右栏显示的是上一次成功读取的内容；你在表单里已经输入的内容不会被清掉。</AlertDescription>
            </Alert>
            {renderCase(panelView.testCase, panelView.panel)}
          </div>
        );
      case 'edit':
        return <div className="flex flex-col gap-2">{renderCase(panelView.testCase, 'edit')}</div>;
      case 'detail':
        return <div className="flex flex-col gap-2">{renderCase(panelView.testCase, 'detail')}</div>;
    }
  };

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active={ACTIVE_NAV} onNavigate={(href) => router.push(href)} onSearch={requestCommandPalette} />
      <ListDetailLayout
        list={listNode}
        detail={renderPanel()}
        detailOpen={panel !== null}
        widthStorageKey="cases-detail-width"
        onRequestCloseDetail={() => go({ panel: null })}
      />
    </>
  );
}
