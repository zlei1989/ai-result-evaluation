/**
 * 路由注入：base URL 规范化 + 「替换型」子进程环境构造。
 * 三条硬性不变量：
 *  1. 注入后返回**新对象**，输入的 route 只读，`process.env` 永不写入（有静态断言守着）；
 *  2. 子进程环境以宿主环境为底（不展开就补不上 PATH，子进程连 node 都找不到），再覆盖该行独立 HOME；
 *  3. 每行的 configHome 是独立目录：行与行之间共享配置目录会互相注入 MCP / 插件定义，直接破坏
 *     「同一起点」这个前提。
 */

/**
 * claude-code：拆掉尾部 `/v1`。
 * 为什么：该 SDK 自己追加 `/v1/messages`，留着会变成 `/v1/v1/messages`。
 */
export function stripV1Suffix(baseUrl: string): string {
  return withPath(baseUrl, (path) => stripV1Path(path));
}

/**
 * codex：补上 `/v1`。
 * 为什么：CLI 只走 Responses wire，即 `POST {base}/v1/responses`。
 */
export function ensureV1Suffix(baseUrl: string): string {
  return withPath(baseUrl, (path) => (/\/v1$/.test(path) ? path : `${path}/v1`));
}

/**
 * 只对 **URL 的路径段** 做规范化，query / fragment 一个字符都不动。
 * 为什么不能用「整串结尾」的正则：用户粘进来的 baseUrl 可能带 `?x=1`/`#frag`/重复斜杠，
 * 于是 `…/anthropic/v1?x=1` 会**不拆** `/v1`（claude 拼成 `/v1/v1/messages`），
 * 而 `…/anthropic?x=1` 会把 `/v1` **追加进 query 值**（codex 打到错误路径）——主动写坏比原样放过更糟。
 * 顺带收敛路径里的重复斜杠（`//v1` → `/v1`），与 `new URL()` 对 pathname 的规范化同向。
 * 为什么用 `URL` 而不是手工在 `[?#]` 处切：`URL` 已经按 WHATWG 规则把 pathname 与 query/fragment
 * 分开并转义，手工切要自己处理 `%3F` 这类已转义字符与畸形输入。
 */
function withPath(baseUrl: string, normalize: (path: string) => string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // 不是绝对 URL（畸形粘贴）：退回纯字符串处理，绝不因为「归一化失败」而抛
    return normalize(baseUrl.replace(/\/+$/, ''));
  }
  const path = trimTrailingSlash(normalize(collapseSlashes(trimTrailingSlash(url.pathname))));
  // 裸 host（`https://gw`）的 pathname 是 '/'：留空才是同一个地址，否则会拼出 `https://gw//v1`
  url.pathname = path === '/' ? '' : path;
  return url.toString();
}

/** 去掉结尾的全部斜杠；只处理结尾，中间的路径一个字符都不动 */
function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/**
 * 把路径段里连续的斜杠收敛成一个。
 * 为什么必须自己做：实测 `new URL('https://gw/a//v1')` 的 pathname **保留** `//`（只有空路径 `https://gw`
 * 才被序列化成 `/`）——不收敛的话 `stripV1Suffix('…/anthropic//v1')` 会残留尾斜杠、与 SDK 追加的
 * `/v1/messages` 拼成 `//v1/messages`。
 */
function collapseSlashes(path: string): string {
  return path.replace(/\/{2,}/g, '/');
}

/** 路径段版本的「拆掉尾部 `/v1`」 */
function stripV1Path(path: string): string {
  return path.replace(/\/v1$/, '');
}

export interface SubprocessEnvInput {
  /** 该行独立配置目录（编排层第 3 步备好的 `.agenthome`） */
  homeDir: string;
  /** 本次要注入的厂商变量；值为 undefined 的键会被删掉，避免子进程看到空串凭据 */
  injected: Record<string, string | undefined>;
}

/**
 * 构造「替换型」子进程环境：宿主环境 → 覆盖 HOME → 覆盖本次注入。
 * 为什么必须是替换型（而不是往 process.env 里塞再让 SDK 自己读）：并行时多行同时驱动不同供应商，
 * 一旦靠读 `process.env` 再兜底写回来注入，第二行起就再也拿不到自己的凭据——写入是粘性的（A5）。
 *
 * 键名口径：**逐项保留宿主的键名形态**，不额外补 `PATH` 的另一种拼写——
 * Windows 的环境块通常写 `Path`，POSIX 写 `PATH`，而子进程查环境变量在 Windows 上不区分大小写，
 * 两种拼写都能让 CLI 找到 `node`。因此 `env.PATH` 在 Windows 真实进程里可能是 `undefined`
 * （值在 `env.Path` 上），这是**正确行为**而非缺陷；断言要大小写不敏感地找 path 键。
 */
export function buildSubprocessEnv(input: SubprocessEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // HOME 与 USERPROFILE 都要改：Windows 上 Node 与多数 CLI 走 USERPROFILE，只改 HOME 等于没隔离
  env.HOME = input.homeDir;
  env.USERPROFILE = input.homeDir;
  for (const [key, value] of Object.entries(input.injected)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
