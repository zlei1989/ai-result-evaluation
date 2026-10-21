// @vitest-environment node
/**
 * 日志抽屉的**接线**守卫：页面必须把实时通道的原因喂给 `resolveLogDrawer`。
 *
 * 为什么需要一条读源码的用例：`apps/web-next` 不能写 `.tsx` 测试（AGENTS.md 的硬约束：该应用
 * `jsx: preserve`），于是页面这一层没有渲染测试面，判定逻辑只能抽成纯函数（`log-drawer-state`）。
 * 但**纯函数的守卫看不见「调用方有没有把参数传进来」**——  正是这种缺陷：
 * `log-drawer-state` 的 6 条用例全绿，而页面只喂了 `logError: log.error`，`stream.error` 从不进
 * 渲染路径 ⇒ 断流时抽屉只有「还没有日志 + 未连接」，没有原因。把页面那行删掉时，纯函数用例**一条都不红**（本文件就是为这个缺口补的守卫）。
 *
 * 断言口径（只扫这一个调用表达式，不整文件匹配）：把 `resolveLogDrawer({ … })` 的实参块抠出来，
 * 逐个断言三个输入位都在。这样「换行/改写其他部分」不会误红，而「漏传一个输入」必红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 应用根目录（`apps/web-next`）：用文件自身位置推导，不依赖 `process.cwd()` */
const pagePath = join(import.meta.dirname, '..', 'app', 'runs', 'page.tsx');

/** 抠出 `resolveLogDrawer({ … });` 的实参块；抠不到直接抛，避免守卫静默失效 */
function logDrawerCall(): string {
  const source = readFileSync(pagePath, 'utf8');
  const start = source.indexOf('resolveLogDrawer({');
  if (start < 0) throw new Error('app/runs/page.tsx 里找不到 resolveLogDrawer({ … }) 调用');
  const end = source.indexOf('});', start);
  if (end < 0) throw new Error('resolveLogDrawer 的调用没有在预期处结束（找不到 `});`）');
  return source.slice(start, end);
}

describe('runs 页面的日志抽屉接线', () => {
  it('把实时通道的原因（stream.error）喂进 resolveLogDrawer', () => {
    const call = logDrawerCall();

    // 五个输入位各一条断言：漏任何一个都会在这里红
    expect(call, '少了 events').toContain('events:');
    expect(call, '少了 recordCount（第二条来源：内容记录——少了它，有内容时也会被误判成「读不出来」）').toContain(
      'recordCount:',
    );
    expect(call, '少了 logError（读文件失败的原因）').toContain('logError:');
    expect(call, '少了 streamError（实时通道的原因）——断流时抽屉就说不出原因了').toContain('streamError:');
    expect(call, '少了 isLoading（「正在读取日志…」那一态）').toContain('isLoading:');
  });

  it('两条来源的提示都交给抽屉渲染（判定在纯函数里、渲染在 `AgentLogLayout` 里）', () => {
    const source = readFileSync(pagePath, 'utf8');

    // 非破坏性提示（实时通道故障 / 读失败）由页面把**已算好的文案**传进抽屉：
    // 抽屉按 `liveError` / `notice` 两个锚点渲染（本文件下一节钉抽屉那一侧）
    expect(source, '实时通道的原因没有传进抽屉').toContain('liveError={logState.liveError}');
    expect(source, '读失败的非破坏性提示没有传进抽屉').toContain('日志可能不完整：${logState.warning}');
    // 故障那一支仍**整段替换**（不渲染抽屉内容），否则它的空态会把故障说成「还没开始跑」
    expect(source).toContain('data-testid="run-log-drawer-failed"');
  });
});

/**
 * 「执行日志」接线的**新契约**守卫。
 *
 * 与上面同一类缺口：`@aieval/client` 与 `@aieval/ui` 各自有自己的用例，而
 * 「页面有没有把两条来源接上」两边都看不见。三条断言各有各的靶子：
 * ① 时间轴的内容来自**内容级记录**（`useCandidateMessages`），不是候选级事件；
 * ② 模型由 `buildAgentLogModel` 现算；
 * ③ 下载台账**仍用 `formatEventLog` 的全量事件**（台账与视图不是一种东西）。
 */
