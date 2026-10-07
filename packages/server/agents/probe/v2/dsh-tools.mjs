/**
 * dsh 真机项①：`read` / `glob` / `grep` / `write` / `edit` / `pwsh` 的**结果形状**。
 *
 * 设计稿 §7.6.6 的登记：dsh 的 `read` 与 `glob` 已拿到真实形状，**`edit` / `grep` / `pwsh` 仍无样本**
 * （"那一轮的提示词没触发它们"），`write` 的 result 形状同样没有落点。
 * ⇒ 本脚本用一条**逐个点名**的提示词把它们全部触发一次，抓原始 `tool/call` 与 `tool/result`。
 *
 * 判据（设计稿 §7.6.3 的族结构落点）：
 *  - `grep`：结果里能不能拿到 `matches[{file,line,text}]`、命中数、是否给"完整清单存在别处"的路径；
 *  - `edit`：结果里有没有 diff / 替换次数；
 *  - `pwsh`：**能不能拿到退出码**（`RunShellResult.exitCode` 的可得性判据）；
 *  - `write`：`{path, bytes, created}` 从哪来。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from './lib/gateway.mjs';
import { runDshProbe, summarize } from './lib/dsh.mjs';

/** 造一个最小但够用的工作区：多文件、可 grep、可 edit。 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'aieval-v2-ws-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'notes.txt'),
    ['alpha', 'beta', 'gamma', 'NEEDLE-one', 'delta'].join('\n') + '\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'src', 'app.ts'),
    ['export function greet(name: string) {', '  return `hello ${name}`;', '}', ''].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'src', 'util.ts'),
    ['export const NEEDLE_TWO = 42;', ''].join('\n'),
    'utf8',
  );
  return root;
}

const workspace = makeWorkspace();
note('工作区 =', workspace);

const prompt = [
  '请**逐个**执行下面每一步，每一步都必须真的调用对应工具，不要用别的方式代替，也不要提前结束：',
  '1. 用 read 工具读取 notes.txt；',
  '2. 用 glob 工具列出 src 目录下的所有 .ts 文件；',
  '3. 用 grep 工具在仓库里搜索 NEEDLE；',
  '4. 用 write 工具新建文件 out/generated.txt，内容写三行：one / two / three；',
  '5. 用 edit 工具把 src/app.ts 里的 `hello` 改成 `hi`；',
  '6. 用 pwsh 工具执行命令：node -e "process.exit(3)"（这条命令会以退出码 3 结束，这是预期的，不要重试）；',
  '7. 最后用一句话汇总每一步的结果。',
].join('\n');

const run = await runDshProbe({ label: 'tools', prompt, workspace });

note('通知分布：');
for (const [key, count] of summarize(run.notifications)) note('  ·', key, '×', count);

// 只挑出工具相关的负载落一份**精简** dump：原始 JSONL 已在 dsh-tools.jsonl
const calls = [];
const results = [];
for (const one of run.notifications) {
  const event = one?.params?.event;
  if (event?.type === 'tool/call') calls.push(event.data);
  if (event?.type === 'tool/result') results.push(event.data);
}
// 工具表：request/header 里带 tools[]，用来核 `ask_user_question` 是否真的挂上了
let toolNames = [];
for (const one of run.notifications) {
  const event = one?.params?.event;
  const tools = event?.data?.tools ?? event?.data?.config?.tools;
  if (Array.isArray(tools) && tools.length > 0) toolNames = tools.map((t) => t?.name ?? t?.function?.name ?? '<无名>');
}

note('tool/call 次数 =', calls.length, '；tool/result 次数 =', results.length);
for (const call of calls) note('  call:', call?.name, JSON.stringify(call?.arguments ?? '').slice(0, 160));
note('request/header 工具表（', toolNames.length, '项）：', toolNames.join(', ') || '【未捕获】');

const file = writeDump('v2/dsh-tools', {
  at: new Date().toISOString(),
  workspace,
  prompt,
  model: run.model,
  error: run.error,
  runResult: run.result === null ? null : { finalResponse: run.result.finalResponse, events: run.result.events?.length, notifications: run.result.notifications?.length },
  toolNames,
  calls,
  results,
});
note('精简 dump →', file);
