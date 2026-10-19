'use client';

/**
 * 用例表单面板（右栏内容）：新建与编辑共用一个组件，`mode` 区分。
 *
 * 纯展示：不调接口、不 import client 包；数据与回调全部来自 props。
 * **错误提示由页面负责**（页面在回调里 catch 后提示）——面板只负责「失败时什么都不做」，
 * 这也正是「生成失败不清空已有评分标准项」这条规则的落点。
 *
 * **不套 `Card`**：右栏本身就是一张表单，与「创建评测」表单（`RunCreatePanel`）
 * 同形——原来那层卡片只带来一条边框、一层内边距与一个「创建用例 / 编辑用例」卡头（同一屏里还有卡片头的
 * 「取消」与页脚「取消」两份），去掉后表单直接落在右栏，与内层「评分标准项」卡片也不再是卡中卡。
 * 代价是**这一屏没有标题了**：新建 / 编辑的区分只由列表选中项与 URL 上的 `panel` 体现。
 *
 * 九条必须守住的行为：
 *   1. **评分标准项就是表单里的一个字段**（`rubric`，`RubricTable` 受控）：
 *      表格状态只存在表单 store 里，面板自己不持有第二份——「智能生成 / 智能识别」成功后
 *      都只 `setValue('rubric', …)` 写回。第二份状态必然漂移（改一处漏一处，界面与提交值分家）；
 *   2. **只有成功才写回表格**。反面写法是「先清空再请求」：一次网络抖动就会清掉用户刚调好的表，
 *      而用户看到的只是一句报错；
 *   3. **commit 候选只是便利**：输入框始终接受手工输入的任意合法 hash，候选按钮只负责回填；
 *   4. **未配置评分模型时两个按钮都禁用**并用去向说明（生成与识别用的是同一把尺子）。
 *      禁用按钮不触发鼠标事件，所以说明文本挂在**外层容器**的 `title` 上；
 *   5. **等宽字体取 `--font-mono`**（`globals.css` 的 `:root` 里定义），不写死字体名——
 *      主题换字体时这里跟着走；正文是代码，等宽是语义要求而不是装饰；
 *   6. **来源态只影响渲染与提交的归一，服务端永远按字符串形态判定**：界面上的「本地 / 远端 / 无」是
 *      给用户的一个显式选择（决定渲染哪些字段、提交时分支归不归一），它**不参与**任何判定——
 *      填成什么形态由服务端 `parseRepoSource` 按字符串本身决定；「无」提交时把哨兵值 `NONE_SOURCE`
 *      （`none://`）写进 `repoPath`。切错态不该让服务端判错，也不该让界面显示的和存下去的成为两回事；
 *   7. **远端两个动作要把「正在拉取远端仓库…」说出来**：首次校验 / 首访候选会真的克隆，
 *      而克隆期间整个 Node 进程阻塞，用户点完没有反馈只会以为没点上、于是再点一次；
 *      本地态不许出现这句话——本地来源一个字节都不上网，说成拉取是错误的方向指引；
 *   8. **识别只带用户粘的那段文本**（识别分支不碰仓库，故 `repoPath` 交空串），成功后**整表替换**；
 *      失败时既不清表格也不清文本——弹窗自己保文本、也不关窗（那是 `RubricRecognizeModal` 存在理由），
 *      面板这边则连一次写回都不做（见要点 2）；
 *   9. **在途的识别请求可以被取消作废**：用户按取消（或遮罩）之后才回来的结果**一个字都不回填**。
 *      取消按钮因此**不禁用**——把不想再等的用户锁在慢请求后面，比白花一次调用更糟；
 *      作废靠一个代次（`recognizeEpochRef`）：取消把代次推进一格，旧代次的结果自己出局。
 *
 * 初值只在挂载时读一次（RHF 的 `defaultValues` 语义）：**切换用例必须换 key 重挂载**，
 * 页面里的 `key={panel === 'edit' ? `case-edit-${id}` : 'case-new'}` 就是为它准备的。
 * 表格的初值也走这条路（`initial.rubric`）——所以**页面不必再存一份「当前表格」**：
 * 多存一份只会得到一份与表单必然漂移的副本（见要点 1）。
 *
 * 校验与提交归一全在 `case-form-schema.ts`（zod resolver）：组件里只有绑定与渲染。
 */
