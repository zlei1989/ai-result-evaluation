// @vitest-environment node
/**
 * cc 窄壳的两处**形状判据**（`sdk.ts`）：
 *
 *   ① **类型面**：`query` 的 `prompt` 必须收 `AsyncIterable`（收窄它就等于把 streaming input 关在门外，
 *      而那正是「运行中注入」唯一的那条路）；`cancelAsyncMessage` / `interrupt` 必须**可选**
 *      ——`cancelAsyncMessage` 在安装态的 `sdk.mjs` 里已实现却**不在公开面**
 *      （`Query` 接口与 `.d.ts` 都没有），把任何一格写成必填，都会让「这一版没有它」变成一次
 *      编译期谎言或一次运行时崩溃（两向都要能赋值，故用条件类型而不是带标注的字面量）。
 *      窄壳**按需声明**：厂商那一堆没人用的方法（多轮入口 `streamInput` 等）不进这个接口。
 *   ② **运行时**：撤回回执的收窄（裸布尔 / `{ cancelled }` / 不认识）——四值映射的第一道闸门。
 */
import { describe, expect, it } from 'vitest';
import { readClaudeCancelResult, readClaudeContextUsage, type ClaudeQuery, type ClaudeSdkModule, type ClaudeUserMessage } from './sdk';

/** 只判方向、不求值：本地类型变宽或变窄都会让 `tsc` 在这里报错 */
type IsOptional<T, K extends keyof T> = undefined extends T[K] ? true : false;

const cancelIsOptional: IsOptional<ClaudeQuery, 'cancelAsyncMessage'> = true;
const interruptIsOptional: IsOptional<ClaudeQuery, 'interrupt'> = true;

/** `prompt` 的两支都要能赋进去（`AsyncIterable` 那一支被收窄即编译失败） */
const stringPrompt: Parameters<ClaudeSdkModule['query']>[0]['prompt'] = '题面';
const streamPrompt: Parameters<ClaudeSdkModule['query']>[0]['prompt'] = (async function* (): AsyncGenerator<ClaudeUserMessage> {
  yield { type: 'user', message: { role: 'user', content: '第一句' }, parent_tool_use_id: null };
})();

describe('cc 窄壳：形状', () => {
  it('`prompt` 收字符串与异步可迭代两支；两格能力全是可选', () => {
    expect([cancelIsOptional, interruptIsOptional]).toEqual([true, true]);
    expect(typeof stringPrompt).toBe('string');
    expect(typeof (streamPrompt as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');
  });

  it('撤回回执的收窄：裸布尔（`sdk.mjs` 的实现形状）与 `{ cancelled }`（控制响应本体）都认', () => {
    expect(readClaudeCancelResult(true)).toBe(true);
    expect(readClaudeCancelResult(false)).toBe(false);
    expect(readClaudeCancelResult({ cancelled: true })).toBe(true);
    expect(readClaudeCancelResult({ cancelled: false })).toBe(false);
  });

  it('不认识的形状一律 `null`：那是**采不到**，绝不猜一个布尔出来', () => {
    expect(readClaudeCancelResult({ cancelled: 'yes' })).toBeNull();
    expect(readClaudeCancelResult({})).toBeNull();
    expect(readClaudeCancelResult(undefined)).toBeNull();
    expect(readClaudeCancelResult('true')).toBeNull();
  });

  /**
   * **「厂商没投送这一格」与「我们读不出这一格」必须落在两个不同的返回值上**。
   *
   * 为什么这一条承重：`readClaudeContextUsage` 的唯一调用方用 `=== null` 区分这两件事
   * ——`null` ⇒ 落一条点名的 WARN、技能面判据降级成 `unverified`；`{skills:null}` ⇒ 一声不吭。
   * 两者共用返回值时，「厂商把 `totalSkills` 改了名」与「厂商真的没投送 skills」在日志与产物里
   * 完全同形，而那条 WARN 变成永不触发的死代码。
   */
  it('上下文用量：skills 缺席 ⇒ `{skills:null}`；形状不认 ⇒ `null`（两档不许同形）', () => {
    // 厂商口径：没有任何 skill 占用上下文时省略整格 ⇒ 采到了「没投送这一格」
    expect(readClaudeContextUsage({})).toEqual({ skills: null });
    expect(readClaudeContextUsage({ skills: null })).toEqual({ skills: null });

    // 形状不认（改名 / 改类型）⇒ 采不到，走 WARN 那一档
    expect(readClaudeContextUsage({ skills: 7 })).toBeNull();
    expect(readClaudeContextUsage({ skills: { totalSkills: '7', includedSkills: 2, skillFrontmatter: [] } })).toBeNull();
    expect(readClaudeContextUsage({ skills: { totalSkills: 7 } })).toBeNull();
    expect(readClaudeContextUsage('nope')).toBeNull();
    expect(readClaudeContextUsage(null)).toBeNull();

    // 正常那一档不受影响
    expect(readClaudeContextUsage({ skills: { totalSkills: 3, includedSkills: 1, skillFrontmatter: [{ name: 'poetry', source: 'userSettings' }] } }))
      .toMatchObject({ skills: { totalSkills: 3, includedSkills: 1 } });
  });
});
