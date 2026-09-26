/**
 * D9 的**库级微基准**：pi-ai 0.85.1 的「流式工具参数」解析到底有多贵？
 *
 * 为什么需要这一步：计划 D9 登记的事实是「SDK spawn 的那份 dsh 实跑 `@earendil-works/pi-ai@0.85.1`，
 * 而修 O(n²) 的 `patches/@earendil-works__pi-ai@0.87.1.patch` 打不到它」——
 * 0.85.1 的 `dist/api/anthropic-messages.js:503` **每个 `input_json_delta` 都把已累积的 JSON
 * 重解析一遍**（`block.arguments = parseStreamingJson(block.partialJson)`）。
 * 报告 §7 当时只给了量级估算（「几十 KB 在毫秒量级、MB 级才有可感停顿」）并登记为**未实测**。
 *
 * 本脚本把那句估算变成数字：直接调用**安装态那一份** `parseStreamingJson`，按真实的累积—重解析
 * 循环跑一遍，并与「只在最后解析一次」（= 0.87.1 的补丁行为）对照。
 *
 * ⚠️ **证据等级要如实标注**：这是**库级微基准**，不是「一次真机大参数工具调用」。
 * 它证明的是代价函数与量级（够不够支撑「可接受 / 需要打补丁」这个裁决），
 * 不覆盖网关的分片粒度、dsh 的调度开销与真实模型生成大参数时的重叠行为。
 *
 * 定位安装态的 pi-ai：它是 SDK 的**传递依赖**（`dsh → dsh-llm-pi-ai → pi-ai ^0.85.1`），
 * 既不在本包的 `node_modules` 里，也不在 `exports` 里暴露 `utils/json-parse.js`
 * （实测 `import.meta.resolve('@earendil-works/pi-ai')` 报 `ERR_MODULE_NOT_FOUND`）
 * ⇒ 走 pnpm 虚拟存储（`node_modules/.pnpm/@earendil-works+pi-ai@<版本>/node_modules/…`）并**按文件哈希去重**：
 * 本机有两个同版本实例（不同 peer 解析），哈希相同则选哪个都不影响结论，不同就如实报出来。
 *
 * 用法：`node probe/v3/pi-ai-tool-arg-scaling.mjs`
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { note, writeDump } from './lib/gateway.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：probe/v3 → probe → agents → server → packages → <repo> */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');

/** 本基准真正要量的两个文件（一个是解析器本体，一个是消费它的 anthropic wire 适配器）。 */
const TARGET_FILES = ['dist/utils/json-parse.js', 'dist/api/anthropic-messages.js'];
const RELATIVE_ENTRY = 'dist/utils/json-parse.js';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 定位安装态的 pi-ai 实例（可能不止一个）。 */
function locatePiAi() {
  const store = join(REPO_ROOT, 'node_modules', '.pnpm');
  const names = readdirSync(store).filter((name) => name.startsWith('@earendil-works+pi-ai@'));
  if (names.length === 0) throw new Error(`在 ${store} 里找不到 @earendil-works/pi-ai（pnpm 尚未安装？）`);
  return names.map((name) => {
    const dir = join(store, name, 'node_modules', '@earendil-works', 'pi-ai');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const hashes = Object.fromEntries(TARGET_FILES.map((file) => [file, sha256(join(dir, file))]));
    return { storeName: name, dir, version: pkg.version, hashes };
  });
}

const instances = locatePiAi();
for (const one of instances) {
  note(`pi-ai ${one.version} @ ${one.storeName}`);
  for (const [file, hash] of Object.entries(one.hashes)) note(`  ${file} sha256=${hash.slice(0, 16)}…`);
}
const distinctHashSets = new Set(instances.map((one) => JSON.stringify(one.hashes)));
if (instances.length > 1 && distinctHashSets.size > 1) {
  note('⚠️ 多个实例的字节**不一致**：下面的数字只代表被选中的那一个');
}
const chosen = instances[0];
const { parseStreamingJson } = await import(pathToFileURL(join(chosen.dir, RELATIVE_ENTRY)).href);
if (typeof parseStreamingJson !== 'function') {
  throw new Error(`${join(chosen.dir, RELATIVE_ENTRY)} 没有导出 parseStreamingJson（版本形状变了？）`);
}
note('已加载', join(chosen.dir, RELATIVE_ENTRY));

