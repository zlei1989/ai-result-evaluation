/**
 * 探针：`@openai/codex-sdk@0.156.1`（内置 CLI `codex-cli 0.156.1`）如何添加 skill？
 *
 * 待回答的问题（**本脚本写就时未跑通，原因见下**）：
 *   1. 把 SKILL.md 放进 `$CODEX_HOME/skills/<name>/`，模型真能看见吗？
 *   2. 要不要额外的 config 开关？
 *   3. skill 正文是常驻上下文，还是像 claude 那样惰性加载？
 *
 * 为什么值得跑：SDK 的 `dist/index.d.ts` 里 `skill` 出现 **0** 次（已独立复核），
 * 但 CLI 二进制里有完整的 skill 子系统（1001 条含 `skill` 的字符串、84 条含 `SKILL.md`、
 * `ext\skills\src\*` 模块路径、`codex_config::skills_config`、app-server 的 `skills/list`），
 * 且内嵌 Python 安装器逐字写着：
 *     return os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
 *     return os.path.join(_codex_home(), "skills")
 * ⇒ 「文件 + CODEX_HOME」这条加法**结构性证据很强**，但缺一次运行期确认。
 *
 * 手法：**自述式判据**，不抓包——落一个 description 带哨兵、
 * 正文带另一个哨兵的 skill，问模型「列出你现在能看到的全部 skill 并逐字引用 description」，
 * 看答复里出现哪个哨兵。比抓包更直接，也不吃「标题生成算第 1 轮」那类计数陷阱
 * （claude 侧踩过，见 .probe-ws/claude-skills/notes）。
 *
 * ── 为什么本机没跑成（2026-09-30）──
 *   1. 上游网关不可达：Test-NetConnection likecode-llm-proxy-test.jd.com:80 → False；
 *      likecode-llm-proxy.jd.com:443 → False（本仓 probe/v2/lib/codex.mjs 的凭据走的就是前者）；
 *   2. `~/.codex` 无凭据（auth.json 不存在）⇒ 没有第二条上游可走。
 * ⇒ 有网环境补上 AIEVAL_V2_CODEX_BASE_URL / AIEVAL_V2_CODEX_API_KEY 即可复跑。
 *
 * ⚠️ 踩过并已修的坑：`execFileSync` 默认把父进程 stdin 交给子进程，而 `codex exec`
 * 会打印 "Reading additional input from stdin..." 并**挂住等 EOF**，整条用例以
 * `spawnSync … ETIMEDOUT` 收场。解法是显式 `stdio: ['ignore', 'pipe', 'pipe']`（下方已带）。
 *
 * 用法：
 *   $env:AIEVAL_V2_CODEX_BASE_URL = 'http://<网关>/v1'
 *   $env:AIEVAL_V2_CODEX_API_KEY  = '<key>'
 *   node packages/server/agents/probe/v2/codex-skills.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { BUNDLED_CODEX_EXE, CODEX_API_KEY, CODEX_BASE_URL, CODEX_MODEL } from './lib/codex.mjs';
import { note } from './lib/gateway.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * SDK 自带的那一份 codex 二进制。
 *
 * 为什么不直接用 `lib/codex.mjs` 的 `BUNDLED_CODEX_EXE`：那个常量是基于 **`process.cwd()`**
 * 拼的，隐含「从 `packages/server/agents` 下跑」这个前提。本脚本要能从仓库根直接跑
 * （`node packages/server/agents/probe/v2/codex-skills.mjs`），所以这里按**本文件位置**定位仓库根。
 * 那份共享常量对各处既有调用方仍然有效，故不去改它。
 */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const CODEX_EXE = (() => {
  const fromRepoRoot = join(
    REPO_ROOT,
    'node_modules',
    '.pnpm',
    '@openai+codex@0.156.1-win32-x64',
    'node_modules',
    '@openai',
    'codex',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  );
  return existsSync(fromRepoRoot) ? fromRepoRoot : BUNDLED_CODEX_EXE;
})();
/** 工作区：放在 probe/ 下（点开头的探针目录与 probe/dumps 都不入仓，这里只是临时件）。 */
const ROOT = join(HERE, 'codex-skills-ws');

