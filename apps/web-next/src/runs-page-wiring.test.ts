// @vitest-environment node
/**
 * 日志抽屉的**接线**守卫：页面必须把实时通道的原因喂给 `resolveLogDrawer`。
 *
 * 为什么需要一条读源码的用例：`apps/web-next` 不能写 `.tsx` 测试（AGENT.md 的硬约束：该应用
 * `jsx: preserve`），于是页面这一层没有渲染测试面，判定逻辑只能抽成纯函数（`log-drawer-state`）。
 * 但**纯函数的守卫看不见「调用方有没有把参数传进来」**——p5 阶段评审的 M2 正是这种缺陷：
 * `log-drawer-state` 的 6 条用例全绿，而页面只喂了 `logError: log.error`，`stream.error` 从不进
 * 渲染路径 ⇒ 断流时抽屉只有「还没有日志 + 未连接」，没有原因。评审实测的变异体证明：
 * 把页面那行删掉，纯函数用例**一条都不红**（本文件就是为这个缺口补的守卫）。
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
  it('把实时通道的原因（stream.error）喂进 resolveLogDrawer——M2 的缺陷就是漏了它', () => {
    const call = logDrawerCall();

    // 三个输入位各一条断言：漏任何一个都会在这里红
    expect(call, '少了 events').toContain('events:');
    expect(call, '少了 logError（读文件失败的原因）').toContain('logError:');
    expect(call, '少了 streamError（实时通道的原因）——断流时抽屉就说不出原因了').toContain('streamError:');
    expect(call, '少了 isLoading（「正在读取日志…」那一态）').toContain('isLoading:');
  });

  it('抽屉渲染实时通道提示（有事件时那条非破坏性 warning），而不是把它再丢掉一次', () => {
    const source = readFileSync(pagePath, 'utf8');

    // 判定在纯函数里，渲染在这里；`liveError` 是那条提示的唯一来源
    expect(source).toContain('logState.liveError');
    // 实时通道的提示要有自己的测试锚点（与「读失败」的 failed 分支分开）
    expect(source).toContain('data-testid="run-log-drawer-live-error"');
  });
});

/**
 * 实时指标的**接线**守卫（用户口径，2026-09-26）。
 *
 * 与上面同一类缺口：数据层（`@aieval/client`）与展示层（`@aieval/ui`）各自有自己的用例，
 * 而「页面有没有把它们接上」两边都看不见——漏接的症状就是**界面永远显示「未采集」**，
 * 三个包的用例还全绿。`apps/web-next` 不能写 `.tsx` 测试（AGENT.md 硬约束），
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
    expect(call, '少了 rowIds（没有它就没有任何一行会订阅）').toContain('rowIds');
  });

  it('只订阅**在跑的行**（列表页有几十轮，全订阅就是几十条长连接）', () => {
    const source = readFileSync(pagePath, 'utf8');

    // 行集合必须由快照的在跑状态筛出来：`isRunningRow` 是契约里的同一份判据（准备中/执行中/评分中）
    expect(source, '行集合没有按 isRunningRow 过滤').toContain('.filter((row) => isRunningRow(row.status))');
  });

  it('把实时指标按行注入详情面板（不注入 = 界面永远「未采集」）', () => {
    const source = readFileSync(pagePath, 'utf8');

    expect(source).toContain('liveOf={(rowId) => live[rowId]}');
  });
});

/**
 * 创建面板「默认评分智能体未配置」内联提示的**接线**守卫（Task 1–7 收口，2026-09-26）。
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
   * B（终审 Important）：`cases` 的**未知态**必须原样传下去——不许写成 `cases ?? []`。
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
 * `apps/web-next` 不能写 `.tsx` 测试（AGENT.md 硬约束），故这里按源码文本钉住。
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
    // 也照样通过。实测：删掉 `const { update, isUpdating } = useUpdateRun();` 这一行，
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
   * 少一个锚点的症状是**假报干净**——把那一支改成无条件的「评测已删除」，盘上没能回收的行工作区
   * 就没人再提；`@aieval/client` 只是把这一位原样交出来（它自己的用例覆盖不到页面的文案）。
   */
  it('删除成功如实报告工作区是否回收（workspaceRemoved === false 不许说成干净删除）', () => {
    const text = source();
    // 两支都要在，且**极性**要对：写反了会在「有残留」时报「已删除」、在干净时报「有残留」
    expect(text, '删除提示没有按 workspaceRemoved 分支（或两支写反了）：残留也会被报成干净删除').toContain(
      'workspaceRemoved ? \'评测已删除\'',
    );
    expect(text, '少了「有残留」那一支的文案').toContain('行工作区有残留');
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

  it('创建路径**显式剥掉**行 id（不依赖 zod 对未知键的静默剥离）', () => {
    // 只断言「创建那一支把 rows 重映射过」这一件事：整条表达式逐字匹配会被换行与格式化打红
    const text = source();
    expect(text).toContain('rows: values.rows.map(');
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