describe('runs 页面的执行日志接线', () => {
  const source = (): string => readFileSync(pagePath, 'utf8');

  it('时间轴订阅了内容级记录（`/messages`），且与事件流是两条独立的订阅', () => {
    const text = source();
    expect(text, '页面没有订阅消息记录——时间轴会永远是空的').toContain('useCandidateMessages({');
    expect(text, '内容记录的订阅没有跟着抽屉开关（关着抽屉也开长连接）').toContain('candidateId: logCandidateId ?? \'\', enabled: logCandidateId !== null');
    // 事件那条仍在（固定事实条与「原始输出」的来源），两条互不替代
    expect(text).toContain('useCandidateStream({');
    // 事件流的订阅必须带「这一次尝试」：不带的话重跑同一行时 effect 一个依赖都没变，
    // 抽屉会一直显示上一轮的原始输出，而连接徽标照旧是「实时连接中」
    expect(text, '事件流的订阅没有带 attemptKey——重跑同一行时原始输出不会刷新').toContain(
      'attemptKey: String(logCandidate?.attempts ?? 0)',
    );
  });

  it('模型由 `buildAgentLogModel` 现算（页面不自己拼界面形状）', () => {
    const text = source();
    expect(text, '页面没有调 buildAgentLogModel').toContain('buildAgentLogModel({');
    expect(text, '模型没有吃消息记录').toContain('records: messages.records,');
    expect(text, '候选级事实没有走 buildCandidateFacts（色档与文案会各写一份）').toContain('buildCandidateFacts({');
  });

  it('`log` 事件**不再**进时间轴：它只走原始输出面板与台账', () => {
    const text = source();
    // 原始输出的两条出口都在：面板（`diagnosticsOf`）与台账（`formatEventLog`）
    expect(text, '原始输出面板没有拿到 diagnostics').toContain('diagnosticsOf(stream.events)');
    expect(text, '下载台账不再是全量事件（台账与视图必须分得开）').toContain('formatEventLog(log.events ?? stream.events)');
    // 旧的 `LogView` 已删除：它的「整段纯文本」正是这次重构要拆掉的东西
    expect(text, '页面仍在渲染旧的 LogView').not.toContain('<LogView');
  });
});

/**
 * 实时指标的**接线**守卫。
 *
 * 与上面同一类缺口：数据层（`@aieval/client`）与展示层（`@aieval/ui`）各自有自己的用例，
 * 而「页面有没有把它们接上」两边都看不见——漏接的症状就是**界面永远显示「未采集」**，
 * 三个包的用例还全绿。`apps/web-next` 不能写 `.tsx` 测试（AGENTS.md 硬约束），
 * 故这里按源码文本钉住三件事：订阅存在、只订阅在跑的行、按行注入详情面板。
 */
describe('runs 页面的实时指标接线', () => {
  /** 抠出 `useRunLiveMetrics({ … });` 的实参块；抠不到直接抛（守卫不许静默失效） */
  function liveSubscriptionCall(): string {
    const source = readFileSync(pagePath, 'utf8');
    const start = source.indexOf('useRunLiveMetrics({');
    if (start < 0) throw new Error('app/runs/page.tsx 里找不到 useRunLiveMetrics({ … }) 调用');
    const end = source.indexOf('});', start);
    if (end < 0) throw new Error('useRunLiveMetrics 的调用没有在预期处结束（找不到 `});`）');
    return source.slice(start, end);
  }

  it('页面订阅了实时指标，并把轮 id 与行集合都传进去', () => {
    const call = liveSubscriptionCall();

    expect(call, '少了 runId').toContain('runId');
    expect(call, '少了 candidateIds（没有它就没有任何一个候选会订阅）').toContain('candidateIds');
  });

  it('只订阅**在跑的行**（列表页有几十轮，全订阅就是几十条长连接）', () => {
    const source = readFileSync(pagePath, 'utf8');

    // 行集合必须由快照的在跑状态筛出来：`isRunningCandidate` 是契约里的同一份判据（准备中/执行中/评分中）
    expect(source, '行集合没有按 isRunningCandidate 过滤').toContain('.filter((row) => isRunningCandidate(row.status))');
  });

  it('把实时指标按行注入详情面板（不注入 = 界面永远「未采集」）', () => {
    const source = readFileSync(pagePath, 'utf8');

    expect(source).toContain('liveOf={(candidateId) => live[candidateId]}');
  });
});

/**
 * **环境信息的接线**守卫。
 *
 * 这一条补的缺口比上面几组更隐蔽：`AgentEnvironmentDrawer` 有自己的用例、
 * `AgentLogLayout` 也有（「未提供时显示『未提供』而不是空白」），而 `environment` 是**可选 prop**
 * ⇒ **页面从来没传过它**这件事，三个包的用例全绿、`pnpm typecheck` 也不响。
 * 症状是一句设计好的「未提供」——它看起来像「这次没采到」，其实是「这一格根本没人填」。
 *
 * 三条断言各有各的靶子：① 值得进抽屉；② 值是从 `buildAgentEnvironment` 现算的
 * （写死一个常量同样能让①绿，而那样三家会显示同一份假环境）；③ `AgentLogSource` 上那个口子
 * 还在（`AgentLogLayout` 拿「它存不存在」判重试按钮画不画）。
 */
describe('runs 页面的环境信息接线', () => {
  const source = (): string => readFileSync(pagePath, 'utf8');

  it('页面把 environment 传进执行日志抽屉——漏了它，三家都只显示「未提供」', () => {
    const text = source();
    expect(text, 'environment 没有传给 AgentLogDrawer：抽屉里永远是「未提供」').toContain('environment: logEnvironment');
  });

  it('环境是 `buildAgentEnvironment` 现算的，不是写死的常量', () => {
    const text = source();
    expect(text, '页面没有调 buildAgentEnvironment').toContain('buildAgentEnvironment({');
    // 四组数据各自的来源都要在位：少喂一个，那一组会静默退化成「没接」
    expect(text, '环境没有吃候选级事件（厂商系统层会整组缺失）').toContain('events: stream.events');
    expect(text, '环境没有吃内容记录（实测统计会整组缺失）').toContain('records: messages.records');
    expect(text, '环境没有吃候选的快照字段（摘要与运行配置会缺失）').toContain('row: logCandidate');
  });

  it('`requestEnvironment` 那个口子留着（`AgentLogLayout` 拿它判重试按钮画不画）', () => {
    expect(source(), '少了 requestEnvironment：读取失败时只剩错误、没有重试').toContain('requestEnvironment:');
  });
});

