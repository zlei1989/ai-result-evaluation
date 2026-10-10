/**
 * 贴入识别与导入语义：把用户粘进来的一段 JSON / JSONC 变成「预览一行行」与「一份最终集合」。
 *
 * 为什么是**纯函数**放在契约里（先例 `maskApiKey` / `intersectEfforts`）：
 *   · 预览与落盘必须用**同一份**判定，否则「预览说覆盖、实际新增」这种偏差只能靠肉眼发现；
 *   · 解析不碰 IO、不碰框架 ⇒ 界面那一票只负责把结果画出来，判据全在这里钉得住；
 *   · 判别是**固定五步、不递归不猜**：贴进来的东西千奇百怪，
 *     一旦开始「看起来像就当成…」，用户拿到的就是一份自己没打算要的配置。
 *
 * 三层职责（别互相越界）：
 *   1. `stripJsonComments` —— JSONC 容错（注释 / 尾逗号），**字符串里的 `//` 不许动**；
 *   2. `parseMcpPaste` —— 五步判别 + 条目化 + 上限，产出预览要的每一格（含「丢了哪些字段」）；
 *   3. `applyMcpPaste` / `sanitizeMcpName` / `mcpPasteNameIssue` —— 「同名覆盖」的合并语义与
 *      裸单项补名字的校验，界面与用例共用同一份口径。
 *
 * ⚠️ 上限（256 KB / 100 条）**先于解析**拦下：先解析再数条数的话，一段 10 MB 的贴入会先把
 * 主线程占满，用户看到的是「界面卡住」而不是「太大了」。
 */
import { MCP_ENV_KEY_PATTERN, MCP_NAME_PATTERN, type McpServerConfig, type McpServers } from './mcp';

/** 贴入文本的字节上限（256 KB）：超过它连剥离都不做，直接给中文原因 */
export const MCP_PASTE_MAX_BYTES = 256 * 1024;

/** 一次导入的条目数上限：够覆盖任何手工维护的清单，又挡得住误贴进来的整份配置文件 */
export const MCP_PASTE_MAX_ENTRIES = 100;

/**
 * 剥掉 JSONC 的注释与尾逗号，返回仍是合法 JSON 的文本。
 *
 * 怎么做到「不误伤字符串」：逐字符扫描并**跟踪字符串状态**——遇到 `"` 就整段拷到收尾引号
 * （含 `\"` 转义），字符串内部的 `//`、`/*`、`,` 一律当普通字符。这是本文件最要紧的一条：
 * `"url": "http://localhost:8080/mcp"` 被当成注释吞掉之后，`JSON.parse` 会报一个
 * 与真正原因毫无关系的位置，用户只会以为自己贴错了。
 *
 * 两条已知的「不宽容」（宁可早报也不硬转）：
 *   · 单引号串 / 无引号键不是 JSONC 的合法子集，遇到就抛**带行号的中文**；
 *   · 块注释里换行会被保留（只为让报错行号与原文本对齐）。
 * 尾逗号用「攒着不落笔」的办法剥：逗号先记在心里，下一个有意义的字符若是 `}` / `]` 就丢掉它
 * —— 这样 `[1, 2,]` 与 `{"a": 1,}` 都成立，而 `[1,,2]` 这类真正的语法错仍会漏给 `JSON.parse`。
 */
