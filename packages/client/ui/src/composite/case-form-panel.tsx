'use client';

/**
 * 用例表单面板（右栏内容）：新建与编辑共用一个组件，`mode` 区分。
 *
 * 纯展示：不调接口、不 import client 包；数据与回调全部来自 props。
 * **错误提示由页面负责**（页面在回调里 catch 后 `message.error`）——面板只负责「失败时什么都不做」，
 * 这也正是「生成失败不清空已有评分标准项」这条规则的落点。
 *
 * **不套 `Card`**（用户口径，2026-09-26）：右栏本身就是一张表单，与「创建评测」表单（`RunCreatePanel`）
 * 同形——原来那层卡片只带来一条边框、一层内边距与一个「创建用例 / 编辑用例」卡头（同一屏里还有卡片头的
 * 「取消」与页脚「取消」两份），去掉后表单直接落在右栏，与内层「评分标准项」卡片也不再是卡中卡。
 * 代价是**这一屏没有标题了**：新建 / 编辑的区分只由列表选中项与 URL 上的 `panel` 体现。
 *
 * 九条必须守住的行为：
 *   1. **评分标准项就是表单里的一个字段**（`Form.Item name="rubric"`，`RubricTable` 受控）：
 *      表格状态只存在 antd 的 store 里，面板自己不持有第二份——「智能生成 / 智能识别」成功后
 *      都只 `setFieldValue('rubric', …)` 写回。第二份状态必然漂移（改一处漏一处，界面与提交值分家）；
 *   2. **只有成功才写回表格**（§4.3）。反面写法是「先清空再请求」：一次网络抖动就会清掉用户刚调好的表，
 *      而用户看到的只是一句报错；
 *   3. **commit 候选只是便利**：用 AutoComplete 而不是只读下拉，手工输入任意合法 hash 必须能提交（§4.2）；
 *   4. **未配置评分模型时两个按钮都禁用**并用 Tooltip 说明去向（§4.3 / D14：生成与识别用的是同一把尺子）。
 *      antd 的禁用按钮不触发鼠标事件，Tooltip 必须挂在**外层 span** 上，否则禁用态下浮层永远不出现；
 *   5. **等宽字体取 antd token**（`theme.useToken().fontFamilyCode`），不写死字体名——
 *      主题换字体时这里跟着走；正文是代码，等宽是语义要求而不是装饰；
 *   6. **来源态只影响渲染与提交的分支归一，服务端永远按字符串形态判定**：界面上的「本地 / 远端」是
 *      给用户的一个显式选择（决定渲染哪些字段、提交时分支归不归一），它**不参与**任何判定——
 *      填成什么形态由服务端 `parseRepoSource` 按字符串本身决定。切错态不该让服务端判错，
 *      也不该让界面显示的和存下去的成为两回事；
 *   7. **远端两个动作要把「正在拉取远端仓库…」说出来**（spec §7.1）：首次校验 / 首访候选会真的克隆，
 *      而克隆期间整个 Node 进程阻塞（§6.8），用户点完没有反馈只会以为没点上、于是再点一次；
 *      本地态不许出现这句话——本地来源一个字节都不上网，说成拉取是错误的方向指引；
 *   8. **识别只带用户粘的那段文本**（D10：识别分支不碰仓库，故 `repoPath` 交空串），成功后**整表替换**；
 *      失败时既不清表格也不清文本——弹窗自己保文本、也不关窗（那是 `RubricRecognizeModal` 存在的理由），
 *      面板这边则连一次写回都不做（见要点 2）；
 *   9. **在途的识别请求可以被取消作废**：用户按取消（或遮罩）之后才回来的结果**一个字都不回填**。
 *      取消按钮因此**不禁用**——把不想再等的用户锁在慢请求后面，比白花一次调用更糟；
 *      作废靠一个代次（`recognizeEpochRef`）：取消把代次推进一格，旧代次的结果自己出局。
 *
 * 初值只在挂载时读一次（antd 的 `initialValues` 语义）：**切换用例必须换 key 重挂载**，
 * 页面里的 `key={panel === 'edit' ? `case-edit-${id}` : 'case-new'}` 就是为它准备的。
 * 表格的初值也走这条路（`initial.rubric`）——所以**页面不必再存一份「当前表格」**：
 * 多存一份只会得到一份与表单必然漂移的副本（见要点 1）。
 */
