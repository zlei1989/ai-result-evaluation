/**
 * 把 eslint 报出的「未使用的 import」摘掉（只动 `import`，不动 `export ... from`）。
 * 配合 `scripts/split-test-file.mjs` 用：拆分后 harness 里会留下一批「只被再导出、自己不用」的名字。
 * 用法： node scripts/strip-unused-imports.mjs <file...>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = process.argv.slice(2);
if (FILES.length === 0) {
  console.error('用法： node scripts/strip-unused-imports.mjs <file...>');
  process.exit(2);
}

let out = '';
try {
  out = execFileSync('pnpm', ['eslint', ...FILES], { encoding: 'utf8', shell: true });
} catch (error) {
  out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}

const unused = new Map();
let current = null;
for (const raw of out.split(/\r?\n/)) {
  const line = raw.trim();
  if (/^[A-Z]:\\.*\.tsx?$/.test(line)) { current = line.replace(/\\/g, '/'); continue; }
  const hit = /error\s+'([^']+)' is defined but never used/.exec(line);
  if (hit && current) {
    if (!unused.has(current)) unused.set(current, new Set());
    unused.get(current).add(hit[1]);
  }
}

for (const [file, names] of unused) {
  let text = readFileSync(file, 'utf8');
  text = text.replace(/^import(?: type)? \{([\s\S]*?)\} from '([^']+)';$/gm, (whole, body, spec) => {
    const kept = body.split(',').map((x) => x.trim()).filter((x) => x !== '').filter((x) => !names.has(x.replace(/^type\s+/, '')));
    if (kept.length === 0) return '';
    const head = whole.startsWith('import type') ? 'import type' : 'import';
    const one = `${head} { ${kept.join(', ')} } from '${spec}';`;
    return one.length <= 130 ? one : `${head} {\n  ${kept.join(',\n  ')},\n} from '${spec}';`;
  });
  writeFileSync(file, text, 'utf8');
  console.log(`${file.split('/').pop()}：摘掉 ${[...names].join(', ')}`);
}
if (unused.size === 0) console.log('lint 干净，无需摘除');
