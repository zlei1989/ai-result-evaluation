// @vitest-environment node
/**
 * 静态守卫：产品代码里**不再出现** antd 的提示通道。
 *
 * 拦两类写法：
 *   ① 静态 `message.success|error|warning|info(...)`（含从 antd 直接 import 的那个单例）；
 *   ② `App.useApp()` / `AntdApp.useApp()` 解构出来的 `message`——它是同一个通道的上下文版本。
 *
 * 为什么必须静态扫：antd 的 `message` 在 jsdom 里**照样弹得出来**（全局的树外渲染器已注册），
 * 于是「有人又加回一句」不会被任何渲染用例发现；而它绕过了 toast 的 viewport、主题变量与
 * `actionProps`，症状只是「这条提示长得跟别处不一样」。本文件是这条边界唯一的回归防线。
 *
 * 扫描面自我定义（`app/` 与 ui 包 `src/` 下全部 `.ts/.tsx`，排除用例），新增页面不必回来登记。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = join(import.meta.dirname, '..');
const UI_SRC = join(APP_ROOT, '../../packages/client/ui/src');

/** 产品代码根：`apps/web-next/app/**` 与 `packages/client/ui/src/**` */
const SOURCE_ROOTS = [join(APP_ROOT, 'app'), UI_SRC];

/** antd 提示通道的调用形态；单双引号与换行都不影响 */
const ANTD_MESSAGE_CALL = /\bmessage\s*\.\s*(success|error|warning|info)\s*\(/;
const USE_APP = /\b(?:AntdApp|App)\s*\.\s*useApp\s*\(\s*\)/;
/** 第二主题真源：toast 的明暗必须跟随 `html[data-theme]`，不能再引一套主题库 */
const NEXT_THEMES = /\bfrom\s+['"]next-themes['"]/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

const FILES = SOURCE_ROOTS.flatMap(walk);

/** 逐行找命中，失败信息带「文件:行号 + 原文」，修起来不用再搜一遍 */
function hits(pattern: RegExp): string[] {
  return FILES.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => pattern.test(text))
      .map(({ line, text }) => `${relative(APP_ROOT, file)}:${line}: ${text.trim()}`),
  );
}

describe('提示通道只剩 toast', () => {
  it('产品代码里不再有 antd message 的调用与 App.useApp()', () => {
    expect(
      hits(ANTD_MESSAGE_CALL),
      '静态 message 已迁到 @aieval/ui 的 toast；新提示请用 toast.success / toast.error / toast.promise',
    ).toEqual([]);
    expect(
      hits(USE_APP),
      'App.useApp() 的 message 是同一个 antd 提示通道；改用包根转出的 toast',
    ).toEqual([]);
  });

  it('没有引入 next-themes（主题真源只有 html[data-theme] 一处）', () => {
    expect(hits(NEXT_THEMES), 'toast 的明暗跟随 html[data-theme]，不要引第二套主题库').toEqual([]);
  });
});
