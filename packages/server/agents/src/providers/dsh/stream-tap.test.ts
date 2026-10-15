// @vitest-environment node
/**
 * stream-tap 的单元判据（机制见 `stream-tap.ts` 的文件头）：
 *  ① 插件源码的形状——订阅对的进程内事件、按 `DSH_HOME` 定位旁路文件、任何失败都吞掉
 *    （它在厂商进程里跑，观测手段没有资格制造失败）；
 *  ② gate 的三件事：渐进读行（半截行留到下次）、块位次换算（首见顺序发号，对齐快照侧
 *    `content[]` 位次）、会话门闸（未知会话挂起、登记之后放行）；
 *  ③ 伪通知的形状——`method: session.event` + `type: aieval/delta`，供 `events.ts` 分流。
 */
import { appendFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DSH_STREAM_DELTA_TYPE } from './protocol';
import {
  createDshStreamTapGate,
  DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH,
  DSH_STREAM_TAP_PLUGIN_SOURCE,
  DSH_STREAM_TAP_RELATIVE_PATH,
} from './stream-tap';

/** 旁路文件的原文；还没被创建时给空串（「一次都没写」与「写了空」在判据上同义） */
function tapFileText(home: string): string {
  try {
    return readFileSync(join(home, DSH_STREAM_TAP_RELATIVE_PATH), 'utf8');
  } catch {
    return '';
  }
}

/** 造一条旁路行（与插件落盘的形状逐字一致：`{ sid, frame }`） */
/**
 * 造一条旁路行，**形状与真机逐字一致**：`frame` 只有 `{type:'chunk', attemptId, revision, index,
 * time, chunk}`——厂商的 `AssistantStreamFrame` 里 `turn` / `step` 只属于 `start` 变体。
 * 夹具若替厂商补上这两格，就会把「增量帧拿不到轮次号」这条事实掩盖掉。
 */
const tapLine = (
  chunkType: string,
  extra: Record<string, unknown>,
  input: { sid?: string; attemptId?: string; blockIndex?: number; frameTurn?: unknown; frameStep?: unknown } = {},
): string =>
  JSON.stringify({
    sid: input.sid ?? 'session-main',
    frame: {
      type: 'chunk',
      attemptId: input.attemptId ?? 'att-1',
      revision: 1,
      index: 0,
      time: 1234,
      // 真机 chunk 帧没有这两格；`frameTurn` / `frameStep` 只为「厂商将来补上它们」的变体用例而留
      ...(input.frameTurn === undefined ? {} : { turn: input.frameTurn }),
      ...(input.frameStep === undefined ? {} : { step: input.frameStep }),
      chunk: { type: chunkType, index: input.blockIndex ?? 0, ...extra },
    },
  });

/** 从伪通知里取 delta 的 position（params 是宽松记录，读侧逐格收窄） */
const positionOf = (one: { params: Record<string, unknown> }): unknown =>
  (one.params.event as { data?: { delta?: { position?: unknown } } } | undefined)?.data?.delta?.position;

describe('DSH_STREAM_TAP_PLUGIN_SOURCE（插件源码形状）', () => {
  it('订阅进程内逐字流事件，并按 DSH_HOME 定位旁路文件（两边与适配器逐字一致）', () => {
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).toContain('ctx.on(\'agent/assistant-stream\'');
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).toContain('join(home, \'aieval-stream-tap.jsonl\')');
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).toContain('process.env.DSH_HOME');
    // 落点常量与插件源码必须指同一个文件名——两处各写一份，漂移的症状是「插件在写、适配器在读另一个文件」
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).toContain(DSH_STREAM_TAP_RELATIVE_PATH);
    // 插件本体落 profile 目录（overlay 的相对名按它解析）
    /**
     * **落在 configHome 根下**（实测修正）：overlay 的 `name: "./aieval-stream-tap.mjs"`
     * 由运行时按 `dshHome` 解析。写在 `profiles/sdk/` 里 ⇒ 插件从未加载、旁路文件恒 0 字节，
     * 而 stderr 只留一句 `1 entry did not activate`（探针 `probe/v3/dsh-tap-truncation.mjs` 变体 B 实证）。
     */
    expect(DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH).toBe('aieval-stream-tap.mjs');
  });

  it('只落四类 chunk、且任何失败都吞掉（观测手段绝不打断被测运行）', () => {
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).toContain('block-start');
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).toContain('text-delta');
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).toContain('reasoning-delta');
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).toContain('block-end');
    // try/catch 全包 + catch 里不 rethrow——源码级断言（单测原理上复现不了厂商进程内的抛错路径）
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).toMatch(/catch\s*\{/);
    expect(DSH_STREAM_TAP_PLUGIN_SOURCE).not.toMatch(/catch\s*\{[\s\S]*?throw/);
  });
});

