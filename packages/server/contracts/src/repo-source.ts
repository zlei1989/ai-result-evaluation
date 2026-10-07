/**
 * 用例的代码来源：形态判定（本地绝对路径 / 远端 git 地址）、归一与仓库名解析。
 *
 * 为什么放 contracts：core 的镜像层、api 的校验与文案、ui 的标签三层都要用它，各写一份必然漂移，
 * 而漂移的代价是「同一个字符串在保存时是远端、在准备时是本地」（RG1）。
 * 判定顺序是承重的，见 parseRepoSource 内的逐条注释。
 */
import { z } from 'zod';
import { ServiceError } from './errors';

/** 白名单 scheme：只有这五种前缀会被当成远端 git 地址 */
const REMOTE_SCHEMES = new Set(['ssh', 'http', 'https', 'git', 'file']);

/** `scheme://` 前缀（scheme 字符集按 RFC 3986，大小写不敏感） */
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
/** Windows 盘符（`D:\…` / `D:/…`）与 UNC（`\\host\share`） */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC_PREFIX = /^\\\\/;
/** scp 形态：`[user@]host:path`（host 段至少 2 字符，排除 `D:` 这种单字母盘符） */
const SCP_LIKE = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]{2,}):(.+)$/;
/** 控制字符（含换行与制表符）：粘贴事故的主要形态，且会污染 git 参数 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type RepoSource =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; url: string; host: string; repoName: string };

/**
 * 形态判定 + 归一 + 解析 host 与仓库名。
 * 判定顺序（改顺序就会误判）：
 *   ① 控制字符 / 以 `-` 开头 —— 硬拒绝（RG13：远端 URL 会作为参数交给 git）；
 *   ② Windows 盘符与 UNC —— 本地（先于 scp 形态：这是 spec 要求的判定顺序；`D:` 这种单字母 host
 *      当前 `SCP_LIKE` 本就吞不掉，这条守的是顺序本身，属防御性代码而**不是**正则冲突）；
 *   ③ `scheme://` —— 白名单内是远端，白名单外**拒绝**（不回落成本地路径）；
 *   ④ `[user@]host:path` 且（含 `@` 或 host 段含点）—— 远端；
 *   ⑤ 其余一律本地路径：本地路径的合法性由 git 自己判（`resolveRepoInfo`），这里不抢它的活。
 */
export function parseRepoSource(source: string): RepoSource {
  // 控制字符查**原串**：trim() 会连结尾的换行 / 制表符一起吃掉，先 trim 就等于放行了最常见的粘贴事故
  if (CONTROL_CHARS.test(source)) {
    throw new ServiceError('INVALID_QUERY', '代码来源里含控制字符（换行、制表符等），请重新粘贴');
  }
  const trimmed = source.trim();
  if (trimmed.startsWith('-')) {
    throw new ServiceError('INVALID_QUERY', `代码来源不能以 - 开头：${trimmed}`);
  }
  if (WINDOWS_DRIVE.test(trimmed) || UNC_PREFIX.test(trimmed)) return { kind: 'local', path: trimmed };

  const schemeMatch = SCHEME_PREFIX.exec(trimmed);
  if (schemeMatch !== null) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    if (!REMOTE_SCHEMES.has(scheme)) {
      throw new ServiceError(
        'INVALID_QUERY',
        `不支持的 git 地址协议：${scheme}（支持 ssh:// / http:// / https:// / git:// / file:// 与 user@host:path）`,
      );
    }
    const url = normalizeRemoteUrl(trimmed);
    // 仓库名与镜像 key 同口径：都从归一后的串取末段，标签才描述真正交给 git 的那个字符串
    return { kind: 'remote', url, host: hostOf(url), repoName: remoteRepoName(url) };
  }

  const scpMatch = SCP_LIKE.exec(trimmed);
  const scpHost = scpMatch?.[2] ?? '';
  if (scpMatch !== null && (trimmed.includes('@') || scpHost.includes('.'))) {
    // 与 scheme:// 分支同一口径：url 是持久化与比较的规范值，仓库名也从归一后的串上取（尾斜杠因此不是「空末段」）
    const url = normalizeRemoteUrl(trimmed);
    const scpPath = SCP_LIKE.exec(url)?.[3] ?? '';
    return { kind: 'remote', url, host: scpHost, repoName: stripGitSuffix(lastSegment(scpPath)) || scpHost };
  }

  return { kind: 'local', path: trimmed };
}