export function stripJsonComments(text: string): string {
  const out: string[] = [];
  /** 容器栈：用来判「这个位置期待的是不是一个对象的键」（无引号键的判据） */
  const stack: Array<'obj' | 'arr'> = [];
  let expectKey = false;
  let pendingComma = false;
  let line = 1;
  let index = 0;

  /** 落一个「有意义的字符」：先把攒着的逗号写下去（走到这里说明逗号后面还有元素） */
  const emit = (piece: string): void => {
    if (pendingComma) {
      out.push(',');
      pendingComma = false;
    }
    out.push(piece);
  };

  while (index < text.length) {
    const char = text[index] as string;

    // 字符串字面量：整段原样拷贝，内部的注释符号与逗号都不是语法
    if (char === '"') {
      let end = index + 1;
      while (end < text.length) {
        const current = text[end] as string;
        if (current === '\\') {
          end += 2;
          continue;
        }
        if (current === '"') break;
        if (current === '\n') line += 1;
        end += 1;
      }
      if (end >= text.length) throw new Error(`第 ${line} 行：字符串没有闭合，检查贴入的内容是否被截断`);
      emit(text.slice(index, end + 1));
      index = end + 1;
      expectKey = false;
      continue;
    }

    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new Error(`第 ${line} 行：块注释没有闭合（缺少 */）`);
      const comment = text.slice(index, end);
      // 换行要留下：报错行号按剥离后的文本算，吃掉换行会让行号整体上移
      for (const inner of comment) if (inner === '\n') out.push('\n');
      line += countNewlines(comment);
      index = end + 2;
      continue;
    }

    if (char === ',') {
      pendingComma = true;
      expectKey = stack[stack.length - 1] === 'obj';
      index += 1;
      continue;
    }
    if (char === '{') {
      emit(char);
      stack.push('obj');
      expectKey = true;
      index += 1;
      continue;
    }
    if (char === '[') {
      emit(char);
      stack.push('arr');
      expectKey = false;
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      // 走到收尾符说明攒着的那个逗号是尾逗号：丢掉它（这一步就是「剥尾逗号」本身）
      pendingComma = false;
      out.push(char);
      stack.pop();
      expectKey = false;
      index += 1;
      continue;
    }
    if (char === '\'') {
      throw new Error(`第 ${line} 行：不支持单引号字符串，JSON 的键与值必须用双引号`);
    }
    if (expectKey && /[A-Za-z_$]/.test(char)) {
      throw new Error(`第 ${line} 行：不支持无引号键，键必须用双引号包起来（如 "command"）`);
    }
    if (char === '\n') line += 1;
    // 空白原样落下（**不许**在这里 flush 攒着的逗号，否则 `[1, ]` 的尾逗号就漏掉了）；
    // 其余字符（数字 / true / null / 冒号 …）原样落，真正的语法错留给 JSON.parse
    if (/\s/.test(char)) out.push(char);
    else emit(char);
    index += 1;
  }

  if (pendingComma) out.push(',');
  return out.join('');
}

/** 数一段文本里有几个换行：块注释整段吞掉时用它补行号 */
function countNewlines(text: string): number {
  let total = 0;
  for (const char of text) if (char === '\n') total += 1;
  return total;
}

/**
 * 四类形状各一行示例：整份「无法识别」时摆在界面上，让用户知道**能贴什么**。
 *
 * 它放在契约里而不是界面文案里，是为了能被守卫盯住：这四条必须自己都是「认得的形状」
 * （用例逐条喂回 `parseMcpPaste`），否则示例会随着文法演进悄悄变成假话。
 */
export const MCP_PASTE_SHAPE_EXAMPLES: readonly string[] = [
  '{ "mcpServers": { "context7": { "url": "https://mcp.context7.com/mcp" } } }',
  '{ "servers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] } }, "inputs": [] }',
  '{ "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }',
  '{ // 注释与尾逗号也认\n  "mcpServers": { "context7": { "url": "https://mcp.context7.com/mcp" }, },\n}',
];

/** 预览里「能导入的一条」：`action` 只区分新增与覆盖，「跳过」由预览逐行切（它不是解析结论） */
export interface McpPasteEntry {
  name: string;
  entry: McpServerConfig;
  action: 'add' | 'overwrite';
  /** `action === 'overwrite'` 时给**被覆盖的那一条**：预览要点名「将覆盖已有的哪一台」 */
  existing?: McpServerConfig;
  /** 这一条被丢掉的字段（未知字段 + 跨传输字段 + 类型不对的键），预览逐行点名 */
  droppedFields: string[];
  /** 只有裸单项为 true：它的名字是猜的，预览里给输入框让用户改 */
  renamable: boolean;
}

