/**
 * 运行快照落盘：`{该轮自己的 workspaceBase}/{runId}/run.json` 的读写。
 * 本文件按接口契约 §5 的签名实现（用例域要数「引用该用例的评测数」，编排域要写快照）。
 *
 * 四个口径：
 *   1. **写盘原子**（临时文件 + rename）：快照是评测的唯一落盘真相，写到一半崩溃会让整轮评测不可读；
 *      不先删目标再 rename——两步之间崩溃会让快照彻底消失。**唯一的例外是目标只读**：这种目标上裸 rename
 *      必失败，只能先删再重试；而那个删除真的会制造一个「快照不存在」的窗口（getRun / SSE 会读到 NOT_FOUND），
 *      所以绝不在其它成因下走它（成因判定见 saveRun 的 catch，口径照 config-store）；
 *   2. **列表读容忍坏文件**：单个损坏的 run.json 只跳过并记 WARN。让一个坏文件把整个评测列表打不开，
 *      是把「一轮评测的本地故障」放大成「全站不可用」。**跳过必须可见**（spec §10）：`listRuns` 在
 *      同一趟扫描的最后对「读得出但已不合契约」的旧快照数记**一条汇总 WARN**（不是每个文件一条）——
 *      否则「评测记录凭空少了几轮」没有任何东西能把它与「产物真的没了」分开；
 *   3. **按用例筛选用用例 id 精确匹配**，不用标题——标题会重名、会被改，拿它筛必然出错；
 *   4. **写侧用该轮自己记录的根，读侧只扫当前设置里的根**（读侧口径见 R10）：一轮评测进行中用户改了
 *      工作区根目录时，该轮的全部产物必须**整体留在旧根**（events.ts 也是按 `run.workspaceBase` 定位的），
 *      否则快照进新根、事件留旧根，这一轮的产物裂成两半——比「找不到」更难查。把根目录改回去即可恢复可见。
 *      在途轮次（编排层）自己读写时走 `getRunForWrite`：同一个「当前根优先、进程内记忆兜底」的解析，
 *      与事件路径（events.ts）**同一个入口**——只兜事件侧会让行停在非终态（评审 H1）。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { EvalRunSchema, ServiceError, type EvalRun } from '@aieval/contracts';
import { createLogger, loadConfig, resolveRootForRead, runDir, runSnapshotFile } from '@aieval/core';
import { isRunIdShapeValid, recalledRunRoot, rememberRunRoot } from './run-root-memory';

const log = createLogger('run-store');

/**
 * 当前工作区根目录：**每次现取**而不是模块加载时缓存一次——
 * 设置页刚改完根目录，列表就该指向新根；缓存会让「改了设置但列表还是空的」变成幽灵问题。
 * `resolveRootForRead` 负责把配置里保留的可读写法 `~/.runs` 展开成绝对路径。
 */
function workspaceRoot(): string {
  return resolveRootForRead(loadConfig().settings.workspaceRoot);
}

/**
 * 一次扫描的记账（只有 `listRuns` 传它）。
 *
 * `incompatible` = **JSON 读得出来、却过不了 `EvalRunSchema`** 的文件数。评分口径升级后的旧
 * `run.json` 就是这个形状（重构前没有 `rubric` 快照这一格），而 `readSnapshot` 对它们只记一句
 * 每文件的 WARN 就返回 null ⇒ 列表**静默变短**（spec §10：症状是「评测记录凭空少了几轮」）。
 * 为什么要单独汇总一条：一条 per-file WARN 说明「哪个文件坏了」，却回答不了「列表为什么短」——
 * 排障的人要能一眼把「旧轮次被跳过」与「产物真的没了 / 根目录改错了」分开。
 * 为什么**不把「读不出」（JSON 坏了）也数进来**：那一类的 per-file WARN 里带着文件路径与解析错误，
 * 处置是修文件；汇总句写的是「因评分口径升级不再兼容」，把损坏文件混进这个数会让这句话说假话。
 */
