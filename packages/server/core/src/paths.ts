/**
 * 路径工具与工作区根目录校验。
 * 为什么校验要「真写一次再删」：只检查父目录是否存在远远不够——
 * 磁盘满、无权限、路径过长、路径被同名文件占住，这些都只在**真正写入**时才暴露。
 * 提前用一个随机名探针文件试写一次，能把失败暴露在设置页而不是第一次跑评测时。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { SETTINGS_DEFAULTS, ServiceError } from '@aieval/contracts';
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
  return expandHome('~/.aieval-runs');
}

/**
 * 默认用例根目录：环境变量 `AIEVAL_CASES_ROOT` **只做默认值**，设置页一旦填了 `casesRoot` 就以它为准。
 * 为什么不让环境变量压过设置（与 `AIEVAL_CONFIG_DIR` 的优先级相反）：用例根目录是**设置页上可见可改的一格**，
 * 让一个看不见的环境变量压过它，用户改了没反应、也查不出为什么。
 * 空的 `AIEVAL_CASES_ROOT`（容器里注入空值）与「没设」等价，仍回落家目录——
 * `||` 而不是 `??` 的理由与 `getConfigDir()` 那段相同。
 */
export function defaultCasesRoot(): string {
  return expandHome(process.env.AIEVAL_CASES_ROOT || '~/.aieval-cases');
}

/**
 * 只做展开、**不碰磁盘**的版本，供「读取路径」使用。
 * 读取时绝不能做可写性校验——目录可能正被临时卸载，此时抛错会让用户连设置页都打不开。
 * 空串回落到 `defaultWorkspaceRoot()` 而不是再写一遍 `'~/.aieval-runs'`：默认根目录的字面量
 * 只留 `defaultWorkspaceRoot` 一处真源，这里抄第二份就是一处会漂移的重复。
 */
export function resolveRootForRead(root: string): string {
  return root === '' ? defaultWorkspaceRoot() : expandHome(root);
}

/**
 * 用例根目录的**只读解析**，也是「环境变量只做默认值」这条口径的**唯一落点**（两个调用方：
 * `case-store.getCasesRoot` 与 api 的设置归一化）：
 *   · 空 / 缺失          → `defaultCasesRoot()`（`AIEVAL_CASES_ROOT` > 家目录）；
 *   · 等于契约默认字面量 → 同上。**为什么把「等于默认字面量」当成没配过**：`normalizeSettings`
 *     会把缺失的 `casesRoot` 补成契约默认值，而设置页保存下来的永远是**展开后的绝对路径**——
 *     于是「读到的正好是那个字面量」恰好等价于「用户没配过」，此时才轮到环境变量。
 *     手改 config.json 把这一格写成同样的字面量、同时又设了环境变量，环境变量会赢：这是已知代价，
 *     换来的是「设置页上看得见的那一格永远压过看不见的环境变量」。
 *   · 其余               → `expandHome`（不 trim：与工作区那一格同口径，「全是空格」由写入侧拒绝）。
 */
export function resolveCasesRootForRead(root: string | undefined): string {
  if (root === undefined || root === '' || root === SETTINGS_DEFAULTS.casesRoot) return defaultCasesRoot();
  return expandHome(root);
}

/**
 * 校验工作区根目录可用：展开 → 建目录 → 试写一个探测文件再删 → 返回解析后的绝对路径。
 * 任一步失败抛 NOT_WRITABLE 并带上失败路径，供设置页直接展示。
 */
export function validateWorkspaceRoot(root: string): { resolved: string } {
  return validateWritableRoot(root, '工作区根目录', '工作区');
}

/**
 * 校验用例根目录可用：据与工作区根目录**完全同一套**（见 `validateWritableRoot`），只有文案不同。
 * 复用而不是抄一份：两处各自演进的话，就会出现「工作区能拦住不可写、用例目录拦不住」这种
 * 只有用户才发现的差异。
 */
export function validateCasesRoot(root: string): { resolved: string } {
  return validateWritableRoot(root, '用例根目录', '用例');
}

/**
 * 可写根目录的共用判据（工作区根 / 用例根）。
 * `label` 是错误文案里的名词（「工作区根目录」/「用例根目录」），`subject` 是探测文件 WARN 日志里的主体，
 * 两者分开是因为日志与用户文案的读者不同：日志要能一眼看出是哪个根目录，用户文案要能直接照做。
 */
function validateWritableRoot(root: string, label: string, subject: string): { resolved: string } {
  if (root.trim() === '') {
    throw new ServiceError('NOT_WRITABLE', `${label}不能为空`);
  }
  const resolved = expandHome(root);
  try {
    mkdirSync(resolved, { recursive: true });
  } catch (error) {
    throw new ServiceError('NOT_WRITABLE', `无法创建${label}：${resolved}（${reason(error)}）`, { cause: error });
  }

  // 真写一次：用随机名避免与并发校验撞车。
  // 写的是**文件**不是子目录：判据是「这个目录能不能落盘」，而建子目录再删会多一次 mkdir
  // 与一次 rmdir，任一步失败都要单独解释；写一个文件更直接地命中「不可写」。
  const probe = join(resolved, `.aieval-probe-${randomSuffix()}`);
  try {
    writeFileSync(probe, '', 'utf8');
  } catch (error) {
    throw new ServiceError('NOT_WRITABLE', `${label}不可写：${resolved}（${reason(error)}）`, { cause: error });
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // 探测文件删不掉不影响「可写」这个结论，留个 WARN 即可
      log.warn(`${subject}探测文件未能删除`, { probe });
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