/** 预览里「不导入的一条」：`reason` 是可直接展示的中文原因（其余条目照常导入） */
export interface McpPasteRejection {
  /** 条目名（map 的键）；键本身不合法时就是那串原文 */
  name: string;
  reason: string;
  /** 看得出来的传输（`type: 'sse'` 这类看不出就不给）：预览那一格照常显示 */
  transport?: McpServerConfig['transport'];
  droppedFields: string[];
}

/**
 * 整份级别的失败：超限 / 语法错 / 无法识别。有它时 `entries` 与 `rejected` 都是空的 ——
 * 「部分成功」在这里不成立：一份读不出来的文本没有任何一行是可信的。
 */
export interface McpPasteError {
  /** 可直接展示的中文原因（SyntaxError 一律在这一层折成中文，不许冒到出口） */
  message: string;
  /** 「无法识别」时给实际看到的顶层键：用户要照着它自己判断贴错了哪一层 */
  topLevelKeys?: string[];
}

/** 解析结果：直接喂预览（逐条说清将要发生什么），不经过第二次加工 */
export interface McpPasteResult {
  error?: McpPasteError;
  entries: McpPasteEntry[];
  rejected: McpPasteRejection[];
  /** 整份级别被丢掉的字段（信封的兄弟键，如 VS Code 的 `inputs`） */
  droppedFields: string[];
}

/** 空结果：给失败分支用，省得每处都写一遍三个空数组 */
function emptyResult(): McpPasteResult {
  return { entries: [], rejected: [], droppedFields: [] };
}

/** 是不是一个「普通对象」（数组与 null 都不算：`mcpServers` 是数组时不该被当成信封） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 按**字节**算长度（不是字符数）：上限写的是 256 KB，而一个汉字算 3 字节 ——
 * 按字符数算的话，一份 300 KB 的中文配置会被放行。
 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 把 `JSON.parse` 的失败折成**含行号与出错片段**的中文原因。
 * V8 的报错文本里带 `position N`，据此在**剥离后**的文本上还原行号与列号；
 * 拿不到位置时只给一句中文兜底，绝不把英文原文直接甩给用户（那会被当成「请求体不合法」）。
 */
function describeJsonFailure(source: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/.exec(raw);
  if (position === null) return '贴入的内容不是合法 JSON：请检查括号、引号与逗号是否配对';
  const at = Number(position[1]);
  const before = source.slice(0, at);
  const line = before.split('\n').length;
  const column = at - before.lastIndexOf('\n');
  const fragment = source.slice(Math.max(0, at - 20), at + 20).replace(/\n/g, '⏎');
  return `贴入的内容不是合法 JSON：第 ${line} 行第 ${column} 列附近「${fragment}」`;
}

/**
 * 剥离 → `JSON.parse` → 五步判别 → 逐条条目化。
 *
 * `existing` 是「现在设置页里有哪些」：它只影响每条的 `action`（同名 ⇒ 覆盖）与
 * `existing` 那一格，**不影响条目本身**（解析结果与落盘无关，纯粹是「这段文本说的是什么」）。
 */
