// @vitest-environment node
/**
 * 读 claude 的子智能体会话文件
 * （`<CLAUDE_CONFIG_DIR>/projects/<项目>/<session>/subagents/agent-<agentId>.jsonl`）。
 * 四条必须钉住的规则：
 *   ① 按 `message.id` 去重、后到覆盖——同一个 API 往返按内容块出现多次，逐条相加会把 input/cached 双计；
 *   ② **按目录枚举**：文件名里是 `agentId`，**不拿事件流的 id 去拼文件名**——
 *      事件流里混着 CLI 的非 Agent task 条目，它们永远没有转录（真机缺陷，见 `subagent-usage.ts` 文件头）；
 *      同一个教训的另一半是**并集规则**：盘上有、而 id 没进名单的转录**照读**；
 *   ③ 有转录读不动 ⇒ 整格 null 并点名（「全量或 null」，绝不把部分和当总数）；
 *   ④ **名单里的每一个（形状像一次派发的）都必须有一份读得动的转录**（收窄，见下）——
 *      缺了它，一个真派发的转录丢失、而另一份转录在盘上时，交出去的就是**部分和**。
 */
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClaudeSubagentUsageCache,
  readClaudeSubagentFile,
  readClaudeSubagentUsage,
} from './subagent-usage';

/**
 * **走的是流式**这条守卫没法用 `vi.spyOn(fs, …)` 写：本仓是 ESM，`node:fs` 的导出是**不可配置**的模块命名空间，
 * `vi.spyOn` 当场抛 `TypeError: Cannot spy on export "readFileSync". Module namespace is not configurable in ESM`
 * ⇒ 只能在**模块层面**换成计数用的假函数，并用 `importOriginal` 把其余导出
 * 原样透出（`readdirSync` / `statSync` / `writeFileSync` / `openSync` / `closeSync` 等照常是真实现，
 * 四个被计数的也**委派**给真实现，免得把本文件里写夹具的那些调用一起打断）。
 *
 * 判据是「**被测模块**有没有整份读」：断言写成 `not.toHaveBeenCalled()` / `toHaveBeenCalledTimes(n)` /
 * 逐个参数上界，每次读之前 `mockClear()`（见 `beforeEach`），所以**只有被测模块的调用**会被看见。
 *
 * ⚠️ 同步流式的判据是 `readSync`（`openSync` + `readSync` + `closeSync`），**不是** `createReadStream`：
 * 转 async 流会把 claude 一家的异步引进 `turn.ts` 的同步钩子（`project` / `finalize`）⇒ 改回整份读
 * （`readFileSync`）必须红，而「每次只读一块」也必须红——两半缺一条，守卫就只剩「改没改名字」。
 */
const fsSpies = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  /**
   * 目录枚举也计数：判据是「`<configHome>/projects` 被枚举了几次」——`cache`
   * 复用会话目录解析结果之后，N 个子会话只该枚举一次（在此之前是 N 次）。
   */
  readdirSync: vi.fn(),
  /**
   * **真实现**的一份副本（`vi.mock` 工厂里赋值）。它是给「读到一半被追加」那条用例用的：
   * 那条要用 `mockImplementationOnce` 顶掉 `readSync`，而顶掉之后**仍需**把这一块真的读出来。
   * ⚠️ 它必须住在这个 `vi.hoisted` 对象里：`vi.mock` 会被提升到文件顶部，工厂里访问**文件级的 `let`
   * 会撞 TDZ**（`Cannot access 'x' before initialization`，本文件实测过）。
   */
  actualReadSync: undefined as unknown as typeof import('node:fs').readSync,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsSpies.actualReadSync = actual.readSync;
  fsSpies.readFileSync.mockImplementation(actual.readFileSync);
  fsSpies.openSync.mockImplementation(actual.openSync);
  fsSpies.readSync.mockImplementation(actual.readSync);
  fsSpies.closeSync.mockImplementation(actual.closeSync);
  fsSpies.readdirSync.mockImplementation(actual.readdirSync);
  return {
    ...actual,
    readFileSync: fsSpies.readFileSync,
    openSync: fsSpies.openSync,
    readSync: fsSpies.readSync,
    closeSync: fsSpies.closeSync,
    readdirSync: fsSpies.readdirSync,
  };
});

/** 夹具所在的 `subagents/` 目录（与 `writeAgentFile` 同一处，追加行时按同一个路径拼） */
function agentDir(configHome: string, sessionId: string): string {
  return join(configHome, 'projects', 'D---tmp-proj', sessionId, 'subagents');
}

