/**
 * pi 的**跨进程续接**夹具：真包 + 脚本式上游，场景是「暗号回读」。
 *
 * 判据取两条**并行**通道，缺一条就分不清「没接」「接坏了」「模型抖了一下」：
 *   · **厂商投影（机制）**：出站请求体里有没有上一轮的暗号——那是厂商自己把会话文件投影成模型上下文
 *     的结果，与模型无关；
 *   · **模型答复（端到端）**：脚本式上游按「请求体里有没有暗号」作答，故答复那一格量的正是
 *     「这条上下文真的走到了模型面前」。
 *
 * 两个**必备件**（缺一个都会让「答对了」有第二种解释）：
 *   · **阴性对照**：同一本次运行目录、同一 cwd、同一会话目录，只是**不打开那份会话文件**跑一轮
 *     ——它必须一个暗号都答不出。没有它，「答对了」可能来自工作区残留或别的东西泄漏；
 *   · **按行隔离**：换一条本次运行目录（会话落点也随之换掉），但**刻意复用同一个 cwd**
 *     ——这是更难的那一半：证明「每个本次运行一个会话落点」本身就够，不需要 cwd 也不同。
 *
 * 为什么这一格算 `real-path` 而不是 `synthetic-fixture`：厂商侧全是真的（真包装配、真会话管理器、
 * 真 JSONL 落盘、真事件投影），假网关只扮演**上游模型**——与另三家 `askUserProofDriver: 'real-path'`
 * 的夹具同一条口径。它证明的不是「我们的桩会读文件」，而是「厂商会把这条会话的转录带回模型上下文」。
 *
 * 本模块只被 `*.test.ts` import。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunResult } from '../types';
import { createPiCandidateDir, runPiCandidateIn, startPiGateway, type CapturedPiRequest, type PiCandidateDir } from './pi-gateway-fixture';

/** 一次续接格的全部读数（断言在测试侧，本模块只负责把事实摆出来） */
export interface PiResumeReading {
  /** 这一轮出站的请求体里有没有这个暗号（**机制**层判据） */
  requestHasNonce: boolean;
  /** 脚本式上游按请求体答出来的那句话（**端到端**层判据） */
  reply: string;
  /** 这一轮的会话落点（`result.sessionId`；pi 落的是路径） */
  sessionFile: string | null;
  result: AgentRunResult;
}

export interface PiResumeScenario {
  /** 首跑：在一棵空的本次运行目录上开新会话、记住暗号 A */
  first: PiResumeReading;
  /** 续接：同一条本次运行目录，`resume` 指向首跑的会话文件 ⇒ 必须带回暗号 A */
  resumed: PiResumeReading;
  /** 阴性对照：同一条本次运行目录，**不传 resume** ⇒ 一个暗号都带不回来 */
  control: PiResumeReading;
  /** 另一条本次运行目录（**同一个 cwd**）：记住暗号 B */
  otherCandidate: PiResumeReading;
  /** 另一条本次运行目录里续接 ⇒ 只认得自己的暗号 B，认不出 A */
  otherCandidateResumed: PiResumeReading;
  nonceA: string;
  nonceB: string;
  candidateOne: PiCandidateDir;
  candidateTwo: PiCandidateDir;
}

/**
 * 判断一份请求体里有没有这个暗号。
 *
 * 空串**必须先被挡掉**：它是任何字符串的子串，漏了这一条会让每一格都报「有暗号」——
 * 阴性对照因此假绿（这正是这类夹具最容易踩的那一脚）。
 */
function bodyHasNonce(body: Record<string, unknown>, nonce: string): boolean {
  if (nonce === '') return false;
  return JSON.stringify(body).includes(nonce);
}

/**
 * 跑完整场景（两个暗号全随机：写死一个词会被「猜中」污染判据）。
 *
 * 上游的答复规则只有一条：请求体里有哪个暗号就回哪个，都没有就回「不知道」。
 * 于是「答复里有暗号」与「请求体里有暗号」在这套夹具里同真同假——两条通道因此可以互相对账，
 * 不一致时能立刻看出是哪一层的问题（请求体里没有而答复里有 = 上游乱答，不是产品的问题）。
 */
export async function runPiResumeScenario(): Promise<PiResumeScenario> {
  const root = mkdtempSync(join(tmpdir(), 'pi-session-'));
  const candidateOne = createPiCandidateDir(join(root, 'candidate1'));
  /**
   * 第二条本次运行目录**刻意复用 candidate1 的 cwd**：隔离判据因此只剩「会话落点不同」这一个自变量。
   * 配置目录仍然是各自的（会话落点就在它下面）。
   */
  const candidateTwo: PiCandidateDir = { cwd: candidateOne.cwd, configHome: join(root, 'candidate2', '.agenthome') };
  mkdirSync(candidateTwo.configHome, { recursive: true });

  const nonceA = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const nonceB = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const remember = (nonce: string): string => `请记住这串暗号：${nonce}。只回复「记住了」三个字，不要复述暗号。`;
  const recall = '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。';

  const seen: CapturedPiRequest[] = [];
  const gateway = await startPiGateway(seen, (body) => {
    if (bodyHasNonce(body, nonceA)) return nonceA;
    if (bodyHasNonce(body, nonceB)) return nonceB;
    return '不知道';
  });

  /** 跑一格：读出站体与答复；`seen` 逐格清空，免得上一格的请求体混进这一格的判据 */
  const read = async (
    dir: PiCandidateDir,
    options: { prompt: string; nonce: string; resume?: { sessionId: string } },
  ): Promise<PiResumeReading> => {
    seen.length = 0;
    const { body, result } = await runPiCandidateIn(seen, dir, gateway.port, {
      protocolType: 'anthropic',
      prompt: options.prompt,
      ...(options.resume === undefined ? {} : { resume: options.resume }),
    });
    return {
      requestHasNonce: bodyHasNonce(body, options.nonce),
      // 端到端那一条读的是**适配器归一后的最终答复**（`result.finalText`）：
      // 原始事件流是厂商方言，而归一那一层本身也在被测范围内
      reply: result.finalText ?? '',
      sessionFile: result.sessionId,
      result,
    };
  };

  try {
    const first = await read(candidateOne, { prompt: remember(nonceA), nonce: nonceA });
    const resumed = await read(candidateOne, {
      prompt: recall,
      nonce: nonceA,
      ...(first.sessionFile === null ? {} : { resume: { sessionId: first.sessionFile } }),
    });
    const control = await read(candidateOne, { prompt: recall, nonce: nonceA });
    const otherCandidate = await read(candidateTwo, { prompt: remember(nonceB), nonce: nonceB });
    const otherCandidateResumed = await read(candidateTwo, {
      prompt: recall,
      nonce: nonceB,
      ...(otherCandidate.sessionFile === null ? {} : { resume: { sessionId: otherCandidate.sessionFile } }),
    });

    return { first, resumed, control, otherCandidate, otherCandidateResumed, nonceA, nonceB, candidateOne, candidateTwo };
  } finally {
    gateway.server.close();
  }
}
