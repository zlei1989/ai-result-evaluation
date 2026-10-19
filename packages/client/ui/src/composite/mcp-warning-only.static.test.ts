// @vitest-environment node
/**
 * 守卫：MCP 服务器名的两条检查**只警告、不拦保存**。
 *
 * 这条语义在 RHF / zod 里没有对位（resolver 一旦不通过就不调 `handleSubmit`），所以它是自建的：
 * 两条检查住在 `mcpNameWarnings` 里、渲染成 `FieldWarning`，**永不进 `formState.errors`**。
 * 三种回归形态都只有静态判据抓得住（行为测试里「仍然能保存」那半会红，但红了以后最自然的修法
 * 是把警告删掉，于是「一个信号都不给」又静默地成立）：
 *   ① 有人「顺手」把字符集 / 撞名检查搬进 zod resolver —— 想覆盖已有名字的用户会存不下去；
 *   ② 有人把警告写进 `setError('name')` —— 同样拦住提交；
 *   ③ 有人把警告渲染点删了 —— 用户填错时一个信号都没有。
 *
 * 因此判据是两半：schema 里**没有**这两条检查（且没有 `warningOnly` 这种死代码），
 * 并且弹窗里**有**两个独立的警告渲染点。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = import.meta.dirname;
const schemaSource = readFileSync(join(HERE, 'mcp-server-form-schema.ts'), 'utf8');
const modalSource = readFileSync(join(HERE, 'mcp-server-form-modal.tsx'), 'utf8');

/**
 * 截出 `mcpServerFormSchema` 的函数体（到下一个 `export` 为止）。
 * 必须截出来而不是扫整份文件：`MCP_NAME_PATTERN` 在 `mcpNameWarnings` 里是**正当**的，
 * 整份扫描会把正确实现判红，那样的守卫只能被删掉。
 */
function schemaFunctionBody(): string {
  const start = schemaSource.indexOf('export function mcpServerFormSchema');
  expect(start, '找不到 mcpServerFormSchema').toBeGreaterThanOrEqual(0);
  const rest = schemaSource.slice(start);
  const nextExport = rest.indexOf('\nexport ');
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

describe('MCP 名字的两条警告（只提示、不拦保存）', () => {
  it('resolver 里没有字符集检查（真源在契约，界面不装第二个裁判）', () => {
    expect(schemaFunctionBody()).not.toMatch(/MCP_NAME_PATTERN/);
  });

  it('resolver 里没有撞名检查（覆盖已有名字是合法操作）', () => {
    expect(schemaFunctionBody()).not.toMatch(/\bin servers\b/);
    expect(schemaFunctionBody()).not.toMatch(/servers\./);
  });

  it('两条警告各有独立的渲染点（不是 FieldError、不是 Alert）', () => {
    expect(modalSource, '字符集警告没有渲染点').toMatch(
      /<FieldWarning[^>]*data-testid="mcp-name-charset-warning"/,
    );
    expect(modalSource, '撞名警告没有渲染点').toMatch(
      /<FieldWarning[^>]*data-testid="mcp-name-duplicate-warning"/,
    );
  });

  it('警告不进 formState.errors（进去就会被拦住提交）', () => {
    // 名字那一格只允许是 required 那条 schema 规则报错；手写 setError('name') 等于把警告变成阻塞
    expect(modalSource).not.toMatch(/setError\(\s*['"`]name['"`]/);
    expect(schemaFunctionBody()).not.toMatch(/warningOnly/);
  });
});
