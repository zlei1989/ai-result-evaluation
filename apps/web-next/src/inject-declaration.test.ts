// @vitest-environment node
/**
 * **注入面声明（`turnInjection`）的取值与出口**：界面那颗输入区能不能用、两颗操作按钮禁不禁用，
 * 全部由它决定，故这一份是「界面由声明驱动」这条口径的数据侧判据。
 *
 * 判据是**逐家**的，不是「四家都不为 `yes`」这种总量判据：总量在四家取值变化时照样绿，
 * 而它恰恰要说清「哪一家今天真能用」。今天的事实是 **dsh 两档都 `yes`（真机已证）
 * ⇒ 输入区必须可用**，另外三家各按自己的档置灰——而这正是「声明透出」与「不透出」的差别：
 * 出口少那一格时四家一律读成「不知道」，连 dsh 那条路也一起死。
 *
 * **为什么这里只断到「声明取值」这一层**（「可用 / 置灰」那一半在
 * `@aieval/ui` 的 `inject-vocab.test.ts` 里逐档断言）：`@aieval/ui` 的包根桶一被 node 环境的用例
 * 引入就会加载 `@ant-design/x-markdown` 的 CJS 产物（它内部 `require('./DebugPanel.css')`），
 * 而 node 的 CJS 加载器会把那份 CSS 当 JS 解析 ⇒ 整个用例文件在收集阶段就崩。
 * 于是这一格拆成**两侧都钉**（本仓对「接缝」的既有处置）：这里钉「出口原样透出、四家取值如实」，
 * `ui` 那边钉「每一档 → 可用性 / 那一句话」。两边都钉才叫接缝，只钉一边会漏掉另一半。
 */
import { describe, expect, it } from 'vitest';
import type { TurnInjectionCapability } from '@aieval/contracts';
import { listAgentModelOptions } from '@aieval/api';

/** 四家的声明，按键取（缺组就是 `undefined`——「整组没交」与「交了一份空声明」是两件事） */
function declarations(): Map<string, TurnInjectionCapability | undefined> {
  return new Map(listAgentModelOptions().map((group) => [group.agentKind, group.turnInjection]));
}

describe('turnInjection 从注册表透到创建期元数据（逐格原样，api 不裁剪）', () => {
  it('四家都交了这一组（今天的事实；整组不交的家会以 `undefined` 出现，不是被编一份）', () => {
    expect([...declarations().keys()].sort()).toEqual(['cc', 'codex', 'dsh', 'pi']);
    for (const [kind, declaration] of declarations()) {
      expect(declaration, `${kind} 没有交 turnInjection：输入区会一律读成「不知道」`).toBeDefined();
    }
  });

  it('四家的两档投递逐格如实：dsh 全 `yes`、codex 的 `idle` 也是 `yes`，其余各按自己的档', () => {
    const byKind = declarations();
    // dsh：两档都是 `yes`（适配器接线 + 真机观测俱备）
    expect(byKind.get('dsh')?.delivery.round.state).toBe('yes');
    expect(byKind.get('dsh')?.delivery.idle.state).toBe('yes');
    // codex：`'idle'` 档有真路径读数（真二进制 + 脚本式上游量到那句话进**厂商出站请求体**）⇒ `yes`；
    // 它的 `'round'` 档仍 `unverified`（投递点没验）
    expect(byKind.get('codex')?.delivery.idle.state).toBe('yes');
    expect(byKind.get('codex')?.delivery.round.state).toBe('unverified');
    // 其余两家今天都不是 `yes`：`unverified` = 有通道没验证过（cc 的接线与生产调用方都齐，
    // 缺的是厂商侧投递点的端到端真路径观测），`off-by-adapter` = 厂商有、我们还没接
    expect(byKind.get('cc')?.delivery.idle.state).toBe('unverified');
    expect(byKind.get('pi')?.delivery.idle.state).toBe('off-by-adapter');
    // 原因必须自成一格（`reason` 是界面那四句中文的直接来源，缺席会让界面说不出为什么）
    for (const [kind, declaration] of byKind) {
      for (const boundary of ['round', 'idle'] as const) {
        const cell = declaration?.delivery[boundary];
        if (cell === undefined || cell.state === 'yes') continue;
        expect(cell.reason, `${kind} 的 ${boundary} 档非 yes 却没给 reason`).not.toBeNull();
      }
    }
  });

  it('撤回能力四档逐家如实：pi 是 `flush-only`、codex 两档不同、cc/dsh 按身份', () => {
    const byKind = declarations();
    // pi 只支持整条清空 ⇒ 界面在「已交给厂商」上禁用「删除」并如实说明原因
    expect(byKind.get('pi')?.retract.idle.state).toBe('flush-only');
    // codex 是「家 × 档」矩阵的样本：更晚那一档按身份可撤，在途那一档撤不了
    expect(byKind.get('codex')?.retract.idle.state).toBe('by-id');
    expect(byKind.get('codex')?.retract.round.state).toBe('none');
    // cc 自铸 uuid、dsh 按 messageId ⇒ 那两家可以真的按条撤
    expect(byKind.get('cc')?.retract.idle.state).toBe('by-id');
    expect(byKind.get('dsh')?.retract.idle.state).toBe('by-id');
    // 四档里的每一格都必须带判据：界面要说得出「撤回可能撤掉哪一条」
    for (const [kind, declaration] of byKind) {
      for (const boundary of ['round', 'idle'] as const) {
        const retract = declaration?.retract[boundary];
        expect(retract?.reason.trim(), `${kind} 的 ${boundary} 档撤回没给判据`).not.toBe('');
      }
    }
  });

  it('两档可以不同（不许被合成一格）：同一家里 `round` 与 `idle` 的撤回能力不是一个值', () => {
    // codex 就是那个反例：把四档写成一格「支持撤回」时，这条会当场红
    const codex = declarations().get('codex');
    expect(codex?.retract.round.state).not.toBe(codex?.retract.idle.state);
  });
});
