/**
 * 机制验证（v3，**不花模型调用**）：`--patch` overlay 到底生不生效。
 *
 * 验两件事，都是适配器 D3/D3b 的前提：
 *   ① `- id: llm-pi-ai` 的 id 定向覆盖是否真的把路由装进合成树（判据：合成树里出现我们的路由键）；
 *   ② `- insert:` 是否能**从 overlay**（而不是 profile patch 文件）把 `ask_user_question` 挂上
 *      （判据：`tool-ask-user` 的出现次数从 0 变 2——与那次 `--dump-config` 观测同口径）。
 *
 * 为什么先跑它：花 0 次模型调用就能证伪「overlay 写错了」，把失败面从
 * 「跑一次 DSH 要几分钟」缩到「一条 CLI 命令」。命令用真实的 dsh 二进制
 * （`@deepseek-ai/dsh@0.2.0-rc.2` 的 `lib/bin.js`），与 SDK spawn 的是同一份。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_MODEL, note, writeDump } from './lib/gateway.mjs';
import { buildOverlay } from './lib/overlay.mjs';

/**
 * 解析真实 dsh 二进制。
 * 为什么要绕 `dsh-sdk-client`：`@deepseek-ai/dsh` **不是**本包的依赖（是 sdk-client 的依赖），
 * pnpm 的隔离布局下 `require.resolve('@deepseek-ai/dsh/package.json')` 会 MODULE_NOT_FOUND。
 * sdk-client 与 dsh 在 `.pnpm` 里是**同一个 node_modules 下的兄弟目录**，所以从前者推后者。
 * 这与 SDK 自己 spawn 的是同一份产物（`lib/bin.js`，见其 package.json 的 `bin.dsh`）。
 */
function resolveDshBin() {
  const require = createRequire(import.meta.url);
  const sdkPkg = require.resolve('@deepseek-ai/dsh-sdk-client/package.json');
  const bin = join(dirname(sdkPkg), '..', 'dsh', 'lib', 'bin.js');
  if (!existsSync(bin)) throw new Error(`推不出 dsh 二进制（找过 ${bin}）`);
  return bin;
}

const home = mkdtempSync(join(tmpdir(), 'aieval-v3-dump-'));
const overlayPath = join(home, 'aieval-route.patch.yml');
const overlay = buildOverlay({
  protocolType: 'anthropic',
  baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
  model: DEEPSEEK_MODEL,
  contextWindow: 131_072,
  maxTokens: 8_192,
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
});
writeFileSync(overlayPath, overlay, { encoding: 'utf8', mode: 0o600 });
note('overlay 落点：', overlayPath);

const dshBin = resolveDshBin();
note('dsh 二进制：', dshBin);

/** 跑一次 dsh 并回原文；非零退出不抛——退出码本身就是结论。 */
function runDsh(args, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [dshBin, ...args], {
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DSH_HOME: home, ...extraEnv },
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

const countOf = (text, needle) => text.split(needle).length - 1;

const withOverlay = runDsh(['--profile', 'sdk', '--patch', overlayPath, '--dump-config']);
const withoutOverlay = runDsh(['--profile', 'sdk', '--dump-config']);

const report = {
  at: new Date().toISOString(),
  home,
  overlayPath,
  overlay,
  dshBin,
  withOverlay: {
    code: withOverlay.code,
    length: withOverlay.stdout.length,
    routeKeyHits: countOf(withOverlay.stdout, 'aieval-route'),
    apiHits: countOf(withOverlay.stdout, 'anthropic-messages'),
    toolAskUserHits: countOf(withOverlay.stdout, 'tool-ask-user'),
    warnings: withOverlay.stdout.split('\n').filter((line) => /warn|ignored|skipped|failed/i.test(line)).slice(0, 20),
  },
  withoutOverlay: {
    code: withoutOverlay.code,
    routeKeyHits: countOf(withoutOverlay.stdout, 'aieval-route'),
    toolAskUserHits: countOf(withoutOverlay.stdout, 'tool-ask-user'),
  },
};

writeFileSync(join(home, 'with-overlay.dump.txt'), withOverlay.stdout, 'utf8');
writeFileSync(join(home, 'without-overlay.dump.txt'), withoutOverlay.stdout, 'utf8');

note('有 overlay：', JSON.stringify(report.withOverlay));
note('无 overlay：', JSON.stringify(report.withoutOverlay));
const file = writeDump('v3/overlay-dump', report);
note('落盘：', file);

// 判据断言（机制不成立就当场红，不要靠肉眼看 count）
const ok = withOverlay.code === 0
  && report.withOverlay.routeKeyHits > 0
  && report.withOverlay.apiHits > 0
  && report.withOverlay.toolAskUserHits > report.withoutOverlay.toolAskUserHits;
note(ok ? '✅ 机制成立：路由进了合成树、insert 生效' : '❌ 机制不成立——见上面的计数');
process.exitCode = ok ? 0 : 1;

// 临时 home 里的 dump 已另存到 probe/dumps，这里清掉
rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
