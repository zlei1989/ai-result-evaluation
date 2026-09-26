// @vitest-environment node
/**
 * 右栏状态机：`?panel=` + 详情取数状态 → 该渲染什么。
 *
 * 为什么值得一组用例：`apps/web-next` 不能写 `.tsx` 测试，这段分支原先整个住在页面里、
 * 等于没有守卫；而其中一条（**取数失败 ≠ 用例不存在**）错了会静默吃掉用户正在输入的整张表单。
 * 这里把「有数据就渲染数据」钉死，并给每条分支配一个不会互相冒充的输入。
 */
import { describe, expect, it } from 'vitest';
import type { TestCase } from '@aieval/contracts';
import { resolveCasePanel } from './case-panel-state';

const CASE: TestCase = {
  id: 'case-1',
  title: '为网关补齐转换回归',
  repoPath: 'D:\\projects\\gateway',
  commitHash: null,
  repoBranch: null,
  taskPrompt: '补一条回归用例',
  // 评分口径现在是**一张表**（旧的 `judgePrompt` 一段自由文本已删）：这一格必须给，
  // 它取代的是「评分维度 / 评分提示词」那两处已删除的展示面
  rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 100 }] }] },
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

const ERROR = new Error('详情接口 500');

describe('resolveCasePanel', () => {
  it('panel=null → none（不显示右栏）', () => {
    expect(resolveCasePanel({ panel: null, id: 'case-1', testCase: CASE, caseError: ERROR })).toEqual({ kind: 'none' });
  });

  it('panel=new → new（新建不读详情：这正是 id 为 null 时的常态）', () => {
    expect(resolveCasePanel({ panel: 'new', id: null, testCase: undefined, caseError: undefined })).toEqual({
      kind: 'new',
    });
  });

  it('有 panel 但没有 id → no-selection（链接被手改，不是「用例不存在」）', () => {
    expect(resolveCasePanel({ panel: 'detail', id: null, testCase: undefined, caseError: undefined })).toEqual({
      kind: 'no-selection',
    });
  });

  it('首次取数、还没有数据也没有错误 → loading', () => {
    expect(resolveCasePanel({ panel: 'edit', id: 'case-1', testCase: undefined, caseError: undefined })).toEqual({
      kind: 'loading',
    });
    // `null` 与「没有错误」同义（SWR 用 undefined 表示没有错误，页面自己也可能传 null）：
    // 写 `!== undefined && !== null` 这种冗余判断只会让「null 也算错」的写法漏进来
    expect(resolveCasePanel({ panel: 'edit', id: 'case-1', testCase: undefined, caseError: null })).toEqual({
      kind: 'loading',
    });
  });

  it('取数失败且从未拿到过数据 → not-found（真的没有东西可渲染）', () => {
    expect(resolveCasePanel({ panel: 'detail', id: 'case-1', testCase: undefined, caseError: ERROR })).toEqual({
      kind: 'not-found',
    });
  });

  /**
   * fix wave Item 3 的核心：一次刷新失败（500 / 网络抖动 / 重验失败）不许把手上这条用例判成「不存在」。
   * 页面据此渲染旧数据 + 一条非破坏性提示，表单不卸载——用户正在输入的内容才留得住。
   */
  it('取数失败但手上还有上一次的数据 → stale，并带着那条用例（不是 not-found）', () => {
    expect(resolveCasePanel({ panel: 'edit', id: 'case-1', testCase: CASE, caseError: ERROR })).toEqual({
      kind: 'stale',
      panel: 'edit',
      testCase: CASE,
    });
    expect(resolveCasePanel({ panel: 'detail', id: 'case-1', testCase: CASE, caseError: ERROR })).toEqual({
      kind: 'stale',
      panel: 'detail',
      testCase: CASE,
    });
  });

  it('数据在手、没有错误 → 按 panel 分成 edit / detail', () => {
    expect(resolveCasePanel({ panel: 'edit', id: 'case-1', testCase: CASE, caseError: undefined })).toEqual({
      kind: 'edit',
      testCase: CASE,
    });
    expect(resolveCasePanel({ panel: 'detail', id: 'case-1', testCase: CASE, caseError: undefined })).toEqual({
      kind: 'detail',
      testCase: CASE,
    });
  });
});
