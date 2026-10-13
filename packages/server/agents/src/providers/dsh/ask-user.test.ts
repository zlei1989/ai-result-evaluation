// @vitest-environment node
/**
 * 应答面（ask-user）的单元判据。四组：
 *   ① 插件源码的形状——订阅进程内提问服务、按 `DSH_HOME` 定位两份流水、只读答复那一份、
 *      任何失败都退成「委派」（观测与应答都不许打断被测运行）；
 *   ② 厂商**服务侧**形状 → 契约形状（族载荷归一；服务侧的多选是驼峰 `multiSelect`）；
 *   ③ 答复 → 厂商应答者要的批次（一题一条、按题面配对、跳过与自由输入的两种落法）；
 *   ④ 父进程那一半（`startDshAskAnswerer`）：认领 → 问端口 → 把答复或委派追加进流水，
 *      以及「读到同一行不服务两次」「交委派而不是编一份空答案」两条边界。
 */
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AskUserPort } from '../../ask-user';
import type { AskUserReply, AskUserRequest } from '../../types';
import { removeTreeWithRetry } from '../../testing/cleanup';
import {
  DSH_ASK_ANSWERER_PLUGIN_SOURCE,
  DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH,
  DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH,
  DSH_ASK_USER_TOOL,
  dshAnswerBatchOf,
  dshQuestionsOf,
  startDshAskAnswerer,
} from './ask-user';

/** 厂商进程内服务派发出来的那一问（字段名逐字按 `questionRequest()` 的产物） */
const VENDOR_QUESTION = {
  id: 'q1',
  header: '选路径',
  question: '用哪条路径？',
  options: [{ label: '选项 A', description: '快一点' }, { label: '选项 B' }],
  multiSelect: false,
};

/** 等到判据成立（上限按「宁可超时也不假红」：这一组都是内存/临时目录上的动作，秒级足够） */
async function waitFor(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 读一份 JSONL 流水的行（测试自己的读法：行数由判据自己数） */
function linesOf(file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe('DSH_ASK_ANSWERER_PLUGIN_SOURCE（插件源码形状）', () => {
  it('订阅进程内提问服务，并按 DSH_HOME 定位两份流水（与适配器逐字一致）', () => {
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).toContain('ctx.on(\'user-questions/request\'');
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).toContain('process.env.DSH_HOME');
    // 两份落点常量与插件源码必须指同一组文件名——漂移的症状是「插件在写、适配器在读另一个文件」
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).toContain(DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH);
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).toContain(DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH);
  });

  it('认领与委派两条出口都是「return」：不调 attachWait（那一格会停掉 Host 自己的定时器）', () => {
    // 认领 = return 一份 { answers }；委派 = next()
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).toContain('return { answers: reply.answers }');
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).toContain('return next()');
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).not.toContain('attachWait');
  });

  it('只往提问流水里写；答复那一份**只读**（方向反了就是两端互相等）', () => {
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).toContain('appendFileSync(transcript');
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).not.toContain('appendFileSync(replies');
  });

  it('任何失败都吞掉并退成委派（观测手段没有资格制造失败）', () => {
    // try/catch 全包 + catch 里不 rethrow + 兜底那一句是 next()——源码级断言
    //（单测原理上复现不了厂商进程内的抛错路径）
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).toMatch(/catch\s*\{/);
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).not.toMatch(/catch\s*\{[\s\S]*?throw/);
    expect(DSH_ASK_ANSWERER_PLUGIN_SOURCE).toContain('return next();');
  });
});

describe('dshQuestionsOf（服务侧形状 → 契约形状）', () => {
  it('字段名逐条归一：question → prompt、驼峰 multiSelect 认得多选、没有的三格如实落 false', () => {
    expect(dshQuestionsOf([VENDOR_QUESTION])).toEqual([
      {
        header: '选路径',
        prompt: '用哪条路径？',
        options: [
          { label: '选项 A', description: '快一点', recommended: false },
          { label: '选项 B', description: null, recommended: false },
        ],
        multiSelect: false,
        // 「哪一项推荐」在厂商 schema 里没有（由「排首位」表达）；`allowOther` 读的是**答复**形状：
        // 答复项恒带可选 `custom`（见 tool-payload.ts 的模块头），secret 两处都没有
        allowOther: true,
        secret: false,
      },
    ]);
    expect(dshQuestionsOf([{ ...VENDOR_QUESTION, multiSelect: true }])[0]?.multiSelect).toBe(true);
  });

  it('厂商没给标题 / 没给选项 ⇒ 空串与空表（不编值）', () => {
    expect(dshQuestionsOf([{ id: 'q1', question: '问什么？' }])).toEqual([
      { header: '', prompt: '问什么？', options: [], multiSelect: false, allowOther: true, secret: false },
    ]);
  });
});

