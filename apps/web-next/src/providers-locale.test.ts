// @vitest-environment node
/**
 * `apps/web-next/app/providers.tsx` 的两条根级契约（R31 与「两个汉字之间不插空格」）。
 *
 * 为什么用**源码级**守卫而不是渲染断言（与 `runtime-deps.test.ts` 同一手法）：本应用没有 jsdom
 * 环境，页面的行为面由 p6 的真机冒烟验收（`r31-locale-before/after.txt`：同一个 `/runs` 空态 SVG
 * `<title>` 从 `["No data"]` 变成 `["暂无数据"]`，且页面里显式的中文文案一字未改）。这里补的是
 * 自动化那一半：**根上那一行 prop 本身**。
 *
 * 为什么值得钉（终审 §2-M7 点名 R31「有落点但无守卫」）：`locale={zhCN}` 是「antd 内置文案默认
 * 英文」这一整类的**根因修复**——p1 时代只能给每个浮层逐个显式补中文，漏一个就漏一个英文，
 * 而删掉包根这一行**不会有任何测试变红**（实测：终审在没有任何测试的情况下把它判成无守卫的落点）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 用文件自身位置推导，不依赖 `process.cwd()`（与 runtime-deps.test.ts 同一口径） */
const providersSource = readFileSync(join(import.meta.dirname, '..', 'app', 'providers.tsx'), 'utf8');

describe('app/providers.tsx 的根级配置（契约 R31）', () => {
  it('导入 antd 的简体中文 locale（zh_CN，不是 zh_TW / en_US）', () => {
    expect(providersSource).toMatch(/import\s+zhCN\s+from\s+'antd\/locale\/zh_CN'/);
  });

  it('ConfigProvider 上真的传了 locale={zhCN}', () => {
    // 只断言「import 了」是不够的：import 进来没传下去，antd 的内置文案照样是英文
    expect(providersSource).toMatch(/locale=\{zhCN\}/);
    // 反面：不能写成别的 locale / 字符串（改掉这一行 ⇒ 本用例必须红）
    expect(providersSource).not.toMatch(/locale=\{zhTW\}/);
    expect(providersSource).not.toMatch(/locale="zh_CN"/);
  });

  it('全局关掉「两个汉字之间插空格」（aria 名要等于可见文案）', () => {
    expect(providersSource).toMatch(/button=\{\{\s*autoInsertSpace:\s*false\s*\}\}/);
  });
});
