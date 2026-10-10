/**
 * 用例存储：`<casesRoot>/<case-id>.json`，**一文件一用例**。
 *
 * 为什么从 `config.json` 的 `cases` 数组搬出来（用户口径，2026-10）：用例是**会被 git 管理的内容**，
 * 而它原来和供应商凭据住在同一个文件里——那个文件一改就是整份覆盖写（每次保存用例都重写全部凭据），
 * 一旦把它放进 git，凭据就跟着进了历史。搬出来之后：一个用例一个文件，diff 干净、冲突面小到单个用例，
 * 「提交哪些变更」也有了天然的粒度。
 *
 * 六条口径：
 *   1. **id 就是文件名**（`<id>.json`），形状由契约的 `isCaseIdShapeValid` 判定：写侧拒绝、读侧跳过。
 *      没有这条判据，一个带 `..` 的 id 就能把读写带出 `<casesRoot>` 之外；
 *   2. **文件名是身份的真源**：文件内容里的 `id` 与之不一致时以**文件名**为准（并留一条 WARN）。
 *      谁的真源只有一个，否则「同一份内容两个 id」会让查找与写入指向不同的文件；
 *   3. **读侧宽容、写侧严格**（与 `loadConfig` 故意不校验、`assertStorable` 在写前自检同一口径）：
 *      `listCases` 跳过坏文件并把它**说出去**（`warnings`），`readCase` 则抛含文件路径的中文原因——
 *      列表要能渲染（否则用户连删掉那个坏文件的入口都没有），详情/评测要能解释为什么用不了；
 *   4. **原子写**：临时文件（创建即 0600）→ rename 覆盖，与 `config-store` 同源。**不产 BOM**，
 *      但**读时容忍 BOM**（PowerShell 5.1 的 `Set-Content` / `ConvertTo-Json` 默认带）；
 *   5. **目录不存在 = 还没有用例**，不是错误（首次使用、刚改过 casesRoot 都是这个状态）；
 *   6. **测试用 `setCasesRootForTesting` 覆盖**，与 `setConfigDirForTesting` 同构。这条是硬要求：
 *      默认根目录落在**真实家目录**下，没有这个钩子，用例测试会去读写开发者的 `~/.aieval-cases`。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError, isCaseIdShapeValid, type CaseList, type TestCase } from '@aieval/contracts';
import { loadConfig } from './config-store';
import { createLogger } from './logger';
import { resolveCasesRootForRead } from './paths';

const log = createLogger('case-store');

/** 用例文件的后缀（文件名 = `<id>.json`，身份即文件名） */
const CASE_FILE_SUFFIX = '.json';

/** 测试可覆盖的用例根目录；为 null 时回落到设置 / 环境变量 / 家目录 */
let overrideRoot: string | null = null;

/**
 * 设置测试用的用例根目录。
 * 为什么必须存在：默认根目录是 `~/.aieval-cases`（真实家目录），而用例的读写测试全部用临时目录——
 * 少了这个钩子，`setConfigDirForTesting` 挡不住它（那个只管 `config.json` 所在目录）。
 */
export function setCasesRootForTesting(dir: string | null): void {
  overrideRoot = dir;
}

/**
 * 当前是否设了测试覆盖（回覆盖目录，没设回 null）。
 * 给**夹具**用的安全阀：批量写用例的夹具（evaluator / api 的 seedConfig）在动手之前必须先确认
 * 自己被指向了临时目录——否则一次忘记 `createTempHome()` 的调用就会把开发者的真实
 * `~/.aieval-cases` 当成夹具目录清空。判据是「覆盖有没有设」，与 config 目录那边同一思路。
 */
export function getCasesRootOverrideForTesting(): string | null {
  return overrideRoot;
}

/**
 * 当前用例根目录。优先级：**测试覆盖 > 设置页的 `casesRoot` > `AIEVAL_CASES_ROOT` > `~/.aieval-cases`**。
 * 后三档的判据只有一处实现（`resolveCasesRootForRead`，api 的设置归一化读的是同一个函数）——
 * 这里再写一遍「环境变量 vs 设置」必然会漂移，而漂移的症状是「设置页显示一个路径、读写落在另一个」。
 */
export function getCasesRoot(): string {
  if (overrideRoot !== null) return overrideRoot;
  return resolveCasesRootForRead(loadConfig().settings.casesRoot);
}

/**
 * 用例 id 的形状校验：不合法一律 `INVALID_QUERY` + 中文原因。
 * **写侧与读侧都要过**：它同时是安全边界（文件名不能带路径分隔符与 `..`）与身份判据。
 */
export function assertCaseId(caseId: string): string {
  if (!isCaseIdShapeValid(caseId)) {
    throw new ServiceError('INVALID_QUERY', `用例 id 不合法（只允许字母、数字、下划线、连字符，最长 64）：${caseId}`, {
      context: { caseId },
    });
  }
  return caseId;
}

/** 某个用例的文件路径。**每次经过 id 校验**：这是防路径穿越的唯一一道门。 */
export function caseFile(caseId: string): string {
  return join(getCasesRoot(), `${assertCaseId(caseId)}${CASE_FILE_SUFFIX}`);
}

/**
 * 列出全部用例：目录不存在 = 空列表；坏文件跳过并记进 `warnings`。
 * 排序不在这里（api 层按 `updatedAt` 倒序），本函数只保证「读到的都读干净了」。
 */
