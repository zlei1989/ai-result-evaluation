// @vitest-environment node
/**
 * `session-log.ts` 的**路径推导**与**多帧解码**守卫。
 *
 * 两条判据分属两类证据，缺一不可：
 *   · 路径片段（`dshProjectKeyOf` / `dshSessionSegmentOf`）的期望值**抄自真机磁盘上的目录名**
 *     （见每条断言上的读数），不是「照着我们自己的实现写一遍」——那种断言对实现的偏差没有区分力；
 *   · 多帧解码用**真实 zstd 压缩出来的样本**（`zstdCompressSync`）——其中一档刻意把魔数字节写进
 *     原文，让压缩产物在**帧内部**出现 `28 B5 2F FD`（不可压缩数据走 raw block，原文照抄）。
 *     这一档是 `decodeFrames` 不能「按魔数硬切」的全部理由：`zstdDecompressSync` 对被截断的帧
 *     **不抛错**（实测切出 0 字节），硬切会静默把整帧内容丢掉。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { countSessionSteps, dshProjectKeyOf, dshSessionSegmentOf } from './session-log';

const zstd = zlib as unknown as {
  zstdCompressSync?: (buffer: Buffer) => Buffer;
  zstdDecompressSync?: (buffer: Buffer) => Buffer;
};
/** `zstd*Sync` 是 Node 22.15+ 才有的入口，本仓类型面没有它（与产品代码同一处运行时探测） */
const HAS_ZSTD = typeof zstd.zstdCompressSync === 'function' && typeof zstd.zstdDecompressSync === 'function';

