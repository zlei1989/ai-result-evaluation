/**
 * git 进程封装：core 内**唯一**的执行入口（本地与远端调用共用）。
 * `execFileSync` 而不是 `execSync`：参数里有用户填的 URL / 路径 / commit hash，走 shell 会引入注入面。
 * 两个 `-c` 见 git.ts 文件头的口径（非 ASCII 路径不乱码、工作树字节与仓库一致）。
 * 本文件相对 git.ts 多出来的只有两件事：追加环境变量、墙钟超时（远端调用需要）。
 */
import { execFileSync } from 'node:child_process';

export interface GitExecOptions {
  /** 追加/覆盖的环境变量（远端调用用它禁交互式提示，见 mirror.ts 的 remoteOptions） */
  env?: Record<string, string>;
  /**
   * 墙钟上限（毫秒）；到点按 killSignal 杀子进程。
   * Node 把 `timeout: 0` 当作**不设超时**（不是「立即超时」）：非正值等于悄悄关掉这道保证，
   * 远端调用方（构造选项处）不得传非正值。这里**不做钳制**——钳制会把「传错了」变成静默行为。
   */
  timeoutMs?: number;
}

/**
 * 执行一条 git 命令并返回 stdout；失败时原样抛出 `execFileSync` 的错误，由调用方折成 ServiceError。
 * `encoding: 'utf8'` 让中文提交信息与路径不乱码：不给 encoding 拿到的是 Buffer，
 * 换成 latin1 之类同样是 string 但已经是乱码——两种错法都过得了类型检查，只有真跑一条中文命令才看得出来。
 */
export function execute(dir: string, args: string[], options: GitExecOptions = {}): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    // 大仓库的 diff / status 可能超过默认 1MB 的 maxBuffer，直接调大避免静默截断
    maxBuffer: 64 * 1024 * 1024,
    // stdin 必须断开：ssh 拿不到输入时会立即失败，而不是等着谁来敲密码
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: 'SIGTERM' as const }),
  });
}

/** 取 execFileSync 抛出的错误里的 stderr 原文（git 的人类可读报错都在这里） */
export function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

/**
 * 是不是「被我们的墙钟上限杀掉」。
 * 判据是**信号**而不是文案：远端自己报 timeout 的原文里也常有 `timed out`，
 * 按关键词匹配会把「远端不可达」与「我们杀的那次」混成一类（分类顺序：先按信号判超时）。
 * Node 在超时时给错误带上 signal（killSignal）与 code=ETIMEDOUT，两者都认。
 * 对任意抛出值都成立：JS 里什么都能 throw，判定函数自己抛错会把「分类失败」变成新的失败点。
 */
export function isTimeoutKill(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const shape = error as { signal?: unknown; code?: unknown };
  return shape.signal === 'SIGTERM' || shape.code === 'ETIMEDOUT';
}