/**
 * **能力声明的接线**守卫。
 *
 * 这是本文件里同一类缺口的**第四个实例**，也是最隐蔽的一个：三家适配器都在
 * `providers/<kind>/index.ts` 里声明了 `messageCapability`（五格各带 `source` / `reason`），
 * `buildAgentLogModel` 收这一格、`CapabilityNotes` 渲染它、`AgentLogLayout` 拿它说
 * 「这一类没被转发」——**每一环都有自己的用例**，而「页面有没有把它接上」谁都不看。
 * 症状不是空白，是一句**假的**原因：`capability` 是可选输入 ⇒ 不传就回落成 `unverified`，
 * 于是三家一律显示「没验证过」，而真相是「厂商有数据、但没投送到我们能读的通道」这种具体事实。
 *
 * 三条断言各有靶子：① 值从 `useRunModelOptions` 的 `messageCapabilityOf` 取；
 * ② 经 `toCapabilityMap` 摊成界面要的字典（契约是扁平的 `x` / `xSource` / `xReason` 三格）；
 * ③ `capabilityNotes` 不再是一个空数组字面量（那是「无条件成立」，而它常常有前提）。
 */
describe('runs 页面的能力声明接线', () => {
  const source = (): string => readFileSync(pagePath, 'utf8');

  /**
   * 抠出 `buildAgentLogModel({ … })` 的实参块；抠不到直接抛（守卫不许静默失效）。
   *
   * 为什么不整份文件扫：`capabilityNotes: []` 在文件里**另有一处合法出现**——
   * 「这个候选还没开始跑」那份空模型（`NEVER_RAN_MODEL`）本来就该是空数组。
   * 整份扫会把那一处判成违规，于是守卫逼着人给一份假的前提。
   */
  function modelCall(): string {
    const text = source();
    const start = text.indexOf('buildAgentLogModel({');
    if (start < 0) throw new Error('app/runs/page.tsx 里找不到 buildAgentLogModel({ … }) 调用');
    const end = text.indexOf('});', start);
    if (end < 0) throw new Error('buildAgentLogModel 的调用没有在预期处结束（找不到 `});`）');
    return text.slice(start, end);
  }

  it('能力声明从候选元数据取出来并注入日志模型', () => {
    const text = source();

    expect(text, '没有取 messageCapabilityOf：整条声明链在页面上断掉').toContain('messageCapabilityOf');
    expect(modelCall(), '模型没有吃能力声明（不传就等于三家都「没验证过」）').toContain('capability: toCapabilityMap(');
    expect(modelCall(), 'capabilityNotes 还是空数组字面量：能力成立的前提被丢掉').not.toContain('capabilityNotes: [],');
    expect(modelCall(), 'capabilityNotes 没有取服务端的 notes').toContain('logCapability?.notes');
  });
});

/**
 * 创建面板「默认评分智能体未配置」内联提示的**接线**守卫。
 *
 * 与本文件开头那两段同一类缺口的第三个实例：`RunCreatePanel` 自己的用例把正反两面都钉住了
 * （`judgeAgentConfigured === false` 才提示、`undefined`「未知」不提示），但**页面有没有把这一位传进来**
 * 它看不见。这一位在面板上是可选 prop，于是删掉那行 `pnpm typecheck` 也不响，
 * 症状恰是「开关打开而没配默认评分智能体时，那条内联警告永远不出现」——
 * 使用者要等候选跑完几分钟，才在评分阶段吃一个失败。
 *
 * 断言口径：把 `<RunCreatePanel … />` 的**开标签**抠出来，只扫这一段，两条分开钉：
 * 这一位在不在位、它的值是不是从已保存的设置现算的。漏传会红，写死成常量（`true` / `undefined`）也会红——
 * 后者同样让提示永不出现，只钉「prop 在位」的话它照样绿。
 */
