// @vitest-environment node
/**
 * `client.ts` 的行为契约。
 *
 * 用**注入的假子进程**测：不 spawn 真进程、不依赖网络——本文件的每一条都是「协议帧怎么进怎么出」
 * 的判据。真机联通性由 `threads.test.ts` 的录播 fixture 与探针命令覆盖，不在这里做。
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createAppServerClient,
  type AppServerChild,
  type AppServerNotification,
  type AppServerSpawn,
} from './client';

/**
 * 假子进程：只实现 `AppServerChild` 那几个成员，够测协议行为与回收行为。
 * 导出给 `../index.test.ts` 的那条**接线**用例（它要拿真客户端 + 假子进程验「回帧真的写进 stdin」）。
 */
export class FakeChild implements AppServerChild {
  readonly written: string[] = [];
  killed = false;
  /** 假 pid：回收时按它走「整棵树」那条路（真实进程树由 `process-tree.test.ts` 与真机探针覆盖） */
  readonly pid = 4242;
  /** 读侧设过的编码（`client.ts` 必须设 utf8，见 `AppServerChild.stdout`） */
  stdoutEncoding: string | null = null;
  stderrEncoding: string | null = null;
  /** 写侧要抛的错（模拟对端已死：`EPIPE` / `ERR_STREAM_DESTROYED`） */
  writeError: Error | null = null;
  private dataListeners: Array<(chunk: Buffer | string) => void> = [];
  private stderrListeners: Array<(chunk: Buffer | string) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private closeListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private stdinErrorListeners: Array<(error: Error) => void> = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      if (this.writeError !== null) throw this.writeError;
      this.written.push(chunk);
      return true;
    },
    on: (_event: 'error', listener: (error: Error) => void): void => {
      this.stdinErrorListeners.push(listener);
    },
  };
  readonly stdout = {
    on: (_event: 'data', listener: (chunk: Buffer | string) => void): void => {
      this.dataListeners.push(listener);
    },
    setEncoding: (encoding: 'utf8'): void => {
      this.stdoutEncoding = encoding;
    },
  };
  readonly stderr = {
    on: (_event: 'data', listener: (chunk: Buffer | string) => void): void => {
      this.stderrListeners.push(listener);
    },
    setEncoding: (encoding: 'utf8'): void => {
      this.stderrEncoding = encoding;
    },
  };
  on(
    event: 'exit' | 'close' | 'error',
    listener: ((code: number | null, signal: string | null) => void) | ((error: Error) => void),
  ): void {
    if (event === 'exit') this.exitListeners.push(listener as (code: number | null, signal: string | null) => void);
    else if (event === 'close') this.closeListeners.push(listener as (code: number | null, signal: string | null) => void);
    else this.errorListeners.push(listener as (error: Error) => void);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** 按行投递（可以一次投多条，验证分帧） */
  emit(...messages: unknown[]): void {
    const text = messages.map((one) => JSON.stringify(one)).join('\n') + '\n';
    for (const listener of this.dataListeners) listener(text);
  }
  emitRaw(text: string): void {
    for (const listener of this.dataListeners) listener(text);
  }
  emitStderr(text: string): void {
    for (const listener of this.stderrListeners) listener(text);
  }
  /**
   * 进程收场：**先 `exit` 再 `close`**，与真实 `ChildProcess` 同序。
   * 两个事件分工在 `client.ts`（结算挂 `close`，`exit` 只记码）；假件把顺序照搬过来，
   * 免得用例在一个真机不存在的中间态上立判据。
   */
  exit(code: number | null): void {
    for (const listener of this.exitListeners) listener(code, null);
    for (const listener of this.closeListeners) listener(code, null);
  }
  /** 只发 `exit`、不发 `close`（真机上「进程没了但 stdout 还没读完」的那一瞬） */
  exitWithoutClose(code: number | null): void {
    for (const listener of this.exitListeners) listener(code, null);
  }
  /** 只发 `close`（接在 `exitWithoutClose` 后面用） */
  closeStdio(code: number | null): void {
    for (const listener of this.closeListeners) listener(code, null);
  }
  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
  /** 触发 stdin 的异步错误（真机是 `EPIPE`）：没人监听它就是未捕获异常 */
  failStdin(error: Error): void {
    for (const listener of this.stdinErrorListeners) listener(error);
  }
  /**
   * stdin 上挂了几个 `'error'` 监听。
   *
   * 判据取**个数**而不是「触发一下看抛不抛」：没有监听者时遍历空表同样不抛，
   * 那条断言在缺陷造回去之后照旧是绿的（而真机上那一刻宿主进程已经没了）。
   */
  get stdinErrorListenerCount(): number {
    return this.stdinErrorListeners.length;
  }
}