export function parseMcpPaste(text: string, existing: McpServers = {}): McpPasteResult {
  if (text.trim() === '') return { ...emptyResult(), error: { message: '还没有贴入内容' } };

  // 上限先于一切：10 MB 的贴入先去解析的话，用户看到的是「界面卡住」而不是「太大了」
  if (byteLength(text) > MCP_PASTE_MAX_BYTES) {
    return {
      ...emptyResult(),
      error: { message: `贴入的内容超过 ${MCP_PASTE_MAX_BYTES / 1024} KB 的上限，请分几次导入` },
    };
  }

  let stripped: string;
  try {
    stripped = stripJsonComments(text);
  } catch (error) {
    // 单引号串 / 无引号键 / 注释没闭合：剥离器给的就是带行号的中文原因，原样透出
    return { ...emptyResult(), error: { message: error instanceof Error ? error.message : String(error) } };
  }

  let root: unknown;
  try {
    root = JSON.parse(stripped);
  } catch (error) {
    return { ...emptyResult(), error: { message: describeJsonFailure(stripped, error) } };
  }

  // 第 1 步 / 第 2 步：两种信封。信封的**兄弟键整份丢弃并在预览里点名** ——
  // VS Code 的 `inputs` 是用户真写过的东西，安静丢掉是预览最不该干的事（同一口径）。
  if (isRecord(root) && isRecord(root.mcpServers)) {
    return collectEntries(root.mcpServers, siblingKeys(root, 'mcpServers'), existing);
  }
  if (isRecord(root) && isRecord(root.servers)) {
    return collectEntries(root.servers, siblingKeys(root, 'servers'), existing);
  }

  // 第 3 步：裸单项（顶层自己带 command 或 url）。名字是猜的 ⇒ renamable，预览里可改
  if (isRecord(root) && ('command' in root || 'url' in root)) {
    const name = guessMcpName(root);
    const outcome = parseEntry(root);
    // 裸单项自带的 `name` 是**被判据用掉了**的（它就是这一台的名字），不该再出现在「被丢字段」里；
    // 不是字符串时 `guessMcpName` 用不上它，那才是真的丢了 —— 两种情形必须分开报
    const usedName = typeof root.name === 'string' && root.name.trim() !== '';
    const droppedFields = usedName ? outcome.droppedFields.filter((key) => key !== 'name') : outcome.droppedFields;
    if (outcome.entry === undefined) {
      return { ...emptyResult(), rejected: [toRejection(name, { ...outcome, droppedFields })] };
    }
    return {
      ...emptyResult(),
      entries: [toEntry(name, outcome.entry, droppedFields, true, existing)],
    };
  }

  // 第 4 步：顶层是数组 —— 不认（不猜「大概是若干台」：一次只说一份配置）
  if (Array.isArray(root)) {
    return {
      ...emptyResult(),
      error: {
        message:
          '顶层是数组，认不出这是哪一种形状：请贴一个对象 —— "mcpServers" 信封、"servers" 信封（VS Code），或单台服务器的配置',
      },
    };
  }

  // 第 5 步：其余 —— 列出**实际看到的顶层键**，让用户自己看出贴错了哪一层
  const topLevelKeys = isRecord(root) ? Object.keys(root) : [];
  const seen = topLevelKeys.length === 0 ? '顶层既不是对象也不是数组' : `看到的顶层键：${topLevelKeys.join('、')}`;
  return {
    ...emptyResult(),
    error: { message: `无法识别这段内容（${seen}）：没有 mcpServers / servers 信封，也没有 command / url`, topLevelKeys },
  };
}

/** 信封的兄弟键（`inputs` 这类）：整份丢弃，但必须点名 */
function siblingKeys(root: Record<string, unknown>, containerKey: string): string[] {
  return Object.keys(root).filter((key) => key !== containerKey);
}

/** name-keyed map → 逐条条目化。条数上限在这里判（数得出来才叫「太多了」） */
function collectEntries(container: Record<string, unknown>, dropped: string[], existing: McpServers): McpPasteResult {
  const names = Object.keys(container);
  if (names.length > MCP_PASTE_MAX_ENTRIES) {
    return {
      ...emptyResult(),
      error: {
        message: `这次贴入有 ${names.length} 台服务器，超过 ${MCP_PASTE_MAX_ENTRIES} 条的上限，请分几次导入`,
      },
    };
  }

  const entries: McpPasteEntry[] = [];
  const rejected: McpPasteRejection[] = [];
  for (const name of names) {
    // 键不合法（如 `my.server`）的条目**不导入并点名**：名字是三家交集的那套字符集，
    // 放进落盘只会在注入时被某一家静默丢掉
    if (!MCP_NAME_PATTERN.test(name)) {
      rejected.push({
        name,
        reason: `名字「${name}」不合法：只能是字母、数字、下划线或连字符，长度 1–32`,
        droppedFields: [],
      });
      continue;
    }
    const outcome = parseEntry(container[name]);
    if (outcome.entry === undefined) rejected.push(toRejection(name, outcome));
    else entries.push(toEntry(name, outcome.entry, outcome.droppedFields, false, existing));
  }
  return { entries, rejected, droppedFields: dropped };
}

