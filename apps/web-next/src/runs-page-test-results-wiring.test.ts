// @vitest-environment node
/**
 * 测试通过率的**页面接线**守卫。
 *
 * 页面这一层没有渲染测试面（`apps/web-next` 必须 `jsx: preserve`，不能写 `.tsx` 测试），
 * 而下面两件事都是静默的：
 *   ① 取数开关恒为 `true` ⇒ 每开一次详情就读一遍所有行的消息账本；
 *   ② `RankTable` 没接上投影 ⇒ 表格永远写「未采集」，但看上去完全正常。
 *
 * 判据只扫排名抽屉那一段，避免把别的抽屉的 hook 算进来。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(import.meta.dirname, '..', 'app', 'runs', 'page.tsx'), 'utf8');

function rankDrawerBlock(): string {
  const titleAt = source.indexOf('<SheetTitle>排名</SheetTitle>');
  if (titleAt < 0) throw new Error('app/runs/page.tsx 里找不到「排名」抽屉（判据失效了）');
  const openAt = source.lastIndexOf('<Sheet\n', titleAt);
  const closeAt = source.indexOf('</SheetContent>', titleAt);
  if (openAt < 0 || closeAt < 0) throw new Error('排名抽屉的开标签 / 闭标签不在预期位置');
  return source.slice(openAt, closeAt);
}

describe('测试通过率的页面接线', () => {
  it('只在排名抽屉打开时读测试结果（与产物清单同一开关）', () => {
    expect(source).toContain('useRunTestResults(runId, drawer?.kind === \'rank\')');
  });

  it('排名表拿到投影（没接上时整列永远「未采集」，页面看不出异常）', () => {
    expect(rankDrawerBlock()).toMatch(/<RankTable[\s\S]*?testResults=\{runTests\.results\}/);
  });
});