import {
  parseRepoSource,
  validateRubric,
  type CaseCreate,
  type CommitCandidate,
  type GenerateRubricInput,
  type RepoInfo,
  type Rubric,
  type TestCase,
} from '@aieval/contracts';
import { Alert, AutoComplete, Button, Card, Flex, Form, Input, Radio, Tooltip, Typography, theme } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDateTime } from '../base/format';
import { RubricRecognizeModal } from './rubric-recognize-modal';
import { RubricTable } from './rubric-table';

/**
 * 禁用两个评分按钮的提示：去向是设置页里的全局默认评分模型。
 * 用例上**没有**评分模型这一格（2026-09 起删除），所以这句话是唯一且永远正确的去处——
 * 原先那个「本用例的评分模型配置不完整或已失效」的分支随用例级覆盖一起消失了。
 */
const GLOBAL_JUDGE_TOOLTIP = '请先到设置里配置默认评分模型';

/**
 * 来源类型：界面的态（用户可以显式选），与服务端「按形态判定」是两件事——那边永远以字符串形态为准。
 */
type SourceKind = 'local' | 'remote';

/**
 * 初值看起来是远端就按远端渲染；判定失败（未填 / 协议不支持）按本地渲染，让用户在本地态里改掉它。
 *
 * 新建用例**默认落在远端**（2026-09-27 用户口径）：界面上「远端仓库」在前且默认选中，
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

/** 表单内部值：与 CaseCreate 同形，但 commitHash 允许空串（输入框清空拿到的是空串，提交时归一成 null） */
interface CaseFormValues {
  title: string;
  taskPrompt: string;
  /** 评分标准项：**表单里的一个字段**（见文件头要点 1），空表也是合法值，非空由提交时的规则拦 */
  rubric: Rubric;
  repoPath: string;
  commitHash?: string;
  /** 远端来源的分支；空串 = 没填（提交时归一成 null = 远端默认分支 HEAD） */
  repoBranch?: string;
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
   * 整个 Node 进程是阻塞的（spec §6.8）——用户点完「重新加载候选」没有任何反馈，只会以为没点上。
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
   * 生成 / 识别评分标准项。**成功才写回表格**（失败时面板什么都不做，错误由页面提示）——
   * 反面写法是「先清空再请求」：一次抖动就清掉用户刚调好的表。
   */
  onGenerate: (input: GenerateRubricInput) => Promise<{ rubric: Rubric; addedItems: number; note?: string }>;
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
  const [form] = Form.useForm<CaseFormValues>();
  const { token } = theme.useToken();
  // 等宽：取 token 而不是写死字体名（见文件头要点 5）
  const monoStyle = { fontFamily: token.fontFamilyCode };

  /**
   * 上一次校验成功的**那一对**（路径 + 分支，与「当前输入」同口径）。仓库信息只在「当前输入 == 它」时才回显——
   * 用户改了路径（或分支）却还看到上一个仓库的名字、tip 与分支，会以为新输入也已经校验过。
   * 两项都要比：只比路径的那版会在改了分支之后继续显示旧分支的回显。
   */
  const [validatedSelection, setValidatedSelection] = useState<{ repoPath: string; repoBranch: string | null } | null>(null);
  const repoPathValue = (Form.useWatch('repoPath', form) as string | undefined) ?? '';

  /** 来源态：由初值判定一次，之后由用户显式切换（见文件头要点 6） */
  const [sourceKind, setSourceKind] = useState<SourceKind>(() => initialSourceKind(initial));
  const repoBranchValue = (Form.useWatch('repoBranch', form) as string | undefined) ?? '';
  /** 来源不同，能填的东西与失败的处置都不同：本地只认目录，远端要联网镜像 */
  const repoPathExtra =
    sourceKind === 'local'
      ? '只支持本地目录：填仓库根目录（含 .git）'
      : '认证使用本机 git 的 SSH key / 凭据助手，工具不保存任何凭据；首次校验会克隆远端仓库到工作区根下，可能较慢';

  /**
   * 远端「代码仓库」的字段级提示（spec §7.1 逐字）：协议白名单是**补救办法**，不是装饰——
   * 填了 `ftp://…` 的用户拿到的是「不支持的 git 地址协议：ftp（支持 ssh:// / http:// / https:// / git:// / file:// 与 user@host:path）」，
   * 而字段级提示只说「请填写 git 地址」的话，他仍然不知道该换成哪一种写法。
   */
  const remoteRepoMessage = '请填写 git 地址（ssh:// / http(s):// / git:// / file:// / user@host:path）';