/** 条目化的一次结果：要么给出一条可落盘的条目，要么给出中文的拒绝原因 */
interface EntryOutcome {
  entry?: McpServerConfig;
  reason?: string;
  transport?: McpServerConfig['transport'];
  droppedFields: string[];
}

/** 把「能导入的一条」拼成预览行：同名 ⇒ 覆盖（默认），并带上被覆盖的那一条 */
function toEntry(
  name: string,
  entry: McpServerConfig,
  droppedFields: string[],
  renamable: boolean,
  existing: McpServers,
): McpPasteEntry {
  const previous = existing[name];
  return {
    name,
    entry,
    action: previous === undefined ? 'add' : 'overwrite',
    ...(previous === undefined ? {} : { existing: previous }),
    droppedFields,
    renamable,
  };
}

/** 把一次拒绝拼成预览行 */
function toRejection(name: string, outcome: EntryOutcome): McpPasteRejection {
  return {
    name,
    reason: outcome.reason ?? '这一条无法导入',
    ...(outcome.transport === undefined ? {} : { transport: outcome.transport }),
    droppedFields: outcome.droppedFields,
  };
}

/** 通用包名段：`@playwright/mcp` 的末段是 `mcp`，光叫「mcp」当名字等于没起名 ⇒ 回落用作用域名 */
const GENERIC_PACKAGE_SEGMENTS = new Set(['mcp', 'server', 'cli', 'index', 'main']);

/**
 * 把一串自由文本净化为合法的服务器名（裸单项的默认名）。
 * 顺序是有讲究的：小写 → 非法字符转 `-` → 折叠连续 `-` → 去首尾 `-` → 截 32 位 → 再修一次尾部
 * （截断本身可能刚好切出一个尾随 `-`）→ 空则回落 `server-1`。
 * 幂等：净化过的名字再净化一次不变（预览里用户改完名字要按同一把尺子校验）。
 */
export function sanitizeMcpName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'server-1' : cleaned;
}

/** 从 URL 里取一个像名字的标签：`mcp.context7.com` ⇒ `context7`（前导的 mcp / api / www 是噪音） */
function hostLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // 不是合法 URL（占位、相对路径、手写半截）：猜不出名字不算错，交给后面的兜底
    return '';
  }
  const labels = host.split('.').filter((label) => label !== '');
  if (labels.length > 1 && ['mcp', 'api', 'www'].includes(labels[0] as string)) labels.shift();
  return labels[0] ?? '';
}

/** 从参数里找包名：`["-y", "@playwright/mcp@latest"]` ⇒ `playwright`（跳过选项、去掉版本号） */
function packageLabel(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const parts = arg.replace(/@[^@/]*$/, '').split('/').filter((part) => part !== '' && part !== '@');
    const last = parts[parts.length - 1] ?? '';
    if (last === '') continue;
    // 末段是通用词（mcp / server）而前面还有作用域时，用作用域名：`@playwright/mcp` ⇒ `playwright`
    if (GENERIC_PACKAGE_SEGMENTS.has(last.toLowerCase()) && parts.length > 1) {
      return (parts[0] as string).replace(/^@/, '');
    }
    // `mcp-server-git` / `server-filesystem` 这类前缀是套话，去掉才像个名字
    let name = last;
    while (/^(mcp|server)-/.test(name) && name.replace(/^(mcp|server)-/, '') !== '') {
      name = name.replace(/^(mcp|server)-/, '');
    }
    return name;
  }
  return '';
}

/**
 * 给裸单项猜一个默认名（预览里可改，所以猜错不致命，但猜得准能省一次输入）。
 * 三条线索按可信度排：显式的 `name` 字段 → URL 主机名 → 命令 / 参数里的包名 → 命令本身的 basename。
 * 最后一律过 `sanitizeMcpName`：猜出来的东西（`Context7 MCP`、`@playwright/mcp@latest`）多半不是合法字符集。
 */
