/**
 * 最小应答者插件（探针 v11 的**被测对象**，不是产品代码）。
 *
 * 它证明的是 dsh 进程内提问服务的**应答者注册形状**：
 * `ctx.userQuestions.ask()` 把请求交给 `user-questions/request` 这条 **Cordis waterfall**，
 * 应答者就是一个 `ctx.on('user-questions/request', (request, next) => …)` 监听器——
 * 返回 `AskUserQuestionAnswer`（`{ answers: [{ id, selected, custom? }] }`）即**认领**，
 * 调 `next()` 即**委派**给下一个应答者（一个都没有时落到服务内置的 `noAnswerer` ⇒ `NO_PROVIDER`）。
 *
 * 两个刻意的设计（改前先读）：
 *  · **零依赖 + 全吞异常**：它在厂商 runtime 进程里跑，观测手段没有资格打断被测运行；
 *  · **不调 `attachWait`**：那条通道是给「自己掌握倒计时」的界面用的——一旦认领，Host 自己的
 *    定时器就停摆（`TimedQuestionWait.schedule()` 见 `claims.size > 0` 就 return）。
 *    本插件不认领 ⇒ `timed` 档的到点收场仍由 Host 产生（这才是我们要观察的那一支）。
 *
 * 回答方式由子进程环境选择（`runDshProbe` 把宿主 `process.env` 整体展开给子进程）：
 *  · `AIEVAL_PROBE_ANSWER=canned`（缺省）：立刻作答，每题取「label 以 `-B` 结尾」的选项，
 *    没有就取最后一项；一项都没有则 `selected: []` + `custom: 'AIEVAL_PROBE_ANSWER'`；
 *  · `AIEVAL_PROBE_ANSWER=file`：轮询 `<DSH_HOME>/aieval-ask-answer.json`（父进程写的答案批次），
 *    出现即用它作答；到 `AIEVAL_PROBE_ANSWER_WAIT_MS`（缺省 60000）仍没有 ⇒ `next()` 委派。
 *
 * 观测面：`<DSH_HOME>/aieval-ask-answerer.jsonl` 逐行记录 `plugin-loaded` / `request` /
 * `answer` / `delegate` 四相。父进程读它就有「请求到达应答者的**原文**」（含 `wait`、`signal`、
 * 会话归属）——这比任何转述都硬。
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 从一问里挑出探针约定的那一项（label 以 `-B` 结尾），没有就退回最后一项。 */
function pickOption(question) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const flagged = options.find((option) => typeof option?.label === 'string' && option.label.endsWith('-B'));
  return flagged ?? options[options.length - 1] ?? null;
}

/** 把一问合成一份答案项：选中标签进 `selected`；无选项时用 `custom` 留一个可辨认的记号。 */
function answerOf(question) {
  const option = pickOption(question);
  return option === null
    ? { id: question.id, selected: [], custom: 'AIEVAL_PROBE_ANSWER' }
    : { id: question.id, selected: [option.label] };
}

export default function aievalAskAnswerer(ctx) {
  const home = process.env.DSH_HOME;
  if (typeof home !== 'string' || home === '') return;
  const transcript = join(home, 'aieval-ask-answerer.jsonl');
  const answerFile = join(home, 'aieval-ask-answer.json');
  const mode = process.env.AIEVAL_PROBE_ANSWER === 'file' ? 'file' : 'canned';
  const waitMs = Number(process.env.AIEVAL_PROBE_ANSWER_WAIT_MS ?? 60000);

  const record = (row) => {
    try {
      appendFileSync(transcript, `${JSON.stringify(row)}\n`);
    } catch {
      // 观测写失败不影响运行：丢一行比打断一次运行便宜
    }
  };

  /** 等父进程把答案写到 `answerFile`；到点返回 null（由调用方决定委派）。 */
  const waitForAnswer = async () => {
    const deadline = Date.now() + (Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 60000);
    for (;;) {
      try {
        const parsed = JSON.parse(readFileSync(answerFile, 'utf8'));
        if (Array.isArray(parsed?.answers) && parsed.answers.length > 0) return parsed.answers;
      } catch {
        // 还没写 / 写了一半：继续等
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  // 自报加载：`import.meta.url` 是「相对名到底按哪个目录解析」的唯一判据
  //（adapter 的 stream-tap 结论是按 `dshHome`，本条把它复核成可读的一行）。
  record({ phase: 'plugin-loaded', at: Date.now(), url: import.meta.url, pid: process.pid, mode, cwd: process.cwd() });

  ctx.on('user-questions/request', async (request, next) => {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    record({
      phase: 'request',
      at: Date.now(),
      questions,
      // Agent 是活对象（可能带 getter / 环）⇒ 只抄两格身份，绝不 JSON.stringify 整个 agent
      agentId: request?.agent?.id ?? null,
      sessionId: request?.agent?.session?.id ?? null,
      wait: request?.wait ?? null,
      hasSignal: request?.signal !== undefined,
    });
    let answers;
    if (mode === 'file') {
      answers = await waitForAnswer();
      if (answers === null) {
        record({ phase: 'delegate', at: Date.now(), reason: 'file-timeout' });
        return next();
      }
    } else {
      answers = questions.map(answerOf);
    }
    record({ phase: 'answer', at: Date.now(), from: mode, answers });
    return { answers };
  });
}
