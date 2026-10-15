/**
 * 候选产物（`RESULT.*`）契约：认哪些文件、索引与正文两个出口形状、两个体积上限。
 *
 * 三条口径：
 *   1. **认的名字只有一层、三种后缀**：候选工作区**根目录**下的 `RESULT.md` /
 *      `RESULT.html` / `RESULT.svg`（大小写不敏感）。后缀白名单是**渲染分档**本身——
 *      界面上「怎么渲染这一份」不是第二份判据（见 `ArtifactKind`）；
 *      加一档只改 `ARTIFACT_EXTENSIONS` 一处，识别与排序都跟着走。
 *   2. **索引与正文分开两个形状**（与 `RowDiffIndex` / `RowDiffFile` 同一条口径）：
 *      正文体积不可控，而一份读不出来不该把整张总览打成空白——逐份各自的错误态。
 *   3. 两个上限都不是「截断就完事」：`ARTIFACT_TEXT_MAX_CHARS` 是**带提示的降级**
 *      （正文截断 + `truncated`，卡片上如实说明）；`ARTIFACT_READ_MAX_BYTES` 是**拒绝**
 *      （连读都不读，只给一句中文原因）——与技能预览同一条处理，半个正文比没有更难读。
 */
import { z } from 'zod';

/**
 * 认的后缀，**数组顺序就是同一候选内多份产物的读取顺序**（markdown 正文在前，
 * 页面 / 图形在后）。它是本文件唯一的白名单真源：识别、排序、渲染分档、占位文案都从它派生。
 */
export const ARTIFACT_EXTENSIONS = ['md', 'html', 'svg'] as const;

/** 文件名的固定前缀（比较时走小写，故这里写的形态只是给人看的） */
export const ARTIFACT_FILE_PREFIX = 'RESULT';

/**
 * 白名单的**人话形态**（`RESULT.md / RESULT.html / RESULT.svg`）。
 * 由白名单拼出来而不是手写：加一档后缀时，占位文案与报错文案跟着一起变，
 * 不会留下一句「只认三个文件」的旧话。
 */
export const ARTIFACT_FILE_HINT = ARTIFACT_EXTENSIONS.map(
  (extension) => `${ARTIFACT_FILE_PREFIX}.${extension}`,
).join(' / ');

/**
 * 单份正文的**字符**上限（不是字节）：超了截断 + `truncated: true`，由界面如实说明。
 * 按字符数定而不是字节数，是为了避开「按字节切在多字节字符中间」这件事——
 * 切坏了渲染出来是一个替换字符，而截断本身已经是可见的降级，不必再叠一个静默的坏字。
 */
export const ARTIFACT_TEXT_MAX_CHARS = 100_000;

/**
 * 单份的**读取**上限（字节）：超过它连读都不读，直接给中文原因。
 * 这一格防的是「名字对、内容是几个 GB」的那类意外（候选写文件不受我们约束），
 * 读进来再截断等于先吃下那份内存。
 */
export const ARTIFACT_READ_MAX_BYTES = 8 * 1024 * 1024;

/** 产物分档 = 后缀本身：`md` 走 markdown 渲染，`html` / `svg` 走沙箱 iframe */
export const ArtifactKindSchema = z.enum(ARTIFACT_EXTENSIONS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/** 文件名的**小写前缀**（含点）：`RESULT.` 的比较就是拿它切后缀 */
const LOWERCASE_FILE_PREFIX = `${ARTIFACT_FILE_PREFIX.toLowerCase()}.`;

/**
 * 这个名字是哪一档产物；不是产物（或不是本仓认的产物）返回 `null`。
 *
 * 大小写不敏感（`RESULT.md` / `result.md` / `Result.MD` 都算）：四家智能体写文件的大小写习惯
 * 不一样，而「哪一份是产物」不该由模型的书写习惯决定。
 *
 * 只认**一层文件名**：前缀必须在开头，后缀必须在结尾，中间不许有任何别的字符——
 * 于是 `RESULT.md.bak`、`sub/RESULT.md`、`RESULT.md/../x` 都不成立。
 * 这条也是读盘那一路**路径穿越的第一道门**（第二道是 core 的 `realpath` 复核）。
 */
export function artifactKindOf(name: string): ArtifactKind | null {
  const lowercase = name.toLowerCase();
  if (!lowercase.startsWith(LOWERCASE_FILE_PREFIX)) return null;
  const extension = lowercase.slice(LOWERCASE_FILE_PREFIX.length);
  return ARTIFACT_EXTENSIONS.find((kind) => kind === extension) ?? null;
}

/**
 * 「产物总览」的索引：**每个候选一行**（顺序 = 快照顺序，服务端**不排名**——名次只有一个判据，
 * 在界面那一侧由 `rankOf` 算）。
 *
 * 没有产物的行照样进来、`files` 是空数组：**「这一行没有产出」是一句要显示出来的事实**，
 * 而不是「这一行不存在」。工作区还没建起来的行同样如此（没跑过 ≠ 读不出来）。
 */
export const RunArtifactIndexSchema = z.object({
  rows: z.array(
    z.object({
      rowId: z.string().min(1),
      files: z.array(
        z.object({
          name: z.string().min(1),
          kind: ArtifactKindSchema,
          /** 盘上这一份的字节数（右下角的体积说明用；截断与否看正文那一份的 `truncated`） */
          bytes: z.number(),
        }),
      ),
    }),
  ),
  /** 全部候选的产物总份数（按钮可见性的唯一判据） */
  total: z.number(),
});
export type RunArtifactIndex = z.infer<typeof RunArtifactIndexSchema>;

/**
 * 一份产物的正文。
 *
 * `truncated` 与 `text` 必须一起给：只给截断后的正文，界面就分不清「它只写了这么多」
 * 与「我们只显示了这么多」——而这两句话对「谁做得更好」的判断完全不同。
 */
export const RowArtifactFileSchema = z.object({
  name: z.string().min(1),
  kind: ArtifactKindSchema,
  /** 原文（已剥 UTF-8 BOM）；`truncated` 为真时是前 `ARTIFACT_TEXT_MAX_CHARS` 个字符 */
  text: z.string(),
  /** 盘上这一份的**完整**字节数（不是 `text` 的长度） */
  bytes: z.number(),
  truncated: z.boolean(),
});
export type RowArtifactFile = z.infer<typeof RowArtifactFileSchema>;