describe('createDshStreamTapGate（tail 与门闸）', () => {
  const known = new Set(['session-main']);

  it('渐进读行：新行按落盘顺序出、半截行留到下次补齐', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-tap-'));
    const file = join(dir, DSH_STREAM_TAP_RELATIVE_PATH);
    const gate = createDshStreamTapGate(file);
    try {
      expect(gate.drain(known)).toEqual([]);
      writeFileSync(file, `${tapLine('block-start', { blockType: 'text' })}\n${tapLine('text-delta', { text: '你好' })}\n`, 'utf8');
      const out = gate.drain(known);
      expect(out).toHaveLength(1); // block-start 只占位不产消息
      // 半截行：没有结尾换行的那段必须留到下次（读盘只能到「写完整行」为止）
      writeFileSync(file, tapLine('text-delta', { text: '，世界' }), { flag: 'a', encoding: 'utf8' });
      expect(gate.drain(known)).toEqual([]);
      writeFileSync(file, '\n', { flag: 'a', encoding: 'utf8' });
      expect(gate.drain(known)).toHaveLength(1);
    } finally {
      gate.close();
    }
  });

  it('伪通知形状：method/type 对得上 events.ts 的分流键，载荷带位置（轮次两格恒 null）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-tap-'));
    const file = join(dir, DSH_STREAM_TAP_RELATIVE_PATH);
    const gate = createDshStreamTapGate(file);
    try {
      writeFileSync(file, `${tapLine('text-delta', { text: '第一段' })}\n`, 'utf8');
      const [one] = gate.drain(known);
      expect(one).toMatchObject({
        method: 'session.event',
        params: {
          sessionId: 'session-main',
          event: {
            type: DSH_STREAM_DELTA_TYPE,
            time: 1234,
            // 真机 chunk 帧上没有 turn/step ⇒ 这两格恒 null，归属由下游按会话步数回落
            data: { turn: null, step: null, delta: { kind: 'text', text: '第一段', position: 0 } },
          },
        },
      });
    } finally {
      gate.close();
    }
  });

  it('块位次换算：首见顺序发号（tool-call 的 block-start 占位），对齐快照侧 content[] 位次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-tap-'));
    const file = join(dir, DSH_STREAM_TAP_RELATIVE_PATH);
    const gate = createDshStreamTapGate(file);
    try {
      // 流序：reasoning(0) → text(1) → tool-call(2)，与厂商 BlockAssembler.order 同一算法
      const lines = [
        tapLine('block-start', { blockType: 'reasoning' }),
        tapLine('reasoning-delta', { text: '想' }),
        tapLine('block-start', { blockType: 'text' }, { blockIndex: 1 }),
        tapLine('text-delta', { text: '说' }, { blockIndex: 1 }),
        tapLine('block-start', { blockType: 'tool-call' }, { blockIndex: 2 }),
        tapLine('text-delta', { text: '完' }, { blockIndex: 1 }),
      ];
      writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
      const out = gate.drain(known);
      expect(out.map(positionOf)).toEqual([0, 1, 1]);
    } finally {
      gate.close();
    }
  });

  it('两次尝试（llm/retry）的流序号各自从 0 起：attemptId 隔离位次表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-tap-'));
    const file = join(dir, DSH_STREAM_TAP_RELATIVE_PATH);
    const gate = createDshStreamTapGate(file);
    try {
      const lines = [
        tapLine('text-delta', { text: '失败那次' }),
        tapLine('text-delta', { text: '重试这次' }, { attemptId: 'att-2' }),
      ];
      writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
      const out = gate.drain(known);
      // 两次尝试的第 0 块各占位次 0（重试不复用失败那次的表）
      expect(out.map(positionOf)).toEqual([0, 0]);
    } finally {
      gate.close();
    }
  });

  it('会话门闸：未知会话挂起，登记之后放行（子会话增量不得误归主会话载体）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-tap-'));
    const file = join(dir, DSH_STREAM_TAP_RELATIVE_PATH);
    const gate = createDshStreamTapGate(file);
    try {
      writeFileSync(
        file,
        [tapLine('text-delta', { text: '子会话的话' }, { sid: 'session-child' }), tapLine('text-delta', { text: '主会话' })].join('\n') + '\n',
        'utf8',
      );
      const first = gate.drain(known);
      // 主会话的行放行、子会话的行挂住（subagent.started 还没投影）
      expect(first.map((one) => one.params.sessionId)).toEqual(['session-main']);
      // 「登记」= knownSessions 里出现子会话 id（notificationStream 在放行 subagent.started 之后）
      const afterRegister = gate.drain(new Set(['session-main', 'session-child']));
      expect(afterRegister.map((one) => one.params.sessionId)).toEqual(['session-child']);
    } finally {
      gate.close();
    }
  });

  /**
   * **轮次两格恒 `null`**，哪怕帧上真的带了它们：厂商的 `AssistantStreamFrame` 里 `turn`/`step`
   * 只属于 `start` 变体，`chunk` 变体没有；适配器**刻意不从这里取**（归属由会话步数回落给出，
   * 与快照同源 ⇒ 两条落进同一载体）。这条断言的价值在于：它把「实现又去帧上硬读这两格」
   * 这个动作钉住——帧上恰好没有时硬读也得到 `null`，只有带值的变体才能把它验出来。
   */
  it('帧上即便带 turn/step 也不采信（归属由会话步数回落）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-tap-'));
    const file = join(dir, DSH_STREAM_TAP_RELATIVE_PATH);
    writeFileSync(file, `${tapLine('text-delta', { text: '好' }, { frameTurn: 7, frameStep: 9 })}\n`, 'utf8');
    const gate = createDshStreamTapGate(file);
    try {
      const [one] = gate.drain(known);
      const data = (one?.params.event as { data?: { turn?: unknown; step?: unknown } } | undefined)?.data;
      expect(data?.turn).toBeNull();
      expect(data?.step).toBeNull();
    } finally {
      gate.close();
    }
  });

  it('坏行跳过、文件不存在视为空、close 幂等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-tap-'));
    const file = join(dir, DSH_STREAM_TAP_RELATIVE_PATH);
    const gate = createDshStreamTapGate(join(dir, 'not-yet.jsonl'));
    expect(gate.drain(known)).toEqual([]); // 文件还没被插件建出来
    const gate2 = createDshStreamTapGate(file);
    writeFileSync(file, '{这不是 JSON\n' + tapLine('text-delta', { text: '好行' }) + '\n', 'utf8');
    expect(gate2.drain(known)).toHaveLength(1); // 坏行只跳过它自己
    gate2.close();
    gate2.close(); // 幂等
    gate.close();
  });

  /**
   * **整份重写必须被认出来**，而不只是「变短」那一种。
   *
   * 判据是「正常追加必然让长度增加」：长度没长而文件被动过（`mtimeMs` 变了）就只可能是重写。
   * 只看 `size < offset` 的实现会把**等长替换**与**加长重写**整段静默吞掉——
   * 症状是「旁路文件在长、界面一条增量都没有」，而任何日志里都没有线索。
   */
  it('旁路文件被整份重写（等长 / 加长 / 截短）都从头跟，不静默吞新行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-tap-'));
    const rewrite = (name: string, before: string, after: string): string[] => {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, `${tapLine('text-delta', { text: before })}\n`, 'utf8');
      const gate = createDshStreamTapGate(file);
      try {
        expect(gate.drain(known)).toHaveLength(1);
        // 重写：整份覆盖（长度可能一样、可能更长）；mtime 显式往前推，避开同毫秒的抖动
        writeFileSync(file, `${tapLine('text-delta', { text: after })}\n`, 'utf8');
        const later = new Date(Date.now() + 5);
        utimesSync(file, later, later);
        return gate.drain(known).map((one) => {
          const data = (one.params.event as { data?: { delta?: { text?: string } } }).data;
          return String(data?.delta?.text ?? '');
        });
      } finally {
        gate.close();
      }
    };
    expect(rewrite('equal-length', 'AAAAA', 'BBBBB')).toEqual(['BBBBB']);
    expect(rewrite('longer', 'AA', 'CCCCCCCCCC')).toEqual(['CCCCCCCCCC']);
    expect(rewrite('shorter', 'AAAAAAAAAA', 'S')).toEqual(['S']);
  });

  /**
   * `close()` 的语义是「**松开句柄 + 忘掉挂起的行**」，**不是**「关掉这条通道」。
   *
   * 为什么这条守卫是承重的：门闸**跨活动区间复用**（首轮与每一次追问共用一个实例），
   * 而每个区间的流收尾都会调一次 `close()` ⇒ 若在 `close()` 里立一个「已关闭」标志、
   * 让 `drain()` 之后恒返回空，追问区间里子智能体继续说话的那一段就整段消失（零报错）。
   * 真机症状：修正轮之后子会话的增量一条都没有，而 `messages.jsonl` 里也看不出少了什么。
   */
  it('close() 之后仍能接着读（跨区间复用）：偏移不重置、句柄可重开，只有挂起的行被丢弃', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-tap-'));
    const file = join(dir, DSH_STREAM_TAP_RELATIVE_PATH);
    writeFileSync(file, `${tapLine('text-delta', { text: '第一段' })}\n`, 'utf8');
    const gate = createDshStreamTapGate(file);
    // 第一条属于**未知**会话 ⇒ 被挂起；close() 之后它必须被丢掉（不再补投）
    expect(gate.drain(new Set(['other-session']))).toEqual([]);
    gate.close();
    // 区间 1 收尾之后区间 2 继续追加 ⇒ 新行照旧要被读出来（这是追问区间的路径）
    appendFileSync(file, `${tapLine('text-delta', { text: '第二段' })}\n`, 'utf8');
    const after = gate.drain(known);
    expect(after.map((one) => (one.params.event as { data?: { delta?: { text?: string } } }).data?.delta?.text)).toEqual([
      '第二段',
    ]);
    gate.close();
    gate.close(); // 幂等
  });
});