function harness(timeoutMs = 5_000) {
  const child = new FakeChild();
  const spawnFn: AppServerSpawn = vi.fn(() => child);
  /** 杀树动作的替身：记下被回收的 pid，不真的去 taskkill */
  const killedTrees: number[] = [];
  const killTree = (pid: number): Promise<void> => {
    killedTrees.push(pid);
    return Promise.resolve();
  };
  const client = createAppServerClient({ binary: 'C:/fake/codex.exe', env: {}, spawnFn, timeoutMs, killTree, terminateGraceMs: 100 });
  const frames = (): Array<Record<string, unknown>> => child.written.map((one) => JSON.parse(one) as Record<string, unknown>);
  return { child, spawnFn, client, frames, killedTrees };
}

describe('createAppServerClient —— 帧与配对', () => {
  it('initialize 声明 experimentalApi:true（parentThreadId 等实验字段的前提）', async () => {
    const { client, frames, child } = harness();
    const pending = client.initialize();
    const [frame] = frames();
    expect(frame?.method).toBe('initialize');
    const params = frame?.params as { clientInfo?: { name?: string }; capabilities?: { experimentalApi?: boolean } };
    expect(typeof params.clientInfo?.name).toBe('string');
    expect(params.capabilities?.experimentalApi).toBe(true);
    child.emit({ jsonrpc: '2.0', id: 1, result: { userAgent: 'x' } });
    await expect(pending).resolves.toBeUndefined();
  });

  it('响应按 id 配对，乱序到达不影响', async () => {
    const { client, child } = harness();
    const first = client.request<string>('thread/list', { limit: 1 });
    const second = client.request<string>('thread/read', { threadId: 't' });
    child.emit({ jsonrpc: '2.0', id: 2, result: 'B' }, { jsonrpc: '2.0', id: 1, result: 'A' });
    await expect(first).resolves.toBe('A');
    await expect(second).resolves.toBe('B');
  });

  it('错误响应按 id 拒绝，且带上 code 与 message', async () => {
    const { client, child } = harness();
    const pending = client.request('thread/list', {});
    child.emit({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'invalid parent thread id' } });
    await expect(pending).rejects.toThrow(/invalid parent thread id/);
  });

  it('无 id 的报文进 notifications，且不解决任何待收请求', async () => {
    const { client, child } = harness();
    const pending = client.request('thread/list', {});
    child.emit(
      { jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'child' } } },
      { jsonrpc: '2.0', method: 'item/completed', params: {} },
    );
    expect(client.notifications().map((one: AppServerNotification) => one.method)).toEqual([
      'thread/started',
      'item/completed',
    ]);
    let settled = false;
    void pending.then(() => (settled = true), () => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit({ jsonrpc: '2.0', id: 1, result: null });
    await expect(pending).resolves.toBeNull();
  });

  it('服务端主动请求（带 id 但不在待收表）单独归类，且没挂应答者时不应答', async () => {
    const { client, child, frames } = harness();
    child.emit({ jsonrpc: '2.0', id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } });
    expect(client.serverRequests().map((one) => one.method)).toEqual(['item/commandExecution/requestApproval']);
    expect(frames()).toHaveLength(0);
  });

  /**
   * 应答者那条通道的三条：什么进应答者、什么写回 stdin、什么**不写**。
   *
   * `null` 与「回一帧空结果」是两件事，正是审批类与问答类的分界线：前者是「本类请求本仓不应答」
   * （评测非交互，回帧等于替用户批准），后者是「应答了但没有人给答案」。
   */
  it('服务端主动请求 → 应答者拿得到原始帧；给结果就写回同一 id 的结果帧', async () => {
    const child = new FakeChild();
    const spawnFn: AppServerSpawn = vi.fn(() => child);
    const seen: Array<{ id: number | string; method: string; params: unknown }> = [];
    const client = createAppServerClient({
      binary: 'C:/fake/codex.exe',
      env: {},
      spawnFn,
      onServerRequest: (request) => {
        seen.push(request);
        return Promise.resolve({ answers: { q1: { answers: ['选项 A'] } } });
      },
    });
    child.emit({ jsonrpc: '2.0', id: 7, method: 'item/tool/requestUserInput', params: { itemId: 'call_1' } });
    await vi.waitFor(() => {
      expect(child.written).toHaveLength(1);
    });
    expect(seen).toEqual([{ id: 7, method: 'item/tool/requestUserInput', params: { itemId: 'call_1' } }]);
    expect(JSON.parse(child.written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { answers: { q1: { answers: ['选项 A'] } } },
    });
    // 归类照旧（服务端请求那一格不因应答者而变）
    expect(client.serverRequests().map((one) => one.id)).toEqual([7]);
  });

  it('应答者返回 `null` ⇒ 一个字都不写回（审批类走这一支）', async () => {
    const child = new FakeChild();
    const spawnFn: AppServerSpawn = vi.fn(() => child);
    const client = createAppServerClient({
      binary: 'C:/fake/codex.exe',
      env: {},
      spawnFn,
      onServerRequest: () => Promise.resolve(null),
    });
    child.emit({ jsonrpc: '2.0', id: 8, method: 'item/commandExecution/requestApproval', params: {} });
    // 让应答者的微任务跑完再判「没写」：直接断言会与「还没轮到它」混淆
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(child.written).toHaveLength(0);
    expect(client.serverRequests().map((one) => one.method)).toEqual(['item/commandExecution/requestApproval']);
  });

  it('应答者抛错 ⇒ 回一帧空结果（厂商在等这一帧，让它等下去比回空的更坏）', async () => {
    const child = new FakeChild();
    const spawnFn: AppServerSpawn = vi.fn(() => child);
    const client = createAppServerClient({
      binary: 'C:/fake/codex.exe',
      env: {},
      spawnFn,
      onServerRequest: () => Promise.reject(new Error('端口炸了')),
    });
    child.emit({ jsonrpc: '2.0', id: 9, method: 'item/tool/requestUserInput', params: { itemId: 'call_1' } });
    await vi.waitFor(() => {
      expect(child.written).toHaveLength(1);
    });
    expect(JSON.parse(child.written[0] ?? '')).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
  });

  it('一次投递多行时不丢帧（粘包）', async () => {
    const { client, child } = harness();
    const pending = client.request<number>('thread/list', {});
    child.emit({ jsonrpc: '2.0', method: 'thread/started', params: {} }, { jsonrpc: '2.0', id: 1, result: 42 });
    await expect(pending).resolves.toBe(42);
    expect(client.notifications()).toHaveLength(1);
  });

  it('半行先到不解析，补齐后才成帧', async () => {
    const { client, child } = harness();
    const pending = client.request<string>('thread/list', {});
    child.emitRaw('{"jsonrpc":"2.0","id":1,"res');
    child.emitRaw('ult":"ok"}\n');
    await expect(pending).resolves.toBe('ok');
  });

  it('子进程退出 ⇒ 所有待收请求以明确错误拒绝（不悬挂），含 code 与 stderr', async () => {
    const { client, child } = harness();
    const pending = client.request('thread/list', {});
    child.emitStderr('boom from codex');
    child.exit(3);
    await expect(pending).rejects.toThrow(/退出/);
    await expect(pending).rejects.toThrow(/3/);
    const after = client.request('thread/list', {});
    await expect(after).rejects.toThrow(/退出/);
  });

  it('spawn 失败（ENOENT）⇒ 请求立即拒绝并带上原因', async () => {
    const child = new FakeChild();
    const client = createAppServerClient({
      binary: 'C:/nope/codex.exe',
      env: {},
      spawnFn: () => child,
      timeoutMs: 5_000,
    });
    const pending = client.request('thread/list', {});
    child.fail(new Error('spawn ENOENT'));
    await expect(pending).rejects.toThrow(/ENOENT/);
  });

  it('超时按「方法名 + 毫秒」拒绝，不留悬挂', async () => {
    const child = new FakeChild();
    const client = createAppServerClient({ binary: 'x', env: {}, spawnFn: () => child, timeoutMs: 20 });
    await expect(client.request('thread/items/list', {})).rejects.toThrow(/thread\/items\/list/);
  });

  it('close 之后请求立即拒绝，且**整棵进程树**被回收', async () => {
    const { client, child, killedTrees } = harness();
    await client.close();
    // 判据是「按 pid 走了杀树那条路」，不是「调过 child.kill()」——后者正是那个 EPERM 的成因
    expect(killedTrees).toEqual([child.pid]);
    await expect(client.request('thread/list', {})).rejects.toThrow(/已关闭/);
  });

  it('close 会等子进程真的退出，而不是发完信号就返回', async () => {
    const { client, child } = harness();
    let closed = false;
    const closing = client.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    // 还没 emit exit：close 必须仍挂在那里（否则下一轮的行产物清理会与句柄释放赛跑）
    expect(closed).toBe(false);
    child.exit(0);
    await closing;
    expect(closed).toBe(true);
  });

  it('close 幂等：重复调用只回收一次（dispose 与「起手失败」两条路会各调一次）', async () => {
    const { client, killedTrees } = harness();
    await Promise.all([client.close(), client.close()]);
    await client.close();
    expect(killedTrees).toHaveLength(1);
  });

  it('子进程在宽限期内不退出 ⇒ close 仍然返回（不悬挂），只是如实记 WARN', async () => {
    const { client, killedTrees } = harness();
    // 不 emit exit：`terminateGraceMs: 100` 到点就放行
    await expect(client.close()).resolves.toBeUndefined();
    expect(killedTrees).toHaveLength(1);
  });
});