/** 一帧 = 一批 append 的完整 JSONL 行（厂商每批一帧，帧内容因此必然以换行收尾） */
function frameOf(lines: readonly string[]): Buffer {
  return zstd.zstdCompressSync!(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

/** 会话日志的第一行是 header（无 `type`），后面才是事件 */
const HEADER = JSON.stringify({ id: 'session-fixture', cwd: '/tmp/fixture', seq: 0 });
let stepSeq = 0;
function stepStart(turn: number, step: number): string {
  stepSeq += 1;
  return JSON.stringify({ type: 'step/start', seq: stepSeq, time: 1_700_000_000_000, data: { turn, step } });
}

let root: string;
let configHome: string;

beforeEach(() => {
  stepSeq = 0;
  root = mkdtempSync(join(tmpdir(), 'aieval-session-log-'));
  configHome = join(root, 'home');
  mkdirSync(configHome, { recursive: true });
});

afterEach(() => {
  removeTreeWithRetry(root);
});

/**
 * **厂商规则的独立复刻**（只为铺夹具的目录，不参与产品代码）。
 *
 * 为什么夹具这一侧不能调产品的 `dshProjectKeyOf` / `dshSessionSegmentOf`：那样「写目录」与
 * 「读目录」同源，产品实现整体跑偏时两边一起偏、断言照样绿——守卫对「我们与厂商不一致」这一类
 * 缺陷**没有区分力**（变异实测：把 `dshProjectKeyOf` 还原成旧实现，同源写法那条仍然绿）。
 * 所以判据这一侧按厂商源码（`dsh-session-persistence-jsonl` 的 `projectKey()` / `encodeSegment()`）
 * 各复刻一份，两份实现互为对照。
 */
function vendorProjectKey(cwd: string): string {
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** 厂商的 `encodeSegment()` 复刻（理由同上：夹具侧必须独立于产品实现） */
function vendorSegment(sessionId: string): string {
  if (sessionId === '.') return '~002E';
  if (sessionId === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < sessionId.length; index += 1) {
    const code = sessionId.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** 按**厂商规则**铺一条会话日志；返回它的绝对路径（读那一侧才走产品实现） */
function writeLog(cwd: string, sessionId: string, frames: readonly Buffer[]): string {
  const dir = join(configHome, 'sessions', vendorProjectKey(resolve(cwd)), vendorSegment(sessionId));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(file, Buffer.concat([...frames]));
  return file;
}

/**
 * 一帧**内部含伪魔数**的日志帧。
 *
 * 为什么要造它：压缩产物里出现 `28 B5 2F FD` 时，「按魔数硬切」会把一帧切成两段，而解码器对
 * 截断帧不抛错 ⇒ 那一帧的内容被静默丢掉（实测：硬切到帧内那个伪魔数处解出 0 字节，
 * 这一帧的 `step/start` 一条都数不到）。真实日志里伪魔数是字节巧合（概率随体积上升），
 * 构造样本是唯一能稳定复现它的办法——**必须用随机字节**：可压缩的填充会被压掉，
 * 原文里的魔数字节就不会出现在压缩产物里（试过 `padding-` 那一路，产物里只剩偏移 0 的帧头魔数）。
 */
function frameWithFakeMagic(lines: readonly string[]): Buffer {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  return zstd.zstdCompressSync!(Buffer.concat([
    randomBytes(16),
    magic,
    Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
    randomBytes(64),
    magic,
    randomBytes(64),
    Buffer.from('\n'),
  ]));
}

describe('dsh 会话日志的路径片段', () => {
  it('projectKey：不安全码元走 ~XXXX（真机磁盘读数）', () => {
    // 真机：cwd 尾段是「工作 区 项目」时，`<DSH_HOME>/sessions/` 下的目录名逐字是
    // `--…-~5DE5~4F5C~0020~533A~0020~9879~76EE--`（空格与汉字逐个转义）
    expect(dshProjectKeyOf('/tmp/工作 区 项目')).toBe('--tmp-~5DE5~4F5C~0020~533A~0020~9879~76EE--');
  });

  it('projectKey：连续分隔符折成一个 -、前导 - 掐掉、~ 自己也要转义', () => {
    expect(dshProjectKeyOf('/a//b')).toBe('--a-b--');
    expect(dshProjectKeyOf('//a')).toBe('--a--');
    expect(dshProjectKeyOf('/tmp/~x')).toBe('--tmp-~007Ex--');
    // Windows 形态：盘符与反斜杠都是分隔符
    expect(dshProjectKeyOf('C:\\work\\proj')).toBe('--C-work-proj--');
  });

  it('projectKey：可读部分截到 251（真机磁盘读数）', () => {
    // 真机：可读部分 240 个字符的 cwd 落成 `--…-aaaaaaaa…-bbbb…-cccccccccccccccccccc--`
    // ——尾部被切掉，长度正好是 251；不截断的话目录名会与磁盘对不上
    const key = dshProjectKeyOf(`/${'a'.repeat(120)}/${'b'.repeat(120)}/${'c'.repeat(120)}`);
    expect(key).toBe(`--${'a'.repeat(120)}-${'b'.repeat(120)}-${'c'.repeat(9)}--`);
    // 外层 `--…--` 之外的可读部分正好 251
    expect(key.length - 4).toBe(251);
  });

  it('projectKey：空 cwd 抛错（厂商的 projectKey 也抛）', () => {
    expect(() => dshProjectKeyOf('')).toThrow(/工作目录为空/);
  });

  it('sessionSegment：`.` / `..` 两个特例与 ~XXXX 转义（真机磁盘读数）', () => {
    // 真机：自定义会话 id `probe~会话~id` 落成的目录名逐字是 `probe~007E~4F1A~8BDD~007Eid`
    expect(dshSessionSegmentOf('probe~会话~id')).toBe('probe~007E~4F1A~8BDD~007Eid');
    expect(dshSessionSegmentOf('.')).toBe('~002E');
    expect(dshSessionSegmentOf('..')).toBe('~002E~002E');
    // 安全集里的形状原样保留（适配器铸的 id 走的就是这一档）
    expect(dshSessionSegmentOf('session-0123456789abcdef0123456789abcdef'))
      .toBe('session-0123456789abcdef0123456789abcdef');
    expect(() => dshSessionSegmentOf('')).toThrow(/会话 id 为空/);
  });
});

describe.skipIf(!HAS_ZSTD)('dsh 会话日志的多帧解码', () => {
  const cwd = '/tmp/fixture-workspace';
  const sessionId = 'session-fixture0000000000000000000000';

  it('三帧拼起来的日志：每一帧的 step/start 都数得到', () => {
    writeLog(cwd, sessionId, [
      frameOf([HEADER, stepStart(1, 1)]),
      frameOf([stepStart(1, 2)]),
      frameOf([stepStart(2, 1), stepStart(2, 2)]),
    ]);
    expect(countSessionSteps({ configHome, cwd, sessionId })).toBe(4);
  });

  it('帧内部出现伪魔数时不丢内容（按魔数硬切会整帧丢掉）', () => {
    writeLog(cwd, sessionId, [
      frameWithFakeMagic([HEADER, stepStart(1, 1), stepStart(1, 2)]),
      frameOf([stepStart(2, 1)]),
    ]);
    expect(countSessionSteps({ configHome, cwd, sessionId })).toBe(3);
  });

  it('尾帧半截（厂商正在写）不影响已经写完的那些帧', () => {
    const complete = frameOf([HEADER, stepStart(1, 1), stepStart(1, 2)]);
    const half = frameOf([stepStart(2, 1)]).subarray(0, 8);
    writeLog(cwd, sessionId, [complete, half]);
    expect(countSessionSteps({ configHome, cwd, sessionId })).toBe(2);
  });

  it('路径形状（cwd 含空格与汉字、会话 id 含 ~）也定位得到', () => {
    const awkwardCwd = '/tmp/工作 区';
    const awkwardId = 'probe~会话~id';
    writeLog(awkwardCwd, awkwardId, [frameOf([HEADER, stepStart(1, 1)])]);
    expect(countSessionSteps({ configHome, cwd: awkwardCwd, sessionId: awkwardId })).toBe(1);
    // 带尾随斜杠的 cwd：厂商落盘用的是 `resolve()` 之后的路径，这里必须同构
    expect(countSessionSteps({ configHome, cwd: `${awkwardCwd}/`, sessionId: awkwardId })).toBe(1);
  });

  it('日志不在 / 读不动 ⇒ null（不播种，不抛）', () => {
    expect(countSessionSteps({ configHome, cwd, sessionId })).toBeNull();
    writeFileSync(join(configHome, 'not-a-log.bin'), Buffer.from('no zstd frame here'));
    expect(countSessionSteps({ configHome, cwd, sessionId })).toBeNull();
  });
});
