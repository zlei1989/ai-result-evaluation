/**
 * 候选工作区里**一张图片**的读取：模型看过的图（`image-view` 块）要能在界面上预览。
 *
 * 只读：本模块不建目录、不写文件、不删任何东西。
 *
 * 五条口径（与 `artifact-store` 同源，但**白名单不同**）：
 *   1. **只认工作区内的相对路径**：入参是 `image-view` 块里那条路径相对工作区根的那一段；
 *      绝对路径一律拒绝——URL 里出现宿主绝对路径既没有额外信息，也会让「读到哪儿了」不可复核；
 *   2. **先判后缀再读盘**：只认图片后缀（白名单在 `IMAGE_CONTENT_TYPES`），文案里点名允许什么；
 *   3. **两道门**：先按相对路径拼目标，再 `realpath` 解析两侧、复核目标仍在工作区之内
 *      （防软链与 `..`）；
 *   4. **两个上限分开**：超过字节上限**连读都不读**（读进来再截断等于先吃下那份内存）；
 *   5. **文件不在 ⇒ `NOT_FOUND`**：工作区在运行结束后会被改写，图片被删掉是常见情形，
 *      把它说成「读不出来」会让界面误报故障。
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { ServiceError } from '@aieval/contracts';
import { isInside } from './path-inside';

/** 可预览的图片后缀 → 响应类型。**顺序不重要**，查表用 */
const IMAGE_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

/** 单张图片的读取上限：超过就不读（与附件上传量级一致，足够放下常见截图） */
export const WORKSPACE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 扩展名清单的中文提示（拒绝文案里点名，否则调用方不知道该换什么格式） */
const IMAGE_EXTENSIONS_HINT = 'png / jpg / jpeg / gif / webp / avif / bmp / svg / ico';

/** 读出来的一张图片：字节与响应类型 */
export interface WorkspaceImageFile {
  bytes: Buffer;
  mimeType: string;
}

/** 「路径不存在」是「没有」，不是「读不出来」 */
function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** 折进中文原因的原始信息（原文只在括号里，方便排查又不冒充结论） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 给大小一句话（拒绝文案里要点名「多大、上限多少」） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 读工作区里的一张图片。
 *
 * `relativePath` 是**相对工作区根**的路径（`image-view` 块里的绝对路径由 api 层换算过来）。
 * 四类拒绝各说各的话：路径形状不对 / 后缀不是图片 / 越出工作区 ⇒ `INVALID_QUERY`；
 * 文件不在 ⇒ `NOT_FOUND`；读盘失败 ⇒ `INTERNAL`（带原始原因）。
 */
export function readWorkspaceImage(workspacePath: string, relativePath: string): WorkspaceImageFile {
  if (relativePath === '' || isAbsolute(relativePath)) {
    throw new ServiceError('INVALID_QUERY', `图片路径必须是工作区内的相对路径：${relativePath}`, {
      context: { workspacePath, relativePath },
    });
  }

  const mimeType = IMAGE_CONTENT_TYPES.get(extname(relativePath).toLowerCase());
  if (mimeType === undefined) {
    throw new ServiceError('INVALID_QUERY', `这不是可预览的图片类型：${relativePath}（只认 ${IMAGE_EXTENSIONS_HINT}）`, {
      context: { workspacePath, relativePath },
    });
  }

  const target = join(workspacePath, relativePath);
  let realDir: string;
  let realTarget: string;
  try {
    realDir = realpathSync(workspacePath);
    realTarget = realpathSync(target);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new ServiceError('NOT_FOUND', `这张图片已经不在了：${relativePath}`, {
        context: { workspacePath, relativePath },
      });
    }
    throw new ServiceError('INTERNAL', `读不出这张图片：${target}（${reason(error)}）`, {
      cause: error,
      context: { workspacePath, relativePath },
    });
  }

  if (!isInside(realDir, realTarget)) {
    throw new ServiceError('INVALID_QUERY', `图片路径越出了候选工作区：${relativePath}`, {
      context: { workspacePath, relativePath, dir: realDir },
    });
  }

  const status = statSync(realTarget, { throwIfNoEntry: false });
  if (status === undefined) {
    throw new ServiceError('NOT_FOUND', `这张图片已经不在了：${relativePath}`, {
      context: { workspacePath, relativePath },
    });
  }
  if (!status.isFile()) {
    throw new ServiceError('INVALID_QUERY', `这不是一个普通文件：${relativePath}`, {
      context: { workspacePath, relativePath },
    });
  }
  if (status.size > WORKSPACE_IMAGE_MAX_BYTES) {
    throw new ServiceError(
      'INVALID_QUERY',
      `这张图片 ${formatSize(status.size)}，超过预览上限 ${formatSize(WORKSPACE_IMAGE_MAX_BYTES)}：${relativePath}`,
      { context: { workspacePath, relativePath, bytes: status.size } },
    );
  }

  try {
    return { bytes: readFileSync(realTarget), mimeType };
  } catch (error) {
    throw new ServiceError('INTERNAL', `读不出这张图片：${target}（${reason(error)}）`, {
      cause: error,
      context: { workspacePath, relativePath },
    });
  }
}