describe('runs 页面的创建面板接线', () => {
  /** 抠出 `<RunCreatePanel … />` 的开标签；抠不到直接抛，避免守卫静默失效 */
  function createPanelTag(): string {
    const source = readFileSync(pagePath, 'utf8');
    const start = source.indexOf('<RunCreatePanel');
    if (start < 0) throw new Error('app/runs/page.tsx 里找不到 <RunCreatePanel … />');
    const end = source.indexOf('/>', start);
    if (end < 0) throw new Error('RunCreatePanel 的开标签没有在预期处结束（找不到 `/>`）');
    return source.slice(start, end);
  }

  it('把「默认评分智能体是否已配置」喂进创建面板——漏了它，内联警告永不出现', () => {
    const tag = createPanelTag();

    expect(tag, '少了 judgeAgentConfigured——开关打开而没配时就没有任何内联提示').toContain(
      'judgeAgentConfigured=',
    );
  });

  it('这一位是从已保存的设置现算的，不是写死的常量', () => {
    const tag = createPanelTag();

    // `settings.defaultJudgeAgent !== null` 是判据本身：写死 `true`（永不提示）或 `undefined`（提示不了）
    // 都能让上一条绿，故这里要求值必须来自 settings 那一格
    expect(tag, 'judgeAgentConfigured 没有从 settings.defaultJudgeAgent 现算').toContain('defaultJudgeAgent');
  });

  /**
   * B：`cases` 的**未知态**必须原样传下去——不许写成 `cases ?? []`。
   *
   * 与上面两位同一类缺口：面板自己的用例把「未知 ≠ 已删除」钉住了（`cases: undefined` 时补的是
   * 可用的当前用例项、不是禁用的「原用例已删除」），但页面若把「还没读到 / 读失败」压成空数组，
   * 面板就会照「已知为空」处置：下拉显示一句假话且选项被禁用。这条症状只在直开 / 刷新
   * `?panel=edit&id=…` 时出现（这一轮的快照常比 `/api/cases` 先到），面板侧全绿也看不出来。
   * 两个面板（创建 / 编辑）同此口径，故一次扫全部调用点的开标签。
   */
  it('两个面板都原样吃 cases 的未知态（写 `?? []` 就把「还没读到」说成了「用例已删除」）', () => {
    const source = readFileSync(pagePath, 'utf8');
    // 抠不到 `/>` 时必须**抛**，不能悄悄截断：`slice(0, -1)` 会返回「除最后一个字符外的整份文件」，
    // 于是这条守卫拿后面**所有** JSX 去 `toContain`，恒绿（同文件 `createPanelTag` 的处置）。
    const tags = source.split('<RunCreatePanel').slice(1).map((rest) => {
      const end = rest.indexOf('/>');
      if (end < 0) throw new Error('RunCreatePanel 的开标签没有在预期处结束（找不到 `/>`）');
      return rest.slice(0, end);
    });

    expect(tags.length, '页面里 RunCreatePanel 的调用点数变了：这条守卫要跟着改').toBe(2);
    for (const tag of tags) {
      expect(tag, 'cases 没有原样传下去（`?? []` 会让编辑表单谎报「原用例已删除」，用例还换不了）').toContain(
        'cases={cases}',
      );
    }
  });
});

/**
 * 「编辑 / 删除」的**接线**守卫（与上面两组同一类缺口）：数据层（`@aieval/client`）与展示层
 * （`@aieval/ui`）各自有自己的用例，而「页面有没有把它们接上」两边都看不见——
 * 漏接的症状是「详情面板上那两个按钮点了没反应」或「编辑保存后列表不刷新」，而各包用例全绿。
 * `apps/web-next` 不能写 `.tsx` 测试（AGENTS.md 硬约束），故这里按源码文本钉住。
 */
