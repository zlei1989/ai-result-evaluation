// @vitest-environment node
/**
 * 用例页的「仓库校验」三个决策：校验成功后记什么、什么时候还算数、递给候选 hook 什么。
 *
 * 为什么值得一组用例：`apps/web-next` 不能写 `.tsx` 测试，这三个决策原先住在页面里、等于没有守卫，
 * 而它们判错的后果都是**静默的错误信息**：回显说「仓库：repo · 分支：feat/x」而输入框里已经是别的分支，
 * 或者候选下拉列出的是**另一条历史**的提交（那些 hash 在那个分支上根本不存在）。
 * 另一条最容易被后人写回去的缺陷是「只比路径不比分支」——下面 `isValidationCurrent` 那组用例专门钉它。
 */
import { describe, expect, it } from 'vitest';
import { candidatesQueryFor, isValidationCurrent, normalizeSelection } from './case-repo-validation';

describe('normalizeSelection（校验成功时记的就是它）', () => {
  it('路径去两侧空白、空白分支归一成 null（与面板上报的「当前输入」同口径）', () => {
    expect(normalizeSelection({ repoPath: '  git@host:g/r.git ', repoBranch: '  feat/x ' })).toEqual({
      repoPath: 'git@host:g/r.git',
      repoBranch: 'feat/x',
    });
    // 空串与纯空白都是「没有分支」：契约是 min(1).nullable()，空串会被服务端拒
    expect(normalizeSelection({ repoPath: 'D:\\r', repoBranch: '' }).repoBranch).toBeNull();
    expect(normalizeSelection({ repoPath: 'D:\\r', repoBranch: '   ' }).repoBranch).toBeNull();
    expect(normalizeSelection({ repoPath: 'D:\\r', repoBranch: null }).repoBranch).toBeNull();
  });

  /**
   * 记的是**发出去的那一对**，不是服务端回显的归一路径。两条理由都不能丢：
   *   ① 回显 / 候选要与「当前输入」比较，两边必须同口径——远端 URL 去掉尾斜杠之后与输入框原文不同，
   *      拿回显去比就会永远不相等（校验成功了却什么都不显示、候选也取不到）；
   *   ② 分支记的是**用户选的那个**，不是服务端解析出的默认分支名（留空 = 用远端默认分支，
   *      而默认分支会随远端 HEAD 变，把它写死成 `main` 就不再是同一个意思了）。
   */
  it('带尾斜杠的远端 URL 原样保留（不在这一层做服务端的归一）', () => {
    expect(normalizeSelection({ repoPath: 'https://host/group/repo.git/', repoBranch: 'feat/x' })).toEqual({
      repoPath: 'https://host/group/repo.git/',
      repoBranch: 'feat/x',
    });
  });
});

describe('isValidationCurrent', () => {
  const validated = { repoPath: 'https://host/group/repo.git', repoBranch: 'feat/x' };

  it('路径与分支完全一致才算有效', () => {
    expect(isValidationCurrent(validated, { repoPath: 'https://host/group/repo.git', repoBranch: 'feat/x' })).toBe(true);
  });

  it('改分支即失效（回显说「分支：feat/x」而输入框里是 main，正是要拦的那类误导）', () => {
    expect(isValidationCurrent(validated, { repoPath: 'https://host/group/repo.git', repoBranch: 'main' })).toBe(false);
    // 从「有分支」改成「默认分支」也算改了：null 与 'feat/x' 是两次不同的解析
    expect(isValidationCurrent(validated, { repoPath: 'https://host/group/repo.git', repoBranch: null })).toBe(false);
    // 反向：校验的是「默认分支」，用户填了个分支名 ⇒ 同样失效
    expect(
      isValidationCurrent({ repoPath: 'https://host/group/repo.git', repoBranch: null }, { ...validated }),
    ).toBe(false);
  });

  it('改路径即失效（原有的那半条口径不变）', () => {
    expect(isValidationCurrent(validated, { repoPath: 'https://host/other.git', repoBranch: 'feat/x' })).toBe(false);
  });

  it('一次都没校验过时恒为 false', () => {
    expect(isValidationCurrent(null, { repoPath: '', repoBranch: null })).toBe(false);
    expect(isValidationCurrent(null, { repoPath: 'https://host/group/repo.git', repoBranch: 'feat/x' })).toBe(false);
  });
});

describe('candidatesQueryFor', () => {
  const validated = { repoPath: 'https://host/group/repo.git', repoBranch: 'feat/x' };

  it('当前输入就是校验过的那一对时，按它取候选', () => {
    expect(candidatesQueryFor(validated, { ...validated })).toEqual({
      repoPath: 'https://host/group/repo.git',
      repoBranch: 'feat/x',
    });
  });

  /**
   * 守卫：用户改了输入而没重新校验时，候选必须**一个都不取**（两个入参都给 null = SWR 的 null key）。
   * 留着旧的一对会让下拉继续列上一个来源 / 上一个分支的提交，而用户看到的输入框已经是新的了。
   */
  it('改分支或改路径之后不再取候选（两个入参都置 null）', () => {
    expect(candidatesQueryFor(validated, { repoPath: validated.repoPath, repoBranch: 'main' })).toEqual({
      repoPath: null,
      repoBranch: null,
    });
    expect(candidatesQueryFor(validated, { repoPath: 'D:\\other', repoBranch: 'feat/x' })).toEqual({
      repoPath: null,
      repoBranch: null,
    });
    expect(candidatesQueryFor(null, { repoPath: validated.repoPath, repoBranch: 'feat/x' })).toEqual({
      repoPath: null,
      repoBranch: null,
    });
  });
});
