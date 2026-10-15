/**
 * v11 探针：codex app-server 上这几条方法**在 wire 上到底存不存在**。
 *
 * 为什么不需要模型与凭据：本探针只发**不会走到模型**的请求，靠**报错原文**区分三种情形：
 *   · `Method not found` 一类 ⇒ 这一版的 wire 上没有这个方法；
 *   · `no active turn` / `expected active turn id …` / `not found` 一类 ⇒ **方法在**，
 *     只是前置不满足（我们要的正是这个判据）；
 *   · 正常返回 ⇒ 连前置都满足（本探针造不出来，因为我们不发 turn）。
 *
 * 顺带回答第 3 问：**管道拉起合不合法**——本探针全程 `stdio: pipe`，
 * 只要 `initialize` 拿得到 result，就说明"必须有交互式终端"那道门禁**不在 app-server 这条路上**。
 *
 * 用法：`node packages/server/agents/probe/v11/codex-wire-methods.mjs`
 * 产物：`probe/dumps/v11/codex-wire-methods.json`
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note } from './lib/cc-ask.mjs';
import { writeDump } from './lib/cc-ask.mjs';
import { startAppServer } from './lib/appserver.mjs';

const BIN = join(
  process.cwd(),
  'node_modules/.pnpm/@openai+codex@0.156.1-darwin-arm64/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex',
);
const home = mkdtempSync(join(tmpdir(), 'aieval-v11-codex-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'aieval-v11-codex-ws-'));

const client = startAppServer({
  command: BIN,
  args: ['app-server'],
  env: { ...process.env, CODEX_HOME: home },
  cwd: workspace,
  timeoutMs: 30000,
});

/** 逐条发一个请求，把「结果 or 报错原文」记下来——报错本身就是读数。 */
async function probe(label, method, params) {
  try {
    const result = await client.request(method, params);
    note(`✅ ${label}（${method}）→ 有结果：${JSON.stringify(result).slice(0, 160)}`);
    return { label, method, params, ok: true, result };
  } catch (caught) {
    // 不截太短：阴性对照那条报错会把**这一版 wire 上的全部方法变体**列出来，那正是本探针要的权威清单
    const message = String(caught?.message ?? caught).slice(0, 8000);
    const code = caught?.code ?? null;
    note(`⏳ ${label}（${method}）→ 报错：${message}`);
    return { label, method, params, ok: false, code, message };
  }
}

const rows = [];
// 第 1 步：握手。**管道下能握上手**就是第 3 问的答案
rows.push(await probe('initialize（管道 stdio）', 'initialize', { clientInfo: { name: 'aieval-probe', version: '1.0.0' }, capabilities: { experimentalApi: true } }));
// 第 2 步：声明存在的那两条——用**不存在的 threadId** 逼出"方法在、前置不满足"
rows.push(await probe('turn/steer（假 thread/turn）', 'turn/steer', {
  threadId: 'probe-no-such-thread',
  expectedTurnId: 'probe-no-such-turn',
  input: [{ type: 'text', text: 'probe' }],
}));
rows.push(await probe('thread/resume（假 thread）', 'thread/resume', { threadId: 'probe-no-such-thread' }));
// 第 3 步："只在 --experimental 产物里"的那一族——schema 里看不到，wire 上呢？
rows.push(await probe('thread/queue/list（假 thread）', 'thread/queue/list', { threadId: 'probe-no-such-thread' }));
rows.push(await probe('thread/queue/delete（假 thread）', 'thread/queue/delete', { threadId: 'probe-no-such-thread', queuedSubmissionId: 'probe-no-such-item' }));
// 第 4 步：一条肯定不存在的，作为"方法不存在长什么样"的**阴性对照**
rows.push(await probe('阴性对照：/probe/nope', 'probe/nope', {}));

const stats = client.stats();
client.close();
const file = writeDump('codex-wire-methods', { bin: BIN, codexHome: home, rows, stats });
note('');
note(`产物：${file}`);
note('判据：`initialize` 有结果 ⇒ 管道拉起合法（第 3 问）；那三条方法若报的是前置不满足而非「方法不存在」，方法就在 wire 上。');
