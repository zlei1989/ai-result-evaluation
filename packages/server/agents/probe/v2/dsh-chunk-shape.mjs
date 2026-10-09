/**
 * 取 `assistant/chunk` 的**线上确切形状**——接正文增量通道（`chunk: 'delta'`）必须先用它，
 * 不能照文档猜字段名（文档给的是存储层的 packed row，不是逻辑事件）。
 *
 * 用法：node packages/server/agents/probe/v2/dsh-chunk-shape.mjs
 * 会真连一次 DeepSeek Harness（读 `~/.dsh/.credentials.yaml` 的 key），并把原始通知落盘。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from './lib/gateway.mjs';
import { runDshProbe } from './lib/dsh.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'aieval-chunk-ws-'));
writeFileSync(join(workspace, 'notes.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

const outcome = await runDshProbe({
  label: 'chunk-shape',
  prompt: '用中文写一段约 200 字的说明，介绍 notes.txt 里有什么。不要调用任何工具。',
  workspace,
  settleMs: 2_000,
  timeoutMs: 180_000,
});

const notifications = outcome?.notifications ?? [];
note('通知总数', notifications.length, '错误', outcome?.error ? String(outcome.error) : '无');

/** 事件类型统计：先确认这条路由到底投不投增量类事件 */
const counts = new Map();
for (const one of notifications) {
  const type = one?.params?.event?.type ?? one?.method ?? 'unknown';
  counts.set(type, (counts.get(type) ?? 0) + 1);
}
note('事件类型统计', [...counts].map(([key, value]) => `${key}×${value}`).join(', '));

/** 增量类事件的逐条形状（前 6 条，含 data 的键与类型） */
const deltaTypes = ['assistant/chunk', 'assistant/delta', 'text/delta', 'assistant/chunk/delta'];
const hits = notifications.filter((one) => deltaTypes.includes(one?.params?.event?.type));
note('增量类命中', hits.length);
for (const hit of hits.slice(0, 6)) {
  note('样本原文', JSON.stringify(hit));
}

writeDump('dsh-chunk-shape', notifications);
note('已落盘', 'dsh-chunk-shape');
