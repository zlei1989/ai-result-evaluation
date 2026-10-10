// @vitest-environment node
/**
 * 设置页两张卡的**接线**守卫：评分配置卡的协议 / 档位域投影，以及工作区卡的用例目录与用例同步。
 *
 * 协议过滤的判据在卡片里（`JudgeSettingsCard` 自己的用例钉住了「协议不匹配的智能体被禁用且说明原因」），
 * 但卡片看不见「页面有没有把那张表传进来」——`agentProtocols` 在卡片上是可选 prop，漏传时
 * `pnpm typecheck` 不响，过滤静默退化成「一个都不过滤」：
 * 每家智能体照旧全部可选，直到创建 / 评分时被服务端的 CONFLICT 拦下，用户才知道自己选错了。
 *
 * 工作区那一段同一条理由：用例目录与同步的 props 虽然必填（漏传会红），
 * 但**回调体接错线**（写错 SettingsPatch 的键）类型查不出、界面上两格长得一模一样，只有源码锚点拦得住。
 *
 * 同目录 `runs-page-wiring.test.ts` 的文件头记着同一类缺陷（纯函数全绿而调用方漏喂输入），本文件是它在设置页的对应物。
 *
 * 为什么读源码而不是渲染页面：`apps/web-next` 保留 `jsx: preserve`（Next 需要），
 * 该应用内**不能写 `.tsx` 测试**（AGENTS.md 的硬约束：报错来自 Vite 的 import-analysis，改 esbuild 配置也无效），
 * 页面这一层没有渲染测试面——这也正是本仓库的「页面接线」守卫都是读源码的 `.ts` 的原因。
 *
 * 断言口径沿用同目录先例：把 `<JudgeSettingsCard … />` 的**开标签**抠出来只扫这一段，
 * 再顺着「表 ← agentOptions ← useRunModelOptions()」这条链各钉一环；抠不到就抛（守卫不许静默失效）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 设置页源码（用文件自身位置推导，不依赖 `process.cwd()`） */
const pagePath = join(import.meta.dirname, '..', 'app', 'settings', 'page.tsx');
const source = readFileSync(pagePath, 'utf8');

/** 抠出某个 JSX 组件的开标签；抠不到直接抛，避免守卫变成永远为真的空断言 */
function openingTag(component: string): string {
  const start = source.indexOf(`<${component}`);
  if (start < 0) throw new Error(`app/settings/page.tsx 里找不到 <${component} … />`);
  const end = source.indexOf('/>', start);
  if (end < 0) throw new Error(`${component} 的开标签没有在预期处结束（找不到 \`/>\`）`);
  return source.slice(start, end);
}

describe('settings 页面的评分配置卡接线', () => {
  it('把「智能体 → 协议」表喂进评分配置卡——漏了它，协议过滤静默退化成不过滤', () => {
    const tag = openingTag('JudgeSettingsCard');

    expect(tag, '少了 agentProtocols——协议不匹配的智能体又变成全部可选').toContain('agentProtocols=');
  });

  it('表按卡片认得的形状投影（agentKind + protocolTypes，少一个卡片就查不出协议）', () => {
    const tag = openingTag('JudgeSettingsCard');

    expect(tag, '投影里少了 agentKind').toContain('agentKind:');
    // 形状是**集合**（2026-09-30 起）：写成单数 `protocolType:` 会让卡片读不到值，
    // 而卡片读不到时会「一个都不过滤」（见它的 agentProtocols 注释），红不出来就是静默退化
    expect(tag, '投影里少了 protocolTypes').toContain('protocolTypes:');
  });

  /**
   * 档位域与协议表**同一条理由**，但后果更硬：卡片的「思考强度」候选就是写下侧的**唯一**把关
   * （`settings.defaultJudge.effort` 的 schema 只看「非空字符串」）。漏了这一格 ⇒ 卡片只能兜规范五档
   * ⇒ dsh 的 `medium` 摆到界面上并被存下 ⇒ 生成 / 识别时被 `requireJudgeEffort` 硬拒。
   * 而它是可选 prop，漏传时 `pnpm typecheck` 一个字都不报。
   */
  it('把「思考强度」的档位域也喂进去——漏了它，候选退化成规范五档，dsh 的 medium 就摆上了界面', () => {
    expect(openingTag('JudgeSettingsCard'), '投影里少了 efforts，档位域只能兜规范五档').toContain('efforts:');
  });

  it('这张表来自服务端的注册表投影（useRunModelOptions），不是页面自己抄的一份', () => {
    // 值写死成字面量（例如自己列几家协议）也能让上面两条绿，故这里要求值的来源是那份投影
    expect(openingTag('JudgeSettingsCard'), 'agentProtocols 不是从 agentOptions 现算的').toContain('agentOptions');
    expect(source, '页面没有调用 useRunModelOptions()').toContain('useRunModelOptions()');
    expect(source, 'agentOptions 不是 useRunModelOptions() 的 options 投影').toContain('options: agentOptions');
  });
});

/**
 * 工作区卡新增的「用例目录」与「用例同步」两块的接线。
 *
 * 卡片自己的用例钉住了显隐与禁用（组件那一侧），但卡片看不见「页面有没有把状态与回调喂进来」：
 * 这些都是必填 prop（漏了 typecheck 会红），真正红不出来的是**回调体接错线**——
 * 用例目录的校验写成 `update({ workspaceRoot })` 时 props 一个不少、类型也对，
 * 而两格的输入框与按钮长得一模一样，肉眼冒烟分不出来，症状是「用例目录改了没生效」。
 */
describe('settings 页面的用例目录与用例同步接线', () => {
  it('接上同步状态与动作两个 hook——漏了它们，卡片只能一直画骨架屏且没有任何动作按钮', () => {
    expect(source, '页面没有调用 useCaseSyncStatus()').toContain('useCaseSyncStatus()');
    expect(source, '页面没有调用 useCaseSyncAction()').toContain('useCaseSyncAction()');

    const tag = openingTag('WorkspaceSettingsCard');
    expect(tag, '少了 syncStatus=').toContain('syncStatus=');
    expect(tag, '少了 onSyncAction=').toContain('onSyncAction=');
    expect(tag, '少了 syncing=').toContain('syncing=');
  });

  it('把用例目录那一格交给卡片：settings（含 casesRoot）+ 独立回调 + 开关都在开标签里', () => {
    const tag = openingTag('WorkspaceSettingsCard');
    expect(tag, '少了 settings=——casesRoot 就在它里面').toContain('settings=');
    expect(tag, '少了 onValidateCasesRoot=').toContain('onValidateCasesRoot=');
    expect(tag, '少了 lastValidatedCases=').toContain('lastValidatedCases=');
    expect(tag, '少了 onToggleAutoCommit=').toContain('onToggleAutoCommit=');
  });

  it('两个回调体各自写到对的键（用例目录写成 workspaceRoot 是静默错线，类型查不出）', () => {
    expect(source, '用例目录没有落到 PUT { casesRoot }').toContain('update({ casesRoot: root })');
    expect(source, '自动提交开关没有落到 PUT { casesAutoCommit }').toContain('update({ casesAutoCommit: value })');
  });

  it('同步状态读失败要显式渲染——否则一次 GET 失败就只剩一个永远转不完的骨架屏', () => {
    expect(source, 'syncError 没有被渲染出来').toContain('loadFailure(syncError');
  });
});
