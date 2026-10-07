/**
 * 临时目录清理的**有界重试**。测试夹具共用，不进任何产品路径。
 *
 * `rmSync` 的 `maxRetries` / `retryDelay` 在本机（Node v26.7.0 / Windows）**形同虚设**：
 * 白名单（`EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`/`EPERM`）只存在于**异步** `fs.rm` 那条路
 * （`node --expose-internals` 读 `internal/fs/rimraf` 的 `retryErrorCodes` 可见），
 * 而 `fs.rmSync` 直接下沉 C++（`binding.rmSync(path, maxRetries, recursive, retryDelay)`）
 * ⇒ 一个**已经空了**的目录照样 3ms 就抛 `EPERM`，给多少 `maxRetries` 都没重试过一次
 * （2026-10-01 与 2026-10-07 两次实测；同场景异步 `fs.rm` 631ms 内自愈）。
 *
 * 而锁本身是**瞬时的**：持锁者是**刚退出的子进程**——Windows 上句柄释放晚于
 * `execFileSync` 返回几 ms，而本包夹具里的 `.agenthome` 与仓库目录正是 git / agent CLI 的 cwd。
 *
 * 所以重试自己写：短窗口、有上限、超限**只 WARN 不抛**——窗口 10 × 200ms ≈ 2s 是释放时间的
 * 十倍余量，正常路径一次就删掉、根本不进重试；真遇到极端滞留也只 WARN
 * （目录留在系统临时目录里由操作系统回收），因为**为它把门禁拖成红的代价远大于留一个临时目录**。
 */
import { rmSync } from 'node:fs';

const CLEANUP_MAX_TRIES = 10;
const CLEANUP_RETRY_DELAY_MS = 200;

/** 同步睡一小会儿（`afterEach` 里不值得为它把钩子改成 async，而 busy-wait 会占满 CPU） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 带真实重试地删掉一棵临时目录树；超限只 WARN（见文件头的实测理由） */
export function removeTreeWithRetry(target: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= CLEANUP_MAX_TRIES) {
        // 只 WARN：清理竞态不是断言失败。带上路径，便于必要时手工回收。
        console.warn(`[WARN] 清理临时夹具目录失败（已重试 ${attempt} 次，留给系统回收）：${target}`, error);
        return;
      }
      sleepSync(CLEANUP_RETRY_DELAY_MS);
    }
  }
}
