/**
 * v11 的 **tee 包装**：把 SDK 真正 spawn 的那份 claude 二进制包一层透明转发，
 * stdin / stdout 各落一份原始 NDJSON，于是能看到 `control_request` 的**线级原文**。
 *
 * 为什么需要它：回调只能证明「我被调用了」，证明不了「厂商发的是哪种控制请求」——
 * 而票里的第一问恰恰是后者。`supportedDialogKinds` 未声明的 dialog kind **根本不下发**，
 * 所以「dialog 回调没被调用」这件事单独看是**不可证伪**的；有了线级帧才谈得上判据。
 *
 * 怎么接：SDK 的 `pathToClaudeCodeExecutable` 指向本文件（`.mjs` ⇒ SDK 用 `node <本文件> <CLI 参数>`
 * 拉起），真实二进制路径与两份帧文件路径由环境变量传进来。
 *
 * 三条不变量：
 *  - **信号必须转发**：SDK 取消时杀的是本进程，不转发的话 CLI 会变成孤儿进程留在机器上；
 *  - **stderr 原样透传**（SDK 自己在收集它），不落盘也不吞；
 *  - **帧文件每轮清空再追加**，一行一帧；chunk 边界可能切在行中间，读回时按行解析并如实报未解析条数。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const realBinary = process.env.PROBE_REAL_CLAUDE;
const frameIn = process.env.PROBE_FRAME_IN;
const frameOut = process.env.PROBE_FRAME_OUT;

if (typeof realBinary !== 'string' || realBinary === '') {
  process.stderr.write('[probe-tee] 缺 PROBE_REAL_CLAUDE（真实 claude 二进制路径）\n');
  process.exit(127);
}

/**
 * 先把两份帧文件清空（本进程每轮 spawn 一个）。
 * 为什么必须清空：同一个 label 重跑时追加会把两轮的帧混成一份，`控制帧 N 条` 这类计数会被读成
 * 「厂商发了两帧」——假读数比没读数更坏。
 */
for (const path of [frameIn, frameOut]) {
  if (typeof path !== 'string' || path === '') continue;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  } catch { /* 帧文件是旁路证据，写不进去不阻断主链路 */ }
}

/** 追加一段原始字节（目录不存在就建；帧文件写不进去不该让整轮探测失败）。 */
function tee(path, chunk) {
  if (typeof path !== 'string' || path === '') return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, chunk);
  } catch { /* 帧文件是旁路证据，写不进去不阻断主链路 */ }
}

const child = spawn(realBinary, process.argv.slice(2), {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

// 上行：宿主 → CLI（SDK 写的每一帧）
process.stdin.on('data', (chunk) => {
  tee(frameIn, chunk);
  child.stdin.write(chunk);
});
process.stdin.on('end', () => child.stdin.end());
process.stdin.on('error', () => child.stdin.end());

// 下行：CLI → 宿主（`control_request` 就在这一侧）
child.stdout.on('data', (chunk) => {
  tee(frameOut, chunk);
  process.stdout.write(chunk);
});

// 信号转发：SDK 取消/终止时杀的是本进程，必须把 CLI 一起带走
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('error', (caught) => {
  process.stderr.write(`[probe-tee] 拉不起真实二进制：${String(caught?.message ?? caught)}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  process.exit(code === null ? (signal === null ? 1 : 128) : code);
});