describe('runs 页面的编辑 / 删除接线', () => {
  const source = (): string => readFileSync(pagePath, 'utf8');

  /**
   * 抠出 `handleDelete` 的**函数体切片**（`const handleDelete = (` 到它自己的 `\n  };`）。
   * 为什么必须切片：「删除成功要回列表」在源码里的落点是 `handleDelete` 体内的 `closePanel();`，
   * 而整文件匹配只能钉住它**外面**那句 `runsPanelHref(null, null)`（在 `closePanel` 里，早于本任务
   * 就存在）。复核实测：把 `handleDelete` 里那句 `closePanel();` 删掉，整文件断言照样绿——那条守卫
   * 形同虚设，需求就此无人看守。切片抠不到直接抛，守卫不许静默失效。
   */
  function handleDeleteBody(): string {
    const text = source();
    const start = text.indexOf('const handleDelete = (');
    if (start < 0) throw new Error('app/runs/page.tsx 里找不到 `const handleDelete = (`');
    const end = text.indexOf('\n  };', start);
    if (end < 0) throw new Error('handleDelete 的函数体没有在预期处结束（找不到 `\\n  };`）');
    return text.slice(start, end);
  }

  it('两个动作在页面里都从数据层取（useUpdateRun / useDeleteRun）', () => {
    const text = source();

    // 断言**解构调用的形状**，不是标识符：只匹配 `useUpdateRun` 时，光有 import 语句
    // （`page.tsx` 顶部那两行）就能让断言绿——hook 调用被删掉（编辑 / 删除永远不发请求）
    // 也照样通过。实测：删掉 `const { update, isUpdating } = useUpdateRun();` 这个候选，
    // 旧的标识符断言不红，这一条红。
    expect(text, '页面没有取 useUpdateRun 的 update / isUpdating').toContain(
      'const { update, isUpdating } = useUpdateRun();',
    );
    expect(text, '页面没有取 useDeleteRun 的 remove / isDeleting').toContain(
      'const { remove, isDeleting } = useDeleteRun();',
    );
  });

  it('编辑走 update(run.id, values)，删除走 remove(run.id) 且在同一个函数体里回列表', () => {
    const text = source();
    // 轮 id 写错（例如写成 values.caseId）就改到别的东西上了：形状必须逐字钉住
    expect(text, '编辑没有把表单值交给 update(run.id, …)').toContain('update(run.id, values)');

    const body = handleDeleteBody();
    expect(body, 'handleDelete 没有调 remove(run.id)：删的不是用户点的那一轮').toContain('remove(run.id)');
    // 删除成功要回列表（无右栏），否则右栏会停在一条已经不存在的轮次上
    expect(body, 'handleDelete 删完没有回列表（右栏会停在一条已经不存在的轮次上）').toContain('closePanel()');
  });

  /**
   * A18 的「如实提示」在页面上只有一个落点：删除响应里的 `workspaceRemoved`。
   * 少一个锚点的症状是**假报干净**——把那一支改成无条件的「评测已删除」，盘上没能回收的候选工作区
   * 就没人再提；`@aieval/client` 只是把这一位原样交出来（它自己的用例覆盖不到页面的文案）。
   */
  it('删除成功如实报告工作区是否回收（workspaceRemoved === false 不许说成干净删除）', () => {
    const text = source();
    // 两支都要在，且**极性**要对：写反了会在「有残留」时报「已删除」、在干净时报「有残留」
    expect(text, '删除提示没有按 workspaceRemoved 分支（或两支写反了）：残留也会被报成干净删除').toContain(
      'workspaceRemoved ? \'评测已删除\'',
    );
    expect(text, '少了「有残留」那一支的文案').toContain('候选工作区有残留');
  });

  it('编辑面板带 mode="edit" 与 initial（预填的唯一来源）', () => {
    const text = source();
    expect(text).toContain('mode="edit"');
    expect(text).toContain('initial={run}');
  });

  it('详情面板把两个回调接上，并把 deleting 透下去（不然确认框不会转圈）', () => {
    const text = source();
    expect(text).toContain('onEdit=');
    expect(text).toContain('onDelete=');
    expect(text).toContain('deleting={isDeleting}');
  });

  it('创建路径**显式剥掉**候选 id（不依赖 zod 对未知键的静默剥离）', () => {
    // 只断言「创建那一支把 rows 重映射过」这一件事：整条表达式逐字匹配会被换行与格式化打红
    const text = source();
    expect(text).toContain('candidates: values.candidates.map(');
    expect(text).toContain('agentKind: row.agentKind, providerId: row.providerId, modelId: row.modelId');
  });

  /**
   * 两个回调必须**原样**交出去，不能包一层 `void` 箭头。
   * 这两处是上一条（`onDelete=` / `initial={run}` 在位）看不见的缺口：`onSubmit={(values) => void
   * handleUpdate(values)}` 与 `onDelete={() => void handleDelete()}` 都能让那些断言全绿，而箭头函数
   * 返回的是 `undefined` —— antd 的 `ActionButton` 只在 `onConfirm` / `onOk` 拿到 thenable 时才等待它，
   * 于是确认框立刻关闭、按钮也不转圈，用户看到的是「点一下没反应」，再点一次就是第二次写请求。
   * 症状与「回调根本没接」几乎一样，但只在**有作废行**（编辑）或**删除**时才出现。
   */
  it('编辑 / 删除都把在途 promise 交回面板回调（包一层 void 箭头就丢了它）', () => {
    const text = source();
    expect(text, '编辑提交写成了 void 箭头：确认框不再等这一笔 PUT').toContain('onSubmit={handleUpdate}');
    expect(text, '删除回调写成了 void 箭头：确认框不再等这一笔 DELETE').toContain('onDelete={handleDelete}');
  });
});

/**
 * 备注的**接线**守卫：两处缺口都在页面这一层，面板与纯函数各自的用例看不见。
 *
 * ① 创建路径：`RunCreate.note` 是**可选键**，`handleCreate` 漏写它时 `tsc` 一声不响，
 *    而症状是「表单里填了备注、落库却没有」——列表与详情永远只显示用例标题。
 * ② 标题列：`runListTitle` 的纯函数用例再全，也拦不住页面把 render / sorter 换回 `caseTitle`；
 *    两个消费点必须共用同一份拼法，「看到的」与「排的」才不会分叉。
 */
describe('runs 页面的备注接线', () => {
  const source = (): string => readFileSync(pagePath, 'utf8');

  /**
   * 抠出 `handleCreate` 的函数体（从它的声明到 `handleUpdate` 之前）。
   * 抠不到直接抛，避免守卫退化成「拿整份文件 toContain」的空断言。
   */
  function handleCreateBody(): string {
    const text = source();
    const start = text.indexOf('const handleCreate = async');
    if (start < 0) throw new Error('app/runs/page.tsx 里找不到 `const handleCreate = async`');
    const end = text.indexOf('const handleUpdate = async', start);
    if (end < 0) throw new Error('handleCreate 的函数体没有在预期处结束（找不到 handleUpdate）');
    return text.slice(start, end);
  }

  it('创建路径把备注交给服务端（可选键不会被类型提醒，漏了就是静默丢弃）', () => {
    expect(handleCreateBody(), '创建载荷里没有 note：表单填的备注永远不会落库').toContain('note: values.note');
  });

  it('标题列的显示与排序都走 runListTitle（看到的与排的同一份拼法）', () => {
    const text = source();
    expect(text, '标题列没有走 runListTitle：备注不会出现在列表里').toContain('runListTitle(record)');
    expect(text, '标题列排序没有走 runListTitle：看到的与排的不是一回事').toContain(
      'compareSortText(runListTitle(a), runListTitle(b))',
    );
  });
});

