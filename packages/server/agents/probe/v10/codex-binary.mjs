#!/usr/bin/env node
/**
 * 解析 `codex app-server` 的可执行文件（探针用）。
 *
 * 为什么不复用产品侧的 `appserver/binary.ts`：探针是纯 `.mjs`，不经过打包器，
 * 也不该为一次探测去起 TypeScript 加载链。这里的口径只有一条：**向上找到 `node_modules/.pnpm`，
 * 在里面找 `@openai+codex@*` 的平台包**，取它 `vendor/<triple>/bin/codex(.exe)`。
 *
 * 环境变量 `AIEVAL_CODEX_BINARY` 优先（换版本 / 换机器时不必改脚本）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 只认这几个已知的平台三元组；`vendor/*` 里出现别的目录（文档、调试件）不误判 */
export function resolveCodexBinary() {
  const fromEnv = process.env.AIEVAL_CODEX_BINARY;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  let dir = HERE;
  for (;;) {
    const pnpm = join(dir, 'node_modules', '.pnpm');
    if (existsSync(pnpm)) {
      for (const entry of readdirSync(pnpm)) {
        if (!entry.startsWith('@openai+codex@')) continue;
        const vendor = join(pnpm, entry, 'node_modules', '@openai', 'codex', 'vendor');
        if (!existsSync(vendor)) continue;
        for (const triple of readdirSync(vendor)) {
          for (const name of ['codex', 'codex.exe']) {
            const candidate = join(vendor, triple, 'bin', name);
            if (existsSync(candidate)) return candidate;
          }
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到 @openai/codex 的平台包（用 AIEVAL_CODEX_BINARY 指定可执行文件）');
}
