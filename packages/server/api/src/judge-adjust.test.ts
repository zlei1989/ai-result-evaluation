// @vitest-environment node
/**
 * 「智能调整」分支（`mode: 'adjust'`，用户口径）：拿一句话改**现有的**评分标准。
 *
 * 本文件钉的不是「函数跑通了」，而是这条路的**三个关口**：
 *   ① **空表 / 空指令当场拒绝，且一次模型调用都不花**（调用是真的钱；空表更是「没有对象可改」）；
 *   ② **不碰仓库**：这一支的输入里只有表与那句话，`repoPath` 给什么都不该被解析
 *      ——生成分支那条「先校验仓库」的顺序在这里没有对应物，写进去只会让「改一条权重」
 *      莫名其妙地依赖一个与它无关的本地目录是否存在；
 *   ③ **清单是算出来的、坏表要拦下**：模型把标准删光、给出权重 0 这类结果一律折成中文错误，
 *      绝不让一张跑不了评分的表回到界面上（用户在弹窗里会看见「共 N 处改动」并据此点应用）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type Provider, type Rubric } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { callTextApi } from '@aieval/evaluator';
import { generateRubric } from './judge';
import { removeTreeWithRetry } from './testing/cleanup';

vi.mock('@aieval/evaluator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/evaluator')>();
  return { ...actual, callTextApi: vi.fn() };
});

let dir: string;

const PROVIDER: Provider = {
  id: 'provider-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  models: [{ id: 'deepseek-chat', source: 'manual' }],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

/** 配好全局默认评分模型（三个动作都只认它，见 `resolveJudgeRoute()` 无参的口径） */
function configureGlobalJudge(): void {
  saveConfig({
    ...loadConfig(),
    providers: [PROVIDER],
    settings: {
      ...loadConfig().settings,
      defaultJudge: { providerId: PROVIDER.id, modelId: 'deepseek-chat' },
      defaultJudgeAgent: null,
    },
  });
}

/** 模型回一段 JSON（本分支只吃「改完的完整表格」这一种答复） */
function modelReplies(rubric: Rubric): void {
  vi.mocked(callTextApi).mockResolvedValue(JSON.stringify(rubric));
}

/** 用户手上那张表：两组三项，都是「有 id」的（无 id 的配对由 contracts 的 rubric-diff 用例钉） */
function existingRubric(): Rubric {
  return {
    groups: [
      { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] },
      {
        name: '二、测试',
        items: [
          { id: 'D1', goal: '有值透传用例', weight: 14 },
          { id: 'D2', goal: '缺失→null 用例', weight: 6 },
        ],
      },
    ],
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-adjust-'));
  setConfigDirForTesting(dir);
  // 绊线：本分支若真去发网络请求，本机离线也应当稳稳失败（而不是打到一个真实网关）
  vi.stubGlobal('fetch', () => {
    throw new Error('测试不得发网络请求：callTextApi 应当仍是替身');
  });
  vi.mocked(callTextApi).mockReset();
  configureGlobalJudge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setConfigDirForTesting(null);
  removeTreeWithRetry(dir);
});

