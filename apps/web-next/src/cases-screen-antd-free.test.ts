// @vitest-environment node
/**
 * 静态守卫：`/cases` 这一屏的源码里**不再出现 antd 说明符**。
 *
 * 扫描面是**这一屏自己的文件**：页面 + 用例专属的 composite（详情 / 表单 / schema / 自建表格）。
 * 页面仍会经 `@aieval/ui` 用到还没迁完的共享件（顶栏、评分标准项表、markdown 渲染），
 * 它们属于别的票，不在本守卫的面上——这也是为什么本轮先把「这一屏自己的 import」清零，
 * 而不是等全仓 antd 清零。
 *
 * 为什么只认说明符：症状是「这一屏又把 antd 的某个控件拿回来了」——组件名与 props 都合法、
 * 类型也过，唯一能红的判据就是 import 那一行。`@ant-design/*` 一并扫：图标与 markdown 渲染器
 * 都不属于这一屏的新栈。
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** 这一屏的全部源码（相对仓库根，报错信息里直接可点） */
const SCREEN_FILES = [
  'apps/web-next/app/cases/page.tsx',
  'packages/client/ui/src/composite/case-detail-panel.tsx',
  'packages/client/ui/src/composite/case-form-panel.tsx',
  'packages/client/ui/src/composite/case-form-schema.ts',
  'packages/client/ui/src/composite/cases-table.tsx',
] as const;

/**
 * antd 的说明符：静态 import / 动态 import / require 三种入口都认。
 * 只匹配**说明符本身**，注释里提到 antd 是说明文字，不是解析请求。
 */
const ANTD_SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:antd|@ant-design\/[^'"]+)['"]/;

describe('cases 屏的 antd 说明符归零', () => {
  it('页面与用例专属 composite 里没有任何 antd / @ant-design 说明符', () => {
    const hits = SCREEN_FILES.flatMap((file) => {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      return text
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => ANTD_SPECIFIER.test(line))
        .map(({ line, number }) => `${relative(REPO_ROOT, join(REPO_ROOT, file))}:${number}: ${line.trim()}`);
    });

    expect(
      hits,
      '这一屏已经换到新栈：antd / @ant-design 的控件请换成 @aieval/ui 从 components/ui 转出的原语',
    ).toEqual([]);
  });
});
