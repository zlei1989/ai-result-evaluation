// @vitest-environment node
/**
 * 人工消息的传输面：快照、发送（幂等）、改期、撤回（kind → HTTP）、附件落盘。
 *
 * 三条口径决定了本文件怎么搭：
 *   1. **队列表与运行快照都用真的**（不 mock `@aieval/evaluator`）——「幂等」「撤回分派」「改期单向」
 *      这些结论的正确性一半在表里，用一份假表断言等于把要测的东西换成自己的假设。快照真落盘
 *      （`saveRun` 写进临时工作区根），撤回那条路顺带把行级事件也真的写出来（它按 `run.json`
 *      解析这一轮的根，假的快照会让它报一条 ERROR——那种噪声会盖住真的问题）。
 *   2. **附件落到真实磁盘**（临时目录）：判据是「盘上真的只多出这一个文件、内容逐字节相等」，
 *      而不是「返回值看起来对」。`run.workspaceBase` 特地与本机设置的根**不一样**，
 *      用来钉住「附件根按这一轮自己记录的根解析」。
 *   3. **`consumed` / `unsupported` / `unknown` 走纯映射函数断言**：它们今天造不出来
 *      （要厂商侧先吃掉、或要适配器交回那两档），而「什么都没改变就不许回 200」这条恰恰是
 *      最需要被钉住的——三种失败各自的状态码与文案在 `retractHttpResult` 上一次断言干净。
 *      「这三种**不改表里的状态**」那一半归 `@aieval/evaluator` 的用例（表在那里）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ServiceError,
  type EvalRun,
} from '@aieval/contracts';
import { setCasesRootForTesting, setConfigDirForTesting } from '@aieval/core';
import {
  listInjectMessages as listQueueEntries,
  resetInjectQueueForTesting,
  saveRun,
  type InjectQueueEntry,
  type InjectRetractResult,
} from '@aieval/evaluator';
import {
  assertUploadContentLength,
  getInjectMessages,
  promoteInjectMessage,
  retractHttpResult,
  retractInjectMessage,
  saveInjectAttachment,
  sendInjectMessage,
} from './inject-messages';
import { updateSettings } from './settings';
import { fixtureWorkspaceRoot, makeRow, makeRun } from './testing/run-fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-inject-messages-'));
  setConfigDirForTesting(dir);
  // 用例目录也要指到临时目录：用例是一文件一落（core 的 `case-store`），config 的 override 管不到它
  setCasesRootForTesting(join(dir, 'cases'));
  // 快照读侧只扫**当前设置里的根**（`getRun` 的口径），故它必须与夹具那棵树的根对上
  updateSettings({ workspaceRoot: fixtureWorkspaceRoot() });
  // 队列表挂在 `globalThis` 的总线上，跨用例、跨文件存活：不清的话上一条用例的条目会让快照多一条，
  // 上一条登记过的 `messageId` 会让下一条同名登记变成幂等命中
  resetInjectQueueForTesting();
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

/** 造一轮单行评测：**真落盘**（撤回那条路要按 run.json 解析这一轮的根），并返回它 */
function seedRun(overrides: Partial<EvalRun> = {}): EvalRun {
  const run = makeRun({ rows: [makeRow()], ...overrides });
  saveRun(run);
  return run;
}

/** 一条合法的登记请求 */
function send(text = '先跑一遍测试', messageId = 'm-1') {
  return { runId: 'run-1', rowId: 'r-1', messageId, text, attachments: [], requires: 'idle' as const };
}

/**
 * 跑一段**本该抛错**的代码，把那个 `ServiceError` 取回来。
 * 比 `toThrow(objectContaining(...))` 好读：状态码与文案是两件要分开断言的事，
 * 而匹配器那一路会把被匹配的错误对象顺手打成一段噪声日志（看起来像产品在报错）。
 */