  /**
   * 「正在拉取远端仓库…」这句只在**远端**说：本地来源两个动作都只读本地目录，一个字节都不上网，
   * 说成拉取会把用户引向「网络是不是有问题」这个错误的排查方向。
   */
  const validatingLabel = sourceKind === 'remote' && validating ? '正在校验并拉取远端仓库…' : '校验';
  const loadCommitsLabel = sourceKind === 'remote' && loadingCommits ? '正在拉取远端仓库…' : '重新加载候选';

  /**
   * 提交给服务端的分支：本地态恒为 null（不让界面上残留的值溜进请求）。
   * 空串同样归一成 null —— 契约里 `repoBranch` 是 `min(1).nullable()`，空串会被拒。
   */
  const submitBranch = (value: string | undefined): string | null => {
    if (sourceKind === 'local') return null;
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? null : trimmed;
  };

  /** 当前选中的来源（归一后）：回显是否作数、以及报给页面的都是它 */
  const currentSelection = { repoPath: repoPathValue.trim(), repoBranch: submitBranch(repoBranchValue) };
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
  /**
   * 识别请求的**代次**：只有最新一代的结果才回填（见文件头要点 9）。
   * 取消（或关掉再开一次）会把代次推进一格，于是那次在途请求回来时直接作废——
   * 用户按取消就是「这次不要了」，让它在背后把表格换掉是最难被发现的一种错。
   * 用 ref 而不是 state：它只在**回调里比较**用，不需要触发渲染，也不需要进依赖数组。
   */
  const recognizeEpochRef = useRef(0);

  /**
   * 表格的当前值：状态在表单里（`name="rubric"`），这里只是把它读出来给受控的 `RubricTable`。
   * 首帧 store 还没接上时给空表（`{ groups: [] }` 是契约里的合法值，也是新建用例的初值）。
   */
  const rubricValue = Form.useWatch('rubric', form) ?? { groups: [] };

  /** 校验仓库：先过本字段的必填校验，再交给页面（空路径直接调接口只会拿到一句「查询参数不合法」） */
  const handleValidate = async (): Promise<void> => {
    const values = await form.validateFields(['repoPath']).catch(() => null);
    if (values === null) return;
    // 这一对是**这一次点击**发出去的值：成功后要照它记录，之后输入只要有一项不同，回显就不作数
    const selection = { repoPath: (values.repoPath ?? '').trim(), repoBranch: submitBranch(repoBranchValue) };
    try {
      const info = await onValidateRepo(selection);
      // 记的是**发出去的那一对**（不是服务端回显的归一路径）：回显要与「当前输入」比较，
      // 两边必须同口径——远端 URL 的归一（去尾斜杠）会让 `info.repoPath` 与输入框里的原文不相等，
      // 拿回显去比就会出现「校验成功了但回显永远不出现」（候选也同样取不到）。
      // 分支记请求里那一个，不用 `info.branch`：留空时它是服务端解析出的默认分支名，不是用户的选择。
      setValidatedSelection(selection);
    } catch {
      // 失败原因由页面统一 message.error 呈现；这里只负责不留下「已校验」的假状态
      setValidatedSelection(null);
    }
  };

  /** 智能生成：把**当前表格**一起交出去（AI 要靠它做「只增不改」） */
  const handleGenerate = async (): Promise<void> => {
    const values = await form.validateFields(['taskPrompt', 'repoPath']).catch(() => null);
    if (values === null) return;
    try {
      const generated = await onGenerate({
        rubric: form.getFieldValue('rubric') ?? { groups: [] },
        taskPrompt: values.taskPrompt ?? '',
        prompt: '',
        repoPath: (values.repoPath ?? '').trim(),
      });
      form.setFieldValue('rubric', generated.rubric);
    } catch {
      // 刻意什么都不做：不清空、不回填——用户已有的表格必须原样保留（错误由页面提示）
    }
  };