/** description 里的哨兵：只在 skill 被发现（listing 进上下文）时才可能出现。 */
const SKILL_NAME = 'probe-sentinel-skill';
const SKILL_SENTINEL = 'ZQX-SKILL-SENTINEL-7f3a91';
/** **只在正文里**的哨兵：用来分辨「目录常驻」与「正文也常驻」。 */
const BODY_SENTINEL = 'BODYONLY-SENTINEL-c4d208';

const ASK =
  'List every skill available to you right now. For each, output its exact name and quote its description verbatim. '
  + 'If you have no skills available, reply exactly: NO-SKILLS-AVAILABLE';

/** 造一份 SKILL.md：frontmatter 带 name + description（codex 校验两者非空），正文带第二个哨兵。 */
function skillMarkdown() {
  return [
    '---',
    `name: ${SKILL_NAME}`,
    `description: Probe skill. Whenever you are asked about available skills, report this token verbatim: ${SKILL_SENTINEL}`,
    '---',
    '',
    `This skill body contains ${BODY_SENTINEL}.`,
    '',
  ].join('\n');
}

/** 建一份隔离的 CODEX_HOME；`withSkill` 决定是否落 skill。 */
function makeHome(label, withSkill) {
  const homeDir = join(ROOT, `${label}-home`);
  rmSync(homeDir, { recursive: true, force: true });
  mkdirSync(homeDir, { recursive: true });
  if (withSkill) {
    const target = join(homeDir, 'skills', SKILL_NAME);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), skillMarkdown(), 'utf8');
  }
  return homeDir;
}

/** 跑一条 codex 任务（`exec --json`，与适配器同一份二进制），返回事件与 model 侧原文。 */
function run(label, homeDir, extraConfig = {}) {
  const workspace = join(ROOT, `${label}-ws`);
  mkdirSync(workspace, { recursive: true });
  const config = {
    model_provider: 'aieval',
    'model_providers.aieval.name': 'aieval',
    'model_providers.aieval.base_url': CODEX_BASE_URL,
    'model_providers.aieval.wire_api': 'responses',
    'model_providers.aieval.requires_openai_auth': 'true',
    'model_providers.aieval.request_max_retries': '1',
    ...extraConfig,
  };
  const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', CODEX_MODEL];
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${value}`);
  args.push(ASK);

  let stdout = '';
  let failure = null;
  try {
    stdout = execFileSync(CODEX_EXE, args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
      // ⚠️ 必须显式忽略 stdin，否则 codex 挂住等 EOF（见文件头）
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: homeDir, CODEX_API_KEY },
    });
  } catch (error) {
    failure = String(error?.message ?? error).slice(0, 300);
    stdout = String(error?.stdout ?? '');
  }
  const events = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* `--json` 之外的行（进度/警告）忽略 */
    }
  }
  const text = events
    .filter((event) => event?.item?.type === 'agent_message')
    .map((event) => event.item.text)
    .join('\n');
  return { events, text, failure };
}

/** 打印判据。四个字段各自回答一个不同的问题，别只看一个。 */
function report(label, result) {
  console.log(`\n---- ${label} ----`);
  console.log('  CLI 异常                 :', result.failure);
  console.log('  item 类型                :', JSON.stringify([...new Set(result.events.map((e) => e?.item?.type).filter(Boolean))]));
  console.log('  模型答复(前 700 字)      :', JSON.stringify(result.text.slice(0, 700)));
  console.log('  >>> description 哨兵命中 :', result.text.includes(SKILL_SENTINEL), '（= listing 进了上下文）');
  console.log('  >>> 正文哨兵命中         :', result.text.includes(BODY_SENTINEL), '（= 正文也常驻，非惰性）');
  console.log('  >>> skill 名命中         :', result.text.includes(SKILL_NAME));
  console.log('  >>> 自述「无 skill」     :', result.text.includes('NO-SKILLS-AVAILABLE'));
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

note('网关 :', CODEX_BASE_URL);
note('模型 :', CODEX_MODEL);
note('二进制:', CODEX_EXE);

console.log('\n================ 用例 A：$CODEX_HOME/skills/ 落 skill，默认 config ================');
report('A(with skill)', run('A-with', makeHome('A', true)));

console.log('\n================ 用例 B：同样的 home，**不放** skill（对照，排除模型自己编名字）================');
report('B(no skill)', run('B-without', makeHome('B', false)));