function serviceErrorOf(run: () => unknown): ServiceError {
  try {
    run();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error('这一段本该抛错，却正常返回了');
}

describe('快照（GET 的读侧）', () => {
  it('没有消息时给空数组（不是 404、也不是 null）', () => {
    seedRun();
    expect(getInjectMessages('run-1', 'r-1')).toEqual([]);
  });

  it('按登记顺序给全，并带上四态与两档要求', () => {
    seedRun();
    sendInjectMessage(send('第一句', 'm-1'));
    sendInjectMessage({ ...send('第二句', 'm-2'), requires: 'round' });

    const snapshot = getInjectMessages('run-1', 'r-1');

    expect(snapshot.map((entry) => [entry.text, entry.requires, entry.state])).toEqual([
      ['第一句', 'idle', 'queued'],
      ['第二句', 'round', 'queued'],
    ]);
  });

  it('终态也在快照里：`gone` 那一条带着收场原因回来（界面要说得出「它为什么消失」）', async () => {
    seedRun();
    sendInjectMessage(send());
    await retractInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-1' });

    const [entry] = getInjectMessages('run-1', 'r-1');

    expect(entry).toMatchObject({ messageId: 'm-1', state: 'gone', outcome: 'retracted' });
  });

  it('轮或行不存在 ⇒ NOT_FOUND（不校验的话，拼错的 rowId 会得到一个「空队列」的假象）', () => {
    seedRun();
    expect(() => getInjectMessages('run-never', 'r-1')).toThrow(ServiceError);
    expect(() => getInjectMessages('run-1', 'r-never')).toThrow(/没有这一行/);
  });
});

describe('发送与幂等（messageId 是幂等键）', () => {
  it('首次登记：created: true，表里那一条与请求逐格对上', () => {
    seedRun();
    const accepted = sendInjectMessage(send());

    expect(accepted.created).toBe(true);
    expect(accepted.message).toMatchObject({ messageId: 'm-1', text: '先跑一遍测试', requires: 'idle', state: 'queued' });
    expect(listQueueEntries('run-1', 'r-1')).toHaveLength(1);
  });

  it('同一 messageId 再发一次 ⇒ 200 + 同一条：不新增、**也不改写**已经登记的内容', () => {
    seedRun();
    sendInjectMessage(send('原始那句'));

    const again = sendInjectMessage(send('改过的另一句'));

    expect(again.created).toBe(false);
    expect(again.message.text).toBe('原始那句');
    expect(listQueueEntries('run-1', 'r-1')).toHaveLength(1);
  });

  it('行不存在 ⇒ NOT_FOUND，且表里一条都不留（不建永远等不到取件的悬挂条目）', () => {
    seedRun();
    expect(() => sendInjectMessage({ ...send(), rowId: 'r-never' })).toThrow(/没有这一行/);
    expect(listQueueEntries('run-1', 'r-never')).toEqual([]);
  });

  it('附件清单原样进表（正文与清单一起构成一条消息）', () => {
    seedRun();
    const attachments = [{ kind: 'image' as const, path: '/tmp/a.png', mimeType: 'image/png' }];

    const accepted = sendInjectMessage({ ...send(), attachments, text: '' });

    expect(accepted.message.attachments).toEqual(attachments);
  });
});

describe('改期（「立即发送」单向）', () => {
  it('排队 → 立即：promoted，且表里的 requires 真的变了', () => {
    seedRun();
    sendInjectMessage(send());

    const accepted = promoteInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-1' });

    expect(accepted).toMatchObject({ outcome: 'promoted', message: { requires: 'round' } });
    expect(listQueueEntries('run-1', 'r-1')[0]?.requires).toBe('round');
  });

  it('再点一次 ⇒ already-round（重复点同一颗按钮的幂等答复，不是 409）', () => {
    seedRun();
    sendInjectMessage({ ...send(), requires: 'round' });

    expect(promoteInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-1' }).outcome).toBe('already-round');
  });

  it('已经交出去（或已被撤回）的那一条改不了 ⇒ CONFLICT（边界已经用掉了）', async () => {
    seedRun();
    sendInjectMessage(send());
    await retractInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-1' });

    expect(serviceErrorOf(() => promoteInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-1' })).code).toBe('CONFLICT');
  });

  it('没有这个 messageId ⇒ NOT_FOUND', () => {
    seedRun();
    expect(() => promoteInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-never' })).toThrow(/没有这条人工消息/);
  });
});

describe('撤回（kind → HTTP）', () => {
  /** 造一条表里那种形状的条目（纯映射函数的入参；三格时刻与四态各取一个真实组合） */
  function entry(overrides: Partial<InjectQueueEntry> = {}): InjectQueueEntry {
    return {
      messageId: 'm-1',
      text: 'x',
      attachments: [],
      requires: 'idle',
      state: 'delivered',
      createdAt: '2026-09-22T10:30:00.000Z',
      deliveredAt: '2026-09-22T10:31:00.000Z',
      settledAt: null,
      outcome: null,
      reason: null,
      ...overrides,
    };
  }

  it('还没投出去的那一条：removed（我们自己手里，不问厂商）', async () => {
    seedRun();
    sendInjectMessage(send());

    const accepted = await retractInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-1' });

    expect(accepted.outcome).toBe('removed');
    expect(listQueueEntries('run-1', 'r-1')[0]).toMatchObject({ state: 'gone', outcome: 'retracted' });
  });

  it('重复撤回 ⇒ already-retracted（`gone` 留在表里正是为了这个：不是 404——那会让客户端以为它从没存在过）', async () => {
    seedRun();
    sendInjectMessage(send());
    await retractInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-1' });

    const again = await retractInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-1' });

    expect(again.outcome).toBe('already-retracted');
  });

  it('表里没有这个 id ⇒ 404', async () => {
    seedRun();
    await expect(retractInjectMessage({ runId: 'run-1', rowId: 'r-1', messageId: 'm-never' })).rejects.toThrow(/没有这条人工消息/);
  });

  it('三个成功结局都在 200 的那份形状里', () => {
    const removed: InjectRetractResult = { kind: 'removed', entry: entry({ state: 'gone', outcome: 'retracted' }) };
    const retracted: InjectRetractResult = { kind: 'retracted', entry: entry({ state: 'gone', outcome: 'retracted' }) };
    const gone: InjectRetractResult = { kind: 'gone', entry: entry({ state: 'gone', outcome: 'retracted' }) };

    expect(retractHttpResult(removed, 'm-1').outcome).toBe('removed');
    expect(retractHttpResult(retracted, 'm-1').outcome).toBe('retracted');
    expect(retractHttpResult(gone, 'm-1').outcome).toBe('already-retracted');
  });

  it('已经被模型吃掉 ⇒ 409 + 表里那句原因（原因缺省时给一句兜底，不许静默成功）', () => {
    const consumed = (reason: string | null): InjectRetractResult => ({
      kind: 'consumed',
      entry: entry({ state: 'consumed', outcome: 'already-consumed', reason }),
    });

    const fromEntry = serviceErrorOf(() => retractHttpResult(consumed('这一条已经交给智能体了，撤不回来'), 'm-1'));
    expect([fromEntry.code, fromEntry.message]).toEqual(['CONFLICT', '这一条已经交给智能体了，撤不回来']);
    expect(serviceErrorOf(() => retractHttpResult(consumed(null), 'm-1')).message).toContain('撤不回来');
  });

  it('厂商说不支持 / 说不清 ⇒ 409，且两句话不同（都是「什么都没改变」，但不许回 200）', () => {
    const unsupported: InjectRetractResult = { kind: 'unsupported', entry: entry() };
    const unknown: InjectRetractResult = { kind: 'unknown', entry: entry() };

    const unsupportedError = serviceErrorOf(() => retractHttpResult(unsupported, 'm-1'));
    const unknownError = serviceErrorOf(() => retractHttpResult(unknown, 'm-1'));

    expect(unsupportedError.code).toBe('CONFLICT');
    expect(unknownError.code).toBe('CONFLICT');
    expect(unsupportedError.message).not.toBe(unknownError.message);
  });
});

describe('附件落盘', () => {
  /**
   * 一条合法的上传入参（字节默认给三个）。
   * ⚠️ 每个用例必须给**自己的 `messageId`**：`run.workspaceBase` 来自夹具模块（一份，跨用例复用），
   * 于是同一个 `<messageId>` 目录会在用例之间残留——上一条用例传过的文件会让下一条的条数上限
   * 提前触顶（表现成一条与被测行为无关的红）。
   */
  function upload(overrides: Partial<Parameters<typeof saveInjectAttachment>[0]> = {}) {
    return {
      runId: 'run-1',
      rowId: 'r-1',
      messageId: 'm-1',
      fileName: 'a.png',
      mimeType: 'image/png',
      bytes: new TextEncoder().encode('png-body'),
      ...overrides,
    };
  }

  it('落到这一行的附件根下，返回绝对路径 + 分档 + 类型；内容逐字节相等', () => {
    const run = seedRun();
    const attachment = saveInjectAttachment(upload());

    const expectedDir = join(run.workspaceBase, 'run-1', 'rows', 'r-1', 'attachments', 'm-1');
    expect(attachment).toEqual({ kind: 'image', path: join(expectedDir, 'a.png'), mimeType: 'image/png' });
    expect(readFileSync(attachment.path!, 'utf8')).toBe('png-body');
    expect(readdirSync(expectedDir)).toEqual(['a.png']);
  });

  it('附件落在**工作区之外**（不进 git diff、不污染评分面），但仍在行目录之内（随删轮次一起清）', () => {
    const run = seedRun();
    const workspacePath = run.rows[0]?.workspacePath ?? '';

    const attachment = saveInjectAttachment(upload({ messageId: 'm-outside' }));

    expect(workspacePath).not.toBe('');
    expect(attachment.path?.startsWith(workspacePath)).toBe(false);
    expect(attachment.path).toBe(join(run.workspaceBase, 'run-1', 'rows', 'r-1', 'attachments', 'm-outside', 'a.png'));
  });

  it('非图片按 file 分档；浏览器说不出类型时 mimeType 落 null（空串会被界面当成一个空白标签）', () => {
    seedRun();

    expect(saveInjectAttachment(upload({ messageId: 'm-kind', fileName: 'notes.txt', mimeType: 'text/plain' }))).toMatchObject({
      kind: 'file',
      mimeType: 'text/plain',
    });
    expect(saveInjectAttachment(upload({ messageId: 'm-kind', fileName: 'unknown.bin', mimeType: '' }))).toMatchObject({
      kind: 'file',
      mimeType: null,
    });
  });

  it(`单个附件超过 ${ATTACHMENT_MAX_FILE_BYTES} 字节 ⇒ 400，原因点名两条数字，且盘上一个字节都不落`, () => {
    const run = seedRun();
    const oversizeDir = join(run.workspaceBase, 'run-1', 'rows', 'r-1', 'attachments', 'm-oversize');
    // 25 MB：故意比上限大一截，好让「上限」与「这次的大小」是两句不同的数字
    const bytes = new Uint8Array(ATTACHMENT_MAX_FILE_BYTES + 5 * 1024 * 1024);

    const error = serviceErrorOf(() => saveInjectAttachment(upload({ messageId: 'm-oversize', bytes })));

    expect(error.code).toBe('INVALID_QUERY');
    // 两句数字都在：上限说得出是多少、用户才知道「换一份多小的」
    expect(error.message).toContain('单个附件不能超过 20.0 MB');
    expect(error.message).toContain('这个是 25.0 MB');
    expect(existsSync(oversizeDir)).toBe(false);
  });

  it(`第 ${ATTACHMENT_MAX_PER_MESSAGE + 1} 个附件 ⇒ 400，原因点名条数上限（用户才知道要删几个）`, () => {
    seedRun();
    for (let n = 0; n < ATTACHMENT_MAX_PER_MESSAGE; n += 1) {
      saveInjectAttachment(upload({ messageId: 'm-count', fileName: `a-${String(n)}.txt`, mimeType: 'text/plain' }));
    }

    expect(serviceErrorOf(() => saveInjectAttachment(upload({ messageId: 'm-count', fileName: 'overflow.txt', mimeType: 'text/plain' }))).message)
      .toContain(`单条消息最多 ${String(ATTACHMENT_MAX_PER_MESSAGE)} 个附件`);
    // 上限触顶时那一个不该落盘：目录里正好 10 个
    expect(readdirSync(join(fixtureWorkspaceRoot(), 'run-1', 'rows', 'r-1', 'attachments', 'm-count'))).toHaveLength(
      ATTACHMENT_MAX_PER_MESSAGE,
    );
  });

  it('messageId 形状不合法 ⇒ 400（它会被拼进目录名：`..` 必须在这道门就断）', () => {
    seedRun();
    expect(serviceErrorOf(() => saveInjectAttachment(upload({ messageId: '..' }))).message).toContain('消息 id 不合法');
  });

  it('轮或行不存在 ⇒ NOT_FOUND，且磁盘上不建任何目录', () => {
    const run = seedRun();

    expect(serviceErrorOf(() => saveInjectAttachment(upload({ rowId: 'r-never' }))).code).toBe('NOT_FOUND');
    expect(existsSync(join(run.workspaceBase, 'run-1', 'rows', 'r-never'))).toBe(false);
  });
});

describe('上传请求体的粗筛（在读进内存之前）', () => {
  it('声明长度在「单文件上限 + 余量」之内就放行（含缺席与脏值：粗筛不是安全边界）', () => {
    const limit = ATTACHMENT_MAX_FILE_BYTES;
    expect(() => assertUploadContentLength(String(limit))).not.toThrow();
    expect(() => assertUploadContentLength(String(limit + 1024))).not.toThrow();
    expect(() => assertUploadContentLength(null)).not.toThrow();
    expect(() => assertUploadContentLength('not-a-number')).not.toThrow();
  });

  it('声明长度明显超标 ⇒ 400，文案说明这次正文有多大（20 MB 是业务上限，不是内存上限）', () => {
    const error = serviceErrorOf(() => assertUploadContentLength(String(30 * 1024 * 1024)));

    expect(error.code).toBe('INVALID_QUERY');
    expect(error.message).toContain('单个附件不能超过 20.0 MB');
    expect(error.message).toContain('30.0 MB');
  });
});
