// @vitest-environment node
/**
 * 事件日志：追加（seq 自动分配）、全量读、按 seq 续订、清空，以及损坏行的容忍。
 * 四条关键守卫：
 *   ① seq 从 1 开始且严格递增——SSE 的 `Last-Event-ID` 续订全靠它，重复或跳号都会丢事件；
 *   ② 坏行（写一半被杀、手工编辑、空行）只跳过该行并 WARN，其余事件必须全部读出来；
 *   ③ `at` 缺省时由写入器补 ISO 8601 时间戳（不要求调用方自己拼）；
 *   ④ **写**进去的事件必须符合契约：读侧的容忍（②）是为了「一行坏不牵连别人」，而写侧容忍的后果
 *      是唯一真相源静默少事件（写成功、读时被 schema 丢掉）——两头都不报，抽屉里凭空少一条。
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { appendEvent, readEvents, readEventsAfter, resetEvents, type PendingAgentEvent } from './event-log';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-events-'));
  file = join(dir, 'events.jsonl');
});

afterEach(() => {
  vi.restoreAllMocks();
  // 重试口径见 `./testing/cleanup`：Windows 上刚关闭的句柄可能还没释放，
  // `force: true` 只吞 ENOENT，EPERM/EBUSY 会让 afterEach 抛错并把用例判红
  removeTreeWithRetry(dir);
});

describe('appendEvent', () => {
  it('seq 从 1 开始、逐条 +1，并在缺省时补 ISO 8601 的 at', () => {
    const first = appendEvent(file, { type: 'log', stream: 'stdout', text: '第一行' });
    const second = appendEvent(file, { type: 'log', stream: 'stderr', text: '第二行' });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(first.type).toBe('log');
  });

  it('调用方给了 at 就用调用方的（适配器可能知道自己事件的时间）', () => {
    const event = appendEvent(file, { type: 'status', status: 'running', at: '2026-09-22T10:30:00.000Z' });
    expect(event.at).toBe('2026-09-22T10:30:00.000Z');
  });

  it('文件是 JSONL：每行一个 JSON，且目标文件不存在时自动建目录', () => {
    const nested = join(dir, 'a', 'b', 'events.jsonl');
    appendEvent(nested, { type: 'status', status: 'preparing' });
    appendEvent(nested, { type: 'status', status: 'running' });
    const lines = readFileSync(nested, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ seq: 1, type: 'status', status: 'preparing' });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ seq: 2, type: 'status', status: 'running' });
  });

  it('seq 接着文件里已有的最大 seq 走（进程重启后继续追加不重号）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ seq: 99, at: 'x', type: 'end', exitReason: 'completed' })}\n`, 'utf8');
    expect(appendEvent(file, { type: 'status', status: 'judged' }).seq).toBe(100);
  });

  it('BOM 开头的日志在追加时也认得已有 seq（R24：否则重号，Last-Event-ID 续订会丢事件）', () => {
    // 外部工具（PowerShell 5.1 的 Set-Content / Out-File）会在文件开头留下 U+FEFF。
    // 若发号路径不剥 BOM：首行 JSON.parse 失败且被静默跳过 → max 退回 0 → 新事件拿到 seq 1，
    // 与文件里已有的事件重号；客户端拿 `Last-Event-ID: 1` 重连时，新事件会被前端去重悄悄丢掉。
    appendEvent(file, { type: 'status', status: 'running' });
    writeFileSync(file, `\uFEFF${readFileSync(file, 'utf8')}`, 'utf8');
    expect(appendEvent(file, { type: 'status', status: 'judged' }).seq).toBe(2);
  });

  it('非正整数 seq 不参与发号（否则之后每条事件都是非整数、被 schema 丢掉，日志静默停止记录）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    // 手改出来的 1.5：合法 JSON，但 seq 不是正整数（契约是 z.number().int().positive()）
    appendFileSync(file, `${JSON.stringify({ seq: 1.5, at: 'x', type: 'end', exitReason: 'completed' })}\n`, 'utf8');
    const next = appendEvent(file, { type: 'status', status: 'running' });
    expect(Number.isInteger(next.seq)).toBe(true);
    expect(next.seq).toBe(2);
    // 写下去的事件必须还能被读出来：seq 若是 2.5，readEvents 的 schema 校验会把它整条丢掉
    expect(readEvents(file).map((event) => event.seq)).toEqual([1, 2]);
  });

  it('usage 与 score 这类负载对象原样落盘（不丢字段）', () => {
    appendEvent(file, { type: 'usage', tokens: { input: 10, cached: 2, output: 3 }, turns: 4 });
    const [event] = readEvents(file);
    expect(event).toMatchObject({ type: 'usage', tokens: { input: 10, cached: 2, output: 3 }, turns: 4 });
  });

  it('缺必填字段的事件被拒绝：抛中文 ServiceError，且**什么都不写**（唯一真相源不能静默少一条）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    let caught: unknown;
    try {
      // 模拟 p3/p4 的形状漂移：类型与契约不同步时，运行时送进来的就是这样一条缺 text 的 log 事件。
      // 没有写侧校验的话它会被写进文件，而 readEvents 的 schema 过滤会把它**静默丢掉**——
      // 写成功、读不到，抽屉 / `/log` / SSE 回放里这条事件凭空消失，且两端都不报错。
      appendEvent(file, { type: 'log', stream: 'stdout' } as unknown as PendingAgentEvent);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    // 用户文案是中文，并点名出问题的字段（zod 的 issue path）——只说「写事件失败」等于没说
    expect((caught as Error).message).toContain('字段');
    expect((caught as Error).message).toContain('text');
    // 什么都没写：文件里仍只有 seq 1 那条，下一次追加接着 seq 2 走
    expect(readFileSync(file, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    expect(readEvents(file).map((event) => event.seq)).toEqual([1]);
    expect(appendEvent(file, { type: 'status', status: 'running' }).seq).toBe(2);
  });

  it('类型对但运行时非法的载荷（NaN）也被拒绝：JSON.stringify 会把它改写成 null，读侧同样整条丢掉', () => {
    let caught: unknown;
    try {
      // NaN 过得了 TS 的类型检查（就是 number），却过不了契约的 z.number()；
      // 而 JSON.stringify({ input: NaN }) 落盘成 {"input":null}，readEvents 的 schema 会整条丢掉——
      // 这是「写成功、读不到」的另一条成因，同样只能靠写侧拦住
      appendEvent(file, { type: 'usage', tokens: { input: Number.NaN, cached: 0, output: 0 }, turns: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as Error).message).toContain('tokens.input');
    expect(readEvents(file)).toEqual([]);
  });
});

describe('readEvents', () => {
  it('文件不存在返回空数组（抽屉首帧在还没跑过的行上也要能开）', () => {
    expect(readEvents(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('跳过空行、坏 JSON 行与不符合 schema 的行，其余全部读出并 WARN（Review Focus 3）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appendEvent(file, { type: 'status', status: 'running' });
    // ① 写了一半的 JSON（进程被杀在写盘中途）
    appendFileSync(file, '{"seq":2,"at":"2026-09-22T10:30:00.000Z","type":"lo\n', 'utf8');
    // ② 空行
    appendFileSync(file, '\n', 'utf8');
    // ③ 合法 JSON 但不符合事件 schema（缺 text）
    appendFileSync(file, `${JSON.stringify({ seq: 3, at: 'x', type: 'log', stream: 'stdout' })}\n`, 'utf8');
    appendEvent(file, { type: 'end', exitReason: 'completed' });

    const events = readEvents(file);
    expect(events.map((event) => event.type)).toEqual(['status', 'end']);
    expect(events.map((event) => event.seq)).toEqual([1, 4]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('容忍文件开头的 UTF-8 BOM（外部工具编辑过日志文件）', () => {
    appendEvent(file, { type: 'status', status: 'running' });
    writeFileSync(file, `\uFEFF${readFileSync(file, 'utf8')}`, 'utf8');
    expect(readEvents(file)).toHaveLength(1);
  });

  it('返回的顺序就是落盘顺序（seq 升序，不重排）', () => {
    for (const status of ['pending', 'preparing', 'running'] as const) {
      appendEvent(file, { type: 'status', status });
    }
    expect(readEvents(file).map((event) => event.seq)).toEqual([1, 2, 3]);
  });
});

describe('readEventsAfter', () => {
  it('只返回 seq > afterSeq 的部分（SSE 的 Last-Event-ID 续订语义）', () => {
    for (const status of ['pending', 'preparing', 'running', 'judging'] as const) {
      appendEvent(file, { type: 'status', status });
    }
    expect(readEventsAfter(file, 2).map((event) => event.seq)).toEqual([3, 4]);
  });

  it('afterSeq 为 0 时返回全部（首次连接）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    expect(readEventsAfter(file, 0)).toHaveLength(1);
  });

  it('afterSeq 超过最大 seq 时返回空数组（不是抛错，也不是全量重发）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    expect(readEventsAfter(file, 999)).toEqual([]);
  });
});

describe('resetEvents', () => {
  it('清空后再追加从 seq 1 重新开始（重跑同一行前调用）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    appendEvent(file, { type: 'status', status: 'running' });
    resetEvents(file);
    expect(readEvents(file)).toEqual([]);
    expect(appendEvent(file, { type: 'status', status: 'preparing' }).seq).toBe(1);
  });

  it('文件本来就不存在时不抛错', () => {
    expect(() => resetEvents(join(dir, 'absent.jsonl'))).not.toThrow();
  });
});
