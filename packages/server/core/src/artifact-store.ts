/**
 * 候选产物（`RESULT.*`）的扫描与读取：候选工作区**根目录**下的交付物。
 *
 * 只读：本模块不建目录、不写文件、不删任何东西。
 *
 * 五条口径：
 *   1. **只扫第一层**（与「用例仓库自带的目录结构」无关）：识别单位是**工作区根下的普通文件**，
 *      名字命中契约的白名单（`artifactKindOf`）。目录同名不算（有人会把 `RESULT.md` 建成一个目录），
 *      **软链也不算**——`Dirent.isFile()` 对软链是 false，这一条顺带把「产物指向工作区之外」
 *      挡在扫描阶段，而不是等你点开才发现读不出来；
 *   2. **工作区不存在 ⇒ 空清单，不是错误**：没跑过的行就是没有产物，把它说成「读不出来」是假结论；
 *      真出错（权限、坏目录）**照抛**，由 api 层按行降级并留 WARN——两条必须分开；
 *   3. **顺序由白名单定**（md → html → svg，同档按名字码位升序）：文件系统的 `readdir` 顺序
 *      不保证稳定，拿它当展示顺序会让「同一个候选的两份产物」在两次打开之间换位置；
 *   4. **读之前先过两道门**：名字必须是白名单里的一层文件名（`artifactKindOf`，第一道），
 *      `realpath` 解析后仍在工作区之内（第二道，防软链与手改路径）；
 *   5. **两个上限分开处置**：超过读取上限（字节）⇒ 拒绝并给中文原因，**连读都不读**
 *      （读进来再截断等于先吃下那份内存）；超过正文上限（字符）⇒ 截断 + `truncated`，
 *      由界面如实说明「只显示了一部分」——截断是可见的降级，不是静默。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACT_EXTENSIONS,
  ARTIFACT_FILE_HINT,
  ARTIFACT_READ_MAX_BYTES,
  ARTIFACT_TEXT_MAX_CHARS,
  ServiceError,
  artifactKindOf,
  type ArtifactKind,
  type RowArtifactFile,
} from '@aieval/contracts';
import { isInside } from './path-inside';

/** 索引里的一份产物（名、档、盘上字节数） */
export interface WorkspaceArtifactEntry {
  name: string;
  kind: ArtifactKind;
  bytes: number;
}

/** 出错原因是「路径不存在」时给 `true`：它是「没有」而不是「读不出来」 */
function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** 读失败时拼进中文原因的原始信息（不透内部细节就没有可排查的线索，原文只在括号里） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 扫一个候选工作区根目录下的产物清单。
 *
 * 目录不存在 / 不是目录 ⇒ `[]`（该行还没跑过，或工作区被手工清掉了——两者在界面上都是「没有产物」）。
 * 目录读不动（权限等）⇒ 抛，调用方按行降级。
 */
