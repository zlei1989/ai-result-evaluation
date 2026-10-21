// @vitest-environment node
/**
 * 「产物总览」的**接线**守卫：排名抽屉里的入口按钮与二级抽屉。
 *
 * 为什么要有这一条：`apps/web-next` 不能写 `.tsx` 测试（该应用 `jsx: preserve`，AGENTS.md 的硬约束），
 * 于是页面这一层没有渲染测试面。而下面四件事都是**静默**的：
 *   ① 清单的取数开关写错（例如恒为 `true`）⇒ 每开一次详情就扫一遍全轮工作区，界面毫无异样；
 *   ② `ArtifactOverview` 被挪出排名抽屉的子树 ⇒ 二级抽屉照样弹，但**主抽屉不被推开**
 *      （`NestedDrawer` 靠 `parentContext` 推，portal 带不走 React 树）；
 *   ③ 关排名抽屉时没复位二级抽屉 ⇒ 重开时它自己弹出来，只在「开过再关再开」的顺序下复现；
 *   ④ 按钮文案就地写死一份 ⇒ 与抽屉标题两处字面量，改一处就不同文。
 *
 * 判据只扫**排名抽屉那一段**（从它的开标签到第一个 `</Drawer>`）：整文件匹配会把别的抽屉
 * （评分详情那两个二级入口）算进来，误伤比漏放行更危险。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 应用根目录（`apps/web-next`）：用文件自身位置推导，不依赖 `process.cwd()` */
const pagePath = join(import.meta.dirname, '..', 'app', 'runs', 'page.tsx');
const source = readFileSync(pagePath, 'utf8');

/**
 * 排名抽屉那一段源码（开标签 → 第一个 `</Drawer>`）。
 * 这一段里没有嵌套的 `<Drawer>`（二级抽屉是组件，不是抽屉开标签），故第一个闭标签就是它的。
 * 抠不到直接抛：判据失效时不能静默通过。
 */
function rankDrawerBlock(): string {
  const titleAt = source.indexOf('title="排名"');
  if (titleAt < 0) throw new Error('app/runs/page.tsx 里找不到「排名」抽屉（判据失效了）');
  const openAt = source.lastIndexOf('<Drawer', titleAt);
  const closeAt = source.indexOf('</Drawer>', titleAt);
  if (openAt < 0 || closeAt < 0) throw new Error('排名抽屉的开标签 / 闭标签不在预期位置');
  return source.slice(openAt, closeAt);
}

describe('产物清单的取数开关', () => {
  it('只在排名抽屉打开时扫盘（别的抽屉开着不扫：一次扫描 = 每个候选一次 readdir）', () => {
    expect(source, '清单的取数开关写错了').toContain('useRunArtifacts(runId, drawer?.kind === \'rank\')');
  });

  it('每份正文一个组件实例（hook 不能按行 × 文件名循环调用）', () => {
    // 页面里必须有一个只吃 { runId, candidateId, name } 的小组件，由它自己调那个 hook
    expect(source, '少了「一份产物一个组件实例」的那一层').toContain('function ArtifactFileBody({ runId, candidateId, name }');
    expect(source, 'ArtifactFileBody 里没有调 useCandidateArtifactFile').toMatch(
      /function ArtifactFileBody[\s\S]{0,400}?useCandidateArtifactFile\(runId, candidateId, name\)/,
    );
    // 循环里自己调 hook 是非法写法（候选数随数据变），出现即说明形状被改回去了
    expect(source, '页面按行循环调了 hook').not.toMatch(/\.map\([^)]*=>\s*useCandidateArtifactFile/);
  });
});

describe('二级抽屉挂在排名抽屉的子树里', () => {
  it('排名抽屉那一段里同时有排名表与产物总览', () => {
    const block = rankDrawerBlock();

    expect(block, '排名表被挪出排名抽屉了').toContain('<RankTable run={run}');
    // 必须在这一段里：`NestedDrawer` 靠 React 树里的 `parentContext` 把主抽屉推开，
    // portal 不影响 context 的传递，但**挪到抽屉外面就传不过去**
    expect(block, '产物总览被挪出排名抽屉了：二级抽屉不会把主抽屉推开').toContain('<ArtifactOverview');
    expect(block, '二级抽屉的正文渲染没有接上每份一个实例的那一层').toContain('<ArtifactFileBody runId={runId}');
    // 开合必须受控（状态住页面），否则入口按钮点不到它
    expect(block, '二级抽屉的开合没有受控').toContain('onOpenChange={setArtifactOpen}');
  });

  it('关掉排名抽屉时把二级抽屉的开合一起复位（重开不该自己弹出来）', () => {
    const block = rankDrawerBlock();

    expect(block, '排名抽屉的 onClose 没有复位二级抽屉').toContain('setArtifactOpen(false)');
    // 复位必须挂在 onClose 上（而不是某个 effect 里）：那两件事是同一次用户动作
    expect(block, '复位不在 onClose 里').toMatch(/onClose=\{\(\) => \{[\s\S]{0,200}?setArtifactOpen\(false\)/);
  });
});

describe('入口按钮', () => {
  it('至少有一份产物才出现（判据是 total，不是「有没有跑完」）', () => {
    const block = rankDrawerBlock();

    expect(block, '按钮的可见性判据改了').toContain('artifacts.index.total > 0');
    expect(block, '按钮没有挂上固定 testid（冒烟要按它定位）').toContain('data-testid="rank-artifacts-open"');
  });

  it('读不到清单时置灰并挂中文原因（不静默不出现）', () => {
    const block = rankDrawerBlock();

    expect(block, '读不到清单被静默吞掉了').toContain('artifacts.error !== null');
    expect(block, '置灰那一支没有 Tooltip 说明原因').toMatch(/<Tooltip title=\{`读不到产物清单：\$\{describeError\(artifacts\.error\)\}`\}/);
  });

  it('按钮文案与抽屉标题同源（不许就地写「产物总览」四个字）', () => {
    const block = rankDrawerBlock();

    // 两处都用常量：可用那一支与置灰那一支（抽屉标题在组件里读同一个常量）
    expect(block.match(/\{ARTIFACT_OVERVIEW_LABEL\}/g) ?? [], '按钮文案没有走共享常量').toHaveLength(2);
    expect(source, '页面里又写了一份「产物总览」字面量').not.toContain('\'产物总览\'');
    expect(source, '页面里又写了一份「产物总览」字面量').not.toContain('"产物总览"');
  });
});
