// @vitest-environment node
/**
 * 候选域术语守卫：这一族概念**只叫「候选 / Candidate」**，不再用 Row / 本行。
 *
 * 为什么值得一条守卫：旧名会从三个方向漏回来——照抄旧注释、复制旧测试夹具、
 * 以及「先写 Row 再批量替换」时漏掉的边角。类型名漏一处只影响可读性，
 * 持久化字段或 URL 段漏一处则会让新旧两套名字同时存在于同一条链路上。
 *
 * 词表只收**旧概念名**，不收 `rows`：磁盘布局与旧 `run.json` 的兼容读取里
 * 仍要写出旧字面量（`rows/`、`rows:`），那是数据，不是术语。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SELF = relative(ROOT, join(import.meta.dirname, 'candidate-vocabulary.test.ts')).replaceAll('\\', '/');

/** 旧概念名：类型 / 字段 / 通道 / 中文术语 */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; hint: string }> = [
  { pattern: /\bEvalRow\b/, hint: 'EvalRow → EvalCandidate' },
  { pattern: /\bRowRecord\b/, hint: 'RowRecord → CandidateRecord' },
  { pattern: /\bRowDiff\b/, hint: 'RowDiff* → CandidateDiff*' },
  { pattern: /\bRowMcp\b/, hint: 'RowMcp* → CandidateMcp*' },
  { pattern: /\bRowSkill\b/, hint: 'RowSkill* → CandidateSkill*' },
  { pattern: /\bROW_STATUS\b/, hint: 'ROW_STATUS* → CANDIDATE_STATUS*' },
  { pattern: /\browId\b/, hint: 'rowId → candidateId' },
  { pattern: /\browChannel\b/, hint: 'rowChannel → candidateChannel' },
  { pattern: /候选行/, hint: '候选行 → 候选' },
];

/** 递归收集要扫的源码与知识文章（构建产物与依赖不算） */
function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path, out);
    else if (/\.(ts|tsx|md)$/.test(entry.name)) out.push(path);
  }
}

describe('候选域术语：旧名不在源码与知识库里复活', () => {
  it('产品代码、测试与知识文章里没有 EvalRow / rowId / 候选行 这类旧名', () => {
    const files: string[] = [];
    collect(join(ROOT, 'packages'), files);
    collect(join(ROOT, 'apps'), files);
    collect(join(ROOT, 'docs'), files);

    const violations: string[] = [];
    for (const file of files) {
      const path = relative(ROOT, file).replaceAll('\\', '/');
      if (path === SELF) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const { pattern, hint } of FORBIDDEN) {
          if (pattern.test(line)) violations.push(`${path}:${index + 1} ${hint}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