function writeAgentFile(configHome: string, sessionId: string, taskId: string, lines: unknown[]): void {
  const dir = agentDir(configHome, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${taskId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
}

function assistant(messageId: string, usage: Record<string, number>): unknown {
  return { type: 'assistant', isSidechain: true, uuid: `${messageId}-${Math.random()}`, message: { id: messageId, usage } };
}

describe('readClaudeSubagentUsage', () => {
  beforeEach(() => {
    // 只数**被测模块**的调用：夹具是上一轮用例写下的，这里的清零让每条用例的计数从 0 起算
    fsSpies.readFileSync.mockClear();
    fsSpies.openSync.mockClear();
    fsSpies.readSync.mockClear();
    fsSpies.closeSync.mockClear();
    fsSpies.readdirSync.mockClear();
  });

  it('按 message.id 去重、后到覆盖（逐条相加会双计 input/cached）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-1', 'task-1', [
      assistant('m-1', { input_tokens: 13596, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant('m-1', { input_tokens: 13596, cache_read_input_tokens: 0, output_tokens: 106 }),
      assistant('m-2', { input_tokens: 1052, cache_read_input_tokens: 13696, output_tokens: 0 }),
      assistant('m-2', { input_tokens: 1052, cache_read_input_tokens: 13696, output_tokens: 2433 }),
    ]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-1', subagentIds: ['task-1'] });
    expect(read.usage).toEqual({ input: 14648, cached: 13696, output: 2539, reasoningOutput: null, total: null });
    expect(read.turns).toBe(2);
    expect(read.missing).toEqual([]);
  });

  it('多个子智能体各自去重后再相加', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-2', 'task-1', [assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 1, output_tokens: 2 })]);
    writeAgentFile(configHome, 's-2', 'task-2', [assistant('m-9', { input_tokens: 3, cache_read_input_tokens: 0, output_tokens: 4 })]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-2', subagentIds: ['task-1', 'task-2'] });
    expect(read.usage).toMatchObject({ input: 13, cached: 1, output: 6 });
    expect(read.turns).toBe(2);
  });

  it('没有子智能体 ⇒ {0,0,0} 与 turns 0（确实没有，不是 null）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    const read = readClaudeSubagentUsage({ configHome, sessionId: null, subagentIds: [] });
    expect(read.usage).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(read.turns).toBe(0);
  });

  /**
   * 读数**不按事件流的 id 去猜文件名**，而是**枚举会话目录**里的
   * `agent-*.jsonl`。判据变成「目录里有没有可读的转录」，事件流的那些 id 只当**事实核对**用
   * （一个转录都没有、可事件流说派过子智能体 ⇒ 事实缺失）。
   *
   * ⚠️ **判据收窄**：传进来的 `subagentIds` 现在只放
   * **形状像一次派发**的 id（判据在 `message.ts` 的 `ClaudeTaskShape`），幻影条目（CLI 给非 Agent 任务
   * 发的那条）**根本不会到达本函数**——它那条「没有同名文件」不再需要在这里被容忍。
   * 下面这条因此改钉**部分和不许冒充总数**：名单里的派发缺转录、而盘上另有可读转录时，**绝不拿部分和冒充总数**。
   */
  it('形状合格的派发缺转录、而盘上另有可读转录 ⇒ 整格 null 并点名缺的那个（部分和会冒充总数）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-8', 'ae63ead9521ee0d28', [
      // 同一个 `message.id` 两条（后到覆盖）⇒ 去重规则在这里照样生效
      assistant('m-1', { input_tokens: 13552, cache_read_input_tokens: 0, output_tokens: 114 }),
      assistant('m-1', { input_tokens: 13552, cache_read_input_tokens: 0, output_tokens: 114 }),
      assistant('m-2', { input_tokens: 1106, cache_read_input_tokens: 13568, output_tokens: 678 }),
    ]);
    // 事件流报过**两个**形状像派发的子智能体，而只有第一个的转录落到了盘上
    const read = readClaudeSubagentUsage({
      configHome,
      sessionId: 's-8',
      subagentIds: ['ae63ead9521ee0d28', 'a870138076fead44b'],
    });
    // ⚠️ 旧行为（只枚举目录、不与名单对账）在这里交的是**第一个的部分和**（14658 / 13568 / 792）——
    // 它在界面上与「全量合计」逐字同形，正是本仓最不接受的那类假数
    expect(read.usage).toBeNull();
    expect(read.turns).toBeNull();
    expect(read.missing).toEqual(['a870138076fead44b']);
  });

  it('名单里形状像派发的子智能体、而目录里一个转录都没有 ⇒ 整格 null 并点名**名单那些 id**（不写成 {0,0,0}）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    const read = readClaudeSubagentUsage({
      configHome,
      sessionId: 's-11',
      subagentIds: ['a870138076fead44b', 'ae63ead9521ee0d28'],
    });
    expect(read.usage).toBeNull();
    expect(read.turns).toBeNull();
    expect(read.missing).toEqual(['a870138076fead44b', 'ae63ead9521ee0d28']);
  });

  it('转录读不动（空文件）⇒ 整格 null 并点名**那个文件的 id**（不拿读到的那些冒充总数）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-10', 'ae63ead9521ee0d28', [assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 })]);
    // 第二个转录文件在、但读不出可用记录（空文件）⇒ 与「文件不在」同一档
    writeAgentFile(configHome, 's-10', '01a106b0-7ee9-7c30-a75a-6e59a9dcaa2b', []);
    // 名单里两个都在（都是形状像派发的 id；幻影条目不会到达这里，见上一条的注记）
    const read = readClaudeSubagentUsage({
      configHome,
      sessionId: 's-10',
      subagentIds: ['ae63ead9521ee0d28', '01a106b0-7ee9-7c30-a75a-6e59a9dcaa2b'],
    });
    expect(read.usage).toBeNull();
    expect(read.turns).toBeNull();
    // 点名的是**文件**的 agentId（那一份读不动），而不是「哪个 id 不在名单里」
    expect(read.missing).toEqual(['01a106b0-7ee9-7c30-a75a-6e59a9dcaa2b']);
  });

  it('事件流一个子智能体都没报、但目录里有转录 ⇒ 照读（转录是更硬的事实）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-9', 'ae63ead9521ee0d28', [assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 })]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-9', subagentIds: [] });
    expect(read.usage).toMatchObject({ input: 10, output: 1 });
    expect(read.turns).toBe(1);
    expect(read.missing).toEqual([]);
  });

  /**
   * **读取集 = 目录里的转录 ∪ 名单**。
   *
   * 两个方向各钉一次，缺一个方向就有一种**静默丢文件**：
   *   · 盘上有、而它的 id **没进名单**（真机可达：`task_started` 没被投送时，盘上那份转录就是唯一事实）
   *     ⇒ 照读——少这一半就会把一份真实的用量悄悄丢掉；
   *   · 名单里有、而盘上没有 ⇒ 整格 `null` + 点名（上一条已经钉住，缺那一半就是**部分和冒充总数**）。
   */
  it('并集规则：转录在盘上就必须读（哪怕它的 id 没进名单），名单里那个也要读', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-13', 'afb636cf844060a29', [
      assistant('m-1', { input_tokens: 20, cache_read_input_tokens: 0, output_tokens: 2 }),
    ]);
    // 这一份的 id **不在名单里**（事件流没报过它）：盘上有就必须读进来
    writeAgentFile(configHome, 's-13', 'ae63ead9521ee0d28', [
      assistant('m-2', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }),
    ]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-13', subagentIds: ['afb636cf844060a29'] });
    // 两份都进合计（只读名单的话这里会是 20 / 0 / 2 —— 少了一份，而界面看不出来）
    expect(read.usage).toMatchObject({ input: 30, output: 3 });
    expect(read.turns).toBe(2);
    expect(read.missing).toEqual([]);
  });

  /**
   * 规则⑤：**只见到收场帧**（`'unjudged'`）的 id 走**另一条路**——
   * 它既不进 `missing`（那会让两格变 `null`：一条判不了的条目把真子智能体的读数拖垮，正是用户报的症状），
   * 也不被静默放过（进 `unjudged` ⇒ 调用方落一句「可能少算它（无法判定它是不是子智能体）」）。
   * 两个方向一起才成立；`unjudgedIds` 是可选格，老调用方不受影响。
   */
  it('判不了的条目（`unjudgedIds`）没有转录 ⇒ 只进 `unjudged`：两格照算、`missing` 为空', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-14', 'ae63ead9521ee0d28', [
      assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }),
    ]);
    const read = readClaudeSubagentUsage({
      configHome,
      sessionId: 's-14',
      subagentIds: [],
      unjudgedIds: ['task-x'],
    });
    // 两格是**读到的那些的和**（盘上那份转录），**没有**被那条判不了的条目拖成 null
    expect(read.usage).toMatchObject({ input: 10, output: 1 });
    expect(read.turns).toBe(1);
    expect(read.missing).toEqual([]);
    // 但也不能静默：点名交给调用方（WARN 的文案在 `index.ts`，刻意不叫它子智能体）
    expect(read.unjudged).toEqual(['task-x']);
  });

  it('判不了的条目在盘上有转录 ⇒ 不进 `unjudged`（照读，没有「可能少算」可说）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-15', 'task-x', [
      assistant('m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
    ]);
    const read = readClaudeSubagentUsage({
      configHome,
      sessionId: 's-15',
      subagentIds: [],
      unjudgedIds: ['task-x'],
    });
    expect(read.usage).toMatchObject({ input: 4, output: 2 });
    expect(read.unjudged).toEqual([]);
  });

  /**
   * 采不到 session id 时**不猜目录**（随「按目录枚举」一起来的收紧）。
   *
   * 旧的兜底会扫 `<projects>/<项目>/<会话>/subagents/` 取第一个读得动的目录——那时判据是按 id 找文件，
   * 猜错目录多半只是「找不到文件 ⇒ 点名 WARN」；**改成按目录枚举之后，猜错目录就会把别的会话
   * （同一个 configHome 下的另一次尝试 / 评分那一次）的转录算到这一行上**：一个看起来完全正常的
   * 错数。⇒ 会话 id 未知时返回「没有目录」，上层照「事实缺失」落 null + 点名 WARN。
   */
  it('采不到 session id ⇒ 不猜目录：宁可 null + 点名，也不读别的会话的转录', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    // 盘上确有一份转录（属于另一个会话；旧兜底会扫到它）
    writeAgentFile(configHome, 's-12', 'ae63ead9521ee0d28', [assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 })]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: null, subagentIds: ['ae63ead9521ee0d28'] });
    expect(read.usage).toBeNull();
    expect(read.turns).toBeNull();
    expect(read.missing).toEqual(['ae63ead9521ee0d28']);
  });
  it('坏行（半截 JSON）跳过而不是整份作废——CLI 边跑边写，半截行是常态', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    const dir = join(configHome, 'projects', 'D---tmp-proj', 's-4', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent-task-1.jsonl'),
      `${JSON.stringify(assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }))}\n{"type":"assist`,
      'utf8',
    );
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-4', subagentIds: ['task-1'] });
    expect(read.usage).toMatchObject({ input: 10, output: 1 });
  });

  /**
   * 下面两条钉的是**同一档**「读失败」的另两种形状：
   * 文件**在**、但读不出可用记录。它们必须与「文件不在」走同一条路（`missing` ⇒ 整格 null + 点名 WARN），
   * 否则会出现「文件不在很响、文件空着却很静」——而被取消 / 失败的运行正好落在后者。
   * 判据不是「0 是好数还是坏数」，而是**我们有没有依据下结论**：读不出来 ⇒ 宁可不出数。
   */
  it('文件在、但一条可识别的用量记录都没有（空文件）⇒ 按读失败处理：整格 null 并点名它', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-5', 'task-1', []);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-5', subagentIds: ['task-1'] });
    expect(read.usage).toBeNull();
    expect(read.turns).toBeNull();
    expect(read.missing).toEqual(['task-1']);
  });

  it('认得是 assistant、却读不出完整三项 ⇒ 同一档按读失败处理（那条往返不许静默消失）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-6', 'task-1', [
      assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }),
      // 缺 cached / output：读不出三项 ⇒ 这一份作废（跳过它会让这次往返从合计与轮次里一起消失）
      assistant('m-2', { input_tokens: 4 }),
    ]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-6', subagentIds: ['task-1'] });
    expect(read.usage).toBeNull();
    expect(read.turns).toBeNull();
    expect(read.missing).toEqual(['task-1']);
  });

  /**
   * 第三处同类的静默丢弃：认得是 `assistant`、三项也齐全，
   * **却没有去重键**（`message.id`）⇒ 它归不到任何一次往返上，跳过它同样是从合计与轮次里抹掉一次往返。
   * ⚠️ 文件里**必须先有一条可用记录**：只有那一条无 id 记录时，这一档会被「一条可用记录都没有」那条
   * 覆盖住（`byMessageId.size === 0`），于是「改回 `continue`」照样是绿的——那就成了一条无区分力的守卫。
   */
  it('认得是 assistant、却拿不到去重键（无 message.id）⇒ 同一档按读失败处理，不静默丢掉那次往返', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-7', 'task-1', [
      assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }),
      // 三项齐全、可就是没有 message.id（归不到任何一次往返上）
      { type: 'assistant', isSidechain: true, uuid: 'no-id', message: { usage: { input_tokens: 4, cache_read_input_tokens: 2, output_tokens: 3 } } },
    ]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-7', subagentIds: ['task-1'] });
    expect(read.usage).toBeNull();
    expect(read.turns).toBeNull();
    expect(read.missing).toEqual(['task-1']);
  });
});

