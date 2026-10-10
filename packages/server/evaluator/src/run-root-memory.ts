/**
 * 「这一轮自己的根」的进程内记忆。
 *
 * 存在理由：`listRuns` / `getRun` 的读侧口径是「只扫当前 `settings.workspaceRoot`」（裁决口径、
 * 见 run-store 文件头口径 4），而一轮评测进行中用户完全可能去设置页改根目录。改完之后，
 * 对**事件路径尚未缓存的行**（同一轮的后续行）调用 `publishRowEvent` 时，`getRun` 会抛 NOT_FOUND——
 * 于是一次设置变更会把一个**在途轮次中途打死**。这条兜底是明写的：
 * 「同进程内另靠『记住 runId → workspaceBase』兜住」。
 *
 * 为什么单独一个模块而不是把记忆放进 `events.ts`：登记它的写侧在 `run-store.ts`（只有那里知道
 * 这一轮落在哪个根），而 `events.ts` 已经依赖 `run-store.ts` 的 `getRun`。把记忆放在 `events.ts`
 * 就会得到 `run-store → events → run-store` 的循环 import（ESM 下能跑，但静态分析看不懂、
 * 两个模块也就此绑死）。记忆本身与「谁写谁读」无关，抽成一个只依赖 contracts 的小模块，
 * 依赖方向保持单向：`run-store → run-root-memory`、`events → run-root-memory`。
 *
 * 为什么可以常驻、不需要失效（三条逐一想过）：
 *   ① runId 是服务端 `createRun` 用 `randomUUID()` 生成的，「同一个 runId 换个根重名」不可能发生——
 *      每一条记忆天然指向唯一一轮，不存在要靠 TTL 纠正的错配；
 *   ② 兜底**只在当前根查不到时才用**（`run-store.ts` 的 `getRunForWrite`）：run.json 一旦在当前根里
 *      存在，读到的就是它与 `getRun` 逐字一致的答案，记忆根本不参与，不会「把新根的结果盖成旧根的」；
 *   ③ 进程重启后记忆为空是**正确**行为、不是缺陷：「跨重启 + 改过根目录的旧轮次
 *      既不在列表也 getRun 不到」，那时就是「找不到」。常驻也不会长成泄漏——
 *      上界是「本进程写过快照的轮次数」，每项只是一个 UUID 加一条路径。
 *
 * 注意：本模块不做任何 I/O，也不读设置。唯一的「判断」是下面这条 runId 形状判据——它住在**调用方**
 * 之前（本模块自己不是路径的使用者），之所以放这里而不是各写一份：`run-store` 的 `assertRunId` 与
 * `rememberRunRoot` 用的是**同一条规则**，两份拷贝早晚分叉。
 */
import { ServiceError } from '@aieval/contracts';

/** `runId` → 这一轮自己记录的根（`run.workspaceBase`） */
const runRoots = new Map<string, string>();

/**
 * runId 的**路径形状**判据：空串、以 `.` 开头、含 `/`、`\`、`..` 一律不合法。
 * 为什么抽成一处：`run-store` 的 `assertRunId`（写/读入口）与本模块的 `rememberRunRoot`（登记守卫）
 * 必须逐字同口径——同一份规则写两遍，改一处就会分叉，而分叉的代价是「非法 id 从另一扇门进来」。
 */
export function isRunIdShapeValid(runId: string): boolean {
  return !(runId === '' || runId.startsWith('.') || runId.includes('/') || runId.includes('\\') || runId.includes('..'));
}

/**
 * 登记「这一轮自己的根」。**只由 `run-store.saveRun` 调用**——写侧唯一知道该轮落点的位置，
 * 调用点在写侧自检通过之后、落盘之前：形状不合契约的快照会在那里抛错，不该留下记忆。
 *
 * 为什么在这里也判一次 runId 形状（而不是信任调用方）：这个值会被拼进事件文件路径。判据与
 * `run-store` 的 `assertRunId` 共用 `isRunIdShapeValid`（同一条规则）；今天 `saveRun` 已经先判过，
 * 所以这条守卫从唯一调用点**不可达**——保留它是**纵深防御**，不是重复判据：万一下一个调用方忘了先判，
 * 坏 id 仍然进不了记忆。形状非法时抛 `INVALID_QUERY`（与形状校验同码、同中文口径），而不是静默跳过：
 * 能走到这里说明数据是我们自己造的，非法形状属于「本不该发生」；静默接受只会把坏 id 记进记忆，
 * 让出错点离现场更远。
 */
export function rememberRunRoot(runId: string, workspaceBase: string): void {
  if (!isRunIdShapeValid(runId)) {
    throw new ServiceError('INVALID_QUERY', `评测 id 不合法，不能登记进事件总线的根目录记忆：${runId}`, {
      context: { runId },
    });
  }
  runRoots.set(runId, workspaceBase);
}

/** 取回记忆里的根；没有这个 runId 时返回 undefined（由调用方决定是否退回它原来的失败） */
export function recalledRunRoot(runId: string): string | undefined {
  return runRoots.get(runId);
}

/**
 * 忘掉这一轮（**唯一**该主动失效的时刻：删除评测）。
 *
 * 为什么删除必须忘：`getRunForWrite` 只在「当前根里找不到」时才查记忆——而「找不到」正是删除之后
 * 的形状，于是记忆会把一次「找不到」答成一条旧根路径，`deleteRun` 自己的存在性检查也就形同虚设。
 * 其它时刻常驻、不需要失效的三条理由见文件头；本函数不改变那三条中的任何一条。
 */
export function forgetRunRoot(runId: string): void {
  runRoots.delete(runId);
}
