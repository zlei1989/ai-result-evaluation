// @vitest-environment node
/**
 * stream-tap 的单元判据（机制见 `stream-tap.ts` 的文件头）：
 *  ① 插件源码的形状——订阅对的进程内事件、按 `DSH_HOME` 定位旁路文件、任何失败都吞掉
 *    （它在厂商进程里跑，观测手段没有资格制造失败）；
 *  ② gate 的三件事：渐进读行（半截行留到下次）、块位次换算（首见顺序发号，对齐快照侧
 *    `content[]` 位次）、会话门闸（未知会话挂起、登记之后放行）；
 *  ③ 伪通知的形状——`method: session.event` + `type: aieval/delta`，供 `events.ts` 分流。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DSH_STREAM_DELTA_TYPE } from './protocol';
import {
  createDshStreamTapGate,
  DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH,
  DSH_STREAM_TAP_PLUGIN_SOURCE,
  DSH_STREAM_TAP_RELATIVE_PATH,
} from './stream-tap';

/** 造一条旁路行（与插件落盘的形状逐字一致：`{ sid, frame }`） */
const tapLine = (
  chunkType: string,
  extra: Record<string, unknown>,
  input: { sid?: string; attemptId?: string; blockIndex?: number; turn?: number; step?: number } = {},
): string =>
  JSON.stringify({
    sid: input.sid ?? 'session-main',
    frame: {
      type: 'chunk',
      attemptId: input.attemptId ?? 'att-1',
      revision: 1,
      index: 0,
      time: 1234,
      turn: input.turn ?? 1,
      step: input.step ?? 1,
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
     * **落在 configHome 根下**（2026-10-10 实测修正）：overlay 的 `name: "./aieval-stream-tap.mjs"`
     * 由运行时按 `dshHome` 解析。曾经写在 `profiles/sdk/` 里 ⇒ 插件从未加载、旁路文件恒 0 字节，
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

  it('伪通知形状：method/type 对得上 events.ts 的分流键，载荷带 turn/step/位置', () => {
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
            data: { turn: 1, step: 1, delta: { kind: 'text', text: '第一段', position: 0 } },
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
});
