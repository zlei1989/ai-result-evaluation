/**
 * 应用配置落盘：JSON 文件 + 原子可覆盖写。
 * 三个必须实现的行为（每条都对应一个真实故障）：
 *   1. 原子写——先写临时文件再 rename，避免写到一半崩溃留下半截 JSON 让全站不可用；
 *   2. 容忍 UTF-8 BOM——外部工具（PowerShell 5.1 的 Set-Content / Out-File / ConvertTo-Json）
 *      默认带 BOM，而 JSON.parse 遇到 U+FEFF 直接抛 SyntaxError，冒到路由层会被误报成
 *      「请求体不是合法 JSON」的 400 并让全站不可用；
 *   3. 损坏时抛含路径的中文原因——不能让 SyntaxError 冒充「请求体不合法」，否则排查方向被带偏。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ServiceError, SETTINGS_DEFAULTS, type Settings } from '@aieval/contracts';
import { createLogger } from './logger';

const log = createLogger('config-store');

export type ProtocolType = 'openai' | 'anthropic';

/** 模型清单条目：source 区分自动拉取与手工维护（拉取是合并，不能冲掉手工项） */
export interface ProviderModelRecord {
  id: string;
  source: 'fetched' | 'manual';
}

/** 供应商（含明文 API 密钥；对外出口一律掩码，见 api 层） */
export interface ProviderRecord {
  id: string;
  name: string;
  protocolType: ProtocolType;
  baseUrl: string;
  apiKey: string;
  models: ProviderModelRecord[];
  createdAt: string;
  updatedAt: string;
}

/** 用例（脚手架阶段只定义形状，功能阶段才读写） */
export interface TestCaseRecord {
  id: string;
  title: string;
  repoPath: string;
  commitHash: string | null;
  taskPrompt: string;
  judgePrompt: string;
  judgeProviderId: string | null;
  judgeModelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppConfig {
  settings: Settings;
  providers: ProviderRecord[];
  cases: TestCaseRecord[];
}

/** 测试可覆盖的配置目录；为 null 时回落到环境变量与家目录 */
let overrideDir: string | null = null;

/**
 * 设置测试用的配置目录。
 * 为什么不用环境变量：环境变量必须在模块加载前设好，测试里改不动已加载的模块。
 */
export function setConfigDirForTesting(dir: string | null): void {
  overrideDir = dir;
}

/**
 * 配置目录：测试覆盖 > AIEVAL_CONFIG_DIR（部署可配）> ~/.aieval。
 * 环境变量用 `||` 而不是 `??`：空串（`AIEVAL_CONFIG_DIR=`、容器里注入空值）必须与「没设」
 * 一样回落——`??` 会把 '' 当成有效值，configFile() 于是变成相对的 'config.json'，
 * 写盘悄悄落到进程的 cwd 里。
 * 注意 `||` 与 `??` 不能不加括号地混用（那是 SyntaxError），故内层单独括起来。
 */
export function getConfigDir(): string {
  return overrideDir ?? (process.env.AIEVAL_CONFIG_DIR || join(homedir(), '.aieval'));
}

function configFile(): string {
  return join(getConfigDir(), 'config.json');
}

/**
 * 完整默认配置：每次返回**独立**的对象，调用方改动不会污染下一次读取。
 * settings 必须深拷贝（structuredClone），不能写成 `{ ...SETTINGS_DEFAULTS }`：
 * 浅拷贝只隔离顶层基本类型，`defaultJudge` 这类嵌套对象仍与共享常量别名，
 * 调用方改一下嵌套字段就永久污染 SETTINGS_DEFAULTS，此后每次读取都拿到脏值。
 */
function defaults(): AppConfig {
  return { settings: structuredClone(SETTINGS_DEFAULTS), providers: [], cases: [] };
}

/**
 * 读配置：文件不存在返回默认值；缺失字段归一化；BOM 容忍；损坏抛中文原因。
 * 归一化是必要的——旧版本写下的文件可能缺字段，但下行契约要求字段恒存在。
 */
export function loadConfig(): AppConfig {
  const file = configFile();
  if (!existsSync(file)) return defaults();

  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    const parsed = JSON.parse(text) as Partial<AppConfig>;
    return {
      settings: { ...SETTINGS_DEFAULTS, ...parsed.settings },
      providers: parsed.providers ?? [],
      cases: parsed.cases ?? [],
    };
  } catch (error) {
    throw new ServiceError(
      'INTERNAL',
      `配置文件不是合法 JSON：${file}（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
}

/**
 * 写配置：确保目录存在 → 写临时文件（创建即 0600）→ 尽力收紧权限 → rename 覆盖。
 * rename 是只读安全的原子替换：libuv 在 Windows 上以 MOVEFILE_REPLACE_EXISTING 语义调用，
 * 覆盖一个可写目标会成功——所以正常情况下**不需要**先删目标。
 * 先删再 rename 反而制造了两个窗口：① 两步之间崩溃/异常会让配置文件彻底消失，
 * 而 loadConfig() 会静默回落默认值（设置、供应商与明文 apiKey 一起丢）；
 * ② 并发读取会看到 ENOENT。
 * 唯一需要删除的场景是目标**只读**：此时裸 rename 抛 EPERM，而 rmSync 能删掉只读文件。
 * 故仅在 rename 失败时才回退到「删掉再重试」，正常路径不经过它。
 */
export function saveConfig(config: AppConfig): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  const file = configFile();
  const tmp = `${file}.tmp`;

  // 配置含明文凭据：0600 必须**在创建时**给出，不能先按默认 mode（受 umask 放宽）建好再 chmod——
  // 「先建后 chmod」之间有一个短暂的可读窗口，同机其他用户能读到密钥。
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // POSIX 下收紧为属主独占 0600。创建时的 mode 在部分平台/路径上不被沿用，故仍然再收紧一次。
  // Windows 无 POSIX 权限位，chmod 仅能近似切换只读位，属主独占由 NTFS ACL 与用户目录隔离承担——
  // 此处尽力而为、失败不报错（不阻断保存）。
  try {
    chmodSync(tmp, 0o600);
  } catch {
    log.warn('收紧配置文件权限失败（Windows 等无 POSIX 权限位的平台属正常）', { file: tmp });
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    log.warn('rename 覆盖配置失败，回退到删除后重试', {
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
    rmSync(file, { force: true });
    renameSync(tmp, file);
  }
  log.info('配置已保存', { file });
}
