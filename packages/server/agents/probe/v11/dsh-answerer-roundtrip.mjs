/**
 * dsh 真机项③：**应答面**的注册形状与两档收场（v11）。
 *
 * 静态面（源码与类型）已给出签名原文；本脚本回答的是「照着那些签名写一个插件，真机上跑不跑得通、
 * 拿回来的原文长什么样」。四臂共用同一份提示词与同一个工作区，只改 profile 的两行：
 *
 *  | 臂 | `tool-ask-user` 那一行 | 应答者插件 | 期望看到 |
 *  |---|---|---|---|
 *  | A | 缺省（= `mode: legacy`，阻塞档） | 有（canned） | 工具结果 `{"answers":[…]}`，选中探针约定的 `-B` 项 |
 *  | B | 缺省（阻塞档） | 无 | **报错**原文（`no user-questions answerer accepted the request`） |
 *  | C | `config: { mode: timed, timeout: 8 }` | 无 | `{"pending":true,"callId":…,"message":"…"}` |
 *  | D | `config: { mode: timed, timeout: 60 }` | 有（file） | 父进程写文件作答 ⇒ 工具拿到 `{"answers":[…]}` |
 *
 * 为什么要 B/C 两臂：要处置「今天那个必然报错的提问工具」，改哪个配置键取决于
 * **阻塞档与有限 timed 档在无人应答时的收场是不是同一个**——这两臂就是那件事的判据。
 * D 臂是产品设计的样子（答案走文件型 side channel），A 臂是最小形状的证明。
 *
 * 判据一律是**原文**：工具调用的 `arguments`、`tool/result` 的 `isError` 与文本、应答者自己写的
 * `aieval-ask-answerer.jsonl`（含 `import.meta.url`，用来核对相对名按哪个目录解析）。
 * **本脚本不伪造运行结果**：跑不了就是跑不了，缺的格留人工回填。
 *
 * 用法（在仓库根；凭据取宿主 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`）：
 *
 *   node packages/server/agents/probe/v11/dsh-answerer-roundtrip.mjs
 *   node packages/server/agents/probe/v11/dsh-answerer-roundtrip.mjs --arms=A,C
 *   node packages/server/agents/probe/v11/dsh-answerer-roundtrip.mjs --serve-delay=3000
 *
 * 花的钱：每臂一次（或两次）模型往返，四臂合计约 4–8 次。行形状有问题先跑
 * `dsh-answerer-config-dump.mjs`（不调模型、不花钱），别拿真机去试 YAML。
 *
 * 产物落 `probe/dumps/`（整个目录已 gitignore，可能含网关返回的敏感原文）：
 *   · `v11/dsh-answerer-roundtrip.json` —— 四臂的结论与逐格原文；
 *   · `v2/dsh-v11-<臂名>.jsonl` —— 每臂的原始通知流（落盘路径由 v2 的外壳决定，名字里的 v11 才是归属）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from '../v2/lib/gateway.mjs';
import { runDshProbe, summarize } from '../v2/lib/dsh.mjs';
import { askUserPairs, buildArms, buildPrompt, composeAnswers, plantPlugin, readTranscript, resultText, verdictOf } from './answerer-arms.mjs';

/** `--arms=A,B` / `--serve-delay=3000` 这些开关只认「名字=值」形状。 */
function readArgs(argv) {
  const out = {};
  for (const one of argv) {
    if (!one.startsWith('--')) continue;
    const [key, value = ''] = one.slice(2).split('=');
    out[key] = value;
  }
  return out;
}

const args = readArgs(process.argv.slice(2));
const arms = (args.arms ?? 'A,B,C,D').split(',').map((one) => one.trim().toUpperCase()).filter((one) => one !== '');
/** D 臂里父进程「看到请求之后再作答」的思考时间：故意留一点延迟，证明答案确实跨了进程。 */
const serveDelayMs = Number(args['serve-delay'] ?? 1500);

/**
 * D 臂的父进程半边：tail 应答者 sidecar，看到 `request` 就延迟 `serveDelayMs` 再把答案写进
 * `<configHome>/aieval-ask-answer.json`（插件在 `file` 模式下轮询它）。
 * 它证明的是「问题跨进程出来、答案跨进程回去」这条 side channel，而不是插件自己编一个答案。
 */
