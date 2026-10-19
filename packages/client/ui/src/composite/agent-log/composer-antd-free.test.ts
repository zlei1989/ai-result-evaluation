// @vitest-environment node
/**
 * 输入区那一批的**换栈纪律**（静态扫描，读本目录的源文件）。
 *
 * 两条靶子：
 *  (1) **这四个文件不再 import antd / `@ant-design/*`**。它们已经换成 vendored 的
 *      `InputGroup` / `Textarea` / `Attachment` / `Collapsible`，而「顺手再加一个 antd 组件」
 *      不会有任何运行时症状——页面上只是多一套字号与间距；
 *  (2) **不许退回 X 的 `Sender` / `Attachments`**：那两个件本身就是 antd 的皮，
 *      留着它们等于只换了一半（形态还是 X 的，换栈判据却绿了）。
 *
 * 扫描面是**点名清单**而不是整个目录：本目录里还有问答卡片等未换的件，整目录扫描会把
 * 「别处还没换」误报成「这处换错了」。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;

/** 本批换栈的四个文件：共用件 + 两个入口 + 排队区 */
const MIGRATED_FILES = [
  'composer-input.tsx',
  'follow-up-composer.tsx',
  'inject-composer.tsx',
  'inject-queue-panel.tsx',
] as const;

/** 去掉注释之后再判：注释里解释「为什么不用 antd」是说明文字，不是依赖 */
function codeOf(file: string): string {
  return readFileSync(join(dir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('输入区那一批的换栈纪律', () => {
  it('四个文件都不 import antd / @ant-design', () => {
    const hits: string[] = [];
    for (const file of MIGRATED_FILES) {
      for (const [index, line] of codeOf(file).split('\n').entries()) {
        if (/from\s+['"](?:antd|@ant-design\/[^'"]+)['"]/.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(hits, '这一批又引回了 antd；它们已经换成 vendored 的 InputGroup / Attachment / Collapsible').toEqual([]);
  });

  it('不许退回 X 的 Sender / Attachments（那两个件就是 antd 的皮）', () => {
    const hits: string[] = [];
    for (const file of MIGRATED_FILES) {
      for (const [index, line] of codeOf(file).split('\n').entries()) {
        if (/XSender|XAttachments|@ant-design\/x/.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(hits, '输入区又接回了 X 的 Sender / Attachments').toEqual([]);
  });

  it('共用件的形态钉在 Prompt Input 上：InputGroup + Textarea + Attachment', () => {
    const source = codeOf('composer-input.tsx');
    for (const symbol of ['InputGroup', 'InputGroupTextarea', 'InputGroupAddon', 'Attachment']) {
      expect(source, `共用件里没有 ${symbol}（Prompt Input 的骨架被换掉了）`).toContain(symbol);
    }
    // 附件清单必须能移除：每一份都有移除按钮（无按钮的清单只能靠重选整批，等于不能删）
    expect(source).toMatch(/aria-label=\{`移除 /);
  });
});