  /**
   * 智能识别：**只带用户粘的文本**（服务端不碰仓库，故不需要 repoPath），成功后整表替换。
   * 抛错时**不关弹窗、不清文本**——那是本弹窗存在的理由；
   * 在途期间用户按了取消（代次变了）则**这一次的结果作废**，一个字都不回填（见文件头要点 9）。
   */
  const handleRecognize = async (prompt: string): Promise<void> => {
    const epoch = recognizeEpochRef.current;
    const generated = await onGenerate({ rubric: { groups: [] }, taskPrompt: '', prompt, repoPath: '' });
    // 用户在请求在途时按了取消 / 关了弹窗（或又开了一次）：他刚表示「这次不要了」，
    // 结果回来时表格**必须原样**——在用户看不见的地方换掉表格是最难被发现的一种错
    if (epoch !== recognizeEpochRef.current) return;
    form.setFieldValue('rubric', generated.rubric);
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

  /** 提交：把表单值归一成契约形状（空串 → null，两侧空白 trim） */
  const handleFinish = (values: CaseFormValues): void => {
    const commitHash = (values.commitHash ?? '').trim();
    onSubmit({
      title: values.title.trim(),
      repoPath: values.repoPath.trim(),
      commitHash: commitHash === '' ? null : commitHash,
      // 分支必须交真实值：编辑一条远端用例时交 null 等于**静默清掉它的分支**（保存后这一轮会换起点）
      repoBranch: submitBranch(values.repoBranch),
      taskPrompt: values.taskPrompt,
      rubric: values.rubric,
    });
  };

  /**
   * 新建用例的表格初值是**空表**（§4.1：空表是一个真实存在的界面状态，非空要求由提交时那条规则给）；
   * 编辑模式原样回填用例里那一份（**不拷贝**：`initialValues` 只在挂载时读一次，之后表格是受控的）。
   */
  const initialValues: Partial<CaseFormValues> =
    initial === null
      ? { rubric: { groups: [] } }
      : {
        title: initial.title,
        taskPrompt: initial.taskPrompt,
        rubric: initial.rubric,
        repoPath: initial.repoPath,
        commitHash: initial.commitHash ?? '',
        // null（本地用例 / 旧数据）落成空串：表单里「没有分支」的表示就是空串
        repoBranch: initial.repoBranch ?? '',
      };

  return (
    <Form form={form} layout="vertical" size="small" initialValues={initialValues} onFinish={handleFinish}>
      {/* 两条规则各管一段：`required` 只判空串（`'   '` 能过），`whitespace` 才判纯空白。
          少了后者，只有空格的标题要先被 `handleFinish` 的 trim 变成 `''` 才交给服务端，
          用户白等一次往返、拿到的还是一句与字段无关的笼统报错 */}
      <Form.Item
        name="title"
        label="标题"
        rules={[
          { required: true, message: '请填写标题' },
          { whitespace: true, message: '标题不能只有空格' },
        ]}
      >
        <Input data-testid="case-title" placeholder="例如：为网关补齐转换回归" />
      </Form.Item>

      <Form.Item
        name="taskPrompt"
        label="考题提示词"
        rules={[{ required: true, message: '请填写考题提示词' }]}
        extra="交给智能体的题面；它决定了这一轮比的是什么"
      >
        <Input.TextArea data-testid="case-task-prompt" rows={4} style={monoStyle} />
      </Form.Item>

      {/* 评分标准项：表格常驻可见（不藏在弹窗里）——它才是主角，两个按钮只是帮它起草 */}
      <Card
        size="small"
        title="评分标准项"
        data-testid="case-rubric"
        extra={
          <Flex gap={8}>
            {judgeConfigured ? (
              <>
                <Button
                  size="small"
                  autoInsertSpace={false}
                  loading={generating}
                  data-testid="case-generate-rubric"
                  onClick={() => void handleGenerate()}
                >
                  智能生成
                </Button>
                <Button
                  size="small"
                  autoInsertSpace={false}
                  disabled={generating}
                  data-testid="case-recognize-rubric"
                  onClick={() => setRecognizeOpen(true)}
                >
                  智能识别
                </Button>
              </>
            ) : (
              // 禁用按钮不触发鼠标事件：Tooltip 必须挂在 span 上（见文件头要点 4）。
              // **两个按钮都在、都禁用**：识别同样要用那把尺子，藏起来只会让用户以为这一版没有识别
              <Tooltip title={GLOBAL_JUDGE_TOOLTIP}>
                <Flex component="span" gap={8} data-testid="case-generate-wrapper">
                  <Button size="small" disabled autoInsertSpace={false} data-testid="case-generate-rubric">
                    智能生成
                  </Button>
                  <Button size="small" disabled autoInsertSpace={false} data-testid="case-recognize-rubric">
                    智能识别
                  </Button>
                </Flex>
              </Tooltip>
            )}
          </Flex>
        }
      >
        {/* 校验规则用的是**写侧的同一份** `validateRubric`（提交 / 落盘 / 设置页也用它）：
            自己再写一份「至少一组、组名非空…」必然漂移，而漂移的症状是「表单放过去、服务端拒掉」。
            `noStyle`：这一格不占一行标签，表格上方那句中文原因由 `RubricTable` 自己显示
            （`validateRubric` 的 message 就是它显示的那一句） */}
        <Form.Item
          name="rubric"
          noStyle
          rules={[
            {
              validator: (_, value: Rubric | undefined) => {
                const checked = validateRubric(value ?? { groups: [] });
                return checked.ok ? Promise.resolve() : Promise.reject(new Error(checked.message));
              },
            },
          ]}
        >
          <RubricTable value={rubricValue} onChange={(next) => form.setFieldValue('rubric', next)} />
        </Form.Item>
      </Card>

      <RubricRecognizeModal
        open={recognizeOpen}
        recognizing={generating}
        onCancel={handleRecognizeCancel}
        onRecognize={handleRecognize}
      />

      {/* 来源类型：显式选择（界面态），与服务端的形态判定是两件事（见文件头要点 6）。
          `Radio.Group` 用 options 写法（不手写 Radio 子元素）：选项文本与值一处给出，少一层手写节点 */}
      <Form.Item label="来源类型" extra="远端仓库的代码由服务端镜像到工作区根下，评测时按分支或 commit 取起点">
        <Radio.Group
          size="small"
          value={sourceKind}
          data-testid="case-source-kind"
          onChange={(event) => {
            const next = event.target.value as SourceKind;
            setSourceKind(next);
            // 切到本地必须清空分支：服务端对「本地 + 分支」是硬拒绝，
            // 留着一个看不见的值会让保存以一句与字段无关的报错失败
            if (next === 'local') form.setFieldValue('repoBranch', '');
            // 来源形态变了，上一次的校验回显必须失效（两套回显的内容不可比）
            setValidatedSelection(null);
          }}
          options={[
            // 顺序即默认口径的一部分：远端在前、本地在后（2026-09-27 用户口径）
            { label: '远端仓库', value: 'remote' },
            { label: '本地目录', value: 'local' },
          ]}
        />
      </Form.Item>

      {/* 仓库路径也要两条规则：`required` 只判空串，纯空格要 `whitespace` 才拦得住。
          少了后者，纯空格的路径先被 `handleFinish` 的 trim 变成 `''` 交给服务端，用户白等一次往返、
          拿到的还是一句与字段无关的「查询参数不合法」（阶段评审 F4） */}
      <Form.Item
        name="repoPath"
        label="代码仓库"
        rules={[
          { required: true, message: sourceKind === 'local' ? '请填写代码仓库的本地绝对路径' : remoteRepoMessage },
          { whitespace: true, message: sourceKind === 'local' ? '请填写代码仓库的本地绝对路径' : remoteRepoMessage },
        ]}
        extra={repoPathExtra}
      >
        <Input
          data-testid="case-repo-path"
          placeholder={sourceKind === 'local' ? 'D:\\projects\\gateway' : 'ssh://git@coding.jd.com/FlowAI/rbac-server.git'}
          // 校验按钮走 `suffix`，不用 antd 6 已弃用的 `addonAfter`（后者每次挂载都打一条 **error 级**的
          // `[antd: Input] addonAfter is deprecated`，而告警只在开发/测试环境出现，生产里静默——
          // 既不会被用户报障发现，又会长期淹没控制台里真正的错误）。同包 `judge-settings-card.tsx`
          // 的单位后缀就是这么处理的。
          // 官方给的替代是 `Space.Compact`，但它会在 Form.Item 与 Input 之间插一层：antd 只给 Form.Item 的
          // **直接孩子**注入 value/onChange（口径同本文件 AutoComplete 处的注释），包一层等于这个字段永远收不到
          // 用户输入，`validateFields(['repoPath'])` 只能拿到空串，「校验」按钮就成了死键。
          // suffix 把按钮留在输入框右端（可见布局不变），绑定与字段级报错都原地不动。
          suffix={
            <Button
              size="small"
              type="text"
              autoInsertSpace={false}
              loading={validating}
              data-testid="case-validate-repo"
              onClick={() => void handleValidate()}
            >
              {validatingLabel}
            </Button>
          }
        />
      </Form.Item>

      {/* 分支：只在远端来源渲染。留空 = 远端默认分支 HEAD（提交成 null），填了就用该分支的 tip，
          且每次评测重新解析——所以这里不做任何「记住上次 tip」的展示（tip 只在上面那次校验的回显里） */}
      {sourceKind === 'remote' && (
        <Form.Item
          name="repoBranch"
          label="分支"
          extra="留空 = 远端默认分支 HEAD；填了就用该分支的 tip，每次评测重新解析"
        >
          <Input data-testid="case-repo-branch" placeholder="例如：feat/multi-protocol-inbound" />
        </Form.Item>
      )}

      {/* 这里冗余判一次 null：靠别名布尔量收窄虽然 TS 4.4+ 支持，但明写一次更稳，
          也省得后人「看着多余」把它删掉再踩一次收窄失败 */}
      {showRepoInfo && repoInfo !== null && (
        <Form.Item label=" " colon={false}>
          <Alert
            data-testid="case-repo-info"
            type="success"
            showIcon
            // 远端与本地回显的是两套信息，故按 `kind` 分派；本地那句**逐字不变**（老用户认的就是它）。
            // 「默认分支 / 分支」看的是**表单里的分支输入**：用户填了分支却看到「当前分支：main」，
            // 会以为填的那个没生效（服务端解析出的 `info.branch` 是它的 tip 所在分支）
            title={
              repoInfo.kind === 'remote'
                ? `仓库：${repoInfo.repoName} · ${repoBranchValue.trim() === '' ? '默认分支' : '分支'}：${repoInfo.branch}` +
                  `${repoInfo.tip === null ? '' : ` · tip ${repoInfo.tip}`}` +
                  ` · 镜像：已就绪${repoInfo.mirrorFetchedAt === null ? '' : `（更新于 ${formatDateTime(repoInfo.mirrorFetchedAt)}）`}`
                : `仓库：${repoInfo.repoName} · 当前分支：${repoInfo.branch}`
            }
          />
        </Form.Item>
      )}

      {/* AutoComplete 直接做 Form.Item 的孩子（**不套一层 Flex**）：antd 只会给直接孩子注入 value/onChange
          与 label 的 htmlFor 所指的 id，套一层容器会让绑定丢在内层控件上——测试里的 getByLabelText 也会失效。
          这里刻意**不给 data-testid**：antd 的 Select 系组件把额外 props 放到外层容器，对着容器触发 change
          改不到表单值；测试用 label 关联取内层 input（见测试里的 commitInput）。 */}
      <Form.Item
        name="commitHash"
        label="commit hash"
        extra={
          <Flex justify="space-between" align="center" gap={8}>
            <Typography.Text type="secondary">留空 = 默认分支 HEAD；候选只是便利，可手工输入任意合法 hash</Typography.Text>
            {/* 这个按钮在远端首访可能触发一次真实克隆（用户跳过了校验直接点它），而克隆期间整个进程
                是阻塞的（spec §6.8）：loading 与「正在拉取远端仓库…」就是那段时间里唯一的反馈 */}
            <Button size="small" type="text" data-testid="case-load-commits" loading={loadingCommits} onClick={onLoadCommits}>
              {loadCommitsLabel}
            </Button>
          </Flex>
        }
      >
        <AutoComplete
          placeholder="留空 = 默认分支 HEAD"
          options={commits.map((commit) => ({ value: commit.hash, label: `${commit.hash} ${commit.subject}` }))}
          // 候选只有 20 条：按输入前缀过滤即可，不过滤的话输入短哈希时下拉会把无关项排满
          filterOption={(input, option) => String(option?.value ?? '').toLowerCase().startsWith(input.toLowerCase())}
          notFoundContent="暂无候选提交，可手工输入完整 hash"
        />
      </Form.Item>

      <Flex justify="end" gap={8} style={{ marginTop: 12 }}>
        {/* 取消只有这一个入口（原先卡片头上的那个 `extra` 取消随卡片一起去掉了）：
            两个一模一样的「取消」在同一屏里，除了让人犹豫点哪个，没有任何信息量 */}
        <Button size="small" autoInsertSpace={false} data-testid="case-cancel" onClick={onCancel}>
          取消
        </Button>
        {/* 提交按钮两态都是**实心主按钮、无图标**（用户口径，2026-09-26）：它只提交这张已经写着
            「创建用例 / 编辑用例」的右栏表单，按钮不必再复述一遍动作，也不该与左边「取消」撞成同一种灰。
            文案仍分两态——新建「确定」、编辑「保存」：前者是确认这张新表单，后者是保存对已有用例的改动。 */}
        <Button
          size="small"
          type="primary"
          htmlType="submit"
          loading={saving}
          autoInsertSpace={false}
          data-testid="case-submit"
        >
          {mode === 'new' ? '确定' : '保存'}
        </Button>
      </Flex>
    </Form>
  );
}
