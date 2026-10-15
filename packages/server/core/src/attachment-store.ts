/**
 * 人工消息附件的**落盘原语**：id 形状闸门、文件名净化、重名排序、原子写入、目录清点。
 *
 * 为什么单独一格而不是塞进 `workspace.ts`：那边只管**布局**（哪个目录在哪），这边管**一个文件
 * 怎么安全地落进去**（名字来自用户、内容来自上传流）。两件事的失败面完全不同——布局错了是
 * 「产物找不着」，名字没净化是「写到了别处」。
 *
 * 四条口径：
 *
 *   1. **文件内容绝不进日志与事件**：只记目录、文件名与字节数。附件是用户随手拖进来的东西
 *      （凭据、私钥、病历都可能），把内容写进日志等于把它复制到一个谁都能读的地方。
 *   2. **名字来自用户 ⇒ 先净化再落盘**：去掉路径分隔符与控制字符、去掉前导点、限长，
 *      尽量保留原名（模型看得懂 `report.pdf`，看不懂 `f3a91c`）。空到什么都不剩时退到一个固定名。
 *   3. **重名并存、前加序号**（`1-a.png`）：同一个 `<messageId>` 下上传两次同名文件是常事
 *      （改过一版再传一次），覆盖会让第一份在没有任何提示的情况下消失。
 *   4. **原子写**：先写 `.名字.part`（创建即 `0600`）再 `renameSync`。半途失败留下的 `.part`
 *      不会参与清点（点开头的名字被过滤掉），并由「该行下一次 prepare 清附件根」兜底。
 *
 * 临时文件为什么用**点开头**而不是 `<名字>.part`：合法文件名可以正好以 `.part` 结尾
 * （用户上传 `x.part`），那样它会被自己的清点规则过滤掉——于是第二次上传同名文件时
 * 「已占用」判据看不见它，直接覆盖第一份。点前缀与净化规则配套（净化会去掉前导点），
 * 于是「点开头的名字」这一集合只属于我们自己的临时文件。
 */
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InjectMessageIdSchema, ServiceError } from '@aieval/contracts';
import { createLogger } from './logger';

const log = createLogger('attachment-store');

/** 单个文件名的长度上限（多数文件系统给 255 字节；留余量给序号前缀与多字节字符） */
const ATTACHMENT_NAME_MAX_LENGTH = 120;
/** 净化后什么都不剩时的兜底名（扩展名信息已经丢了，只能给一个中性名字） */
const ATTACHMENT_FALLBACK_NAME = 'attachment';
/** 临时文件的前缀：点开头（净化会去掉用户名字里的前导点，故两者不会相撞） */
const TEMP_PREFIX = '.';
const TEMP_SUFFIX = '.part';
/** 限长时愿意保留的扩展名最长长度（再长就不像扩展名了，硬截断反而更可读） */
const EXTENSION_MAX_LENGTH = 16;

/**
 * 一条人工消息 id 的形状校验：不合法一律 `INVALID_QUERY` + 中文原因。
 * 与用例 id 同一处置——它同时是身份判据与安全边界：这个名字会被拼进附件目录名。
 */
export function assertInjectMessageId(messageId: string): string {
  const parsed = InjectMessageIdSchema.safeParse(messageId);
  if (!parsed.success) {
    throw new ServiceError('INVALID_QUERY', `消息 id 不合法（只允许字母、数字、点、下划线、连字符，首字符须为字母或数字，最长 128）：${messageId}`, {
      context: { messageId },
    });
  }
  return parsed.data;
}

/**
 * 把用户给的文件名净化成一个**安全的单段文件名**（纯函数，磁盘无关）。
 *
 * 顺序是有讲究的：先按分隔符取最后一段（`..\\a/b.png` 要归到 `b.png`，而不是把 `..` 留下来），
 * 再删控制字符（NUL 与换行会让路径拼接与界面渲染出岔子）、折叠空白，最后去掉**前导点**
 * ——`.` / `..` / 隐藏文件都不是用户想上传的名字，而它们正是路径语义里最危险的那一段。
 */
export function sanitizeAttachmentName(name: string): string {
  const lastSegment = name.split(/[\\/]/).pop() ?? '';
  const cleaned = lastSegment
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutLeadingDots = cleaned.replace(/^\.+/, '');
  const limited = limitAttachmentNameLength(withoutLeadingDots);
  return limited === '' ? ATTACHMENT_FALLBACK_NAME : limited;
}

/** 超长时保留扩展名、截断主干：模型认扩展名来判断「这是什么文件」 */
function limitAttachmentNameLength(name: string): string {
  if (name.length <= ATTACHMENT_NAME_MAX_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= EXTENSION_MAX_LENGTH ? name.slice(dot) : '';
  return `${name.slice(0, ATTACHMENT_NAME_MAX_LENGTH - extension.length)}${extension}`;
}

/**
 * 该目录下**已落盘的附件名**（正序无关；清点用于「还能再传几个」与「这个名字占了没有」）。
 *
 * 过滤两类：点开头的（我们自己的 `.part` 临时文件）与目录项。前者会让「传了一半」算成一个附件，
 * 后者会让计数多一个——两者都会让上限在用户眼里提前触顶。
 * 目录不存在 = 一个附件都没有（首次上传，不是错误）。
 */
export function listAttachmentFileNames(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith(TEMP_PREFIX))
    .map((entry) => entry.name);
}

/** 落盘一个附件：返回**最终**文件名与绝对路径（都是这一次写入的事实） */
export interface WrittenAttachment {
  path: string;
  name: string;
}

/**
 * 把一个附件原子地落进 `dir`（目录不存在则建），返回最终路径。
 *
 * 重名处置：在净化的基础上**前加序号**（`1-a.png`、`2-a.png`），从 1 开始试到没被占用为止。
 * 序号在前是为了让同一次上传的几份文件在目录里排在一起（人翻目录时看得懂）。
 */
export function writeAttachmentFile(input: { dir: string; name: string; bytes: Uint8Array }): WrittenAttachment {
  const { dir } = input;
  mkdirSync(dir, { recursive: true });
  const base = sanitizeAttachmentName(input.name);
  const taken = new Set(listAttachmentFileNames(dir));
  let name = base;
  for (let n = 1; taken.has(name); n += 1) name = `${String(n)}-${base}`;

  const path = join(dir, name);
  const temp = join(dir, `${TEMP_PREFIX}${name}${TEMP_SUFFIX}`);
  try {
    writeFileSync(temp, input.bytes, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ServiceError('INTERNAL', `附件落盘失败：${path}（${detail}）`, { cause: error, context: { dir, name } });
  }
  // 只记大小与名字：文件内容绝不进日志（口径 1）
  log.info('附件已落盘', { dir, name, bytes: input.bytes.byteLength });
  return { path, name };
}