import {
  NONE_SOURCE,
  parseRepoSource,
  type CaseCreate,
  type CommitCandidate,
  type GenerateRubricInput,
  type GenerateRubricResult,
  type RepoInfo,
  type Rubric,
  type RubricChange,
  type TestCase,
} from '@aieval/contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { formatDateTime } from '../base/format';
import { Alert, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel, FieldTitle } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import { RubricAdjustModal } from './rubric-adjust-modal';
import { RubricRecognizeModal } from './rubric-recognize-modal';
import { RubricTable } from './rubric-table';
import { caseFormSchema, toCaseCreate, type CaseFormInput, type CaseSourceKind } from './case-form-schema';

/**
 * 禁用两个评分按钮的提示：去向是设置页里的全局默认评分模型。
 * 用例上**没有**评分模型这一格（2026-09 起删除），所以这句话是唯一且永远正确的去处——
 * 没有「本用例的评分模型配置不完整或已失效」这一分支——用例级覆盖已不在。
 */
const GLOBAL_JUDGE_TOOLTIP = '请先到设置里配置默认评分模型';

/** 来源类型：界面的态（用户可以显式选），与服务端「按形态判定」是两件事 */
type SourceKind = CaseSourceKind;

/** 来源选项：顺序即默认口径的一部分——远端在前、本地其次、无最后 */
const SOURCE_KIND_OPTIONS = [
  { label: '远端仓库', value: 'remote' },
  { label: '本地目录', value: 'local' },
  { label: '无', value: 'none' },
] as const;

/**
 * 初值看起来是远端就按远端渲染；判定失败（未填 / 协议不支持）按本地渲染，让用户在本地态里改掉它。
 *
 * 新建用例**默认落在远端**：界面上「远端仓库」在前且默认选中，
 * 本地目录作为第二个选项。
 */
function initialSourceKind(initial: TestCase | null): SourceKind {
  if (initial === null) return 'remote';
  try {
    return parseRepoSource(initial.repoPath).kind;
  } catch {
    return 'local';
  }
}

export interface CaseFormPanelProps {
  mode: 'new' | 'edit';
  /** 编辑模式的初值；**只在挂载时读一次**，切换用例要换 key 重挂载 */
  initial?: TestCase | null;
  /** 是否已配置评分模型；false 时两个按钮都禁用并提示去设置页 */
  judgeConfigured: boolean;
  saving: boolean;
  generating: boolean;
  validating: boolean;
  /**
   * commit 候选是否正在取（`useCommitCandidates` 的 `isLoading`）。
   * 为什么必须由页面交进来：候选那条路在**远端首访**会真的克隆（镜像还没建时），而克隆期间
   * 整个 Node 进程是阻塞的——用户点完「重新加载候选」没有任何反馈，只会以为没点上。
   */
  loadingCommits: boolean;
  commits: CommitCandidate[];
  repoInfo: RepoInfo | null;
  onSubmit: (values: CaseCreate) => void;
  onCancel: () => void;
  onValidateRepo: (input: { repoPath: string; repoBranch: string | null }) => Promise<RepoInfo>;
  /**
   * 当前选中的来源（路径 + 归一后的分支）变化时上报；页面用它判断上一次校验是否还作数、
   * 以及要不要继续按那一对取 commit 候选。可选：不传时面板照常工作（只是没人消费这个信号）。
   */
  onRepoSelectionChange?: (selection: { repoPath: string; repoBranch: string | null }) => void;
  /**
   * 生成 / 识别 / 调整评分标准项。**成功才写回表格**（失败时面板什么都不做，错误由页面提示）——
   * 反面写法是「先清空再请求」：一次抖动就清掉用户刚调好的表。
   * 注意「成功」在调整分支上**不等于**「已写回」：那一支要等用户在弹窗里点「应用改动」（见 `handleAdjust`）。
   */
  onGenerate: (input: GenerateRubricInput) => Promise<GenerateRubricResult>;
  onLoadCommits: () => void;
}