export function guessMcpName(raw: Record<string, unknown>): string {
  if (typeof raw.name === 'string' && raw.name.trim() !== '') return sanitizeMcpName(raw.name);
  if (typeof raw.url === 'string' && raw.url !== '') {
    const label = hostLabel(raw.url);
    if (label !== '') return sanitizeMcpName(label);
  }
  const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const fromPackage = packageLabel(args);
  if (fromPackage !== '') return sanitizeMcpName(fromPackage);
  if (typeof raw.command === 'string' && raw.command !== '') {
    // 命令本身可能是 `/usr/local/bin/uvx`：取 basename 才像个名字
    return sanitizeMcpName(raw.command.split(/[\\/]/).pop() ?? raw.command);
  }
  return sanitizeMcpName('');
}

/**
 * 读一张「键 → 字符串」表（`headers` / `env`）。
 * 判据逐格给：键与值都要是字符串，键另有各自的正则（headers 只要非空、env 走环境变量形状）。
 * 不合格的**逐格丢掉并点名**（`env.MY.KEY` 这样带字段名），而不是整张表扔了或者硬转成字符串
 * —— 后者会让一条本来能用的配置因为一个笔误的键名整条作废。
 */
function readStringMap(
  value: unknown,
  field: 'headers' | 'env',
  droppedFields: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    droppedFields.push(field);
    return undefined;
  }
  const map: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const keyOk = field === 'headers' ? key !== '' : MCP_ENV_KEY_PATTERN.test(key);
    if (!keyOk || typeof item !== 'string') {
      droppedFields.push(`${field}.${key === '' ? '(空键名)' : key}`);
      continue;
    }
    map[key] = item;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/** 读 `args`：非数组整格丢、非字符串的**逐项**丢并点名（一个数字参数不该毁掉整条命令） */
function readArgs(value: unknown, droppedFields: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    droppedFields.push('args');
    return undefined;
  }
  const args: string[] = [];
  value.forEach((item, index) => {
    if (typeof item === 'string') args.push(item);
    else droppedFields.push(`args[${index}]`);
  });
  return args.length > 0 ? args : undefined;
}

/** `type` / `transport` 的三种读数：http / stdio / 不认识；没给就是「靠字段推」 */
type DeclaredTransport = { kind: 'http' | 'stdio' } | { kind: 'unsupported'; reason: string } | { kind: 'none' };

/**
 * 读声明的传输。`type` 优先于 `transport`（VS Code 与 Cursor 用前者，我们自己的落盘形态用后者，
 * 两者同时出现且打架时以 `type` 为准：贴进来的文本按来源方的习惯读）。
 * `sse` / `sdk` 明确点名「不支持」——它们是**看得出来**的构造，不该混进「不认识」那句里。
 */
function readDeclaredTransport(raw: Record<string, unknown>): DeclaredTransport {
  const value = raw.type ?? raw.transport;
  if (value === undefined) return { kind: 'none' };
  if (typeof value !== 'string') return { kind: 'unsupported', reason: 'type / transport 只能是字符串' };
  const normalized = value.toLowerCase();
  if (normalized === 'http' || normalized === 'streamable-http') return { kind: 'http' };
  if (normalized === 'stdio') return { kind: 'stdio' };
  if (normalized === 'sse') return { kind: 'unsupported', reason: '暂不支持 type: \'sse\'（旧版 SSE 传输）：服务端只认 stdio 与 http' };
  if (normalized === 'sdk') return { kind: 'unsupported', reason: '暂不支持 type: \'sdk\'（进程内 SDK 传输）：服务端只认 stdio 与 http' };
  return { kind: 'unsupported', reason: `不认识的传输类型「${value}」：只认 stdio 与 http / streamable-http` };
}