describe('generateRubric：智能调整分支', () => {
  it('模型改完的表 + 服务端算出来的改动清单一起回来（改权重 + 新增项）', async () => {
    const changed: Rubric = {
      groups: [
        {
          name: '一、生产代码',
          items: [
            { id: 'A1', goal: '追加 agent 字段', weight: 30 },
            { id: 'A2', goal: '补错误处理', weight: 6 },
          ],
        },
        existingRubric().groups[1] as Rubric['groups'][number],
      ],
    };
    modelReplies(changed);

    const result = await generateRubric({
      mode: 'adjust',
      rubric: existingRubric(),
      taskPrompt: '',
      prompt: '把 A1 提到 30 分，再加一条错误处理',
      repoPath: '',
    });

    expect(result.rubric).toEqual(changed);
    // `addedItems` 在这一支恒为 0（它只描述「生成」补了几项，见契约注释）
    expect(result.addedItems).toBe(0);
    // 清单由 `diffRubric` 算出（模型自己说的不算数）
    expect(result.changes).toEqual([
      {
        kind: 'update-item',
        groupName: '一、生产代码',
        before: { id: 'A1', goal: '追加 agent 字段', weight: 18 },
        after: { id: 'A1', goal: '追加 agent 字段', weight: 30 },
      },
      { kind: 'add-item', groupName: '一、生产代码', item: { id: 'A2', goal: '补错误处理', weight: 6 } },
    ]);
    // 不写回、不落盘：本模块是只读的（回写由界面在用户点「应用改动」之后做）
    expect(result.note).toBeUndefined();
  });

  it('删项也如实进清单（保留同组其余项，不触发「空组」那条业务校验）', async () => {
    const changed: Rubric = {
      groups: [
        { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] },
        { name: '二、测试', items: [{ id: 'D1', goal: '有值透传用例', weight: 14 }] },
      ],
    };
    modelReplies(changed);

    const result = await generateRubric({
      mode: 'adjust',
      rubric: existingRubric(),
      taskPrompt: '',
      prompt: '删掉 D2',
      repoPath: '',
    });

    expect(result.changes).toEqual([
      { kind: 'remove-item', groupName: '二、测试', item: { id: 'D2', goal: '缺失→null 用例', weight: 6 } },
    ]);
  });

  it('模型原样返回 ⇒ 清单为空 + 一句说明（界面据此不写回表格）', async () => {
    modelReplies(existingRubric());

    const result = await generateRubric({
      mode: 'adjust',
      rubric: existingRubric(),
      taskPrompt: '',
      prompt: '你觉得需要改吗',
      repoPath: '',
    });

    expect(result.changes).toEqual([]);
    expect(result.note).toBe('模型认为这份评分标准不需要修改');
  });

  it('空表 ⇒ 当场拒绝，且**一次模型调用都不花**（没有可调整的对象）', async () => {
    const error = await generateRubric({
      mode: 'adjust',
      rubric: { groups: [] },
      taskPrompt: '',
      prompt: '把 A1 提到 30 分',
      repoPath: '',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('INVALID_QUERY');
    expect((error as ServiceError).message).toContain('空的');
    expect(vi.mocked(callTextApi)).not.toHaveBeenCalled();
  });

  it('指令为空（或只有空白）⇒ 同样当场拒绝、不花调用（界面按钮禁用之外的第二道门）', async () => {
    const error = await generateRubric({
      mode: 'adjust',
      rubric: existingRubric(),
      taskPrompt: '',
      prompt: '   ',
      repoPath: '',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('INVALID_QUERY');
    expect(vi.mocked(callTextApi)).not.toHaveBeenCalled();
  });

  it('不碰仓库：`repoPath` 填一个根本不存在的远端地址也照常成功（这一支不看它）', async () => {
    modelReplies(existingRubric());

    const result = await generateRubric({
      mode: 'adjust',
      rubric: existingRubric(),
      taskPrompt: '',
      prompt: '把 A1 的措辞改得更具体',
      // 生成分支会在这里 parseRepoSource → 校验仓库；调整分支**不该**有任何仓库动作
      repoPath: 'git@never.invalid:group/repo.git',
    });

    expect(result.rubric).toEqual(existingRubric());
  });

  it('模型把标准删光（空 groups）⇒ JUDGE_PARSE_FAILED，不让一张空表回到界面', async () => {
    modelReplies({ groups: [] });

    const error = await generateRubric({
      mode: 'adjust',
      rubric: existingRubric(),
      taskPrompt: '',
      prompt: '把没用的都删掉',
      repoPath: '',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
    // 「删光」与「识别不出来」是两件事，文案要能区分（否则用户按「识别」的思路去排查）
    expect((error as ServiceError).message).toContain('删空');
  });

  it('模型回了权重 0 的坏表 ⇒ JUDGE_PARSE_FAILED（折成中文，不把坏表交出去）', async () => {
    modelReplies({ groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 0 }] }] });

    const error = await generateRubric({
      mode: 'adjust',
      rubric: existingRubric(),
      taskPrompt: '',
      prompt: '把 A1 降到 0 分',
      repoPath: '',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
    expect((error as ServiceError).message).toContain('权重');
  });
});