describe('dshAnswerBatchOf（答复 → 厂商应答批次）', () => {
  it('一题一条、按题目 id 认领：custom 为 null 就不带这个键', () => {
    const reply: AskUserReply = {
      outcome: 'answered',
      answers: [{ header: '选路径', selected: ['选项 A'], custom: null }],
    };
    expect(dshAnswerBatchOf(reply, [VENDOR_QUESTION])).toEqual([{ id: 'q1', selected: ['选项 A'] }]);
  });

  it('自由输入跟着选项一起交（厂商那一格是字符串，两个字段各归各位）', () => {
    const reply: AskUserReply = {
      outcome: 'answered',
      answers: [{ header: '选路径', selected: ['选项 A'], custom: '走第三条' }],
    };
    expect(dshAnswerBatchOf(reply, [VENDOR_QUESTION])).toEqual([
      { id: 'q1', selected: ['选项 A'], custom: '走第三条' },
    ]);
  });

  it('没有答复的那一题落「跳过」：空 selected 且不带 custom（厂商文档的跳过形状）', () => {
    const reply: AskUserReply = { outcome: 'answered', answers: [] };
    expect(dshAnswerBatchOf(reply, [VENDOR_QUESTION])).toEqual([{ id: 'q1', selected: [] }]);
  });

  it('两题各交各的：答案按题面配到自己那一题上', () => {
    const second = { id: 'q2', header: '选节奏', question: '快还是稳？' };
    const reply: AskUserReply = {
      outcome: 'answered',
      answers: [{ header: '选节奏', selected: ['稳'], custom: null }],
    };
    expect(dshAnswerBatchOf(reply, [VENDOR_QUESTION, second])).toEqual([
      { id: 'q1', selected: [] },
      { id: 'q2', selected: ['稳'] },
    ]);
  });
});