/**
 * 造一个 `write` 风格的工具参数，切成 `chunkChars` 一段，按 0.85.1 的循环**逐段累积并重解析**。
 * `once` 是对照组：同一份 payload 只解析一次（= 0.87.1 打了补丁之后的行为）。
 */
function bench(totalChars, chunkChars) {
  const head = '{"file_path":"big.txt","content":"';
  const tail = '"}';
  const body = 'A'.repeat(Math.max(0, totalChars - head.length - tail.length));
  const payload = `${head}${body}${tail}`;
  const chunks = [];
  for (let at = 0; at < payload.length; at += chunkChars) chunks.push(payload.slice(at, at + chunkChars));

  let accumulated = '';
  const startedPerDelta = process.hrtime.bigint();
  for (const chunk of chunks) {
    accumulated += chunk;
    parseStreamingJson(accumulated);
  }
  const perDeltaMs = Number(process.hrtime.bigint() - startedPerDelta) / 1e6;

  const startedOnce = process.hrtime.bigint();
  const once = parseStreamingJson(payload);
  const onceMs = Number(process.hrtime.bigint() - startedOnce) / 1e6;

  return {
    totalChars: payload.length,
    chunkChars,
    deltas: chunks.length,
    perDeltaMs: Number(perDeltaMs.toFixed(2)),
    onceMs: Number(onceMs.toFixed(3)),
    overheadMs: Number((perDeltaMs - onceMs).toFixed(2)),
    // 相对同一次解析的倍数：O(n²) 的代价倍数（不是相对「只解析一次」的总时间比）
    timesOfSingleParse: Number((perDeltaMs / Math.max(onceMs, 1e-6)).toFixed(1)),
    // 解析结果必须真的可用：解析器返回空对象时上面的耗时就没有意义
    parsedContentChars: typeof once?.content === 'string' ? once.content.length : null,
  };
}

const CHUNK = 100; // ≈ SSE 里一次 input_json_delta 的常见长度
const SIZES = [8_000, 32_000, 128_000, 512_000];
const rows = SIZES.map((size) => {
  const row = bench(size, CHUNK);
  note(`size=${row.totalChars} deltas=${row.deltas} 逐段=${row.perDeltaMs}ms 单次=${row.onceMs}ms 倍数=${row.timesOfSingleParse}×`);
  return row;
});

// 二次增长判据：size 翻 4 倍时，逐段耗时应当约翻 16 倍（O(n²)）；线性的实现只翻 4 倍。
const growth = rows.slice(1).map((row, index) => {
  const prev = rows[index];
  return {
    fromChars: prev.totalChars,
    toChars: row.totalChars,
    sizeRatio: Number((row.totalChars / prev.totalChars).toFixed(2)),
    timeRatio: Number((row.perDeltaMs / Math.max(prev.perDeltaMs, 1e-6)).toFixed(2)),
  };
});
for (const one of growth) {
  note(`size ×${one.sizeRatio} ⇒ 逐段耗时 ×${one.timeRatio}（O(n²) 期望 ≈ sizeRatio²；线性期望 ≈ sizeRatio）`);
}

const file = writeDump('v3/pi-ai-tool-arg-scaling', {
  at: new Date().toISOString(),
  evidenceLevel: 'library-microbenchmark（不是真机大参数工具调用）',
  instances: instances.map((one) => ({ storeName: one.storeName, version: one.version, dir: one.dir, hashes: one.hashes })),
  chosen: chosen.dir,
  sizes: SIZES,
  chunkChars: CHUNK,
  rows,
  growth,
  // 抽样：512KB 那一档的绝对值决定了「可不可感」
  verdict512kMs: rows.at(-1)?.perDeltaMs ?? null,
});
note('落盘：', file);
if (!existsSync(file)) throw new Error('结论没有落盘');