/**
 * **插件本体要真的被执行一次**，不能只断言源码文本里有几个字符串。
 *
 * 为什么这条必须存在：能力位声明 `streamingDelta: 'yes'` + `source: 'hook'`，而它的**唯一**数据源
 * 就是这支插件——它把厂商进程内的逐字流旁路到 `<DSH_HOME>/aieval-stream-tap.jsonl`。
 * 插件的失效模式是**全静默**的：落点写错、事件名写错、`chunk` 形状变了，症状都只是
 * 「旁路文件恒 0 字节、界面一条增量都没有、零报错」（真机上发生过一次：插件写在 `profiles/sdk/`，
 * 运行时按 `dshHome` 解析相对名 ⇒ 从未加载）。文本断言对这类漂移没有区分力。
 *
 * 做法：把源码当**真模块**落盘再 `import()`（它只依赖 `node:` 内建），喂一个假 `ctx` 收下它注册的
 * 处理器，再按真机帧形状调一次，判据取**磁盘上的那一行**。
 */
describe('DSH_STREAM_TAP_PLUGIN_SOURCE：插件本体跑一次（判据取落盘的那一行）', () => {
  const originalHome = process.env.DSH_HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
  });

  /** 落盘 → 动态 import → 用假 ctx 应用一次，返回它注册的处理器 */
  async function applyPlugin(home: string): Promise<(payload: unknown) => void> {
    const pluginPath = join(home, DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH);
    writeFileSync(pluginPath, DSH_STREAM_TAP_PLUGIN_SOURCE, 'utf8');
    process.env.DSH_HOME = home;
    const loaded = (await import(/* @vite-ignore */ pathToFileURL(pluginPath).href)) as {
      default: (ctx: unknown) => void;
    };
    let handler: ((payload: unknown) => void) | null = null;
    loaded.default({
      on: (event: string, one: (payload: unknown) => void) => {
        if (event === 'agent/assistant-stream') handler = one;
      },
    });
    expect(handler, '插件必须订阅 agent/assistant-stream（换事件名 = 增量一条都拿不到）').not.toBeNull();
    return handler as unknown as (payload: unknown) => void;
  }

  const frameOf = (chunk: Record<string, unknown>): unknown => ({
    agent: { session: { id: 'session-child-1' } },
    frame: { type: 'chunk', attemptId: 'att-1', revision: 1, index: 0, time: 7, turn: 1, step: 2, chunk },
  });

  it('一条 text-delta ⇒ 旁路文件里出现一行 `{ sid, frame }`（sid 取会话 id）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-tap-plugin-'));
    const handler = await applyPlugin(home);

    handler(frameOf({ type: 'text-delta', index: 0, text: '你好' }));

    const lines = readFileSync(join(home, DSH_STREAM_TAP_RELATIVE_PATH), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0] ?? '{}') as { sid?: unknown; frame?: { chunk?: { text?: unknown } } };
    expect(row.sid).toBe('session-child-1');
    expect(row.frame?.chunk?.text).toBe('你好');
  });

  it('不认识的帧、非 chunk 帧、拿不到会话 id 的帧、非对象载荷 ⇒ 一行都不落', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-tap-plugin-'));
    const handler = await applyPlugin(home);

    handler(frameOf({ type: 'tool-call-delta', index: 0 }));
    handler({ agent: { session: { id: 'session-child-1' } }, frame: { type: 'not-a-chunk' } });
    handler({ agent: { session: null }, frame: { type: 'chunk', attemptId: 'att-1', chunk: { type: 'text-delta', index: 0, text: 'x' } } });
    // 非对象载荷在**参数位**解构就会抛到厂商读循环里（本插件的第一条不变量：任何失败都吞掉）
    handler(null);

    // 文件可能还没被创建（一次都没写）或存在但为空，两种都算「什么都没落」
    expect(tapFileText(home).trim()).toBe('');
  });

  /**
   * **块边界帧必须落**：父进程的 `positionOf` 靠它们给块占一个 content 位次
   * （tool-call 块可能只有 start/end、没有任何增量）。插件只写增量的话，块位次与
   * `assistant/message` 快照的 `content[]` 位次会错开——实时视图与快照落进两个槽位。
   */
  it('block-start / block-end 也落盘（位次换算的唯一依据）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-tap-plugin-'));
    const handler = await applyPlugin(home);

    handler(frameOf({ type: 'block-start', index: 0, blockType: 'text' }));
    handler(frameOf({ type: 'block-end', index: 0 }));

    const rows = tapFileText(home).trim().split('\n').map((line) => JSON.parse(line) as { frame?: { chunk?: { type?: unknown } } });
    expect(rows.map((row) => row.frame?.chunk?.type)).toEqual(['block-start', 'block-end']);
  });

  it('`DSH_HOME` 缺失时插件直接退出（不抛、不写）——它在厂商进程里跑，观测手段不许制造失败', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-tap-plugin-'));
    const pluginPath = join(home, DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH);
    writeFileSync(pluginPath, DSH_STREAM_TAP_PLUGIN_SOURCE, 'utf8');
    delete process.env.DSH_HOME;
    const loaded = (await import(/* @vite-ignore */ pathToFileURL(pluginPath).href)) as { default: (ctx: unknown) => void };

    let subscribed = false;
    expect(() => {
      loaded.default({
        on: () => {
          subscribed = true;
        },
      });
    }).not.toThrow();
    expect(subscribed).toBe(false);
  });
});