/**
 * 管道两端的三个不变量（`client.ts` 文件头第五条）。
 *
 * 这一组的判据刻意分两种：**解码那条用真实 Node 流**（假件模拟不了 `StringDecoder` 的跨 chunk
 * 行为，照着模拟等于在测试里重写一遍 Node，验出来的是我们自己的实现），其余两条在假件上立。
 */
describe('createAppServerClient —— 管道两端的不变量', () => {
  /**
   * **真实 stdout 管道**：`PassThrough` 就是 `ChildProcess.stdout` 的同族（都是 `Readable`），
   * `setEncoding` 在它上面的行为就是生产行为 ⇒ 这一条用例能证明的事情，真机上同样成立。
   */
  class RealPipeChild implements AppServerChild {
    readonly written: string[] = [];
    readonly pid = 4343;
    readonly stdoutPipe = new PassThrough();
    readonly stderrPipe = new PassThrough();
    readonly stdin = {
      write: (chunk: string): boolean => {
        this.written.push(chunk);
        return true;
      },
      on: (): void => undefined,
    };
    get stdout(): AppServerChild['stdout'] {
      return this.stdoutPipe as unknown as AppServerChild['stdout'];
    }
    get stderr(): AppServerChild['stderr'] {
      return this.stderrPipe as unknown as AppServerChild['stderr'];
    }
    on(): void {
      return undefined;
    }
    kill(): boolean {
      return true;
    }
  }

  it('跨 chunk 的多字节字符不被切坏（读侧必须 setEncoding）', async () => {
    const child = new RealPipeChild();
    const client = createAppServerClient({ binary: 'x', env: {}, spawnFn: () => child, timeoutMs: 5_000 });
    const pending = client.request<{ text: string }>('thread/read', {});

    /**
     * 把一帧按**字节**切成两半，切点落在汉字中间——真机上这正是「单条通知大于管道一次读上限」
     * 时发生的事（`aggregatedOutput`、长 `agentMessage`、中文 `reasoning.content` 都是常客）。
     */
    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: '中文内容要完整' } })}\n`, 'utf8');
    const cut = frame.indexOf(Buffer.from('文', 'utf8')) + 1;
    child.stdoutPipe.write(frame.subarray(0, cut));
    child.stdoutPipe.write(frame.subarray(cut));

    // 判据是**正文逐字相同**：不设编码时这里会是「中<replacement>…」，而 JSON.parse 照旧成功（静默）
    await expect(pending).resolves.toEqual({ text: '中文内容要完整' });
  });

  it('读侧与错误侧都接上了：stdout/stderr 设了 utf8，stdin 的异步错误有人听（否则打崩宿主）', () => {
    const { child } = harness();
    expect(child.stdoutEncoding).toBe('utf8');
    expect(child.stderrEncoding).toBe('utf8');
    // 判据是「有监听者」：空表遍历同样不抛，拿 `not.toThrow()` 立判据等于没立
    expect(child.stdinErrorListenerCount).toBeGreaterThan(0);
    expect(() => child.failStdin(new Error('EPIPE'))).not.toThrow();
  });

  it('写帧失败（对端已死）⇒ 该请求立刻拒绝，不白等一个超时', async () => {
    const child = new FakeChild();
    const client = createAppServerClient({ binary: 'x', env: {}, spawnFn: () => child, timeoutMs: 60_000 });
    child.writeError = new Error('write EPIPE');
    // 判据是「立刻」：超时设成 60 s，靠超时兜住的话这条用例会先被 vitest 掐掉
    await expect(client.request('thread/list', {})).rejects.toThrow(/没能写出去/);
  });

  it('结算挂 `close` 而不是 `exit`：进程写完响应就退出时，那一次请求仍然成功', async () => {
    const { client, child } = harness();
    const pending = client.request<string>('thread/read', {});
    /**
     * 真机顺序：进程 `exit` 之后 stdout 里**还有**没被读完的数据，`close` 才是 stdio 收口。
     * 挂在 `exit` 上结算会把这一帧还没来得及读的响应拒成「进程已退出」。
     */
    child.exitWithoutClose(0);
    child.emit({ jsonrpc: '2.0', id: 1, result: 'ok' });
    child.closeStdio(0);
    await expect(pending).resolves.toBe('ok');
  });

  it('close 那一刻把 stdout 的残留尾行也过一遍（上游没以换行收尾）', async () => {
    const { client, child } = harness();
    const pending = client.request<string>('thread/read', {});
    child.emitRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'tail' })}`);
    child.exit(0);
    await expect(pending).resolves.toBe('tail');
  });
});

