// @vitest-environment node
/**
 * 用例页「仓库校验」的**接线**守卫：决策在 `case-repo-validation.ts`（纯函数 + 用例），
 * 但纯函数的守卫看不见「调用方有没有把参数传进来」——`runs-page-wiring.test.ts` 的文件头记着同一个教训
 * （M2：纯函数 6 条全绿，而页面漏喂了一个输入，缺陷照样上线）。
 *
 * 这一层要挡的四种静默死法：
 *   ① 页面不再把面板上报的「当前输入」喂给判定 ⇒ 整套「改了就失效」的机制形同不存在
 *      （回显与候选永远挂在最后一次校验上）；
 *   ② 递给候选 hook 的不是判定过的查询（例如绕过判定直接用 `validatedRepo`）⇒ 用户改了输入，
 *      下拉里还列着旧来源 / 旧分支的提交；
 *   ③ 校验成功后记的不是「发出去的那一对」（例如记成服务端回显的归一路径）⇒ 远端 URL 带尾斜杠时
 *      回显与候选永远不出现；
 *   ④ 用例文件被跳过（读侧跳过坏文件）而页面不说 ⇒ 用户的症状是「我的用例不见了」却查不到原因。
 *
 * 断言口径沿用同目录的先例：把某个调用 / 字段的**那一小块**抠出来断言，其余部分换行重构不会误红，
 * 而漏传、写死、传错必红；抠不到就抛（守卫不许静默失效）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 用例页源码（用文件自身位置推导，不依赖 `process.cwd()`） */
const pagePath = join(import.meta.dirname, '..', 'app', 'cases', 'page.tsx');
const source = readFileSync(pagePath, 'utf8');

/** 抠出某个调用表达式的实参块；抠不到直接抛，避免守卫变成永远为真的空断言 */
function callArgs(callee: string): string {
  const start = source.indexOf(`${callee}(`);
  if (start < 0) throw new Error(`app/cases/page.tsx 里找不到 ${callee}(…) 调用`);
  const end = source.indexOf(')', start);
  if (end < 0) throw new Error(`${callee} 的调用没有在预期处结束`);
  return source.slice(start, end + 1);
}

describe('cases 页面的仓库校验接线', () => {
  it('候选入参来自判定过的查询（两个入参都不许绕过判定）', () => {
    const call = callArgs('useCommitCandidates');

    expect(call, '少了 candidatesQuery.repoPath').toContain('candidatesQuery.repoPath');
    expect(call, '少了 candidatesQuery.repoBranch').toContain('candidatesQuery.repoBranch');
  });

  it('把面板上报的当前输入交给判定，并用它决定回显', () => {
    // ② 没有这个回调，页面就永远不知道用户改过输入（判定拿不到 currentRepo）
    expect(source, '面板没接 onRepoSelectionChange').toContain('onRepoSelectionChange: handleRepoSelectionChange');
    // ③ 回显过的是判定结果（路径与分支都比过），不是「有 repoInfo 就给」
    expect(source, '回显没有过 isValidationCurrent 判定').toContain('isValidationCurrent(validatedRepo, currentRepo)');
    expect(source, '面板拿到的不是判定过的回显').toContain('repoInfo: echoInfo');
  });

  it('校验成功后记下的是「发出去的那一对」（不是 null、也不是服务端回显的归一路径）', () => {
    expect(source, '成功路径没有记下校验结果').toContain('setValidatedRepo(normalizeSelection(input))');
    // 失败路径必须清掉：留着它，一次失败的校验会继续显示上一次的成功回显
    expect(source, '失败路径没有清掉校验结果').toContain('setValidatedRepo(null)');
  });
});

/**
 * 「用例文件被跳过」的告警接线（用例一文件一落后新增）。
 *
 * 读侧的口径是**跳过**坏文件（一条手改坏的 json 不能让整页列表 500），于是同一份响应里多了
 * `warnings`。跳过而不说，用户的症状是「我的用例不见了」却查不到原因——`useCases()` 解构漏了
 * 这一格不会红（它只是个多出来的字段），页面照常渲染，缺陷要到用户报「用例丢了」才暴露。
 * 故这里把三件事都钉住：解构拿 warnings、按非空渲染、以及**把跳过原因一起显示出来**。
 */
describe('cases 页面的用例跳过告警接线', () => {
  it('把 useCases() 的 warnings 解构出来（漏了它，页面拿不到任何跳过信息）', () => {
    // 锚在**解构那一行**上：光有 `warnings` 这个字（类型名、注释、其它变量）都不算接上了
    expect(source, 'useCases() 的解构里少了 warnings').toMatch(/const\s*\{[^}]*\bwarnings\b[^}]*\}\s*=\s*useCases\(\)/);
  });

  it('非空时渲染告警，且文案要说清「被跳过、没显示出来」——只报数字等于没说', () => {
    expect(source, '少了 warnings.length > 0 的渲染条件').toContain('warnings.length > 0');
    expect(source, '告警没有说清「这些用例没有显示出来」').toContain('这些用例没有显示出来');
  });

  it('把每条跳过原因也渲染出来（只给一句「有 N 个被跳过」，用户仍然不知道是哪个文件）', () => {
    expect(source, '跳过原因没有被渲染').toContain('warnings.join');
  });
});
