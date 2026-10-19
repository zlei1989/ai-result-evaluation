// @vitest-environment node
/**
 * vendored 原语的**内容**纪律：`components/ui/**` 与清单逐字节一致。
 *
 * 为什么需要它：`vendored-sources.test.ts` 只守说明符（`@/` 别名），守不住「有人为了让某页好看，
 * 直接改原语里的间距、字号或颜色」——这类改动没有编译错、没有运行期错，只有「和上游越来越不像」
 * 这一种症状，而症状要等下一轮设计评审才被看见。清单把「手改」变成一条红用例。
 *
 * 允许的两类改动，都必须**同时**更新清单并说明理由：
 *   1. 重新 vendor（上游改版 / 换 registry 条目）：跑 `node scripts/vendored-manifest.mjs`；
 *   2. 有据可查的本仓适配（如 `message-scroller.tsx` 去掉滚动淡出与自动滚动类、
 *      `button.tsx` 补焦点环）：改文件的同时改清单，让差异留在 git diff 里而不是藏进历史。
 *
 * 不查「与今天上游是否一致」：registry 没有版本号，仓库也不钉上游快照；能离线证明的是
 * **相对上次登记没有变**，这是本守卫的边界。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_DIR = join(import.meta.dirname, 'ui');
const MANIFEST = join(import.meta.dirname, 'vendored-manifest.json');
const REGENERATE = 'node scripts/vendored-manifest.mjs';

/** 当前落盘的组件名（排除用例），排序后用于与清单比对集合 */
const present = readdirSync(UI_DIR)
  .filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
  .sort();

const manifest: Record<string, string> = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, string>;

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('vendored 原语的哈希清单', () => {
  it('清单覆盖的件与落盘的件完全一致（不多不少）', () => {
    const listed = Object.keys(manifest).sort();
    const missing = present.filter((name) => !listed.includes(name));
    const stale = listed.filter((name) => !present.includes(name));
    expect(missing, `新增的 vendored 件没有登记：${missing.join('、')}（重新 vendor 后跑 ${REGENERATE}）`).toEqual([]);
    expect(stale, `清单里有已经不存在的件：${stale.join('、')}（跑 ${REGENERATE} 或补回文件）`).toEqual([]);
  });

  it('每个件的内容与清单一致（手改会在这里红）', () => {
    const changed = present.filter((name) => {
      const file = join(UI_DIR, name);
      return existsSync(file) && manifest[name] !== sha256(file);
    });
    expect(
      changed,
      [
        `这些 vendored 原语被改过：${changed.join('、')}`,
        '原语是 registry 产物，页面差异应该落在组装层（PageHeader / Card / 列宽 / 间距），',
        '不是改原语自身。若这次确实是重新 vendor 或有据可查的适配，跑 ',
        `${REGENERATE} 并把清单一起提交。`,
      ].join(''),
    ).toEqual([]);
  });
});