/**
 * 「评分详情」抽屉 footer 上「原始输出 N 条」入口的**接线**守卫。
 *
 * 为什么必须在这一层钉：入口按钮在**页面**渲染的 `Drawer footer` 上，而正文
 * 仍在 `@aieval/ui` 的 `ScoreDetailView` 里 ——两边各自有自己的用例，**「页面有没有把
 * 这一组 props 接上」谁都不看**。漏接的症状不是报错，是「点了按钮没反应」（开合恒假）
 * 或者「二级抽屉关不掉」（`onOpenChange` 没接），而两包的用例全绿。
 *
 * 同一段源码里还挂着**顶部那两个候选的数据来源**那一条——它出于
 * 同一条理由：视图在包里、页面这一层没有渲染测试面。两条守卫共用下面那个「抠块」助手。
 *
 * 断言口径：抠出「评分详情」那一支抽屉的**整段**（从它的标题到它自己的 `</Drawer>`）再逐条断言，
 * 不整文件匹配 ——页面里还有别的抽屉，整文件扫会让「footer 挂在别的抽屉上」也照样绿。
 */
describe('runs 页面的「评分详情」抽屉接线（footer 入口 + 受控开合 + 评分数据来源）', () => {
  const source = (): string => readFileSync(pagePath, 'utf8');

  /**
   * 抠出「评分详情」抽屉的整段源码；抠不到直接抛（守卫不许静默失效）。
   * 结束判据取**它自己的** `</Drawer>`：抽屉不嵌套，标题之后的第一个闭合标签就是它
   * （正文里那个二级抽屉是组件内部的，不在这份源码里）。
   */
  function scoreDrawerBlock(): string {
    const text = source();
    const start = text.indexOf('title="评分详情"');
    if (start < 0) throw new Error('app/runs/page.tsx 里找不到「评分详情」抽屉（守卫失效了）');
    const end = text.indexOf('</Drawer>', start);
    if (end < 0) throw new Error('「评分详情」抽屉没有在预期处结束（找不到 `</Drawer>`）');
    return text.slice(start, end);
  }

  it('「原始输出 N 条」入口在评分详情抽屉的 footer 上，且带那个 data-testid', () => {
    const block = scoreDrawerBlock();

    expect(block, '评分详情抽屉没有 footer：入口按钮又回到正文里了').toContain('footer={');
    expect(block, 'footer 里没有「原始输出 N 条」的入口按钮').toContain('data-testid="score-judge-output-open"');
    // 按钮必须在 **footer 属性里**，不是在 children 里（后者就是那次要拆掉的形状）
    const footerStart = block.indexOf('footer={');
    const footerEnd = block.indexOf('>', block.indexOf('{judgeOutputLabel}', footerStart));
    expect(footerEnd, '「原始输出」不在 footer 表达式里').toBeGreaterThan(footerStart);
    expect(block.slice(footerStart, footerEnd), '「原始输出」没挂在 footer 上').toContain('{judgeOutputLabel}');
  });

  it('「原始输出」跟着 judgeOutputVisible 渲染：不可见时 footer 整段为 null', () => {
    // 归一化空白后再比：判据是**条件本身**，不该被换行/缩进打红
    const block = scoreDrawerBlock().replace(/\s+/g, ' ');

    expect(block, 'footer 不再跟着 judgeOutputVisible 判空：空态那一格也会长出点不动的入口').toContain(
      'footer={ judgeOutputVisible ?',
    );
    // 按钮本身也在 footer 那一支里（可见性判据见下一条：有分时按 judgeAgentKind、judging 时按 run.useAgentJudge）
    const footerStart = block.indexOf('footer={');
    expect(block.slice(footerStart), '「原始输出」按钮没有落在 judgeOutputVisible 那一支里').toContain(
      'data-testid="score-judge-output-open"',
    );
  });

  /**
   * 「原始输出」入口的**可见性判据**守卫（设计口径，两半缺一不可）：
   * 有分时按 `score.judgeAgentKind` 判（文本 API 评分没有评审会话 ⇒ 不渲染）；
   * 评分进行中（judging ⇔ 无分，`judgeAgentKind` 要等分落下来才有）按轮级开关
   * `run.useAgentJudge` 判。判据写在页面这一层，包里的用例看不见它。
   */
  it('「原始输出」的可见性：有分看 judgeAgentKind，judging 看 run.useAgentJudge', () => {
    const text = source();

    expect(text, '没有按 judgeAgentKind 判（文本 API 评分也会长出入口）').toContain(
      'scoreDetail.score.judgeAgentKind !== null',
    );
    expect(text, '没有按 run.useAgentJudge + judging 判（评分进行中没有入口，SSE 无处可达）').toContain(
      'run?.useAgentJudge === true && judgeLive',
    );
    expect(text, 'judging 判据不是候选状态（与「judging ⇔ 无分」的服务端口径漂移）').toContain(
      'scoreCandidate?.status === \'judging\'',
    );
  });

  /**
   * 「原始输出」那条流的**订阅接线**：入口可见才取数、judging 才接 SSE。
   * 两端（hook 与视图）各有自己的用例，只有这一层看得见「页面把参数传对了没有」。
   */
  it('评分事件流的订阅：enabled 跟着可见性、live 跟着 judging、折法与执行日志同源', () => {
    const text = source();

    expect(text, '页面没有订阅评分事件流').toContain('useCandidateJudgeEvents({');
    expect(text, '订阅没有跟着入口可见性（不可见也拉历史是白请求）').toContain('enabled: judgeOutputVisible,');
    expect(text, 'SSE 的开关不是 judging（终态候选会挂一条只发心跳的空连接）').toContain('live: judgeLive,');
    // 折法与执行日志抽屉同一份（`diagnosticsOf`）：两处各写一遍必然漂移
    expect(text, '评分原始输出没有走 diagnosticsOf 折行').toContain('diagnosticsOf(judgeOutput.events)');
    // 入口与抽屉标题同文：两处各写一个模板字符串也会漂移
    expect(text, '入口文案没有走 rawOutputLabel（与抽屉标题不是同一份实现）').toContain(
      'rawOutputLabel(judgeOutput.status === \'ready\'',
    );
  });

  it('开合态按**候选 id** 判据（换一行 / 关抽屉时二级抽屉不会自己弹出来）', () => {
    const text = source();

    expect(text, '「原始输出」开合态不是按候选 id 判据：换一行后二级抽屉会自己弹出来').toContain(
      'judgeOutputCandidateId === scoreCandidateId',
    );
    expect(text, '没有把 judgeOutput 传给 ScoreDetailView（正文与三态都进不去）').toContain('judgeOutput=');
    expect(text, '没有把受控开合传给 judgeOutput（点了按钮没反应 / 关不掉）').toContain('open: judgeOutputOpen,');
    expect(text, 'judgeOutput 的关合动作没有回写页面状态').toContain('onOpenChange: (next) => setJudgeOutputCandidateId(');
  });

  /**
   * 顶部那两个候选的**数据来源**守卫。
   *
   * 为什么必须在这一层反向钉：这**五格**（评分智能体 / 评分模型 / 思考强度 / 评分用量 / 评分耗时）
   * 全在 `score` 上，页面只需要把 `score` 递下去；而 那一版曾经把**候选**
   * 也递进去当五格的来源。把那一格接回来不会有任何报错——组件已经不吃它了，TS 会在编译期拦下；
   * 真正会静默出问题的是**反过来**：有人「顺手」把它加回来，然后组件里再长出第二份「候选运行信息」，
   * 于是抽屉里又出现执行那一份数据。
   *
   * 断言口径与上面同一套：在「评分详情」抽屉的整段里找，不整文件匹配。
   */
  it('不把候选传给 ScoreDetailView（抽屉里只讲这一分，候选数据不进评分详情）', () => {
    const block = scoreDrawerBlock();
    expect(block, '评分详情抽屉又把候选传下去了：抽屉里会重新出现执行那一份数据').not.toContain('row={');
    expect(block, '评分详情抽屉没有把 score 传下去').toContain('score={scoreDetail.score}');
    expect(block, '评分详情抽屉没有把评分表快照传下去（逐项判定会对不上任何一张表）').toContain(
      'rubric={scoreDetail.rubric}',
    );
  });
});

