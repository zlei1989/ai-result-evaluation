// @vitest-environment node
/**
 * 守卫：产品代码里不再出现 antd 的 `Form` 家族。
 *
 * 为什么这条要靠静态扫描：四个真表单迁到 `Field` + react-hook-form 之后，**行为测试全部照常绿**的
 * 回归形态只有一种——有人顺手又写回一个 `Form.Item`（它自带 label 排版与字段注入，写起来更省事），
 * 于是同一张表单里两套状态并存：`Form.Item` 里的字段不在 RHF 的 store 里，提交时静默丢值，
 * 而界面上一切正常。这类缺陷没有运行时症状，只能钉源码形态。
 *
 * 判据分两半，缺一不可：
 *   ① 四个真表单文件里**一个 antd 表单 API 都不许有**（`Form.Item` / `Form.useForm` /
 *      `Form.useWatch` / `Form.List` / `FormInstance` / `<Form>`）；
 *   ② 它们必须**确实**用上了新基座（`useForm(` / `<Field` / `zodResolver`）——
 *      只做 ① 的话，把整个文件删掉也能通过。
 *
 * 扫描范围是产品源码（`packages/client/ui/src` 与 `apps/web-next/app`、`apps/web-next/src`）：
 * 测试文件不在射程（它们可以引用历史形态做对照）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 本守卫认的「antd 表单家族」：命中任何一个都算又把旧基座带回来了 */
const FORBIDDEN = [
  { name: 'Form.Item', pattern: /\bForm\.Item\b/ },
  { name: 'Form.List', pattern: /\bForm\.List\b/ },
  { name: 'Form.useForm', pattern: /\bForm\.useForm\b/ },
  { name: 'Form.useWatch', pattern: /\bForm\.useWatch\b/ },
  { name: 'Form.useFormInstance', pattern: /\bForm\.useFormInstance\b/ },
  { name: 'FormInstance', pattern: /\bFormInstance\b/ },
  { name: 'FormListFieldData', pattern: /\bFormListFieldData\b/ },
  { name: '<Form>', pattern: /<Form\b/ },
] as const;

/** 四个真表单：迁移完成后它们必须落在 `Field` + RHF + zod resolver 上 */
const MIGRATED = [
  'composite/case-form-panel.tsx',
  'composite/run-create-panel.tsx',
  'composite/provider-form-modal.tsx',
  'composite/mcp-server-form-modal.tsx',
] as const;

const UI_SRC = join(import.meta.dirname, '..');
const APP_ROOT = join(import.meta.dirname, '../../../../../apps/web-next');

/** 递归收集源码文件（跳过测试文件与生成物） */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry)) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('产品代码里的 antd Form 家族', () => {
  it('四个真表单不再出现任何 antd 表单 API', () => {
    for (const relative of MIGRATED) {
      const source = readFileSync(join(UI_SRC, relative), 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        expect(source, `${relative} 里又出现了 ${name}`).not.toMatch(pattern);
      }
    }
  });

  it('UI 包与 web-next 的产品源码里都没有 antd 表单 API', () => {
    for (const file of [...sourceFiles(UI_SRC), ...sourceFiles(APP_ROOT)]) {
      const source = readFileSync(file, 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        expect(source, `${file} 里又出现了 ${name}`).not.toMatch(pattern);
      }
    }
  });

  it('四个真表单确实用上了新基座（不是把文件掏空）', () => {
    for (const relative of MIGRATED) {
      const source = readFileSync(join(UI_SRC, relative), 'utf8');
      expect(source, `${relative} 没有 useForm`).toMatch(/\buseForm[<(]/);
      expect(source, `${relative} 没有 zodResolver`).toMatch(/zodResolver\(/);
      expect(source, `${relative} 没有 Field 一族`).toMatch(/<Field\b/);
    }
  });
});