export function CaseFormPanel({
  mode,
  initial = null,
  judgeConfigured,
  saving,
  generating,
  validating,
  loadingCommits,
  commits,
  repoInfo,
  onSubmit,
  onCancel,
  onValidateRepo,
  onRepoSelectionChange,
  onGenerate,
  onLoadCommits,
}: CaseFormPanelProps): ReactNode {
  // 等宽：取语义变量而不是写死字体名（见文件头要点 5）
  const monoStyle = { fontFamily: 'var(--font-mono)' };

  /**
   * 上一次校验成功的**那一对**（路径 + 分支，与「当前输入」同口径）。仓库信息只在「当前输入 == 它」时才回显——
   * 用户改了路径（或分支）却还看到上一个仓库的名字、tip 与分支，会以为新输入也已经校验过。
   * 两项都要比：只比路径的那版会在改了分支之后继续显示旧分支的回显。
   */
  const [validatedSelection, setValidatedSelection] = useState<{ repoPath: string; repoBranch: string | null } | null>(null);

  /**
   * 评分项是否「被动过」：新建时初值就是空表，一进来就飘红等于先把用户判成有罪。
   * 红字等到「用户动过表格」或「点过一次提交」才出现（提交那条由 `formState.isSubmitted` 给）。
   */
  const [rubricTouched, setRubricTouched] = useState(false);

  /** 来源态：由初值判定一次，之后由用户显式切换（见文件头要点 6） */
  const [sourceKind, setSourceKind] = useState<SourceKind>(() => initialSourceKind(initial));

  /**
   * 新建用例的表格初值是**空表**（空表是一个真实存在界面状态，非空要求由提交时那条规则给）；
   * 编辑模式原样回填用例里那一份。
   */
  const initialValues: CaseFormInput =
    initial === null
      ? { title: '', taskPrompt: '', rubric: { groups: [] }, repoPath: '', commitHash: '', repoBranch: '', includeSteps: false }
      : {
        title: initial.title,
        taskPrompt: initial.taskPrompt,
        rubric: initial.rubric,
        repoPath: initial.repoPath,
        commitHash: initial.commitHash ?? '',
        // null（本地用例 / 旧数据）落成空串：表单里「没有分支」的表示就是空串
        repoBranch: initial.repoBranch ?? '',
        // 契约里 includeSteps 必填（旧文件由读侧兜成 false），直接回显用例上的值
        includeSteps: initial.includeSteps,
      };

  /**
   * 来源态以回调交给 schema：校验与提交归一那一刻才读，于是切 Radion 之后规则立刻跟着换
   * （表单实例不重建，`defaultValues` 也只在挂载时读一次）。
   */
  const schema = caseFormSchema(() => sourceKind);
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
  });
  const { control, getValues, setValue, trigger, handleSubmit } = form;

  const repoPathValue = (useWatch({ control, name: 'repoPath' }) as string | undefined) ?? '';
  const repoBranchValue = (useWatch({ control, name: 'repoBranch' }) as string | undefined) ?? '';
  /**
   * 表格的当前值：状态在表单里（`rubric` 那一格），这里只是读出来给受控的 `RubricTable`。
   * 断言到 `Rubric`：表单输入侧允许评分项的 `id` 缺省（新建时还没填），而表格的展示形状里它是必填的
   * 空串——`RubricTable` 对两者一视同仁（空 id 就是「按位置引用」）。
   */
  const rubricValue = (useWatch({ control, name: 'rubric' }) ?? { groups: [] }) as Rubric;

  /** 来源不同，能填的东西与失败的处置都不同：本地只认目录，远端要联网镜像 */
  const repoPathExtra =
    sourceKind === 'local'
      ? '只支持本地目录：填仓库根目录（含 .git）'
      : '认证使用本机 git 的 SSH key / 凭据助手，工具不保存任何凭据；首次校验会克隆远端仓库到工作区根下，可能较慢';

  /**
   * 「正在拉取远端仓库…」这句只在**远端**说：本地来源两个动作都只读本地目录，一个字节都不上网，
   * 说成拉取会把用户引向「网络是不是有问题」这个错误的排查方向。
   */
  const validatingLabel = sourceKind === 'remote' && validating ? '正在校验并拉取远端仓库…' : '校验';
  const loadCommitsLabel = sourceKind === 'remote' && loadingCommits ? '正在拉取远端仓库…' : '重新加载候选';

  /**
   * 提交给服务端的分支：本地与无来源恒为 null（不让界面上残留的值溜进请求）。
   * 空串同样归一成 null —— 契约里 `repoBranch` 是 `min(1).nullable()`，空串会被拒。
   */
  const submitBranch = (value: string | undefined): string | null => {
    if (sourceKind === 'local' || sourceKind === 'none') return null;
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? null : trimmed;
  };

  /** 当前选中的来源（归一后）：回显是否作数、以及报给页面的都是它。
   *  无来源时报**哨兵值**而不是地址框里的残留文本：页面拿它去比「上一次校验过的那一对」，
   *  任何真实路径都不可能等于 `none://`，于是候选与回显在「无」态下天然失效、不发请求。 */
  const currentSelection = {
    repoPath: sourceKind === 'none' ? NONE_SOURCE : repoPathValue.trim(),
    repoBranch: submitBranch(repoBranchValue),
  };
  const showRepoInfo =
    repoInfo !== null &&
    validatedSelection !== null &&
    validatedSelection.repoPath === currentSelection.repoPath &&
    validatedSelection.repoBranch === currentSelection.repoBranch;

  /**
   * 把当前选中的来源报给页面：页面据此让上一次校验的结果与 commit 候选一起失效
   * （候选是按「来源 + 分支」取的，用户改了输入之后旧的那一对就不该再用来取候选）。
   * 依赖写两个**原始值**而不是 `currentSelection` 对象：后者每次渲染都是新对象，会把 effect 变成每次都跑。
   */
  useEffect(() => {
    onRepoSelectionChange?.({ repoPath: currentSelection.repoPath, repoBranch: currentSelection.repoBranch });
  }, [currentSelection.repoPath, currentSelection.repoBranch, onRepoSelectionChange]);

  /** 识别弹窗是否打开。表格状态**不在这里**（见文件头要点 1）：这个 state 只管弹窗开合 */
  const [recognizeOpen, setRecognizeOpen] = useState(false);
  /** 调整弹窗是否打开（同样只管开合：清单与新表都在那个组件自己的 state 里） */
  const [adjustOpen, setAdjustOpen] = useState(false);
  /**
   * 识别请求的**代次**：只有最新一代的结果才回填（见文件头要点 9）。
   * 取消（或关掉再开一次）会把代次推进一格，于是那次在途请求回来时直接作废——
   * 用户按取消就是「这次不要了」，让它在背后把表格换掉是最难被发现的一种错。
   * 用 ref 而不是 state：它只在**回调里比较**用，不需要触发渲染，也不需要进依赖数组。
   */
  const recognizeEpochRef = useRef(0);

  /** 校验仓库：先过本字段的必填校验，再交给页面（空路径直接调接口只会拿到一句「查询参数不合法」） */
  const handleValidate = async (): Promise<void> => {
    const valid = await trigger(['repoPath']);
    if (!valid) return;
    // 这一对是**这一次点击**发出去的值：成功后要照它记录，之后输入只要有一项不同，回显就不作数
    const selection = { repoPath: (getValues('repoPath') ?? '').trim(), repoBranch: submitBranch(repoBranchValue) };
    try {
      const info = await onValidateRepo(selection);
      // 记的是**发出去的那一对**（不是服务端回显的归一路径）：回显要与「当前输入」比较，
      // 两边必须同口径——远端 URL 的归一（去尾斜杠）会让 `info.repoPath` 与输入框里的原文不相等，
      // 拿回显去比就会出现「校验成功了但回显永远不出现」（候选也同样取不到）。
      // 分支记请求里那一个，不用 `info.branch`：留空时它是服务端解析出的默认分支名，不是用户的选择。
      setValidatedSelection(selection);
    } catch {
      // 失败原因由页面统一提示；这里只负责不留下「已校验」的假状态
      setValidatedSelection(null);
    }
  };

  /** 智能生成：把**当前表格**一起交出去（AI 要靠它做「只增不改」）。
   *  无来源时交哨兵值（服务端认它、用固定仓库名替身起草），且地址格已隐藏、不参与校验。 */
  const handleGenerate = async (): Promise<void> => {
    const valid = await trigger(sourceKind === 'none' ? ['taskPrompt'] : ['taskPrompt', 'repoPath']);
    if (!valid) return;
    try {
      const generated = await onGenerate({
        mode: 'generate',
        // 表单输入侧允许评分项 id 缺省（新建时用户还没填），而契约要求 id 是字符串（空串 = 按位置引用）
        rubric: (getValues('rubric') ?? { groups: [] }) as Rubric,
        taskPrompt: getValues('taskPrompt') ?? '',
        prompt: '',
        repoPath: sourceKind === 'none' ? NONE_SOURCE : (getValues('repoPath') ?? '').trim(),
      });
      setValue('rubric', generated.rubric);
    } catch {
      // 刻意什么都不做：不清空、不回填——用户已有的表格必须原样保留（错误由页面提示）
    }
  };

  /**
   * 智能调整：把**当前表格**与用户那句话一起交出去，拿回「模型改完的新表 + 服务端算出的改动清单」。
   * **这里不写回表格**——写回要等用户在弹窗里点「应用改动」（`handleAdjustApply`）。
   * 关口只有这一处：模型有顺手润色的倾向，而微调的对象是用户可能已经调了很久、甚至跑过评测的标准。
   */
  const handleAdjust = async (instruction: string): Promise<{ rubric: Rubric; changes: RubricChange[] }> => {
    const generated = await onGenerate({
      mode: 'adjust',
      rubric: (getValues('rubric') ?? { groups: [] }) as Rubric,
      // 题面只作理解上下文（服务端拿它帮模型读懂「A1」指的是哪一项）；空着也能用
      taskPrompt: getValues('taskPrompt') ?? '',
      prompt: instruction,
      repoPath: '',
    });
    return { rubric: generated.rubric, changes: generated.changes ?? [] };
  };

  /** 用户在预览段点了「应用改动」：**这一刻**才把新表写进表单（本功能唯一的写入口） */
  const handleAdjustApply = (rubric: Rubric): void => {
    setValue('rubric', rubric);
    setAdjustOpen(false);
  };

  /**
   * 智能识别：**只带用户粘的文本**（服务端不碰仓库，故不需要 repoPath），成功后整表替换。
   * 抛错时**不关弹窗、不清文本**——那是本弹窗存在的理由；
   * 在途期间用户按了取消（代次变了）则**这一次的结果作废**，一个字都不回填（见文件头要点 9）。
   */
  const handleRecognize = async (prompt: string): Promise<void> => {
    const epoch = recognizeEpochRef.current;
    const generated = await onGenerate({ mode: 'recognize', rubric: { groups: [] }, taskPrompt: '', prompt, repoPath: '' });
    // 用户在请求在途时按了取消 / 关了弹窗（或又开了一次）：他刚表示「这次不要了」，
    // 结果回来时表格**必须原样**——在用户看不见的地方换掉表格是最难被发现的一种错
    if (epoch !== recognizeEpochRef.current) return;
    setValue('rubric', generated.rubric);
    setRecognizeOpen(false);
  };

  /**
   * 取消识别：关窗 + 推进代次（作废在途请求的结果）。
   * **取消按钮不在识别期间禁用**：那是「把一个已经不想等的用户锁在慢请求后面」，
   * 比一次白花的调用更糟——白花的那次结果会被代次挡在门外。
   */
  const handleRecognizeCancel = (): void => {
    recognizeEpochRef.current += 1;
    setRecognizeOpen(false);
  };

  /** 提交：先过 resolver 的校验，再由 `toCaseCreate` 归一成契约形状 */
  const submit = handleSubmit((values) => onSubmit(toCaseCreate(values, sourceKind)));

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {/* 面板标题：右栏换内容不弹层，第一行就要说清这是创建还是编辑、以及「用例」由哪几件东西构成 */}
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-title font-medium">{mode === 'edit' ? '编辑用例' : '创建用例'}</h2>
        <p className="text-sub text-muted-foreground">用例 = 仓库 + commit + 考题提示词</p>
      </header>
      <Controller
        control={control}
        name="title"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="case-title">标题</FieldLabel>
            <Input
              {...field}
              id="case-title"
              data-testid="case-title"
              aria-invalid={fieldState.invalid}
              placeholder="例如：为网关补齐转换回归"
            />
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        )}
      />

      <Controller
        control={control}
        name="taskPrompt"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="case-task-prompt">考题提示词</FieldLabel>
            <Textarea
              {...field}
              id="case-task-prompt"
              data-testid="case-task-prompt"
              rows={4}
              style={monoStyle}
              aria-invalid={fieldState.invalid}
            />
            <FieldDescription>交给智能体的题面；它决定了这一次评测比的是什么</FieldDescription>
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        )}
      />

      {/* 评分标准项：表格常驻可见（不藏在弹窗里）——它才是主角，两个按钮只是帮它起草。
            这一格不属于 Controller：`RubricTable` 自己就是受控组件，值经 `setValue` 回写；
            校验规则仍走 schema 里那一格（同一个 `validateRubric`）。 */}
      <Card size="sm" data-testid="case-rubric">
        <CardHeader>
          <CardTitle>评分标准项</CardTitle>
          <CardAction>
            <div className="flex items-center gap-2">
              {judgeConfigured ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={generating}
                    data-testid="case-generate-rubric"
                    onClick={() => void handleGenerate()}
                  >
                    {generating ? '生成中…' : '智能生成'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={generating}
                    data-testid="case-recognize-rubric"
                    onClick={() => setRecognizeOpen(true)}
                  >
                    智能识别
                  </Button>
                  {/* 「智能调整」按**现有**表格改：与另两个的区别只在输入与落点，
                        按钮文案说不清的部分由弹窗里的说明承担 */}
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={generating}
                    data-testid="case-adjust-rubric"
                    onClick={() => setAdjustOpen(true)}
                  >
                    智能调整
                  </Button>
                </>
              ) : (
              // 禁用按钮不触发鼠标事件：去向说明挂在**外层 span** 的 `title` 上（见文件头要点 4）。
              // **三个按钮都在、都禁用**：识别与调整同样要用那把尺子，藏起来只会让用户以为这一版没有它们
                <span
                  title={GLOBAL_JUDGE_TOOLTIP}
                  data-testid="case-generate-wrapper"
                  className="flex items-center gap-2"
                >
                  <Button variant="outline" size="sm" type="button" disabled data-testid="case-generate-rubric">
                    智能生成
                  </Button>
                  <Button variant="outline" size="sm" type="button" disabled data-testid="case-recognize-rubric">
                    智能识别
                  </Button>
                  <Button variant="outline" size="sm" type="button" disabled data-testid="case-adjust-rubric">
                    智能调整
                  </Button>
                </span>
              )}
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {/* 校验规则用的是**写侧的同一份** `validateRubric`（提交 / 落盘 / 设置页也用它）：
                自己再写一份「至少一组、组名非空…」必然漂移，而漂移的症状是「表单放过去、服务端拒掉」。
                这一格**不渲染** `FieldError`：表格上方那句中文原因由 `RubricTable` 自己显示
                （两处显示同一个 message 只会让人分不清哪一句才是判据）。 */}
          <RubricTable
            value={rubricValue}
            onChange={(next) => {
              setRubricTouched(true);
              setValue('rubric', next);
            }}
            validationVisible={rubricTouched || form.formState.isSubmitted}
          />
        </CardContent>
      </Card>

      {/* 「包含步骤」：单一布尔开关（`checked` / `onChange` 显式绑定）。
            开启 = 评分阶段把候选的执行过程记录纳入评分证据，评分标准可针对每一步推理给分；
            关闭 = 评分只看最终改动。只影响评分阶段——考题提示词与执行阶段与开关无关。 */}
      <Controller
        control={control}
        name="includeSteps"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="case-include-steps">包含步骤</FieldLabel>
            <Switch
              id="case-include-steps"
              data-testid="case-include-steps"
              checked={field.value}
              onCheckedChange={(checked) => field.onChange(checked)}
              aria-invalid={fieldState.invalid}
            />
            <FieldDescription>
              开启后评分阶段会读到候选的执行过程记录，评分标准可针对每一步推理给分；关闭时评分只看最终改动
            </FieldDescription>
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        )}
      />

      <RubricRecognizeModal
        open={recognizeOpen}
        recognizing={generating}
        onCancel={handleRecognizeCancel}
        onRecognize={handleRecognize}
      />

      {/* 调整弹窗：新表只在它自己的 state 里，点「应用改动」才经 handleAdjustApply 写回表格 */}
      <RubricAdjustModal
        open={adjustOpen}
        adjusting={generating}
        onCancel={() => setAdjustOpen(false)}
        onAdjust={handleAdjust}
        onApply={handleAdjustApply}
      />

      {/* 来源类型：显式选择（界面态），与服务端的形态判定是两件事（见文件头要点 6）。
            三个选项由同一张表渲染：选项文本与值一处给出，标签包住单选控件，可访问名就是可见文案 */}
      <Field>
        <FieldTitle>来源类型</FieldTitle>
        <RadioGroup
          value={sourceKind}
          data-testid="case-source-kind"
          className="flex flex-wrap gap-4"
          onValueChange={(next) => {
            const nextKind = next as SourceKind;
            setSourceKind(nextKind);
            // 切到本地必须清空分支：服务端对「本地 + 分支」是硬拒绝，
            // 留着一个看不见的值会让保存以一句与字段无关的报错失败
            if (nextKind === 'local') setValue('repoBranch', '');
            // 来源形态变了，上一次的校验回显必须失效（两套回显的内容不可比）
            setValidatedSelection(null);
          }}
        >
          {SOURCE_KIND_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <RadioGroupItem value={option.value} id={`case-source-${option.value}`} />
              <span>{option.label}</span>
            </label>
          ))}
        </RadioGroup>
        <FieldDescription>
          远端仓库的代码由服务端镜像到工作区根下，评测时按分支或 commit 取起点；无 = 空仓库（无来源代码），评测时初始化一个空 git 仓库
        </FieldDescription>
      </Field>

      {/* 仓库路径的规则在 schema 里（复用契约的 `RepoSourceStringSchema`）：纯空格与非法协议都拿到
            契约那句中文。无来源时整格隐藏（提交时落哨兵值）。 */}
      {sourceKind !== 'none' && (
        <Controller
          control={control}
          name="repoPath"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="case-repo-path">代码仓库</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  {...field}
                  id="case-repo-path"
                  data-testid="case-repo-path"
                  aria-invalid={fieldState.invalid}
                  placeholder={sourceKind === 'local' ? 'D:\\projects\\gateway' : 'ssh://git@coding.jd.com/FlowAI/rbac-server.git'}
                />
                {/* 校验按钮与输入框同一行：它只作用于这一格，不该被看成整张表单的动作 */}
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={validating}
                  data-testid="case-validate-repo"
                  onClick={() => void handleValidate()}
                >
                  {validatingLabel}
                </Button>
              </div>
              <FieldDescription>{repoPathExtra}</FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      )}

      {/* 分支：只在远端来源渲染。留空 = 远端默认分支 HEAD（提交成 null），填了就用该分支的 tip，
            且每次评测重新解析——所以这里不做任何「记住上次 tip」的展示（tip 只在上面那次校验的回显里） */}
      {sourceKind === 'remote' && (
        <Controller
          control={control}
          name="repoBranch"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="case-repo-branch">分支</FieldLabel>
              <Input
                {...field}
                id="case-repo-branch"
                data-testid="case-repo-branch"
                aria-invalid={fieldState.invalid}
                placeholder="例如：feat/multi-protocol-inbound"
              />
              <FieldDescription>留空 = 远端默认分支 HEAD；填了就用该分支的 tip，每次评测重新解析</FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      )}

      {/* 这里冗余判一次 null：靠别名布尔量收窄虽然 TS 4.4+ 支持，但明写一次更稳，
            也省得后人「看着多余」把它删掉再踩一次收窄失败 */}
      {showRepoInfo && repoInfo !== null && (
        <Field>
          <Alert
            data-testid="case-repo-info"
            className="border-success/40 bg-success/10 [&_[data-slot=alert-title]]:text-success"
            // 远端与本地回显的是两套信息，故按 `kind` 分派；本地那句**逐字不变**（老用户认的就是它）。
            // 「默认分支 / 分支」看的是**表单里的分支输入**：用户填了分支却看到「当前分支：main」，
            // 会以为填的那个没生效（服务端解析出的 `info.branch` 是它的 tip 所在分支）
          >
            <AlertTitle>
              {repoInfo.kind === 'remote'
                ? `仓库：${repoInfo.repoName} · ${repoBranchValue.trim() === '' ? '默认分支' : '分支'}：${repoInfo.branch}` +
                    `${repoInfo.tip === null ? '' : ` · tip ${repoInfo.tip}`}` +
                    ` · 镜像：已就绪${repoInfo.mirrorFetchedAt === null ? '' : `（更新于 ${formatDateTime(repoInfo.mirrorFetchedAt)}）`}`
                : `仓库：${repoInfo.repoName} · 当前分支：${repoInfo.branch}`}
            </AlertTitle>
          </Alert>
        </Field>
      )}

      {/* commit 输入框始终可手工输入：候选只是便利，点一下回填，不改变「提交的是输入框里的值」。
            无来源没有提交历史，整格隐藏（提交时 commitHash 恒为 null）。 */}
      {sourceKind !== 'none' && (
        <Controller
          control={control}
          name="commitHash"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="case-commit-hash">提交（commit hash）</FieldLabel>
              <Input
                {...field}
                id="case-commit-hash"
                aria-invalid={fieldState.invalid}
                placeholder="留空 = 默认分支 HEAD"
              />
              {/* 候选只作便利：点一下把 hash 填进输入框，输入框本身始终可手工输入任意合法 hash。
                    候选最多 20 条，直接摊成一行按钮比下拉少一层交互，也不会挡住表单 */}
              {commits.length > 0 && (
                <div className="flex flex-wrap gap-1" data-testid="case-commit-candidates">
                  {commits.map((commit) => (
                    <Button
                      key={commit.hash}
                      variant="outline"
                      size="xs"
                      type="button"
                      onClick={() => field.onChange(commit.hash)}
                    >
                      {`${commit.hash} ${commit.subject}`}
                    </Button>
                  ))}
                </div>
              )}
              <FieldDescription>
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span>留空 = 默认分支 HEAD；候选只是便利，可手工输入任意合法 hash</span>
                  {/* 这个按钮在远端首访可能触发一次真实克隆（用户跳过了校验直接点它），而克隆期间整个进程
                        是阻塞的：禁用 + 「正在拉取远端仓库…」就是那段时间里唯一的反馈 */}
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid="case-load-commits"
                    disabled={loadingCommits}
                    onClick={onLoadCommits}
                  >
                    {loadCommitsLabel}
                  </Button>
                </span>
              </FieldDescription>
              {commits.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无候选提交，可手工输入完整 hash</p>
              )}
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      )}

      <div className="flex justify-end gap-2 pt-1">
        {/* 取消只有这一个入口（卡片头上没有第二个）：
              两个一模一样的「取消」在同一屏里，除了让人犹豫点哪个，没有任何信息量 */}
        <Button variant="outline" size="sm" type="button" data-testid="case-cancel" onClick={onCancel}>
          取消
        </Button>
        {/* 提交按钮两态都是**实心主按钮、无图标**：它只提交这张已经写着
              「创建用例 / 编辑用例」的右栏表单，按钮不必再复述一遍动作，也不该与左边「取消」撞成同一种灰。
              文案仍分两态——新建「确定」、编辑「保存」：前者是确认这张新表单，后者是保存对已有用例的改动。 */}
        <Button type="submit" size="sm" disabled={saving} data-testid="case-submit">
          {saving ? '保存中…' : mode === 'new' ? '确定' : '保存'}
        </Button>
      </div>
    </form>
  );
}
