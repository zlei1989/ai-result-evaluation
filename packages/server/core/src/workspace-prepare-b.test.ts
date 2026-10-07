// @vitest-environment node
/**
 * 目录结构（spec §6.3 / 契约 §10）（切分后的第二块）
 *
 * 本文件是 `workspace.test.ts` 拆分后的一块：临时家目录 / 仓库模板与清理钩子都在 `./testing/workspace-harness`。
 */
import { describe, expect, it } from 'vitest';
import {
  git,
  makeRepo,
  root,
  configDir,
  existsSync,
  writeFileSync,
  join,
  getConfigDir,
  prepareRowWorkspace,
  rowWorkspaceDir,
  registerWorkspaceHooks,
} from './testing/workspace-harness';



registerWorkspaceHooks();

describe('prepareRowWorkspace', () => {
  it('commitHash 为 null 时跟随来源仓库的新 tip（克隆一次不把「默认分支 HEAD」冻结在克隆那一刻，R28）', () => {
    const { dir } = makeRepo();
    const input = {
      workspaceRoot: root,
      caseId: 'c-7',
      repoPath: dir,
      runId: 'run-7',
      rowId: 'row-7',
      commitHash: null,
      branch: 'test/row-7',
    };
    const first = prepareRowWorkspace(input);

    // 来源仓库在缓存建立之后前移（用户又提交了一次）
    writeFileSync(join(dir, 'later.txt'), 'later\n', 'utf8');
    git(dir, 'add', 'later.txt');
    git(dir, 'commit', '-q', '-m', '来源仓库前移');
    const tip = git(dir, 'rev-parse', 'HEAD').trim();

    const second = prepareRowWorkspace(input);
    // 基线跟着来源走，工作区里能看见新提交带来的文件——否则这一轮会静默评测一份旧代码
    expect(second.baselineCommit).toBe(tip);
    expect(second.baselineCommit).not.toBe(first.baselineCommit);
    expect(existsSync(join(second.workspacePath, 'later.txt'))).toBe(true);
  });
  it('两行的目录互不相同（串行模式下也各自独立，spec §3 F6 的防回归）', () => {
    const { dir } = makeRepo();
    const base = { workspaceRoot: root, caseId: 'c-4', repoPath: dir, commitHash: null };
    const a = prepareRowWorkspace({ ...base, runId: 'run-4', rowId: 'row-a', branch: 'test/row-a' });
    const b = prepareRowWorkspace({ ...base, runId: 'run-4', rowId: 'row-b', branch: 'test/row-b' });
    expect(a.workspacePath).not.toBe(b.workspacePath);
    expect(a.agentHome).not.toBe(b.agentHome);
    // 在 A 里写文件，B 必须看不见
    writeFileSync(join(a.workspacePath, 'only-a.txt'), 'a\n', 'utf8');
    expect(existsSync(join(b.workspacePath, 'only-a.txt'))).toBe(false);
  });
  it('commit 不存在时抛 INVALID_REF，且不会留下一个「看起来建好了」的工作区', () => {
    const { dir } = makeRepo();
    let caught: unknown;
    try {
      prepareRowWorkspace({
        workspaceRoot: root,
        caseId: 'c-5',
        repoPath: dir,
        runId: 'run-5',
        rowId: 'row-5',
        commitHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        branch: 'test/row-5',
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: unknown }).code).toBe('INVALID_REF');
    expect(existsSync(join(rowWorkspaceDir(root, 'run-5', 'row-5'), '.git'))).toBe(false);
  });
  it('配置目录指针生效（本模块不读配置，这条是 Review Focus 5 的护栏）', () => {
    expect(getConfigDir()).toBe(configDir);
  });
});