/**
 * 「读法三条」里前两条（用户点名的两件事，判据源 `docs/protocols/message-spec.md`）：
 * ① **流式**（不许整份进内存）② **同版本不重复解析**。
 *
 * ⚠️ ①的判据是**同步流式**（`openSync` + 循环 `readSync` + `closeSync`），不是异步流：
 * `turn.ts` 的 `project` / `finalize` 都是同步钩子，把异步引进来要改骨架并波及 dsh / codex
 * （见 `subagent-usage.ts` 文件头）。改回 `readFileSync` 整份读要红，而「一块读到底」也要红
 * ——两半缺一条，这条守卫就只剩「改没改函数名」。
 *
 * ① 钉一个**改回去就会静默变坏**的行为：改回 `readFileSync` + `split('\n')` ⇒ 峰值内存回到
 * 2–3× 文件大小（大文件 OOM 的那条路）。②钉的是「同一份文件一次运行读两次」——终态通知为子任务条
 * 读一次、收尾为合计与最终值再读一次。
 *
 * ⚠️ **没有 `rounds`（逐轮明细）**（用户裁定：只展示最终用量；那批读数要按轮拆
 * 转录文件，成本与收益不成比例）⇒ 本文件里相关的断言一并删掉，读数两格（`usage` / `turns`）逐字不变。
 */
