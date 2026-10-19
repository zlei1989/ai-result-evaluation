#!/usr/bin/env node
/**
 * 重新生成 vendored 原语的哈希清单。
 *
 * 只允许在**确实重新 vendor**（`pnpm dlx shadcn@<版本> add <条目>` 之后、或上游改版）时跑；
 * 平时手改 `components/ui/**` 不跑它——那份清单存在的意义就是让「手改」变成一条红用例
 * （`src/components/vendored-manifest.test.ts`），而不是一次没人看见的静默漂移。
 *
 * 用法：node scripts/vendored-manifest.mjs
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const uiDir = join(repoRoot, 'packages/client/ui/src/components/ui');
const manifestPath = join(repoRoot, 'packages/client/ui/src/components/vendored-manifest.json');

/** 只登记 registry 落盘的组件（测试文件与说明文件不算原语） */
const files = readdirSync(uiDir)
  .filter((name) => name.endsWith('.tsx'))
  .filter((name) => !name.includes('.test.'))
  .sort();

/** @type {Record<string, string>} */
const manifest = {};
for (const name of files) {
  manifest[name] = createHash('sha256').update(readFileSync(join(uiDir, name))).digest('hex');
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`已写入 ${relative(repoRoot, manifestPath)}：${files.length} 件`);