/**
 * **追问（第二期）的接线**守卫。
 *
 * 与本文件里前几组同一类缺口：契约的真值表在 `@aieval/contracts`、编排层的同源在
 * `@aieval/evaluator`、入口按钮在 `@aieval/ui`、可用性读侧在 `@aieval/client`——**每一环都有自己的
 * 用例**，而「页面有没有把它们接上」谁都不看。漏接的症状是三种静默：
 *   · `onFollowUpCandidate` 没接 ⇒ 点「追问」什么都不发生；
 *   · `followUpOf` 没接 ⇒ 按钮永远停在「读不到判据」的禁用态（看起来像「这个候选不能追问」）；
 *   · footer 那一支没接 ⇒ 抽屉打开了、底下没有输入框。
 * `apps/web-next` 不能写 `.tsx` 测试（AGENTS.md 硬约束），故这里按源码文本钉住。
 */
describe('runs 页面的追问接线', () => {
  const source = (): string => readFileSync(pagePath, 'utf8');

  it('可用性判据从数据层读，且跟着候选状态与会话变化重读', () => {
    const text = source();

    expect(text, '页面没有订阅追问可用性：按钮没有判据').toContain('useFollowUpAvailability({');
    // 判据随候选状态翻转（正在跑 / 上一次没收尾），而这条读侧没有信号流 ⇒ 必须有 revision
    expect(text, 'revision 没有带上候选的状态与会话 id：候选跑完之后按钮还是灰的').toContain('row.sessionId === null');
    expect(text, '判据没有喂给详情面板（每一张卡片都拿不到结论）').toContain('followUpOf={followUps.verdictOf}');
  });

  it('「追问」打开的是这个候选的日志抽屉（输入区在 footer 上），并把在途态透下去', () => {
    const text = source();

    expect(text, '「追问」没有打开日志抽屉：点了什么都不发生').toContain(
      'onFollowUpCandidate={(candidateId) => setDrawer({ kind: \'log\', candidateId, followUp: true })}',
    );
    expect(text, '没有透在途态：追问按钮不会转圈，连点两次就是两段上下文').toContain('followingUp={isFollowingUp}');
    // 抽屉工具条上的**第二个入口**：漏接的症状是那颗图标按钮永远不出现，或者点了不换输入区
    const compact = text.replace(/\s+/g, ' ');
    expect(compact, '日志抽屉没有接「追问」入口：工具条上那颗图标按钮不会出现').toContain('onFollowUp={() => {');
    expect(compact, '抽屉的追问入口没有把底部槽翻成追问输入区').toContain(
      'setDrawer({ kind: \'log\', candidateId: logCandidateId, followUp: !open })',
    );
    // **开合**：先读当前是不是已经开着，再取反。写死成 `true` 的症状是「再点一次收不回去」，
    // 而单点一次的用例全绿——判据必须落在「读 open 再取反」这一步上
    expect(compact, '「追问」入口不是开合的：再点一次收不回输入区').toContain(
      'const open = drawer?.kind === \'log\' && drawer.followUp === true;',
    );
    expect(compact, '抽屉的追问按钮没有拿到服务端判据：会永远停在禁用态').toContain(
      'followUpVerdict={logCandidateId === null ? undefined : followUps.verdictOf(logCandidateId)}',
    );
  });

  it('底部槽的追问输入区接上了写动作与附件上传（缺一个就是「点了没反应」或「附件发不出去」）', () => {
    const text = source();

    expect(text, '页面没有渲染追问输入区').toContain('<FollowUpComposer');
    expect(text, '追问输入区没有接写动作').toContain('await followUpCandidate({');
    // 附件走**同一条 multipart 端点**（落点是同一个 candidateDir/attachments/<messageId>/）
    expect(text, '追问的附件没有落在与人工消息同一条上传通路上').toContain('onUploadAttachment={async (input) => postInjectAttachment(');
    // 失败原因交回调用方提示（这一层是页面上唯一的提示出口）
    expect(text, '追问的失败原因没有交回页面提示').toContain('onError={(cause) => void message.error(describeError(cause))}');
    // 两支 footer 互斥且都在：跑动中那一支不能被这一支顶掉
    expect(text, '底部槽没有把两支输入区合起来判空').toContain('const logFooter = followUpFooter ?? injectFooter;');
    expect(text, '底部槽没有真的接上（`footer` 一个节点都不渲染）').toContain('{ footer: logFooter }');
  });

  it('追问输入区只在「这个候选不在跑」时渲染（在跑的那条走排队输入区）', () => {
    const text = source();
    // jsx 里的换行与缩进不该打红这条判据：归一化空白之后再找那一段
    const compact = text.replace(/\s+/g, ' ');
    expect(compact, '追问输入区没有跟着「不在跑」判：在跑的候选会长出一个点了会被 409 拒的输入框').toContain(
      'drawer?.kind === \'log\' && drawer.followUp === true && logCandidate !== undefined && !isRunningCandidate(logCandidate.status)',
    );
  });
});