describe('readClaudeSubagentUsage：同步流式 + 同版本不重复解析', () => {
  beforeEach(() => {
    fsSpies.readFileSync.mockClear();
    fsSpies.openSync.mockClear();
    fsSpies.readSync.mockClear();
    fsSpies.closeSync.mockClear();
    fsSpies.readdirSync.mockClear();
  });

  /** 一份**跨多块**的转录（每行约 200 B × 900 行 ≈ 180 KB ⇒ 64 KB 一块要读三次以上） */
  function writeBigAgentFile(configHome: string, sessionId: string, count: number): number {
    const lines = Array.from({ length: count }, (_, index) =>
      JSON.stringify(assistant(`m-${index}`, { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 })),
    );
    const dir = agentDir(configHome, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-task-1.jsonl'), lines.join('\n'), 'utf8');
    return lines.join('\n').length;
  }

  /**
   * 钩子：`openSync` / `closeSync` 必须**成对**（作废那条分支跳出读循环时 fd 还开着，靠 `finally` 关）。
   * 用 `afterEach` 而不是写在每条用例里：任何一条用例把 fd 漏掉都要红。
   */
  afterEach(() => {
    expect(fsSpies.openSync).toHaveBeenCalledTimes(fsSpies.closeSync.mock.calls.length);
  });

  it('走的是同步流式：不调用 readFileSync、每次只读一块（钉住「不许整份进内存」）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    const bytes = writeBigAgentFile(configHome, 's-20', 900);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-20', subagentIds: ['task-1'] });
    // 结果先自证没读坏（跨块拼行、去重、计数都得对）
    expect(read.usage).toMatchObject({ input: 900, cached: 0, output: 900 });
    expect(read.turns).toBe(900);
    // ①-a 整份读这条腿：改回 `readFileSync` ⇒ 这里红
    expect(fsSpies.readFileSync).not.toHaveBeenCalled();
    expect(fsSpies.openSync).toHaveBeenCalledTimes(1);
    // ①-b 一块读到底这条腿：每次 `readSync` 的**长度参数**都必须 ≤ 64 KB、且小于整份大小
    // （`readSync(fd, buffer, offset, length, position)` 的 length 是第 4 个参数，索引 3）
    const chunks = fsSpies.readSync.mock.calls.map((call) => call[3] as number);
    expect(chunks.length).toBeGreaterThanOrEqual(3); // ≥3 块 + EOF 那一次
    expect(Math.max(...chunks)).toBeLessThanOrEqual(64 * 1024);
    expect(Math.max(...chunks)).toBeLessThan(bytes);
  });

  /**
   * **等价性**：`usage` / `turns` 的数值必须与改前**逐字相同**。
   *
   * 判据用**字面量**（`toEqual` 不是 `toMatchObject`）：数值少一个字段、多一个字段都会红——
   * 流式改造最容易出的正是「半截行/去重规则被顺手改了一点」而合计只差几个 token。
   * 夹具同时压下三条老规则：同 id 后到覆盖（`m-1` / `m-2` 各两条，第一条 output 0）、
   * 单个 id 一轮（`turns` = 去重后个数）。
   */
  it('等价性：usage / turns 与改前逐字相同（同一份夹具，数值一个都不许变）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-22', 'task-1', [
      assistant('m-1', { input_tokens: 13596, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant('m-1', { input_tokens: 13596, cache_read_input_tokens: 0, output_tokens: 106 }),
      assistant('m-2', { input_tokens: 1052, cache_read_input_tokens: 13696, output_tokens: 0 }),
      assistant('m-2', { input_tokens: 1052, cache_read_input_tokens: 13696, output_tokens: 2433 }),
    ]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-22', subagentIds: ['task-1'] });
    // 14648 = 13596 + 1052 ｜ 13696 = 0 + 13696 ｜ 2539 = 106 + 2433（改前 `readOne` 的交出值，逐字）
    expect(read.usage).toEqual({ input: 14648, cached: 13696, output: 2539, reasoningOutput: null, total: null });
    expect(read.turns).toBe(2);
  });

  /**
   * **同版本不重复解析**：键是 `(路径, size, mtimeMs)`，缓存**run 作用域**
   * （`createClaudeSubagentUsageCache()` 建的那个对象，**显式传入**；不是模块级——模块级会跨 run 留大对象）。
   *
   * 真机形状就是这条用例：收场那帧为子任务条读一次（`index.ts:290`），收尾为合计再读一次
   * （`index.ts:391`）。**收尾必须重读**（文件是 CLI 边跑边追加的），但「文件没长」的那些
   * 子智能体不该被解析两遍——第二次直接复用第一次的结果。
   *
   * ⚠️ 后半段（追加一行 ⇒ 重新读）是这条守卫的另一半：只钉「读第二次不重解析」而不钉「长长了要重读」，
   * 一个「永远返回第一次结果」的实现照样绿——而那是**少算**（收尾读到的是陈旧值）。
   * ⚠️ 判据用 `openSync`（一次读盘 = 一次 open）而不是「时间」：它不受机器快慢影响。
   */
  it('同版本不重复解析：连读两次只打开一次文件；文件长长了 ⇒ 重新读', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-23', 'task-1', [
      assistant('m-1', { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 1 }),
    ]);
    const cache = createClaudeSubagentUsageCache();
    const first = readClaudeSubagentUsage({ configHome, sessionId: 's-23', subagentIds: ['task-1'], cache });
    expect(first.usage).toMatchObject({ input: 5, output: 1 });
    expect(fsSpies.openSync).toHaveBeenCalledTimes(1);
    // ① 同一版本（路径 + size + mtimeMs 都没变）⇒ 复用解析结果，不第二次读盘
    const again = readClaudeSubagentUsage({ configHome, sessionId: 's-23', subagentIds: ['task-1'], cache });
    expect(again).toEqual(first);
    expect(fsSpies.openSync).toHaveBeenCalledTimes(1);
    // ② 文件长长了（size 变）⇒ 版本变了，必须重新读（收尾才是全量）
    appendFileSync(
      join(agentDir(configHome, 's-23'), 'agent-task-1.jsonl'),
      `\n${JSON.stringify(assistant('m-2', { input_tokens: 3, cache_read_input_tokens: 0, output_tokens: 1 }))}`,
      'utf8',
    );
    const grown = readClaudeSubagentUsage({ configHome, sessionId: 's-23', subagentIds: ['task-1'], cache });
    expect(fsSpies.openSync).toHaveBeenCalledTimes(2);
    expect(grown.usage).toMatchObject({ input: 8, output: 2 });
    expect(grown.turns).toBe(2);
  });

  /**
   * 缓存必须**两个入口共用**（同一条 `readOne` 规则下的两个读者）：否则「收场帧按单个读、收尾按合计读」
   * 会把同一份文件解析两遍——正是用户点名的「不要多次重复读取」。
   * 两处传同一个 `cache` ⇒ 第二次直接命中。
   */
  it('缓存两个入口共用：先按合计读、再按单个读同一份文件 ⇒ 只打开一次文件', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-24', 'task-1', [
      assistant('m-1', { input_tokens: 7, cache_read_input_tokens: 0, output_tokens: 2 }),
    ]);
    const cache = createClaudeSubagentUsageCache();
    const all = readClaudeSubagentUsage({ configHome, sessionId: 's-24', subagentIds: ['task-1'], cache });
    expect(all.usage).toMatchObject({ input: 7, output: 2 });
    // 抽屉里子任务条那一格（`readClaudeSubagentFile`）：同一份文件、同一个缓存版本 ⇒ 不再读盘
    const one = readClaudeSubagentFile({ configHome, sessionId: 's-24', taskId: 'task-1', cache });
    expect(one?.usage).toMatchObject({ input: 7, output: 2 });
    expect(one?.turns).toBe(1);
    expect(fsSpies.openSync).toHaveBeenCalledTimes(1);
    expect(fsSpies.readFileSync).not.toHaveBeenCalled();
  });

  /**
   * **读完之后文件长长了** ⇒ 下一次读必须**重新解析**到全量。
   *
   * 真机形状（本任务存在的理由）：收场那帧为子任务条读一次（`index.ts:290`），CLI 又写了一行，
   * 收尾为合计再读一次（`index.ts:391）——第二次必须看到**全量**，而这个「必须真读一次」正是
   * 缓存不能做成「读一次就永远返回」的原因（版本变了要重读）。
   *
   * ⚠️ **这条抓不住什么，如实登记**：追加会让 `size` 变，只凭 size 那一格就能发现版本变了
   * ⇒ 「按读之前的版本写缓存」那个缺陷下它照样绿（实测）。它钉的是**真机那条路**本身
   * （收尾那次读到的是新写的那一轮），不是缓存键的写法。
   */
  it('读完之后文件长长了 ⇒ 下一次读重新解析到全量（收尾必须看到新写的那一轮）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    const file = join(agentDir(configHome, 's-25'), 'agent-task-1.jsonl');
    mkdirSync(agentDir(configHome, 's-25'), { recursive: true });
    // ⚠️ 第 1 行**不带结尾换行**：追加方必须补一个，否则两行会粘成一条（那条会被当成坏行跳过）
    writeFileSync(
      file,
      JSON.stringify(assistant('m-1', { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 1 })),
      'utf8',
    );
    const cache = createClaudeSubagentUsageCache();
    const first = readClaudeSubagentUsage({ configHome, sessionId: 's-25', subagentIds: ['task-1'], cache });
    expect(first.turns).toBe(1);
    expect(fsSpies.openSync).toHaveBeenCalledTimes(1);
    // 「CLI 又写了一行」
    appendFileSync(
      file,
      `\n${JSON.stringify(assistant('m-2', { input_tokens: 3, cache_read_input_tokens: 0, output_tokens: 4 }))}`,
      'utf8',
    );
    // 第二次读：必须重新读盘拿到全量（旧版本上那份「只有一轮」绝不许被复用）
    const second = readClaudeSubagentUsage({ configHome, sessionId: 's-25', subagentIds: ['task-1'], cache });
    expect(second.turns).toBe(2);
    expect(second.usage).toMatchObject({ input: 8, output: 5 });
    expect(fsSpies.openSync).toHaveBeenCalledTimes(2);
  });

  /**
   * **会话目录整行只解析一次**（用户点名的「不要多次重复读取」）。
   *
   * 真机形状：收尾为「每个子智能体的最终用量」那一个循环里**每个**子会话都调一次
   * `readClaudeSubagentFile`（`index.ts` 的 `finalSubagents()`），而它每次都从 `<configHome>/projects`
   * 重新枚举一遍项目目录、再逐个项目 `readdirSync` 试一次 ⇒ O(子会话数 × 项目目录数) 次目录遍历，
   * 而这两个输入在一行里是固定的。判据取「`<projects>` 被枚举了几次」：共用一个缓存时必须是 **1**。
   *
   * ⚠️ 判据只数 `projects` 那一层（不看候选目录那几次 `readdirSync`）：那才是随子会话数线性增长的部分。
   * ⚠️ 两条前提钉缺一不可：每一次都必须**真读到**（否则「只枚举一次」可能只是「压根没找」）、
   * 枚举动作必须真的发生过（否则一条 `readdirSync` 都没调的实现会以 0 次通过）。
   */
  it('会话目录整行只解析一次：3 个子会话共用缓存 ⇒ `<projects>` 只枚举一次', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-dir-'));
    for (const taskId of ['task-1', 'task-2', 'task-3']) {
      writeAgentFile(configHome, 's-31', taskId, [
        assistant(`m-${taskId}`, { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 }),
      ]);
    }
    // 再多一个项目目录（真机形状：同一个 `configHome` 下多个项目）：它不含这个会话 ⇒ 遍历必须走完才命中
    mkdirSync(join(configHome, 'projects', 'D---other-proj'), { recursive: true });
    const cache = createClaudeSubagentUsageCache();
    fsSpies.readdirSync.mockClear();
    for (const taskId of ['task-1', 'task-2', 'task-3']) {
      const read = readClaudeSubagentFile({ configHome, sessionId: 's-31', taskId, cache });
      // 前提钉：每一次都真的读到了（`null` 会让下面那条计数变成「没找」而不是「复用」）
      expect(read?.turns).toBe(1);
    }
    const projectScans = fsSpies.readdirSync.mock.calls.filter((call) => String(call[0]).endsWith('projects'));
    expect(projectScans).toHaveLength(1);
    // 前提钉：枚举动作真的发生过（不是「一条 readdirSync 都没调」这种假绿）
    expect(fsSpies.readdirSync.mock.calls.length).toBeGreaterThan(1);
  });
});