function startFileAnswerer(configHome) {
  const answerFile = join(configHome, 'aieval-ask-answer.json');
  let stopped = false;
  const done = (async () => {
    const deadline = Date.now() + 240000;
    for (;;) {
      if (stopped || Date.now() >= deadline) return null;
      const request = readTranscript(configHome).find((row) => row.phase === 'request');
      if (request !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, serveDelayMs));
        const payload = { at: new Date().toISOString(), from: 'parent-probe', answers: composeAnswers(request.questions) };
        writeFileSync(answerFile, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
        note('  D 臂父进程：已按观察到的请求作答 →', answerFile);
        return payload;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  return { done, stop: () => { stopped = true; } };
}

// ── 跑 ────────────────────────────────────────────────────────────────────────
const nonce = randomBytes(3).toString('hex').toUpperCase();
const workspace = mkdtempSync(join(tmpdir(), 'aieval-v11-ask-'));
const prompt = buildPrompt(nonce);
const catalog = buildArms();
note('工作区 =', workspace);
note('提示词 nonce =', nonce);
note('本批臂 =', arms.join(','));

const results = {};
for (const key of arms) {
  const arm = catalog[key];
  if (arm === undefined) {
    note(`跳过未知臂 ${key}`);
    continue;
  }
  note('');
  note(`═══ ${arm.title} ═══`);
  const configHome = mkdtempSync(join(tmpdir(), `aieval-v11-${key}-`));
  plantPlugin(configHome);
  // 子进程环境由 v2 的外壳整体展开宿主 process.env ⇒ 在这里设、跑完还原；
  // `undefined` 是「显式删除」语义（不要让它从上一臂漏进来）。
  const previous = process.env.AIEVAL_PROBE_ANSWER;
  const previousWait = process.env.AIEVAL_PROBE_ANSWER_WAIT_MS;
  if (arm.env.AIEVAL_PROBE_ANSWER === undefined) delete process.env.AIEVAL_PROBE_ANSWER;
  else process.env.AIEVAL_PROBE_ANSWER = arm.env.AIEVAL_PROBE_ANSWER;
  if (arm.env.AIEVAL_PROBE_ANSWER_WAIT_MS === undefined) delete process.env.AIEVAL_PROBE_ANSWER_WAIT_MS;
  else process.env.AIEVAL_PROBE_ANSWER_WAIT_MS = arm.env.AIEVAL_PROBE_ANSWER_WAIT_MS;

  const server = arm.serve === true ? startFileAnswerer(configHome) : null;
  let run;
  let served = null;
  try {
    run = await runDshProbe({ label: arm.label, prompt, workspace, configHome, profileRows: arm.rows, settleMs: 0 });
    // 父进程半边是否真的写过答案文件：有界等待，别让一个没收到请求的臂拖住整批
    if (server !== null) {
      served = await Promise.race([server.done, new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
    }
  } finally {
    server?.stop();
    if (previous === undefined) delete process.env.AIEVAL_PROBE_ANSWER;
    else process.env.AIEVAL_PROBE_ANSWER = previous;
    if (previousWait === undefined) delete process.env.AIEVAL_PROBE_ANSWER_WAIT_MS;
    else process.env.AIEVAL_PROBE_ANSWER_WAIT_MS = previousWait;
  }

  const pairs = askUserPairs(run.notifications);
  const transcript = readTranscript(configHome);
  note('工具调用/结果：');
  for (const pair of pairs) {
    note('  arguments =', String(pair.arguments).slice(0, 400));
    note('  result.isError =', pair.result?.message?.isError ?? '【无 result】');
    note('  result.text =', JSON.stringify(resultText(pair)).slice(0, 900));
  }
  note('应答者 sidecar（', transcript.length, '行）：');
  for (const row of transcript) note('  ·', JSON.stringify(row).slice(0, 700));
  if (server !== null) note('父进程写回的答案 =', JSON.stringify(served).slice(0, 400));
  note('最终答复 =', JSON.stringify(run.result?.finalResponse ?? null).slice(0, 700));
  note('通知分布：');
  for (const [name, count] of summarize(run.notifications)) note('  ·', name, '×', count);
  const verdict = verdictOf(arm, pairs[0], transcript);
  note('判读（原文为准）：');
  for (const line of verdict) note('  ', line);

  results[key] = {
    title: arm.title,
    profileRows: arm.rows,
    childEnv: arm.env,
    configHome,
    prompt,
    pairs,
    transcript,
    served,
    error: run.error,
    finalResponse: run.result?.finalResponse ?? null,
    notificationSummary: summarize(run.notifications),
    verdict,
  };
}

const file = writeDump('v11/dsh-answerer-roundtrip', {
  at: new Date().toISOString(),
  nonce,
  workspace,
  model: 'deepseek-flash',
  prompt,
  arms: results,
});
note('');
note('→', file);
note('原始通知流另存 probe/dumps/v2/dsh-v11-*.jsonl（落盘路径由 v2 的外壳决定）');