describe('createAppServerClient —— 报文方向只看有没有 method', () => {
  it('服务端请求的 id 撞上我们在飞的 id，仍按服务端请求处置（不被当成响应吃掉）', async () => {
    const child = new FakeChild();
    const asked: string[] = [];
    const client = createAppServerClient({
      binary: 'x',
      env: {},
      spawnFn: () => child,
      timeoutMs: 50,
      onServerRequest: async (request) => {
        asked.push(request.method);
        return { answers: {} };
      },
    });
    // 我们的第一条请求用 id=1；厂商的服务端请求也用 id=1（两个方向的 id 空间互不相干）
    const pending = client.request('thread/start', {});
    /**
     * 先把拒绝的 handler 挂上再去等回帧：`timeoutMs` 只有 50ms，而下面的 `waitFor` 可能跑得更久
     * ⇒ 晚挂 handler 会让这条 promise 在无人接管的窗口里 reject，vitest 记成未捕获 rejection，
     * 而那会**污染同一个 worker 里其它用例的判定**（它自己的提示里就写着 false positive）。
     */
    const settled = expect(pending).rejects.toThrow(/超时/);
    child.emit({ jsonrpc: '2.0', id: 1, method: 'item/tool/requestUserInput', params: { itemId: 'i1', questions: [] } });
    await vi.waitFor(() => {
      expect(child.written.length).toBeGreaterThan(1);
    });
    // 归类面与回帧都按「服务端请求」走
    expect(asked).toEqual(['item/tool/requestUserInput']);
    expect(client.serverRequests().map((one) => one.method)).toEqual(['item/tool/requestUserInput']);
    // 而我们那条请求**没有**被它顶替结算（照旧走自己的超时）
    await settled;
  });

  it('认不出归属的响应（超时后迟到的那一条）不进服务端请求归类面', async () => {
    const child = new FakeChild();
    const client = createAppServerClient({ binary: 'x', env: {}, spawnFn: () => child, timeoutMs: 20 });
    await expect(client.request('thread/list', {})).rejects.toThrow(/超时/);
    // 迟到的响应：没有 `method` ⇒ 既不该被当成服务端请求，也不该让谁结算
    child.emit({ jsonrpc: '2.0', id: 1, result: 'late' });
    expect(client.serverRequests()).toHaveLength(0);
  });

  it('坏帧既进计数也落日志（静默跳过会让「上游换了帧格式」查无实据）', () => {
    const { client, child } = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      child.emitRaw('这不是 JSON\n');
      expect(client.unparsedFrames()).toBe(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * **合法 JSON 但不是帧**的那些行：不许崩、要进坏帧计数、后面的帧照常。
   *
   * 要拦的缺陷：`JSON.parse('null')` 是**合法 JSON**，而 `null.id` 会抛
   * `TypeError: Cannot read properties of null (reading 'id')`——这一行是从 socket 的 `data`
   * 处理器里跑出来的，抛出去就是**未捕获异常**（Node 的默认处置是打印后 `process.exit(1)`），
   * 带走整个宿主进程（本仓是 Next 服务）。数字 / 字符串不抛，但会一路滑到「认不出归属」那一支
   * ⇒ `unparsedFrames()` 少算它们，计数就不再是「坏帧数」。
   *
   * 真机读数：真 codex 上百帧一次没发过这种行 ⇒ 触发条件未观测到；但**判据在我们这一侧**——
   * 喂进去会不会崩与厂商发不发得出来是两个问题，前者必须为否。
   */
  it('合法 JSON 但不是对象的行（null / 数字 / 字符串）⇒ 不抛、计数、后面的帧照常', async () => {
    const { client, child } = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    /** 处理器抛错时 vitest 会把它报成未处理错误；这里显式收下来，好让断言说的是「抛没抛」 */
    const uncaught: string[] = [];
    const onUncaught = (error: Error): void => {
      uncaught.push(`${error.name}: ${error.message}`);
    };
    process.on('uncaughtException', onUncaught);
    try {
      child.emitRaw('null\n');
      child.emitRaw('123\n');
      child.emitRaw('"x"\n');
      expect(uncaught, '这些行一行都不许抛未捕获异常（宿主进程会因此退出）').toEqual([]);
      expect(client.unparsedFrames(), '三行都要计入坏帧').toBe(3);
      // 后面的真帧照常配对：坏行不该污染请求-响应这条线
      const pending = client.request('thread/list', {});
      child.emitRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`);
      await expect(pending).resolves.toEqual({ ok: true });
    } finally {
      process.off('uncaughtException', onUncaught);
      warn.mockRestore();
    }
  });
});