/**
 * ⚠️ **「逐行读取」那一层的守卫在共用模块的用例里**：
 * 分块读与跨块多字节还原现在住在 `packages/server/agents/src/read-lines.ts`（今天只有 claude
 * 这条读盘路径用它；codex 自 app-server 改造后只走协议取数）⇒ 守卫跟着实现走，见 `src/read-lines.test.ts`。
 */

/**
 * **IO 失败不进缓存**。
 *
 * 缺陷形状：`statSync` 成功而 `openSync` / `readSync` 抛（瞬时占用 / 权限 / 磁盘错）时，旧实现把
 * `streamUsage` 吞回来的 `null` **写进了缓存** ⇒ 对一份**已经写完**（size / mtimeMs 不再变）的转录，
 * 收尾那次「必须真读」直接命中这条失败：行级分量整格 `null` + 点名 WARN，而按上一段的口径
 * 「收尾仍要真读」，这一次本该读得到。同一个 catch 还把 `consume` 里
 * 任何意外异常（编程错）也降级成「读不出」并被缓存。
 *
 * 判据：第一次 `openSync` 抛、第二次成功（**同一版本**，文件一个字没改）⇒ 第二次必须读到真实的
 * `turns` / `usage`。把 IO 失败写进缓存，这条当场红（第二次返回那条 `null`，`openSync` 也只有 1 次）。
 */