export function listCases(): CaseList {
  const root = getCasesRoot();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    // 目录还没建出来是**正常状态**（首次使用 / 刚改过根目录），不是错误
    if (isMissingPath(error)) return { cases: [], warnings: [] };
    throw new ServiceError('INTERNAL', `读取用例目录失败：${root}（${reason(error)}）`, { cause: error, context: { root } });
  }

  const cases: TestCase[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    if (!name.endsWith(CASE_FILE_SUFFIX)) continue;
    const id = name.slice(0, -CASE_FILE_SUFFIX.length);
    if (!isCaseIdShapeValid(id)) {
      // 只有警告，**不删**：这个文件不是我们建的，什么时候清理由用户决定
      const warning = `跳过文件名不合法的用例文件：${name}（id 只允许字母、数字、下划线、连字符，最长 64）`;
      warnings.push(warning);
      log.warn(warning, { root, name });
      continue;
    }
    const parsed = parseCaseFile(join(root, name), id);
    if (!parsed.ok) {
      warnings.push(parsed.reason);
      log.warn('跳过读不出来的用例文件', { root, name, reason: parsed.reason });
      continue;
    }
    cases.push(parsed.testCase);
  }
  return { cases, warnings };
}

/**
 * 取单个用例：文件不存在返回 null（调用方按「用例不存在」处置）。
 * **坏文件抛含路径的中文 INTERNAL**（不返回 null）：把它说成「不存在」会让用户去别处找，
 * 而真正该做的是修好或删掉那个文件——原因里就带着路径。
 */
export function readCase(caseId: string): TestCase | null {
  const file = caseFile(caseId);
  if (!existsSync(file)) return null;
  const parsed = parseCaseFile(file, caseId);
  if (!parsed.ok) {
    throw new ServiceError('INTERNAL', parsed.reason, { context: { file, caseId } });
  }
  return parsed.testCase;
}

/** 写一个用例：确保目录存在 → 原子替换（临时文件 0600 → rename） */
export function writeCase(testCase: TestCase): void {
  const file = caseFile(testCase.id);
  const dir = getCasesRoot();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw writeFailed(file, error);
  }

  const tmp = `${file}.tmp`;
  try {
    // 创建时就 0600，不留「先按 umask 建好再收紧」的可读窗口（用例里可能有私有仓库地址与题面）
    writeFileSync(tmp, `${JSON.stringify(testCase, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    throw writeFailed(file, error);
  }
  // 尽力收紧：创建时的 mode 在部分平台/路径上不被沿用；Windows 无 POSIX 权限位，失败不阻断
  try {
    chmodSync(tmp, 0o600);
  } catch {
    log.warn('收紧用例文件权限失败（Windows 等无 POSIX 权限位的平台属正常）', { file: tmp });
  }

  try {
    renameSync(tmp, file);
  } catch (error) {
    // 与 `config-store.saveConfig` 同一套处置：目标**只读**时裸 rename 在 Windows 上必失败，
    // 只能先删目标；杀软/索引器的瞬时占用则重试 rename 就过去了——把后者当只读处理，
    // 会白白制造一个「用例文件不存在」的窗口
    log.warn('rename 覆盖用例文件失败，按目标是否只读决定是否先删除', {
      file,
      readOnly: isReadOnly(file),
      reason: reason(error),
    });
    if (isReadOnly(file)) rmSync(file, { force: true });
    try {
      renameSync(tmp, file);
    } catch (retryError) {
      throw writeFailed(file, retryError);
    }
  }
}

/** 删掉一个用例文件：文件本来就不在也算成功（幂等——调用方只关心「删完之后它不在了」） */
export function deleteCaseFile(caseId: string): void {
  const file = caseFile(caseId);
  try {
    rmSync(file, { force: true });
  } catch (error) {
    throw new ServiceError('INTERNAL', `删除用例文件失败：${file}（${reason(error)}）`, { cause: error, context: { file } });
  }
}

/**
 * 解析一个用例文件。
 * 两件事各自成一段：
 *   1. JSON 能解析、且是对象（数组 / 标量都算坏文件）；
 *   2. **文件名胜出**——内容里的 `id` 与文件名不一致时以文件名为准并留 WARN。
 *      `id` 是查找键与写入目标，两处指向不同的值必然出事（改 A 读到 B）。
 * 失败返回原因而不是抛：`listCases` 把它折成 warnings，`readCase` 把它折成 INTERNAL，
 * 两条路要的是同一句话。
 */
function parseCaseFile(file: string, id: string): { ok: true; testCase: TestCase } | { ok: false; reason: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    return { ok: false, reason: `读不出用例文件：${file}（${reason(error)}）` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `用例文件不是合法 JSON：${file}（${reason(error)}）` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `用例文件的内容不是一个对象：${file}` };
  }

  const record = parsed as TestCase;
  if (record.id !== id) {
    // 内容里的 id 与文件名不一致：文件名是真源，但要留痕——手抄文件忘改 id 是最常见的成因
    log.warn('用例文件里的 id 与文件名不一致，以文件名为准', { file, fileId: id, contentId: record.id });
  }
  return { ok: true, testCase: { ...record, id } };
}

/** 目标文件是否只读（Windows 用写位表达只读属性，两个平台都认 `(mode & 0o200) === 0`） */
function isReadOnly(file: string): boolean {
  const stat = statSync(file, { throwIfNoEntry: false });
  return stat !== undefined && (stat.mode & 0o200) === 0;
}

/** 落盘失败统一折成含路径的中文 INTERNAL（裸 errno 到路由层只剩「服务端内部错误」） */
function writeFailed(file: string, error: unknown): ServiceError {
  return error instanceof ServiceError
    ? error
    : new ServiceError('INTERNAL', `用例保存失败：${file}（${reason(error)}）`, { cause: error, context: { file } });
}

/** 是不是「路径不存在」这类 errno（读不存在的目录不是错误） */
function isMissingPath(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/** 取错误的人类可读原因（error 不一定是 Error） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
