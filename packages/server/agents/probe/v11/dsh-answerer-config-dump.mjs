/**
 * v11 应答者探针的**离线判据**：不调模型、不花钱，只回答「这几行 profile 配置到底组装成了什么」。
 *
 * 存在的理由：真机那一批每臂都要花一次模型往返，而最常见的失败（行 id 撞了、`config` 写错一层、
 * 相对名解析到一个不存在的文件）在**组装期**就该被拦下。dsh CLI 自带 `--dump-config`
 * ——打印合成后的 profile 树并退出，不挂任何插件、不连网关。本脚本用它，并加三条断言：
 *
 *  1. 每一臂要的行都在（id 逐字）；`timed` 臂的 `config.mode`/`config.timeout` 逐字；
 *  2. 应答者那一行的 `name` 被解析成 `file:///…` **且该文件真实存在**——这是「插件会不会被加载」
 *     的唯一静态判据（相对名的解析基准由 dump 原文回答，见 REPORT 的读数）；
 *  3. 组合结果里 `dsh-base` 的 `user-questions` 服务行在场（应答者挂上去要有个服务在听）。
 *
 * 退出码：任一条断言不过就 1——它可以当门禁跑。
 *
 * 用法：`node packages/server/agents/probe/v11/dsh-answerer-config-dump.mjs`
 *      `node packages/server/agents/probe/v11/dsh-answerer-config-dump.mjs --dsh-bin=<绝对路径>`
 *      `node packages/server/agents/probe/v11/dsh-answerer-config-dump.mjs --keep`（保留临时目录）
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { note } from '../v2/lib/gateway.mjs';
import { writeProfilePatch } from '../v2/lib/dsh.mjs';
import { ANSWERER_PLUGIN_NAME, buildArms, plantPlugin } from './answerer-arms.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((one) => one.startsWith('--')).map((one) => {
    const [key, value = ''] = one.slice(2).split('=');
    return [key, value];
  }),
);

/**
 * 找 dsh CLI 的入口：与 SDK 同一条路——**经由 `@deepseek-ai/dsh-sdk-client` 解析**
 * （`@deepseek-ai/dsh` 是它的直接依赖，pnpm 只把直接依赖链到本包的 `node_modules`，
 * 从探针目录直接 `import.meta.resolve('@deepseek-ai/dsh')` 会 MODULE_NOT_FOUND）。
 */
function resolveDshBin() {
  if (args['dsh-bin'] !== undefined && args['dsh-bin'] !== '') return args['dsh-bin'];
  const require = createRequire(import.meta.url);
  const fromSdk = createRequire(require.resolve('@deepseek-ai/dsh-sdk-client/package.json'));
  const pkgFile = fromSdk.resolve('@deepseek-ai/dsh/package.json');
  return join(pkgFile, '..', 'lib', 'bin.js');
}

/** 把 `--dump-config` 里**属于本行 patch 文件**的那一段切出来（用户层永远是最后一段）。 */
function userSection(dump, patchPath) {
  const marker = `# == ${patchPath}`;
  const at = dump.indexOf(marker);
  return at === -1 ? null : dump.slice(at);
}

/**
 * 极简行解析：只认 `- id: <值>` 开头的一行与它后面同缩进的 `键: 值`。
 * 够用就好的理由——要断的是**逐字出现**，不是完整的 YAML 语义；
 * 唯一的例外是**折叠标量**：长值（本机临时目录一长就会触发）会被 dump 成
 * `name: >-` 加一行缩进内容，不拼回去就会把解析结果读成一个 `>-`。
 */