describe('IO 失败不进缓存（审查 Important B）', () => {
  beforeEach(() => {
    fsSpies.readFileSync.mockClear();
    fsSpies.openSync.mockClear();
    fsSpies.readSync.mockClear();
    fsSpies.closeSync.mockClear();
    fsSpies.readdirSync.mockClear();
  });

  it('第一次 openSync 抛、第二次真读：失败没有被固化（收尾那次「必须真读」必须读得到）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-io-'));
    writeAgentFile(configHome, 's-30', 'task-1', [
      assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }),
    ]);
    const cache = createClaudeSubagentUsageCache();
    // 真机可达的形状：`statSync` 成功（文件在、版本取得到）而 `openSync` 抛
    fsSpies.openSync.mockImplementationOnce(() => {
      throw new Error('EIO: openSync 失败（模拟瞬时读不动）');
    });
    const failed = readClaudeSubagentFile({ configHome, sessionId: 's-30', taskId: 'task-1', cache });
    // 这一次就是读不出来：如实说「没采到」（调用方走 `missing` + 点名 WARN）
    expect(failed).toBeNull();
    // 第二次：**同一版本**（size / mtimeMs 一个字没变）也必须重新去 open —— 这正是「不进缓存」的判据
    const second = readClaudeSubagentFile({ configHome, sessionId: 's-30', taskId: 'task-1', cache });
    expect(fsSpies.openSync).toHaveBeenCalledTimes(2);
    expect(second?.turns).toBe(1);
    expect(second?.usage).toEqual({ input: 10, cached: 0, output: 1, reasoningOutput: null, total: null });
    // 另一半不变式照旧：**内容决定的结论**（这一次是真读到的）该缓存就缓存 ⇒ 第三次不再读盘
    const third = readClaudeSubagentUsage({ configHome, sessionId: 's-30', subagentIds: ['task-1'], cache });
    expect(fsSpies.openSync).toHaveBeenCalledTimes(2);
    expect(third.turns).toBe(1);
  });
});