describe('startDshAskAnswerer（父进程那一半）', () => {
  it('认领一问：按厂商的调用 id 问端口，再把答案批次追加进答复流水', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aieval-dsh-ask-'));
    const transcriptPath = join(root, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH);
    const repliesPath = join(root, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH);
    const asks: AskUserRequest[] = [];
    const port: AskUserPort = {
      available: true,
      ask: async (request) => {
        asks.push(request);
        return { outcome: 'answered', answers: [{ header: '选路径', selected: ['选项 A'], custom: null }] };
      },
    };
    const bridge = startDshAskAnswerer({ port, transcriptPath, repliesPath, pollMs: 5 });
    try {
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({ phase: 'request', key: 'call_1', callId: 'call_1', questions: [VENDOR_QUESTION] })}\n`,
      );
      await waitFor('答复流水里出现那一行', () => linesOf(repliesPath).length === 1);

      // 入参五格：工具名是厂商原文、调用 id 取厂商给的那个、另两格如实 null
      expect(asks).toHaveLength(1);
      expect(asks[0]?.toolName).toBe(DSH_ASK_USER_TOOL);
      expect(asks[0]?.callId).toBe('call_1');
      expect(asks[0]?.vendorBudgetMs).toBeNull();
      expect(asks[0]?.subagentId).toBeNull();
      expect(asks[0]?.questions[0]?.prompt).toBe('用哪条路径？');

      // 答复帧：厂商应答者那一支要的形状（`answerResult()` 逐字段读它）
      expect(linesOf(repliesPath)[0]).toEqual({
        key: 'call_1',
        answers: [{ id: 'q1', selected: ['选项 A'] }],
        outcome: 'answered',
      });
    } finally {
      bridge.close();
      removeTreeWithRetry(root);
    }
  });

  it('读到同一行不会被服务两次（流水是追加型：每拍整份重读不许重放已认领的那些）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aieval-dsh-ask-'));
    const transcriptPath = join(root, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH);
    const repliesPath = join(root, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH);
    let calls = 0;
    const port: AskUserPort = {
      available: true,
      ask: async () => {
        calls += 1;
        return { outcome: 'answered', answers: [] };
      },
    };
    const bridge = startDshAskAnswerer({ port, transcriptPath, repliesPath, pollMs: 5 });
    try {
      appendFileSync(transcriptPath, `${JSON.stringify({ phase: 'request', key: 'call_1', callId: 'call_1', questions: [VENDOR_QUESTION] })}\n`);
      await waitFor('第一次认领完成', () => linesOf(repliesPath).length === 1);
      // 再放几拍：流水里仍然只有那一行 ⇒ 不许再问第二次
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(calls).toBe(1);
      expect(linesOf(repliesPath)).toHaveLength(1);
    } finally {
      bridge.close();
      removeTreeWithRetry(root);
    }
  });

  it('端口给「没有答案」⇒ 交「委派」，不编一份空答案（厂商自己的收场才是那一档的原生语义）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aieval-dsh-ask-'));
    const transcriptPath = join(root, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH);
    const repliesPath = join(root, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH);
    const port: AskUserPort = {
      available: true,
      ask: async () => ({ outcome: 'timeout', answers: null }),
    };
    const bridge = startDshAskAnswerer({ port, transcriptPath, repliesPath, pollMs: 5 });
    try {
      appendFileSync(transcriptPath, `${JSON.stringify({ phase: 'request', key: 'call_1', callId: 'call_1', questions: [VENDOR_QUESTION] })}\n`);
      await waitFor('委派那一行出现', () => linesOf(repliesPath).length === 1);
      const line = linesOf(repliesPath)[0];
      expect(line).toEqual({ key: 'call_1', delegate: true, reason: 'timeout' });
      // 「没有答案」不许被写成一份空答案批次：那会被厂商读成「用户跳过了这题」
      expect(line?.['answers']).toBeUndefined();
    } finally {
      bridge.close();
      removeTreeWithRetry(root);
    }
  });

  it('没有调用 id ⇒ 交委派不碰端口；没有配对键 ⇒ 一行答复都不写（都配不回那次调用）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aieval-dsh-ask-'));
    const transcriptPath = join(root, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH);
    const repliesPath = join(root, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH);
    let calls = 0;
    const port: AskUserPort = {
      available: true,
      ask: async () => {
        calls += 1;
        return { outcome: 'unavailable', answers: null };
      },
    };
    const bridge = startDshAskAnswerer({ port, transcriptPath, repliesPath, pollMs: 5 });
    try {
      appendFileSync(transcriptPath, `${JSON.stringify({ phase: 'request', key: 'anon-1', questions: [VENDOR_QUESTION] })}\n`);
      appendFileSync(transcriptPath, `${JSON.stringify({ phase: 'request', callId: 'call_2', questions: [VENDOR_QUESTION] })}\n`);
      await waitFor('那一行委派出现', () => linesOf(repliesPath).length === 1);
      expect(calls).toBe(0);
      expect(linesOf(repliesPath)[0]).toEqual({ key: 'anon-1', delegate: true, reason: 'no-call-id' });
      // 第二行连键都没有：写答复只会写出一份没人认领的东西 ⇒ 一行都不写
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(linesOf(repliesPath)).toHaveLength(1);
    } finally {
      bridge.close();
      removeTreeWithRetry(root);
    }
  });

  it('close() 之后不再认领新的提问（运行收尾时轮询必须停）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aieval-dsh-ask-'));
    const transcriptPath = join(root, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH);
    const repliesPath = join(root, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH);
    let calls = 0;
    const port: AskUserPort = {
      available: true,
      ask: async () => {
        calls += 1;
        return { outcome: 'answered', answers: [] };
      },
    };
    const bridge = startDshAskAnswerer({ port, transcriptPath, repliesPath, pollMs: 5 });
    try {
      bridge.close();
      appendFileSync(transcriptPath, `${JSON.stringify({ phase: 'request', key: 'call_1', callId: 'call_1', questions: [VENDOR_QUESTION] })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(calls).toBe(0);
      expect(linesOf(repliesPath)).toHaveLength(0);
    } finally {
      removeTreeWithRetry(root);
    }
  });
});