/**
 * **run 焦点的接线**守卫（本页是焦点的唯一写入方）。
 *
 * 与上面同一类缺口：`@aieval/client` 有焦点单例的用例、待答队列有「暂缓」的用例，
 * 而「页面有没有在选中某一轮时写焦点」两边都看不见——漏写的症状是**暂缓在生产里不存在**
 * （切走的那一轮的提问照旧弹出来），而客户端那几条暂缓用例全绿（它们直接把焦点喂给 hook）。
 */
describe('runs 页面的 run 焦点接线', () => {
  /** 归一化空白之后再断言：换行与缩进不该打红这两条判据 */
  const compactSource = (): string => readFileSync(pagePath, 'utf8').replace(/\s+/g, ' ');

  it('右栏选中哪一轮就把焦点设成那一轮（跟着 `selectedId` 走）', () => {
    const text = compactSource();

    expect(text, '页面没有设 run 焦点——暂缓在生产里不存在').toContain(
      'useEffect(() => { setFocusedRun(selectedId); }, [selectedId])',
    );
  });

  it('离开本页即复位（不复位 = 焦点一直挂在上一轮上，别的页面的提问再也不弹）', () => {
    const text = compactSource();

    expect(text, '页面卸载时没有复位焦点').toContain('useEffect(() => () => setFocusedRun(null), [])');
  });
});

/**
 * `image-view` 块的缩略图接线。
 *
 * 为什么需要：缩略图的 URL 由页面拼（只有页面知道这个候选是哪一轮的哪一行），而**漏传
 * `imageSrcOf` 时组件不报错**——它只是退化成一句「当前视图不提供图片预览」，看起来像配置问题。
 * 这条守卫钉两件事：URL 的形状（路由 + 候选 id + 编码）与**有没有传进抽屉**。
 */
describe('runs 页面的图片接线', () => {
  /** 归一化空白之后再断言：换行与缩进不该打红这两条判据 */
  const compactSource = (): string => readFileSync(pagePath, 'utf8').replace(/\s+/g, ' ');

  it('URL 由页面拼：读该候选工作区的那条路由 + 候选 id，查询值编码一次', () => {
    const text = compactSource();

    expect(text, '没有拼图片 URL（组件会退化成「不提供预览」）').toContain(
      '`/api/runs/${runId}/candidates/${logCandidateId}/image?path=${encodeURIComponent(previewPath)}`',
    );
  });

  it('拼好的 resolver 传进执行日志抽屉（漏传 = 缩略图永远不出现）', () => {
    const text = compactSource();

    expect(text, 'AgentLogDrawer 没有接 imageSrcOf').toContain(
      '{...(imageSrcOf === undefined ? {} : { imageSrcOf })}',
    );
  });
});
