/**
 * 带**真重试**的子树回收（2026-10-07）。
 *
 * 为什么不能交给 `rmSync` 的 `maxRetries` / `retryDelay`：本机实测（Node v26.7.0 / Windows）
 * 那一对参数**形同虚设**——重试白名单（`EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`/`EPERM`）只存在于
 * **异步** `fs.rm` 那条路（`internal/fs/rimraf` 的 `retryErrorCodes`），而 `rmSync` 直接下沉 C++
 * （`binding.rmSync(path, maxRetries, recursive, retryDelay)`）⇒ 一个**已经空了**的目录照样 3ms 就抛
 * `EPERM`，给多少 `maxRetries` 都没重试过一次（2026-10-01、2026-10-07 两次实测；
 * 同场景异步 `fs.rm` 631ms 内自愈）。同一事实在 `testing/cleanup.ts` 的文件头也登记过。
 *
 * 而锁常常是**瞬时**的：持锁者是刚退出的子进程（git、厂商 CLI）、杀软或索引器，
 * Windows 上句柄释放晚几毫秒到几秒。行产物清理过去是「一次 `rmSync` 不成就折成 INTERNAL」——
 * 一次瞬时占用就能把一行判死，而且**每次重跑都会再死一次**（锁没消失之前，失败是稳定的）。
 *
 * 三条口径：
 *  1. **有界**：默认 6 次 × 250ms ≈ 1.5s（正常路径一次就删掉，根本不进重试；真遇到长时间占用也只
 *     多花这 1.5s，而不是把整轮卡住）；
 *  2. **只重试值得重试的错误**：白名单与 Node 异步 `rimraf` 同表（EPERM/EBUSY/EACCES/ENOTEMPTY/
 *     EMFILE/ENFILE）；其余错误（含代码写错、路径不存在）一次就返回，不做无谓等待；
 *  3. **超限不在这里抛**：把最后一次错误原样交给调用方——由它决定折成什么中文原因、要不要带上
 *     「谁可能占着它」的提示（行产物那一处正是这么用的）。
 */
import { rmSync } from 'node:fs';
import { createLogger } from './logger';

const log = createLogger('fs');

/** 重试次数上限（含首次尝试） */
export const REMOVE_TREE_ATTEMPTS = 6;
/** 两次尝试之间的等待（毫秒） */
export const REMOVE_TREE_RETRY_DELAY_MS = 250;

/** 值得重试的 errno，与 Node 异步 `rimraf` 的 `retryErrorCodes` 同表 */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

export interface RemoveTreeOutcome {
  /** 删掉了吗 */
  removed: boolean;
  /** 实际尝试了几次（首次也算一次） */
  attempts: number;
  /** 最后一次的错误（`removed: true` 时为 null） */
  lastError: unknown;
}

export interface RemoveTreeOptions {
  /** 尝试次数上限；测试里调小，避免用例白等 */
  attempts?: number;
  /** 两次尝试之间的等待毫秒数 */
  delayMs?: number;
  /** 删除动作的注入点（默认 `fs.rmSync`，`recursive + force`）；生产调用方一律不传 */
  remove?: (target: string) => void;
  /** 等待的注入点（默认真等）；测试里换成立即返回 */
  wait?: (ms: number) => void;
  /** 「这个错误值不值得再试一次」的判据注入点 */
  isRetryable?: (error: unknown) => boolean;
}

/** 同步睡一小会儿（本模块跑在同步路径上：`prepareRowWorkspace` 全程同步，没有 await 可用） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 这个错误值不值得再试一次（判据见文件头第 2 条） */
export function isRetryableRemoveError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

/**
 * 删掉一棵子树，瞬时占用就地重试。**不抛**：结论与最后一次错误都在返回值里。
 */
export function removeTreeWithRetry(target: string, options: RemoveTreeOptions = {}): RemoveTreeOutcome {
  const attempts = options.attempts ?? REMOVE_TREE_ATTEMPTS;
  const delayMs = options.delayMs ?? REMOVE_TREE_RETRY_DELAY_MS;
  const remove = options.remove ?? ((one: string) => rmSync(one, { recursive: true, force: true }));
  const wait = options.wait ?? sleepSync;
  const isRetryable = options.isRetryable ?? isRetryableRemoveError;

  let lastError: unknown = null;
  let attempt = 0;
  for (attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(target);
      // 第一次就成功是常态：只有真的重试过才值得留痕（否则行日志会被这类 INFO 淹掉）
      if (attempt > 1) log.info('子树回收在重试后成功（瞬时占用）', { target, attempt });
      return { removed: true, attempts: attempt, lastError: null };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt >= attempts) break;
      // WARN 而不是 DEBUG：它解释了「为什么这一次准备慢了几百毫秒」，也是锁的来源线索
      log.warn('子树被占用，稍后重试删除', {
        target,
        attempt,
        code: (error as NodeJS.ErrnoException).code,
        reason: error instanceof Error ? error.message : String(error),
      });
      wait(delayMs);
    }
  }
  return { removed: false, attempts: attempt, lastError };
}