export function scanWorkspaceArtifacts(workspacePath: string): WorkspaceArtifactEntry[] {
  if (workspacePath === '' || !existsSync(workspacePath)) return [];
  const status = statSync(workspacePath, { throwIfNoEntry: false });
  if (status === undefined || !status.isDirectory()) return [];

  const entries = readdirSync(workspacePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, kind: artifactKindOf(entry.name) }))
    .filter((item): item is { name: string; kind: ArtifactKind } => item.kind !== null)
    .map((item) => ({
      ...item,
      // 体积读不出来（权限 / 坏链）按 0 报：这一格只用于显示，
      // 而把「读不到体积」说成「读取失败」会让整个索引少一份产物
      bytes: statSync(join(workspacePath, item.name), { throwIfNoEntry: false })?.size ?? 0,
    }));

  // 白名单顺序优先，同档按名字码位升序（`<` 而不是 `localeCompare`：顺序不随 locale / ICU 变）。
  // 同档 tiebreak 只在区分大小写的文件系统上才用得上（白名单里同一档的名字只可能差大小写，
  // 而 macOS 默认不区分大小写）——留着它是为了让顺序在两种文件系统上都**确定**。
  return entries.sort((left, right) => {
    const byKind = ARTIFACT_EXTENSIONS.indexOf(left.kind) - ARTIFACT_EXTENSIONS.indexOf(right.kind);
    if (byKind !== 0) return byKind;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

/**
 * 读一份产物的正文。
 *
 * 四类拒绝各说各的话（调用方与使用者都要能从中看出「该改什么」）：
 *   · 名字不是本仓认的产物 ⇒ `INVALID_QUERY`（`RESULT.txt`、`sub/RESULT.md`、`RESULT.md.bak` 都走这一条）；
 *   · 路径越出工作区（软链 / 手改快照里的路径）⇒ `INVALID_QUERY`；
 *   · 文件不在 / 不是普通文件 / 是目录 ⇒ `NOT_FOUND` 与 `INVALID_QUERY` 分开；
 *   · 超过读取上限、或内容不是 UTF-8 文本 ⇒ `INVALID_QUERY` + 中文原因，**不给半个正文**。
 */
export function readWorkspaceArtifact(workspacePath: string, name: string): RowArtifactFile {
  const kind = artifactKindOf(name);
  if (kind === null) {
    throw new ServiceError('INVALID_QUERY', `这不是本仓认的产物文件：${name}（只认 ${ARTIFACT_FILE_HINT}）`, {
      context: { workspacePath, name },
    });
  }

  const target = join(workspacePath, name);
  let realDir: string;
  let realTarget: string;
  try {
    realDir = realpathSync(workspacePath);
    realTarget = realpathSync(target);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new ServiceError('NOT_FOUND', `这一行没有这份产物：${target}`, {
        context: { workspacePath, name },
      });
    }
    throw new ServiceError('INTERNAL', `读不出这份产物：${target}（${reason(error)}）`, {
      cause: error,
      context: { workspacePath, name },
    });
  }

  if (!isInside(realDir, realTarget)) {
    throw new ServiceError('INVALID_QUERY', `产物路径越出了候选工作区：${name}`, {
      context: { workspacePath, name, dir: realDir },
    });
  }

  const status = statSync(realTarget, { throwIfNoEntry: false });
  if (status === undefined) {
    throw new ServiceError('NOT_FOUND', `这一行没有这份产物：${target}`, { context: { workspacePath, name } });
  }
  if (status.isDirectory()) {
    throw new ServiceError('INVALID_QUERY', `这是一个目录，不是文件：${name}`, { context: { workspacePath, name } });
  }
  if (!status.isFile()) {
    throw new ServiceError('INVALID_QUERY', `这不是一个普通文件：${name}`, { context: { workspacePath, name } });
  }
  if (status.size > ARTIFACT_READ_MAX_BYTES) {
    throw new ServiceError(
      'INVALID_QUERY',
      `这份产物 ${formatSize(status.size)}，超过读取上限 ${formatSize(ARTIFACT_READ_MAX_BYTES)}：${name}`,
      { context: { workspacePath, name, bytes: status.size } },
    );
  }

  let text: string;
  try {
    text = readFileSync(realTarget, 'utf8');
  } catch (error) {
    throw new ServiceError('INTERNAL', `读不出这份产物：${target}（${reason(error)}）`, {
      cause: error,
      context: { workspacePath, name },
    });
  }
  // Node 的解码器把非法字节序列换成替换字符，故它的出现**就是**「不是 UTF-8 文本」的痕迹
  if (text.includes('\uFFFD')) {
    throw new ServiceError(
      'INVALID_QUERY',
      `这一类产物不预览（二进制 / 非 UTF-8，${formatSize(status.size)}）：${name}`,
      { context: { workspacePath, name, bytes: status.size } },
    );
  }
  // 行首 BOM（PowerShell 5.1 的 `Set-Content` 默认带）：留着它 markdown 的第一行会多一个不可见字符
  if (text.startsWith('\uFEFF')) text = text.slice(1);

  const truncated = text.length > ARTIFACT_TEXT_MAX_CHARS;
  return {
    name,
    kind,
    text: truncated ? text.slice(0, ARTIFACT_TEXT_MAX_CHARS) : text,
    bytes: status.size,
    truncated,
  };
}

/** 体积的人话（KB / MB 一位小数）：只用在中文原因里，不落进契约 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
