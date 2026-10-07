/**
 * 读 vitest 的 JSON 报告，打印：总用例数、失败文件与其失败原因、最慢的 N 个文件。
 * 用法： node scripts/vitest-report-summary.mjs <report.json> [slowCount]
 */
import { readFileSync } from 'node:fs';

const [file, slowCountRaw] = process.argv.slice(2);
if (!file) {
  console.error('用法：node scripts/vitest-report-summary.mjs <report.json> [slowCount]');
  process.exit(2);
}
const slowCount = Number(slowCountRaw ?? 15);
const report = JSON.parse(readFileSync(file, 'utf8'));

const files = report.testResults ?? [];
const rows = files.map((result) => {
  const assertions = result.assertionResults ?? [];
  const failed = assertions.filter((a) => a.status === 'failed');
  return {
    name: result.name.replace(/\\/g, '/').replace(/^.*ai-result-evaluation\//, ''),
    durationMs: (result.endTime ?? 0) - (result.startTime ?? 0),
    total: assertions.length,
    failed: failed.length,
    messages: failed.map((a) => `${a.fullName} :: ${(a.failureMessages ?? []).join(' ').split('\n')[0]}`),
  };
});

const total = rows.reduce((sum, row) => sum + row.total, 0);
const failedTotal = rows.reduce((sum, row) => sum + row.failed, 0);
console.log(`files=${rows.length} tests=${total} failedTests=${failedTotal}`);

const failedFiles = rows.filter((row) => row.failed > 0);
if (failedFiles.length > 0) {
  console.log('\n--- 失败文件 ---');
  for (const row of failedFiles) {
    console.log(`${row.name}  (${row.failed}/${row.total})`);
    for (const message of row.messages) console.log(`    ${message.slice(0, 160)}`);
  }
}

console.log(`\n--- 最慢 ${slowCount} 个文件（按文件墙钟，受并发影响）---`);
for (const row of [...rows].sort((a, b) => b.durationMs - a.durationMs).slice(0, slowCount)) {
  console.log(`${(row.durationMs / 1000).toFixed(1).padStart(8)}s  ${row.total.toString().padStart(4)} tests  ${row.name}`);
}
