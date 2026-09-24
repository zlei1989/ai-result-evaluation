/**
 * 路径工具与工作区根目录校验。
 * 为什么校验要「真写一次再删」：只检查父目录是否存在远远不够——
 * 磁盘满、无权限、路径过长、路径被同名文件占住，这些都只在**真正写入**时才暴露。
 * 提前用一个随机名探针文件试写一次，能把失败暴露在设置页而不是第一次跑评测时。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ServiceError } from '@aieval/contracts';
import { createLogger } from './logger';

const log = createLogger('paths');

/** 盘符形式（`D:/…`、`D:\…`）：POSIX 上 `isAbsolute()` 认不出来，得单独识别一次 */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * 开头的 `~` 展开为家目录，并把相对路径解析为绝对路径（避免 CWD 漂移导致产物散落）。
 * 已经是绝对路径的输入**原样返回**：`resolve()` 会重写分隔符与根形式
 * （Windows 上 `D:/a/b` → `D:\a\b`，`/tmp/x` → `D:\tmp\x`），等于把用户填的路径
 * 悄悄换成另一个字符串——回显、日志与相等比较都会对不上，而它本来就已经是绝对路径。
 */
export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(join(homedir(), input.slice(2)));
  return isAbsolute(input) || WINDOWS_DRIVE.test(input) ? input : resolve(input);
}

/** 默认工作区根目录（与设置默认值同源） */
export function defaultWorkspaceRoot(): string {
  return expandHome('~/.runs');
}

/**
 * 只做展开、**不碰磁盘**的版本，供「读取路径」使用。
 * 读取时绝不能做可写性校验——目录可能正被临时卸载，此时抛错会让用户连设置页都打不开。
 * 空串回落到 `defaultWorkspaceRoot()` 而不是再写一遍 `'~/.runs'`：默认根目录的字面量
 * 只留 `defaultWorkspaceRoot` 一处真源，这里抄第二份就是一处会漂移的重复。
 */
export function resolveRootForRead(root: string): string {
  return root === '' ? defaultWorkspaceRoot() : expandHome(root);
}

/**
 * 校验工作区根目录可用：展开 → 建目录 → 试写一个探测文件再删 → 返回解析后的绝对路径。
 * 任一步失败抛 NOT_WRITABLE 并带上失败路径，供设置页直接展示。
 */
export function validateWorkspaceRoot(root: string): { resolved: string } {
  if (root.trim() === '') {
    throw new ServiceError('NOT_WRITABLE', '工作区根目录不能为空');
  }
  const resolved = expandHome(root);
  try {
    mkdirSync(resolved, { recursive: true });
  } catch (error) {
    throw new ServiceError('NOT_WRITABLE', `无法创建工作区根目录：${resolved}（${reason(error)}）`, { cause: error });
  }

  // 真写一次：用随机名避免与并发校验撞车。
  // 写的是**文件**不是子目录：判据是「这个目录能不能落盘」，而建子目录再删会多一次 mkdir
  // 与一次 rmdir，任一步失败都要单独解释；写一个文件更直接地命中「不可写」。
  const probe = join(resolved, `.aieval-probe-${randomSuffix()}`);
  try {
    writeFileSync(probe, '', 'utf8');
  } catch (error) {
    throw new ServiceError('NOT_WRITABLE', `工作区根目录不可写：${resolved}（${reason(error)}）`, { cause: error });
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // 探测文件删不掉不影响「可写」这个结论，留个 WARN 即可
      log.warn('工作区探测文件未能删除', { probe });
    }
  }
  return { resolved };
}

/** 取错误的人类可读原因（error 不一定是 Error） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 随机后缀：`Math.random().toString(16)` 的小数片段，长度**不固定**
 * （`0.5` → `"8"`，接近 0 的值 → `""`），并不是「8 位十六进制」。
 * 撞名概率仍可忽略；写入故意用非独占打开（不加 `wx`）：万一同名撞上，
 * 独占写会把一次正常校验误判成 NOT_WRITABLE，而普通写最多覆盖一个本就要删掉的名字。
 */
function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10);
}
