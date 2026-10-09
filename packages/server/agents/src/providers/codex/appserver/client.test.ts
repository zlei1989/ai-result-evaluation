// @vitest-environment node
/**
 * `client.ts` 的行为契约。
 *
 * 用**注入的假子进程**测：不 spawn 真进程、不依赖网络——本文件的每一条都是「协议帧怎么进怎么出」
 * 的判据。真机联通性由 `threads.test.ts` 的录播 fixture 与探针命令覆盖，不在这里做。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAppServerClient,
  type AppServerChild,
  type AppServerNotification,
  type AppServerSpawn,
} from './client';

/** 假子进程：只实现 `AppServerChild` 那几个成员，够测协议行为与回收行为 */
class FakeChild implements AppServerChild {
  readonly written: string[] = [];
  killed = false;
  /** 假 pid：回收时按它走「整棵树」那条路（真实进程树由 `process-tree.test.ts` 与真机探针覆盖） */
  readonly pid = 4242;
  private dataListeners: Array<(chunk: Buffer | string) => void> = [];
  private stderrListeners: Array<(chunk: Buffer | string) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.written.push(chunk);
      return true;
    },
  };
  readonly stdout = {
    on: (_event: 'data', listener: (chunk: Buffer | string) => void): void => {
      this.dataListeners.push(listener);
    },
  };
  readonly stderr = {
    on: (_event: 'data', listener: (chunk: Buffer | string) => void): void => {
      this.stderrListeners.push(listener);
    },
  };
  on(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: string | null) => void) | ((error: Error) => void),
  ): void {
    if (event === 'exit') this.exitListeners.push(listener as (code: number | null, signal: string | null) => void);
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
  exit(code: number | null): void {
    for (const listener of this.exitListeners) listener(code, null);
  }
  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
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

  it('服务端主动请求（带 id 但不在待收表）单独归类，且客户端不应答', async () => {
    const { client, child, frames } = harness();
    child.emit({ jsonrpc: '2.0', id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } });
    expect(client.serverRequests().map((one) => one.method)).toEqual(['item/commandExecution/requestApproval']);
    expect(frames()).toHaveLength(0);
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
    // 判据是「按 pid 走了杀树那条路」，不是「调过 child.kill()」——后者正是 2026-10-07 那个 EPERM 的成因
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