function parseRows(section) {
  const rows = new Map();
  let current = null;
  let continuation = null;
  for (const line of section.split('\n')) {
    const idMatch = /^- id: (.+)$/.exec(line);
    if (idMatch !== null) {
      current = { id: idMatch[1].trim(), fields: {}, lines: [line] };
      rows.set(current.id, current);
      continuation = null;
      continue;
    }
    if (current === null) continue;
    current.lines.push(line);
    const fieldMatch = /^( {2})([A-Za-z][\w-]*): ?(.*)$/.exec(line);
    if (fieldMatch !== null) {
      const value = fieldMatch[3].trim();
      const isBlock = value === '>-' || value === '>' || value === '|' || value === '|-';
      current.fields[fieldMatch[2]] = isBlock ? '' : value;
      continuation = isBlock ? { key: fieldMatch[2], indent: fieldMatch[1].length } : null;
      continue;
    }
    if (continuation === null) continue;
    const indent = line.length - line.trimStart().length;
    if (line.trim() === '' || indent <= continuation.indent) {
      continuation = null;
      continue;
    }
    current.fields[continuation.key] = `${current.fields[continuation.key]}${line.trim()}`;
  }
  return rows;
}

const failures = [];
const check = (label, ok, detail) => {
  note(`  ${ok ? '✅' : '❌'} ${label}${detail === undefined ? '' : ` —— ${detail}`}`);
  if (!ok) failures.push(label);
};

const dshBin = resolveDshBin();
note('dsh CLI =', dshBin);
if (!existsSync(dshBin)) {
  note('❌ 找不到 dsh CLI 入口（用 --dsh-bin=<绝对路径> 指定）');
  process.exit(1);
}

for (const [key, arm] of Object.entries(buildArms())) {
  note('');
  note(`═══ ${key} ${arm.title} ═══`);
  const configHome = mkdtempSync(join(tmpdir(), `aieval-v11-dump-${key}-`));
  const planted = plantPlugin(configHome);
  // 与真机脚本同一个写盘函数（v2 的外壳），只是 withAskUser=false + 显式给整份 rows
  writeProfilePatch(configHome, false, arm.rows);
  const patchPath = join(configHome, 'profiles', 'sdk', 'cordis.patch.yml');
  const dump = execFileSync(process.execPath, [dshBin, '--profile', 'sdk', '--dump-config'], {
    env: { ...process.env, DSH_HOME: configHome },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const section = userSection(dump, patchPath);
  if (section === null) {
    check('本行 patch 出现在合成树里', false, patchPath);
    continue;
  }
  note('本行合成结果：');
  for (const line of section.split('\n')) note('  |', line);
  const rows = parseRows(section);

  check('user-questions 服务在场（dsh-base）', dump.includes("name: '@deepseek-ai/dsh-user-questions'"));
  for (const row of arm.rows) {
    const parsed = rows.get(row.id);
    check(`行 ${row.id} 在`, parsed !== undefined);
    if (parsed === undefined) continue;
    if (row.config !== undefined) {
      for (const [field, value] of Object.entries(row.config)) {
        check(`行 ${row.id} 的 config.${field} 逐字`, parsed.lines.some((line) => line.trim() === `${field}: ${value}`));
      }
    }
  }
  const answerer = rows.get('aieval-ask-answerer');
  if (answerer !== undefined) {
    const resolved = answerer.fields.name ?? '';
    const file = resolved.startsWith('file://') ? fileURLToPath(resolved) : '';
    check('应答者行解析到真实文件', file !== '' && existsSync(file), resolved === '' ? '（解析结果为空）' : resolved);
    check('离线检查落盘的两份插件都在', planted.every((one) => existsSync(one)), planted.join(' | '));
    // 解析基准写进读数：它是「插件为什么会被/不会被加载」的唯一答案
    note(`  ℹ 相对名 ./${ANSWERER_PLUGIN_NAME} 被这一层解析为：`, resolved);
  }
}

note('');
if (failures.length === 0) {
  note('✅ 全部行形状检查通过（', Object.keys(buildArms()).length, '臂）');
} else {
  note('❌ 检查未通过：', failures.join('；'));
}
process.exit(failures.length === 0 ? 0 : 1);
