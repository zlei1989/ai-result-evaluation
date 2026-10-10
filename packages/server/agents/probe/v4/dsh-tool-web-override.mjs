/**
 * dsh 顶层 id-targeted 覆盖是**合并**还是**整份替换**？
 *
 * 为什么必须机械核对（原话）：「若是整份替换，`{ search: false }` 会把 `dsh-base` 的
 * `{ fetch: true, searchTimeoutMs: 60000 }` 一并抹掉（连带改掉 `web_fetch` 的行为）。
 * ⇒ 实现时必须 `dsh --profile sdk --dump-config` 机械核对，不要靠推断。」
 *
 * 判据（同一份二进制、只切一个 patch）：
 *   · 若 `fetch` 仍为 true 且 `searchTimeoutMs` 仍在 ⇒ **合并**（浅合并/深合并都算合并）；
 *   · 若 `config` 只剩 `{ search: false }` ⇒ **整份替换**，实现时必须把另两格一起写出。
 *
 * 用法：node probe/v4/dsh-tool-web-override.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, resolveDshBin, writeDump } from './lib/env.mjs';

const dshBin = resolveDshBin();
const home = mkdtempSync(join(tmpdir(), 'aieval-v4-toolweb-'));

/** 只覆盖 tool-web 的 search：若语义是"整份替换"，fetch/searchTimeoutMs 会被抹掉。 */
const patchPath = join(home, 'tool-web.patch.yml');
writeFileSync(patchPath, ['- id: tool-web', '  config:', '    search: false', ''].join('\n'), { encoding: 'utf8', mode: 0o600 });

/**
 * **修法**：既然语义是整份替换，就必须把 `dsh-base` 原本那两格一起写出。
 * 本档用来证明"写全了就不会静默改动 web_fetch 的行为"。
 */
const fixedPath = join(home, 'tool-web-fixed.patch.yml');
writeFileSync(fixedPath, [
  '- id: tool-web',
  '  config:',
  '    search: false',
  '    fetch: true',
  '    searchTimeoutMs: 60000',
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600 });

/** 跑一次 dsh 并回原文；非零退出不抛——退出码本身就是结论。 */
function runDsh(args) {
  try {
    const stdout = execFileSync(process.execPath, [dshBin, ...args], {
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DSH_HOME: home },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: typeof error?.status === 'number' ? error.status : null,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    };
  }
}

/**
 * 从 dump-config 文本里把 `tool-web` 那一段抠出来。
 * 不假设输出是 JSON（也可能是 YAML 风格），故按**行窗口**取：命中行前后各 12 行。
 */
function regions(text, needle, before = 6, after = 14) {
  const lines = text.split('\n');
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(needle)) {
      hits.push({
        line: index + 1,
        text: lines.slice(Math.max(0, index - before), index + after).join('\n'),
      });
    }
  }
  return hits;
}

const baseline = runDsh(['--profile', 'sdk', '--dump-config']);
const patched = runDsh(['--profile', 'sdk', '--patch', patchPath, '--dump-config']);
const fixed = runDsh(['--profile', 'sdk', '--patch', fixedPath, '--dump-config']);

const baselineRegions = regions(baseline.stdout, 'tool-web');
const patchedRegions = regions(patched.stdout, 'tool-web');
const fixedRegions = regions(fixed.stdout, 'tool-web');

/** 在一个 region 文本里判三个键的存在与取值。 */
function probeKeys(regionText) {
  return {
    hasFetchKey: /fetch\s*:\s*(true|false)/.test(regionText),
    fetchValue: /fetch\s*:\s*(true|false)/.exec(regionText)?.[1] ?? null,
    hasSearchKey: /search\s*:\s*(true|false)/.test(regionText),
    searchValue: /search\s*:\s*(true|false)/.exec(regionText)?.[1] ?? null,
    hasSearchTimeout: /searchTimeoutMs\s*:\s*\d+/.test(regionText),
    searchTimeoutValue: /searchTimeoutMs\s*:\s*(\d+)/.exec(regionText)?.[1] ?? null,
  };
}

const report = {
  at: new Date().toISOString(),
  dshBin,
  patch: ['- id: tool-web', '  config:', '    search: false'],
  baseline: { code: baseline.code, regionCount: baselineRegions.length, regions: baselineRegions, keys: baselineRegions.map((one) => probeKeys(one.text)) },
  patched: { code: patched.code, regionCount: patchedRegions.length, regions: patchedRegions, keys: patchedRegions.map((one) => probeKeys(one.text)) },
  fixed: { code: fixed.code, regionCount: fixedRegions.length, regions: fixedRegions, keys: fixedRegions.map((one) => probeKeys(one.text)) },
  fixedPatch: ['- id: tool-web', '  config:', '    search: false', '    fetch: true', '    searchTimeoutMs: 60000'],
  stderrTail: { baseline: baseline.stderr.slice(-600), patched: patched.stderr.slice(-600), fixed: fixed.stderr.slice(-600) },
};

note('baseline exit', baseline.code, 'tool-web 命中', baselineRegions.length, JSON.stringify(report.baseline.keys));
note('patched  exit', patched.code, 'tool-web 命中', patchedRegions.length, JSON.stringify(report.patched.keys));

// ── 判据（不靠肉眼看 count）──
const patchedKeys = report.patched.keys[0] ?? {};
const baselineKeys = report.baseline.keys[0] ?? {};
let verdict;
if (patchedRegions.length === 0) verdict = '无法判定：patch 后 dump 里找不到 tool-web（可能该 profile 没装这个插件）';
else if (patchedKeys.fetchValue === 'false' || patchedKeys.hasFetchKey === false || patchedKeys.hasSearchTimeout === false) {
  verdict = '整份替换（REPLACE）：fetch / searchTimeoutMs 被抹掉 ⇒ 实现时必须把 fetch: true 与 searchTimeoutMs 一起写出';
} else verdict = '合并（MERGE）：search 被改成 false，fetch 与 searchTimeoutMs 原样保留 ⇒ 实现时可以只写 search';

note('基线 keys：', JSON.stringify(baselineKeys));
note('覆盖 keys：', JSON.stringify(patchedKeys));
note('修法 keys（三格全写）：', JSON.stringify(report.fixed.keys[0] ?? {}));
note('判定：', verdict);

const fixedKeys = report.fixed.keys[0] ?? {};
report.fixedVerdict = (fixedKeys.searchValue === 'false' && fixedKeys.fetchValue === 'true' && fixedKeys.searchTimeoutValue === '60000')
  ? '✅ 修法成立：search=false 且 fetch=true、searchTimeoutMs=60000 三格都留在合成树里'
  : '❌ 修法不成立：写全三格后合成树里仍缺格——见 fixed.keys';
note('修法判定：', report.fixedVerdict);

report.verdict = verdict;
const file = writeDump('v4/dsh-tool-web-override', report);
note('落盘：', file);

rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