interface ScanTally {
  incompatible: number;
}

/**
 * 读单个快照：不存在或读不出都返回 null（列表路径不允许抛）。
 * 传了 `tally` 才记账（`listRuns` 的那个计数）；`getRun` 那条路只关心这一个文件读不读得出来。
 */
function readSnapshot(file: string, tally?: ScanTally): EvalRun | null {
  if (!existsSync(file)) return null;
  try {
    // BOM 容忍与 config-store 同口径：外部工具写过的 JSON 可能带 U+FEFF，JSON.parse 遇到它直接抛
    const parsed = EvalRunSchema.safeParse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    if (!parsed.success) {
      if (tally !== undefined) tally.incompatible += 1;
      log.warn('运行快照字段不合法，已跳过', { file, issueCount: parsed.error.issues.length });
      return null;
    }
    return parsed.data;
  } catch (error) {
    log.warn('运行快照读不出，已跳过', { file, reason: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * 全部运行快照；根目录不存在时返回空数组（从没跑过评测是正常状态，不是错误）。
 *
 * **整趟扫描只在最后记一条汇总 WARN**（口径 2 的另一半，spec §10 要求的「可见性」）：
 * 扫到的快照里有 N 个读得出但已不合契约（旧口径的轮次）时，记「有 N 轮不再兼容、列表会比磁盘上少」
 * 一条，而不是每个文件一条（per-file WARN 已经在 `readSnapshot` 里有了）。
 * 为什么落在这里而不是启动钩子里：**这里是唯一一次同时看得见「读出来的」与「被跳过的」的扫描**——
 * `recoverInterruptedRuns()`（启动钩子唯一的入口）拿到的已经是 `listRuns()` 过滤后的结果，
 * 被跳过的旧轮次在那一步根本不存在，它想数就只能再扫一遍盘。落在扫描点上，启动钩子那一趟
 * （它第一步就是 `listRuns()`）照样会在启动时打出这条汇总，日常的列表读取也会带上它——
 * 与 per-file WARN 同一节奏，而「列表短了」与「为什么短」永远在同一条日志流里挨着。
 */
export function listRuns(): EvalRun[] {
  const root = workspaceRoot();
  if (!existsSync(root)) return [];
  const runs: EvalRun[] = [];
  const tally: ScanTally = { incompatible: 0 };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // 只认目录：同一个根目录下还住着 cases/（用例级缓存仓库）与各种临时文件
    if (!entry.isDirectory()) continue;
    const run = readSnapshot(runSnapshotFile(root, entry.name), tally);
    if (run !== null) runs.push(run);
  }
  if (tally.incompatible > 0) {
    log.warn('有运行快照因评分口径升级不再兼容，已从列表跳过（列表显示的轮次会比磁盘上的少）', {
      root,
      incompatible: tally.incompatible,
    });
  }
  return runs;
}

/** 某个用例的全部运行快照（删用例前要数它，用例详情将来要显示它） */
export function listRunsForCase(caseId: string): EvalRun[] {
  return listRuns().filter((run) => run.caseId === caseId);
}

/**
 * runId 的**路径形状**校验。
 *
 * `getRun` / `saveRun` 把 runId 直接拼进路径（`{workspaceRoot}/{runId}/run.json`），带 `..` / 分隔符 /
 * 绝对路径的 id 会让 `join` 逃出 workspaceRoot——`saveRun` 甚至会在根目录之外建目录并写文件。
 * 空串同样拒绝：`join(root, '')` 把快照写到 `{workspaceRoot}/run.json`，那既不是任何一轮评测的目录，
 * `listRuns` 也永远看不到它。
 *
 * 为什么校验落在这里而不是调用方：这是唯一的路径拼接点。今天调用方都传 `randomUUID()`，但 p5 的
 * `GET /api/runs/{runId}` 会把**用户可控的 URL 段**喂给 `getRun`，而契约 §5 的签名不做任何形状约束。
 *
 * 判据本身是 `run-root-memory` 的 `isRunIdShapeValid`（登记守卫用的是同一条规则，评审 N1）：
 * 两处各写一份，改一处就会分叉，而分叉的代价是「非法 id 从另一扇门进来」。
 */
function assertRunId(runId: string): void {
  if (!isRunIdShapeValid(runId)) {
    throw new ServiceError('INVALID_QUERY', `评测 id 不合法（不能为空、不能是 . 或 .. 开头、不能含路径分隔符）：${runId}`, {
      context: { runId },
    });
  }
}

/** 盘符形式（`D:/…`、`D:\…`）：POSIX 上 `isAbsolute()` 认不出来，与 core 的 `expandHome` 同口径单独识别一次 */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * `workspaceBase` 的**形状**校验（与 `assertRunId` 并列，理由同 R36：它也是直接拼进路径的字段）。
 *
 * `saveRun` 的落盘位置**完全取自这一项**（`runDir(root, id)`），而契约的 `EvalRunSchema.workspaceBase`
 * 只是 `z.string()`——没有 `.min(1)`、没有绝对路径约束。形状不对的值会让产物写到**读侧永远看不到的地方**：
 *   · `''` ⇒ `runDir('', id) = join('', id)`，即**进程 CWD** 下的 `<runId>/`；`events.jsonl` 也跟着过去
 *     （`getRunForWrite` 的兜底返回的也是 `''`），一轮评测的产物散落在启动目录里；
 *   · `'~/.runs'`（设置里合法的可读写法）⇒ 写进**字面 `~` 目录**，而读侧 `resolveRootForRead` 会把它
 *     展开成家目录下的真实路径 ⇒ 写进去的东西永远读不出来。
 * 「今天创建点都写绝对路径」（p5 的 `createRun` 走 `resolveRootForRead`）不是安全论证——写侧已经在
 * 依赖它了，R36 的教训正是「只有 randomUUID() 会进来」当日就被探针推翻。
 * 检查顺序：写完侧自检之后（此时才确定是字符串）、`rememberRunRoot` 之前——坏根不许进记忆。
 */
function assertWorkspaceBase(runId: string, root: string): void {
  if (root === '' || !(isAbsolute(root) || WINDOWS_DRIVE.test(root))) {
    throw new ServiceError('INVALID_QUERY', `运行快照的工作区根目录不合法（不能为空、必须是绝对路径）：${root}`, {
      context: { runId, workspaceBase: root },
    });
  }
}

/** 在**指定的根**下读一个快照：不存在抛 NOT_FOUND，损坏抛 INTERNAL（两者都带路径，便于直接去磁盘上核对） */
function readRunAt(root: string, runId: string): EvalRun {
  const file = runSnapshotFile(root, runId);
  if (!existsSync(file)) {
    throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`, { context: { runId } });
  }
  const run = readSnapshot(file);
  if (run === null) {
    // 具体原因已经由 readSnapshot 记进 WARN 日志；对外只给可展示的中文原因 + 路径
    throw new ServiceError('INTERNAL', `评测快照读不出（文件可能损坏）：${file}`, { context: { file } });
  }
  return run;
}

/**
 * 取单个快照（**对外读入口**）：不存在抛 NOT_FOUND，损坏抛 INTERNAL。
 * 读侧口径 = **只扫当前 `settings.workspaceRoot`**（R10 的裁决，p5 的路由用的就是它）。
 */
export function getRun(runId: string): EvalRun {
  assertRunId(runId);
  return readRunAt(workspaceRoot(), runId);
}

/**
 * 在途轮次（编排层）读写快照的入口：**按这一轮自己记录的根**解析，而不是当前设置里的根。
 *
 * 与 `getRun` 的唯一差别是「当前根找不到时用进程内记忆兜底」（R10 的『记住 runId → workspaceBase』）。
 * 为什么必须有这个入口（评审 H1）：`getRun` 只扫当前根，而用户在评测进行中把工作区根目录从 A 改到 B 后，
 * 编排层第一次 `requireRow` 就抛 NOT_FOUND ⇒ `settleFailed` 也要先 `requireRow` ⇒ **行停在非终态**、
 * 只留一行 ERROR 日志——R10 想消灭的「一次设置变更把在途轮次打死」换个扇门照样发生。
 * 事件路径（`events.ts`）与快照路径现在共用这一个解析，两边的兜底口径不可能再分叉。
 *
 * 关键取舍（与 events.ts 原来的口径逐字一致）：**兜底只覆盖「这一轮不在当前根里」这一种失败**。
 *   · 其它失败（INVALID_QUERY 形状非法、INTERNAL 快照损坏）原样冒出去——它们各有各的处置，
 *     拿一个旧根去重试只会让「形状不对」伪装成「根不对」，把排查引向完全错误的方向；
 *   · 记忆里没有这个 runId 时同样原样冒 NOT_FOUND——那正是 R10 明确接受的局限
 *     （进程重启后 + 改过根目录），此时「找不到」就是正确结论。
 * **`getRun` 的对外语义不受影响**：它仍然只扫当前根（p5 的列表 / 详情路由要的就是「当前根里有什么」）。
 */
export function getRunForWrite(runId: string): EvalRun {
  assertRunId(runId);
  try {
    return readRunAt(workspaceRoot(), runId);
  } catch (error) {
    if (!(error instanceof ServiceError) || error.code !== 'NOT_FOUND') throw error;
    const remembered = recalledRunRoot(runId);
    if (remembered === undefined) throw error;
    // 记 WARN 而不是 DEBUG：这是「用户改了根目录，但这一轮仍在旧根下继续跑」的事实，
    // 排查「产物怎么在旧根里」时它是唯一的线索，不该只活在 debug 级别里。
    log.warn('当前工作区根目录下找不到这一轮，按进程内记忆读写它自己的根（R10）', {
      runId,
      workspaceBase: remembered,
    });
    return readRunAt(remembered, runId);
  }
}

/**
 * 目标文件是否只读。用于区分 rename 覆盖失败的两种成因（口径同 config-store）。
 * Windows 无 POSIX 权限位，libuv 用写位表达文件系统的只读属性（只读文件报 0444），
 * 故判断 `(mode & 0o200) === 0` 在两个平台都成立。
 * 文件不存在时返回 false：目标不存在就无需删除，rename 会直接创建它。
 */
function isReadOnly(file: string): boolean {
  const stat = statSync(file, { throwIfNoEntry: false });
  return stat !== undefined && (stat.mode & 0o200) === 0;
}

/**
 * 原子写快照：建运行目录 → 写临时文件 → rename 覆盖。
 * 每次都整体覆盖（调用方传的是完整快照）——不做增量合并，避免出现「两份真相」。
 *
 * 根目录取自 **`run.workspaceBase`（该轮自己记录的根）**，不是当前 `settings.workspaceRoot`：
 * 这与 `events.ts` 的 `rowEventsFile(getRunForWrite(runId).workspaceBase, …)` 同源，保证「一轮的产物不裂成两半」
 * （口径 4）。用当前设置的话，用户在评测进行中改一次根目录，快照就会写进新根、事件留在旧根——
 * 这一轮的行状态与事件日志分居两处，界面显示的行状态与日志抽屉对不上，而两边都不报错。
 */
export function saveRun(run: EvalRun): void {
  assertRunId(run.id);
  // 写侧自检（§11 R26 的同一条原则，与 event-log 的写入点校验对齐）：读侧 readSnapshot 用的是 safeParse，
  // 它遇到不合契约的字段只 WARN 一句就跳过，于是脏数据照样写进磁盘、却在 listRuns 里**静默消失**
  //（这一轮评测从列表里凭空不见、两端都不报错，只有 getRun 会抛 INTERNAL）。
  // 校验必须在写入点，且落盘的是**校验后的对象**而不是原对象——否则「校验归校验、写归写」：
  // `JSON.stringify(NaN)` 会把它改写成 `null`，脏数据依旧混进磁盘，而原始信息已经丢了。
  // 校验先于 mkdir：形状不对时盘上连目录都不该留下。
  // 拒绝时抛**中文 ServiceError**（口径同 core 的 appendEvent 写侧校验）：本包对外的错误面只有
  // 「code + 可直接展示的中文原因」这一种，裸 ZodError 冒到路由层等于给使用者一段英文 zod 文案。
  const checked = EvalRunSchema.safeParse(run);
  if (!checked.success) {
    const issues = checked.error.issues;
    const detail = issues
      .slice(0, 3)
      .map((issue) => `${issue.path.length === 0 ? '（根对象）' : issue.path.join('.')}：${issue.message}`)
      .join('；');
    const more = issues.length > 3 ? `；另有 ${issues.length - 3} 处` : '';
    throw new ServiceError('INTERNAL', `运行快照不符合契约，写入被拒绝（${run.id}）：${detail}${more}`, {
      cause: checked.error,
      context: {
        runId: run.id,
        issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
  }
  const parsed = checked.data;
  const root = parsed.workspaceBase;
  // 落盘位置取自这一项 ⇒ 它的形状必须在这里拦住（空串写 CWD、`~` 写进字面目录，读侧永远看不到）。
  // 位置紧跟写侧自检：契约只保证 workspaceBase 是字符串，绝对路径是**写侧的额外要求**（M2）。
  assertWorkspaceBase(parsed.id, root);
  // 把「这一轮自己的根」登记进事件总线的进程内记忆（R10，记忆本体在 run-root-memory.ts）：
  // 一轮评测进行中用户改了工作区根目录后，events.ts / getRunForWrite 对**这一轮**会查不到，
  // 而那是「在途轮次中途崩（或停在非终态）」的成因。登记点选在这里（写侧唯一知道该轮落点的位置、
  // 写侧自检与根形状校验都已通过、尚未落盘）：形状不合契约的快照在上面已经抛错，不会留下记忆；
  // 写盘失败却留下记忆也无害——记忆里的根与快照本该在的那个根是同一个值。
  // 读侧口径不受影响（listRuns / getRun 仍只扫当前根）。
  rememberRunRoot(parsed.id, root);
  mkdirSync(runDir(root, parsed.id), { recursive: true });
  const file = runSnapshotFile(root, parsed.id);
  const tmp = `${file}.tmp`;
  // 快照里含错误堆栈与本机路径：创建时就给 0600（先建后 chmod 之间有一个短暂的可读窗口）
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    // rename 覆盖失败有两种成因，症状同为 EPERM、处置却相反（口径照 config-store，别只抄「同口径」四个字）：
    //   ① 目标只读——替换只读文件在 Windows 上必失败，只能先删目标再重命名；
    //   ② 杀软 / 索引器瞬时占用——纯粹的瞬时失败，重试 rename 就过去了。
    // 把 ② 当成 ① 处理（无条件先删目标）会**白白**制造「快照不存在」的窗口：删除与重命名之间的
    // getRun / SSE 读到的是 NOT_FOUND，而这一刻正是「这一轮写不进磁盘」的故障现场——排障的人会先怀疑
    // 数据丢了，而不是磁盘被占。故只有目标确实只读时才删。
    const readOnly = isReadOnly(file);
    log.warn('rename 覆盖运行快照失败，按目标是否只读决定是否先删除', {
      file,
      readOnly,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (readOnly) rmSync(file, { force: true });
    try {
      renameSync(tmp, file);
    } catch (retryError) {
      // 重试仍失败：把裸 errno 折成可展示的中文原因 + 路径（调用方要处置的是「这一轮写不进磁盘」）。
      // 目标文件保持原样（上面没删它），新内容留在 `run.json.tmp` 里供排查——宁可报错，不静默丢数据。
      throw new ServiceError(
        'INTERNAL',
        `运行快照写入失败（${file}）：${retryError instanceof Error ? retryError.message : String(retryError)}`,
        { cause: retryError, context: { file, tmp } },
      );
    }
  }
}