/**
 * 一条原始值 → 一条 canonical 条目（或一条中文拒绝原因）。
 *
 * 传输判定的顺序：**声明的 type / transport 优先** → 缺省靠字段推（有 url ⇒ http、
 * 有 command ⇒ stdio）→ **两者都有却没说 type ⇒ 拒绝**（「不猜」这条在这里最要紧：猜错方向时
 * 用户拿到的是一个连不上的端点，而预览上写着「成功」）。
 *
 * 字段处置一律「strip 并点名」：未知字段、跨传输字段、类型不对的键都进 `droppedFields`，
 * 由预览逐行显示。拒绝只留给**真的分不出**的情形（没有字段、两边都有、声明与字段对不上、
 * 不支持的占位与传输类型）——「丢掉一个不认识的字段」不是拒绝理由。
 */
function parseEntry(raw: unknown): EntryOutcome {
  const droppedFields: string[] = [];
  if (!isRecord(raw)) {
    return { reason: `这一条不是一台 MCP 服务器（值是 ${describeValue(raw)}）`, droppedFields };
  }

  const declared = readDeclaredTransport(raw);
  if (declared.kind === 'unsupported') return { reason: declared.reason, droppedFields };

  const url = typeof raw.url === 'string' && raw.url !== '' ? raw.url : undefined;
  const command = typeof raw.command === 'string' && raw.command !== '' ? raw.command : undefined;

  let transport: McpServerConfig['transport'];
  if (declared.kind !== 'none') {
    transport = declared.kind;
    // 声明与字段对不上时**拒绝**而不是补齐：`type: 'http'` 却没有 url 的条目落盘之后，
    // 注入那一刻会以一个空端点出现在厂商配置里
    if (transport === 'http' && url === undefined) {
      return { reason: '声明了 http，但缺少 url', transport, droppedFields };
    }
    if (transport === 'stdio' && command === undefined) {
      return { reason: '声明了 stdio，但缺少 command', transport, droppedFields };
    }
  } else if (url !== undefined && command !== undefined) {
    return {
      reason: '同时带了 url 与 command 却没说 type / transport，分不出是 stdio 还是 http',
      droppedFields,
    };
  } else if (url !== undefined) {
    transport = 'http';
  } else if (command !== undefined) {
    transport = 'stdio';
  } else {
    return { reason: '既没有 url 也没有 command，不是一台 MCP 服务器', droppedFields };
  }

  // 字段映射：只认本传输那一支的字段，其余（含另一支的字段）当「不认识」
  let headers: Record<string, string> | undefined;
  let args: string[] | undefined;
  let env: Record<string, string> | undefined;
  for (const key of Object.keys(raw)) {
    if (key === 'type' || key === 'transport' || key === 'enabled') continue; // 已消费，不算丢
    if (transport === 'http') {
      if (key === 'url') continue;
      if (key === 'headers') {
        headers = readStringMap(raw.headers, 'headers', droppedFields);
        continue;
      }
      droppedFields.push(key);
      continue;
    }
    if (key === 'command') continue;
    if (key === 'args') {
      args = readArgs(raw.args, droppedFields);
      continue;
    }
    if (key === 'env') {
      env = readStringMap(raw.env, 'env', droppedFields);
      continue;
    }
    droppedFields.push(key);
  }

  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;
  if (raw.enabled !== undefined && enabled === undefined) droppedFields.push('enabled');

  // 占位检查：env / headers 的**值**里只认 `${ENV_NAME}`；url / command / args
  // 里一个都不认（它们不参与注入时的解析，留一串 `${…}` 就是一句假话）。拒绝而不是硬转：
  // `${input:token}` 是 VS Code 的输入外壳，服务端没有那套输入机制，硬转出来的条目一定连不上。
  const placeholders: Array<{ text: string; allowEnvName: boolean }> =
    transport === 'http'
      ? [
        { text: url as string, allowEnvName: false },
        ...Object.values(headers ?? {}).map((text) => ({ text, allowEnvName: true })),
      ]
      : [
        { text: command as string, allowEnvName: false },
        ...(args ?? []).map((text) => ({ text, allowEnvName: false })),
        ...Object.values(env ?? {}).map((text) => ({ text, allowEnvName: true })),
      ];
  for (const item of placeholders) {
    const bad = findUnsupportedPlaceholder(item.text, item.allowEnvName);
    if (bad !== null) {
      return {
        reason: `不支持占位 ${bad}：占位只能写在 env / headers 的值里，且只认 \${环境变量名} 这一种形式`,
        transport,
        droppedFields,
      };
    }
  }

  const entry: McpServerConfig =
    transport === 'http'
      ? { transport: 'http', enabled: enabled ?? true, url: url as string, ...(headers === undefined ? {} : { headers }) }
      : {
        transport: 'stdio',
        enabled: enabled ?? true,
        command: command as string,
        ...(args === undefined ? {} : { args }),
        ...(env === undefined ? {} : { env }),
      };
  return { entry, droppedFields };
}