/**
 * 远端 URL 的归一：仅去尾部斜杠。
 * 刻意**不**做大小写折叠、不剥 `.git`、不把 https 改写成 ssh：它是镜像 key 与
 * 「用例来源是否改变」的判据，过度归一会让两个不同的远端指向同一份镜像（spec §4.1）。
 */
export function normalizeRemoteUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** 仓库名：远端取归一后末段去 `.git`（无路径段时回落 host），本地取路径末段（界面标签与远端提示词共用） */
export function repoNameFromSource(source: string): string {
  const parsed = parseRepoSource(source);
  return parsed.kind === 'remote' ? parsed.repoName : lastSegment(parsed.path);
}

/**
 * 展示用的仓库名：**任何字符串都不抛错**，供列表 / 下拉这类渲染期取名字的地方用。
 *
 * 与 `repoNameFromSource` 的分工是刻意的：那条是**判定路径**的函数，对非法来源响亮地抛错（写路径靠它拦），
 * 而渲染期拿到的是**已经落盘的数据**——读路径不保证来源合法（`loadConfig()` 不校验 `cases`，
 * 本功能之前的用例 schema 还是裸的 `z.string()`），一个坏行抛在渲染里就是整页白屏，而不是一行难看的文字。
 * 退化顺序：末段（先剥尾分隔符，去一次 `.git`）→ 原串；纯空白给空串（不可见的空白不该当名字）。
 */
export function displayRepoName(source: string): string {
  try {
    return repoNameFromSource(source);
  } catch {
    return fallbackName(source);
  }
}

/** 解析失败时的退化取名：没有分隔符就原样回显（例如 `-` 开头的注入形态，原串至少能让人认出是哪一条） */
function fallbackName(source: string): string {
  const trimmed = source.trim().replace(/[\\/]+$/, '');
  if (trimmed === '') return '';
  return stripGitSuffix(lastSegment(trimmed)) || trimmed;
}

/** 给用例契约用的来源校验：失败时把 ServiceError 的中文原因原样带进 zod issue */
export const RepoSourceStringSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    // `.min(1)` 只拦得住空串，拦不住 `'   '`（长度 > 1、trim 后为空）：空白的判据只能是 trim
    if (value.trim() === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '代码来源不能为空' });
      return;
    }
    try {
      parseRepoSource(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof ServiceError ? error.message : '代码来源不合法',
      });
    }
  });

/**
 * 远端 URL 的主机名；`file://` 没有主机，统一记作 `localhost`。
 * 白名单内但 `new URL()` 解析不出的串（如 `https://`）拿到**空串**：这里不编造主机也不报错，交给 git 报真正的错。
 */
function hostOf(url: string): string {
  if (url.startsWith('file://')) return 'localhost';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 远端 URL 的仓库名：取路径末段去 `.git`；**没有路径段**（`https://host/`）时才回落主机名。
 * 传进来的必须是**已归一**的串：归一（剥尾斜杠）与镜像 key 同一口径，尾斜杠因此不是「空末段」。
 */
function remoteRepoName(url: string): string {
  const path = url.startsWith('file://') ? url.slice('file://'.length) : safePathname(url);
  return stripGitSuffix(lastSegment(path)) || hostOf(url) || 'repo';
}

/** `new URL()` 解析不出路径时给空串（scp 形态不走这里；畸形 URL 由 git 去报错） */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** 取路径末段：先剥尾分隔符再切（两种斜杠都认）；尾分隔符不算「空末段」，与镜像 key 的归一同口径 */
function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** 去掉 `.git` 后缀（只去一次，`x.git.git` → `x.git`） */
function stripGitSuffix(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -'.git'.length) : name;
}
