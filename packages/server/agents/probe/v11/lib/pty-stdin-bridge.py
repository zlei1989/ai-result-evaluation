#!/usr/bin/env python3
"""v11 探针专用：给子进程一个**真 TTY 的 fd 0**，其余 fd 保持管道。

为什么需要它：本仓跑 codex 一直是 `stdio: ['pipe','pipe','pipe']`（JSON-RPC 要能双向读写），
而厂商二进制里有一句 ``request_user_input requires an interactive stdin terminal``。
要**证伪或证实**「非 TTY 的 stdin 到底拦不拦」，就得有一个只改这一格的对照臂：
app-server 的 fd 0 挂在真终端上、stdout/stderr 仍是干净的管道（否则 JSON-RPC 会被
stderr 诊断混进来）。

做法：`pty.openpty()` 开一对伪终端 → 子进程 `stdin=<slave>`、stdout/stderr 原样继承；
本进程把**自己的 stdin** 转发进 pty 的 master（JSON-RPC 请求就是这个方向），
同时把 master 上的**回声**读掉丢弃（pty 的行规程会把写进去的字节回显到 master，
不排空既会塞满 pty 缓冲、也会把请求字节混进响应管道）。

用法（由 `codex-ask-user-stdin.mjs` 的 `pty` 臂调用，不单独用）：
    python3 pty-stdin-bridge.py <可执行文件> [参数...]
"""
import errno
import os
import pty
import signal
import subprocess
import sys
import threading
import tty

if len(sys.argv) < 2:
    sys.stderr.write('用法：pty-stdin-bridge.py <可执行文件> [参数...]\n')
    sys.exit(2)

master, slave = pty.openpty()
# 关掉行规程的回显与规范模式：JSON-RPC 是整行写进来的，不需要等换行；
# 不回显则 master 侧只剩我们主动丢弃的字节。`isatty(fd 0)` 不受影响，仍为真。
tty.setraw(slave)

child = subprocess.Popen(
    sys.argv[1:],
    stdin=slave,
    stdout=None,  # 继承：调用方（Node）据此读 JSON-RPC 响应
    stderr=None,
    close_fds=True,
)
os.close(slave)


def forward_stdin():
    """调用方 stdin → pty master：这一路就是 app-server 读到的「终端输入」"""
    while True:
        try:
            data = sys.stdin.buffer.read1(65536)
        except (OSError, ValueError):
            break
        if not data:
            break
        try:
            os.write(master, data)
        except OSError:
            break


def drain_master():
    """排空 pty 回声：master 上读到的一切都丢弃（响应只走子进程的 stdout 管道）"""
    while True:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            # 子进程退出后读 master 会拿到 EIO，这是正常收场而不是故障
            if error.errno in (errno.EIO, errno.EBADF):
                break
            break
        if not data:
            break


def terminate(_signum, _frame):
    """被调用方取消时把子进程一起带走，别留孤儿持着 `$CODEX_HOME`"""
    if child.poll() is None:
        child.kill()
    sys.exit(0)


threading.Thread(target=forward_stdin, daemon=True).start()
threading.Thread(target=drain_master, daemon=True).start()
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)

sys.exit(child.wait())