/** 值的中文描述：拒绝原因里要说清「看到的是什么」，否则用户不知道那一格到底被读成了什么 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value;
}

/**
 * 找出第一个不支持的 `${…}` 占位，返回它的**原文**（拒绝原因里要逐字点出来，用户才改得动）。
 * `allowEnvName` 为 true 时只认 `${ENV_NAME}`（env / headers 的值）；
 * 为 false 时一个都不认（url / command / args：它们不参与注入时的解析）。
 * 只认 `}` 收尾的写法：`${VAR` 这种半截留给 `JSON.parse` / 厂商去报，不在这里假装看得出来。
 */
function findUnsupportedPlaceholder(text: string, allowEnvName: boolean): string | null {
  for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
    const inner = match[1] ?? '';
    if (allowEnvName && MCP_ENV_KEY_PATTERN.test(inner)) continue;
    return match[0];
  }
  return null;
}

/**
 * 预览里那一格名字能不能导入：`null` = 可以，非空 = 中文原因（这一行**不许导入**）。
 *
 * 两条判据都只在裸单项上真的会发生（它的名字是猜的、可改），但函数对**所有行**一视同仁：
 * 判据写在一处，将来多一种可改名的形状时不会再各写一遍。
 * 「撞名」比的是**净化后**的名字：`Context7` 与 `context7` 在落盘里是两个键，
 * 但在用户眼里是同一台 —— 让它过，第二台会以一个看不出差别的名字悄悄写进去。
 */
export function mcpPasteNameIssue(name: string, taken: readonly string[]): string | null {
  if (name.trim() === '') return '名字不能为空：请给这一台填一个名字';
  if (!MCP_NAME_PATTERN.test(name)) return '名字只能是字母、数字、下划线或连字符，长度 1–32';
  const normalized = sanitizeMcpName(name);
  if (taken.some((other) => sanitizeMcpName(other) === normalized)) {
    return `名字「${name}」与本次导入的另一台重名，请改一个`;
  }
  return null;
}

/**
 * 把预览里**决定导入的那些行**并进现有集合，返回一份新的整份 map（调用方拿着它走一次
 * `PUT /api/settings` —— 一次原子落盘，不做第二次合并，否则「预览说 3 台、落盘 4 台」这种
 * 偏差会重新出现）。
 *
 * 顺序口径与 `upsertServer` 一致：覆盖的条目**挪到末尾**（先删键再写），新增按贴入顺序追加。
 * 不这么做的话，同一件事（保存一条同名条目）在表单与粘贴两条路径上会给出两种顺序。
 * `clearFirst` 为真时从空 map 起步 —— 那是用户明确勾选的「先清空现有条目再导入」，
 * 与「一条都没导入」是两态，故空 `rows` 也照样清空。
 */
export function applyMcpPaste(
  current: McpServers,
  rows: ReadonlyArray<{ name: string; entry: McpServerConfig }>,
  clearFirst = false,
): McpServers {
  const next: McpServers = clearFirst ? {} : { ...current };
  for (const row of rows) {
    delete next[row.name];
    next[row.name] = row.entry;
  }
  return next;
}
