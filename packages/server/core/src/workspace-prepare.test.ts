// @vitest-environment node
/**
 * 目录结构
 *
 * 本文件是 `workspace.test.ts` 拆分后的一块：临时家目录 / 仓库模板与清理钩子都在 `./testing/workspace-harness`。
 */
import { describe, expect, it } from 'vitest';
import {
  git,
  makeRepo,
  root,
  existsSync,
  readFileSync,
  writeFileSync,
  join,
  appendEvent,
  readEvents,
  caseCacheDir,
  prepareRowWorkspace,
  rowAgentHomeDir,
  rowAttemptsFile,
  rowDir,
  rowEventsFile,
  rowWorkspaceDir,
  runDir,
  runSnapshotFile,
  registerWorkspaceHooks,
} from './testing/workspace-harness';



registerWorkspaceHooks();

describe('目录结构', () => {
  it('八个路径函数逐字给出约定位置', () => {
    expect(caseCacheDir(root, 'c-1')).toBe(join(root, 'cases', 'c-1', 'cache'));
    expect(runDir(root, 'run-1')).toBe(join(root, 'run-1'));
    expect(rowDir(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1'));
    expect(rowWorkspaceDir(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1', 'workspace'));
    expect(rowAgentHomeDir(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1', '.agenthome'));
    expect(rowEventsFile(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1', 'events.jsonl'));
    // 尝试账本与事件日志**同级但不同文件**：前者累计、永不被 resetEvents 清掉（见 rowAttemptsFile 的注释）
    expect(rowAttemptsFile(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1', 'attempts.jsonl'));
    expect(runSnapshotFile(root, 'run-1')).toBe(join(root, 'run-1', 'run.json'));
  });

  it('事件日志与 run.json 落在行目录/运行目录内，不与 workspace 混在一起', () => {
    // workspace 内部是 agent 的工作副本，agent 可以随意在里面建文件；
    // 事件日志若也放进去，一次 `rm -rf` 就会把证据一起删掉
    expect(rowEventsFile(root, 'run-1', 'row-1').startsWith(rowWorkspaceDir(root, 'run-1', 'row-1'))).toBe(false);
    expect(rowAttemptsFile(root, 'run-1', 'row-1').startsWith(rowWorkspaceDir(root, 'run-1', 'row-1'))).toBe(false);
    expect(runSnapshotFile(root, 'run-1').startsWith(runDir(root, 'run-1'))).toBe(true);
  });
});

describe('prepareRowWorkspace', () => {
  it('首次调用：克隆缓存 → 复制出工作区 → 建分支 → 建 .agenthome，并返回三个路径与基线', () => {
    const { dir, commit } = makeRepo();
    const result = prepareRowWorkspace({
      workspaceRoot: root,
      caseId: 'c-1',
      repoPath: dir,
      runId: 'run-1',
      rowId: 'row-1',
      commitHash: null,
      branch: 'test/row-1',
    });

    expect(result.workspacePath).toBe(rowWorkspaceDir(root, 'run-1', 'row-1'));
    expect(result.agentHome).toBe(rowAgentHomeDir(root, 'run-1', 'row-1'));
    expect(existsSync(join(result.workspacePath, '.git'))).toBe(true);
    expect(existsSync(join(root, 'cases', 'c-1', 'cache', '.git'))).toBe(true);
    expect(existsSync(result.agentHome)).toBe(true);
    // null → 具体 40 位 hash
    expect(result.baselineCommit).toBe(commit);
    expect(result.baselineCommit).toHaveLength(40);
    expect(git(result.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('test/row-1');
  });

  it('给定 commitHash 时基线是那个 commit，工作区里没有它之后的文件', () => {
    const { dir } = makeRepo();
    const first = git(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'later.txt'), 'later\n', 'utf8');
    git(dir, 'add', 'later.txt');
    git(dir, 'commit', '-q', '-m', '之后的提交');

    const result = prepareRowWorkspace({
      workspaceRoot: root,
      caseId: 'c-2',
      repoPath: dir,
      runId: 'run-2',
      rowId: 'row-2',
      commitHash: first,
      branch: 'test/row-2',
    });
    expect(result.baselineCommit).toBe(first);
    expect(existsSync(join(result.workspacePath, 'later.txt'))).toBe(false);
  });

  it('重跑同一行：清掉旧工作区（上一轮 agent 的改动绝不残留）', () => {
    const { dir } = makeRepo();
    const input = {
      workspaceRoot: root,
      caseId: 'c-3',
      repoPath: dir,
      runId: 'run-3',
      rowId: 'row-3',
      commitHash: null,
      branch: 'test/row-3',
    };
    const first = prepareRowWorkspace(input);
    // 模拟第一轮 agent 的产出：改了受跟踪文件 + 建了新文件 + 在自己家里写了配置
    writeFileSync(join(first.workspacePath, 'a.txt'), 'hello\n第一轮的改动\n', 'utf8');
    writeFileSync(join(first.workspacePath, 'agent-new.txt'), '第一轮的新文件\n', 'utf8');
    writeFileSync(join(first.agentHome, 'settings.json'), '{"model":"第一轮"}', 'utf8');

    const second = prepareRowWorkspace(input);
    expect(readFileSync(join(second.workspacePath, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(second.workspacePath, 'agent-new.txt'))).toBe(false);
    expect(existsSync(join(second.agentHome, 'settings.json'))).toBe(false);
    // 分支被重置到基线（不是复用上一轮那个已经前移的分支）
    expect(second.baselineCommit).toBe(first.baselineCommit);
    expect(git(second.workspacePath, 'rev-parse', 'HEAD').trim()).toBe(second.baselineCommit);
  });

  it('重跑同一行**不动 events.jsonl**：文件与它的 seq 都活着，下一条事件接着发号', () => {
    // 编排层的顺序是 resetEvents → 发 preparing（seq 1，这一步就建出了行目录）→ prepareRowWorkspace。
    // 准备阶段若把整个行目录一起删，刚写下的 preparing 就没了，下一次追加又从 seq 1 开始；
    // 界面的 useRowStream 按 seq 去重，于是清空后的第一条状态事件被**静默吞掉**——
    // 这正是这条保证存在的理由，而且每一轮评测都会发生。
    const { dir } = makeRepo();
    const input = {
      workspaceRoot: root,
      caseId: 'c-6',
      repoPath: dir,
      runId: 'run-6',
      rowId: 'row-6',
      commitHash: null,
      branch: 'test/row-6',
    };
    prepareRowWorkspace(input);
    const eventsFile = rowEventsFile(root, 'run-6', 'row-6');
    expect(appendEvent(eventsFile, { type: 'status', status: 'preparing' }).seq).toBe(1);

    prepareRowWorkspace(input);

    // ① 文件还在，② 里面那条事件还在，③ 下一条事件拿到 seq 2（不是重号）
    expect(existsSync(eventsFile)).toBe(true);
    expect(readEvents(eventsFile).map((event) => event.seq)).toEqual([1]);
    expect(appendEvent(eventsFile, { type: 'status', status: 'running' }).seq).toBe(2);
  });




});
