/**
 * 「产物总览」二级抽屉：按名次逐份摆候选工作区根下的 `RESULT.*`。
 *
 * 本文件钉住的界面语义：
 *   · **顺序就是名次序**（与排名表同源：`orderForDisplay` + `rankOf`），快照顺序不参与；
 *   · 一份候选多份产物 = 多个折叠面板（标题右侧是文件名），四段标题里不掺文件名；
 *   · 没有产物的候选**也占一个面板**（正文 `EmptyState`），首段写候选状态——「没产出」不是「这个候选不存在」；
 *   · 面板一律 `size="small"` 且**默认全部展开**（逐份摊开是这一层的用途）；
 *   · 三种渲染分档：md 走本仓的 markdown 外壳、html / svg 走 `sandbox=""` 的 iframe（SVG 另加最小 HTML 壳）；
 *   · 加载中 / 读失败 / 截断三种状态各有可读文案，没有一格静默空白。
 *
 * jsdom 能看见的是结构、属性与文案；**「iframe 里到底画成什么样」看不见**（跨源且不渲染）——
 * 那一半交给真机冒烟，源码形态那一半交给 `artifact-overview.static.test.ts`。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EvalRun, CandidateArtifactFile, RunArtifactIndex } from '@aieval/contracts';
import {
  ARTIFACT_FRAME_HEIGHT,
  ARTIFACT_OVERVIEW_LABEL,
  ArtifactFileContent,
  ArtifactOverview,
  artifactPanelTitle,
} from './artifact-overview';

type Candidate = EvalRun['candidates'][number];

/** 判分结论：`totalScore` 决定名次，判定内容与本文件无关 */
function score(totalScore: number): Candidate['score'] {
  return {
    judgments: [{ id: 'T1', achieved: totalScore >= 100, reason: '理由' }],
    totalScore,
    maxScore: 100,
    verdict: '可用',
    raw: '{}',
    judgeProviderId: 'p-1',
    judgeModelId: 'judge-model',
    judgedAt: '2026-10-12T08:10:00.000Z',
    judgeAgentKind: null,
    judgeEffort: null,
    structuredOutput: false,
    judgeTokens: null,
    judgeDurationMs: null,
  };
}

function makeCandidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    agentKind: 'dsh',
    providerId: 'p-1',
    providerName: '本地',
    baseUrl: 'http://127.0.0.1:4000',
    modelId: 'GLM-5.3',
    status: 'judged',
    branch: `test/${id}`,
    workspacePath: `/runs/run-1/candidates/${id}/workspace`,
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: score(100),
    error: null,
    attempts: 1,
    sessionId: null,
    followUps: 0,
    followUpRounds: 0,
    ...overrides,
  };
}

function makeRun(candidates: Candidate[]): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '06 鹈鹕骑车',
    note: '',
    repoPath: 'none://',
    commitHash: '',
    repoBranch: null,
    rubric: { groups: [{ name: '一、任务完成度', items: [{ id: 'T1', goal: '产出 RESULT.svg', weight: 100 }] }] },
    includeSteps: false,
    status: 'done',
    executionMode: 'parallel',
    useAgentJudge: false,
    askUser: false,
    injectMessages: false,
    candidates,
    workspaceBase: '/runs',
    createdAt: '2026-10-12T08:00:00.000Z',
    startedAt: '2026-10-12T08:00:01.000Z',
    finishedAt: '2026-10-12T08:05:00.000Z',
  };
}

function indexOf(candidates: { candidateId: string; files: { name: string; kind: 'md' | 'html' | 'svg' }[] }[]): RunArtifactIndex {
  return {
    candidates: candidates.map((row) => ({
      candidateId: row.candidateId,
      files: row.files.map((file) => ({ ...file, bytes: 10 })),
    })),
    total: candidates.reduce((sum, row) => sum + row.files.length, 0),
  };
}

/** 抽屉里那些面板的正文槽（DOM 顺序 = 阅读顺序） */
function panels(): HTMLElement[] {
  return screen.queryAllByTestId('artifact-panel');
}

/** 面板正文槽的 `data-row-id` 序列：用来断言「顺序是名次序」 */
function panelCandidateIds(): (string | null)[] {
  return panels().map((panel) => panel.getAttribute('data-row-id'));
}

const renderBody = (input: { candidateId: string; name: string }) => <span>{`正文字典：${input.name}`}</span>;

describe('ArtifactOverview 顺序与标题', () => {
  it('抽屉标题就是入口那一句（同一个常量，不写第二份字面量）', () => {
    render(
      <ArtifactOverview
        run={makeRun([makeCandidate('a')])}
        index={indexOf([{ candidateId: 'a', files: [{ name: 'RESULT.md', kind: 'md' }] }])}
        open
        onOpenChange={vi.fn()}
        renderBody={renderBody}
      />,
    );

    expect(screen.getByText(ARTIFACT_OVERVIEW_LABEL)).toBeInTheDocument();
  });

  it('面板顺序 = 名次序，不是快照顺序（快照把第三名放最前面）', () => {
    const run = makeRun([
      makeCandidate('third', { score: score(50) }),
      makeCandidate('first', { score: score(100) }),
      makeCandidate('second', { score: score(80) }),
    ]);

    render(
      <ArtifactOverview
        run={run}
        index={indexOf([
          { candidateId: 'third', files: [{ name: 'RESULT.md', kind: 'md' }] },
          { candidateId: 'first', files: [{ name: 'RESULT.md', kind: 'md' }] },
          { candidateId: 'second', files: [{ name: 'RESULT.md', kind: 'md' }] },
        ])}
        open
        onOpenChange={vi.fn()}
        renderBody={renderBody}
      />,
    );

    expect(panelCandidateIds()).toEqual(['first', 'second', 'third']);
  });

  it('标题四段：排名 · 智能体 · 模型 · 思考强度（强度缺省写「未指定」）', () => {
    const run = makeRun([
      makeCandidate('a', { agentKind: 'cc', modelId: 'claude-opus-4-6', effort: 'high' }),
      makeCandidate('b', { agentKind: 'pi', modelId: 'gpt-5', effort: undefined, score: score(60) }),
    ]);

    render(
      <ArtifactOverview
        run={run}
        index={indexOf([
          { candidateId: 'a', files: [{ name: 'RESULT.md', kind: 'md' }] },
          { candidateId: 'b', files: [{ name: 'RESULT.md', kind: 'md' }] },
        ])}
        open
        onOpenChange={vi.fn()}
        renderBody={renderBody}
      />,
    );

    expect(screen.getByText('第 1 名 · Claude Code · claude-opus-4-6 · high')).toBeInTheDocument();
    expect(screen.getByText('第 2 名 · Pi Coding Agent · gpt-5 · 未指定')).toBeInTheDocument();
  });

  it('面板是紧凑档（`size="small"`）且**默认全部展开**（逐份摊开，不用挨个点开）', () => {
    render(
      <ArtifactOverview
        run={makeRun([makeCandidate('a'), makeCandidate('b', { score: score(60) })])}
        index={indexOf([
          {
            candidateId: 'a',
            files: [
              { name: 'RESULT.md', kind: 'md' },
              { name: 'RESULT.svg', kind: 'svg' },
            ],
          },
        ])}
        open
        onOpenChange={vi.fn()}
        renderBody={renderBody}
      />,
    );

    // 抽屉挂在 portal 上（不在 render 的容器里），故按文档查
    // 紧凑档与排名表同尺寸：退回中档就是「逐份摊开的面板比排名表松一圈」
    expect(document.querySelector<HTMLElement>('.ant-collapse')?.className, '折叠面板退回了中档').toContain('ant-collapse-small');
    // 三个面板（a 的两份产物 + b 的空态）全部 active：`defaultActiveKey` 漏一格，那一格就是收起的
    expect(document.querySelectorAll('.ant-collapse-item')).toHaveLength(3);
    expect(document.querySelectorAll('.ant-collapse-item-active')).toHaveLength(3);
  });

  it('未出分的候选排在出分的后面，首段写候选状态（不写成「最后一名」）', () => {
    const run = makeRun([
      makeCandidate('failed', { status: 'failed', score: null }),
      makeCandidate('ok', { agentKind: 'cc', modelId: 'M-1', effort: 'low' }),
    ]);

    render(
      <ArtifactOverview
        run={run}
        index={indexOf([
          { candidateId: 'failed', files: [{ name: 'RESULT.md', kind: 'md' }] },
          { candidateId: 'ok', files: [{ name: 'RESULT.md', kind: 'md' }] },
        ])}
        open
        onOpenChange={vi.fn()}
        renderBody={renderBody}
      />,
    );

    expect(panelCandidateIds()).toEqual(['ok', 'failed']);
    expect(screen.getByText('失败 · DeepSeek Harness · GLM-5.3 · 未指定')).toBeInTheDocument();
  });

  it('一份候选两份产物 = 两个面板，标题右侧是文件名（四段标题里不掺文件名）', () => {
    const received: { candidateId: string; name: string }[] = [];
    render(
      <ArtifactOverview
        run={makeRun([makeCandidate('a')])}
        index={indexOf([
          {
            candidateId: 'a',
            files: [
              { name: 'RESULT.md', kind: 'md' },
              { name: 'RESULT.svg', kind: 'svg' },
            ],
          },
        ])}
        open
        onOpenChange={vi.fn()}
        renderBody={(input) => {
          received.push(input);
          return <span>{`正文：${input.name}`}</span>;
        }}
      />,
    );

    expect(panels()).toHaveLength(2);
    expect(panels().map((panel) => panel.getAttribute('data-artifact-name'))).toEqual(['RESULT.md', 'RESULT.svg']);
    // 标题右侧那一格显示文件名（等宽）
    expect(screen.getByText('RESULT.svg')).toBeInTheDocument();
    // 正文按「每份一个组件实例」的形状把身份交回调用方
    expect(received).toEqual([
      { candidateId: 'a', name: 'RESULT.md' },
      { candidateId: 'a', name: 'RESULT.svg' },
    ]);
  });

  it('没有产物的候选**也占一个面板**，正文是空态（写清认的文件名）', () => {
    render(
      <ArtifactOverview
        run={makeRun([makeCandidate('a'), makeCandidate('b', { score: score(60) })])}
        index={indexOf([{ candidateId: 'a', files: [{ name: 'RESULT.md', kind: 'md' }] }])}
        open
        onOpenChange={vi.fn()}
        renderBody={renderBody}
      />,
    );

    expect(panelCandidateIds()).toEqual(['a', 'b']);
    expect(screen.getByText('这个候选没有产物')).toBeInTheDocument();
    expect(screen.getByText('执行的目录里没有 RESULT.md / RESULT.html / RESULT.svg')).toBeInTheDocument();
  });

  it('清单还没读到 ⇒ 一句空态，而不是一排空面板（「还没读到」≠「都没有产出」）', () => {
    render(<ArtifactOverview run={makeRun([makeCandidate('a')])} index={undefined} open onOpenChange={vi.fn()} renderBody={renderBody} />);

    expect(panels()).toHaveLength(0);
    expect(screen.getByText('还没读到产物清单')).toBeInTheDocument();
  });

  it('抽屉没打开 ⇒ 一个节点都不在（开合归调用方）', () => {
    render(
      <ArtifactOverview
        run={makeRun([makeCandidate('a')])}
        index={indexOf([{ candidateId: 'a', files: [{ name: 'RESULT.md', kind: 'md' }] }])}
        open={false}
        onOpenChange={vi.fn()}
        renderBody={renderBody}
      />,
    );

    expect(screen.queryAllByTestId('artifact-panel')).toHaveLength(0);
  });
});

/**
 * 面板标题拼法（`artifactPanelTitle`）的直测。
 *
 * 组件用例只覆盖「落进 DOM 的那几个组合」；这一层钉的是**取值面**：名次 / 候选状态、强度的
 * 「未指定」、四段的分隔符。它是页面与守卫共用的那一份拼法，散写就没人守着它们一致。
 */
describe('artifactPanelTitle', () => {
  it('四段用 ` · ` 连接；名次在前、强度在后', () => {
    expect(artifactPanelTitle(makeCandidate('a', { agentKind: 'codex', modelId: 'gpt-5', effort: 'max' }), 2)).toBe(
      '第 2 名 · Codex · gpt-5 · max',
    );
  });

  it('没有名次时首段是候选状态（未出分的候选不参与排名）', () => {
    expect(artifactPanelTitle(makeCandidate('a', { status: 'timed-out' }), undefined)).toBe(
      '已超时 · DeepSeek Harness · GLM-5.3 · 未指定',
    );
  });
});

describe('ArtifactFileContent', () => {
  function file(overrides: Partial<CandidateArtifactFile> = {}): CandidateArtifactFile {
    return { name: 'RESULT.md', kind: 'md', text: '# 交付说明', bytes: 10, truncated: false, ...overrides };
  }

  it('加载中 ⇒ Skeleton（不是空白：空白会被读成「这份是空的」）', () => {
    render(<ArtifactFileContent file={undefined} error={null} isLoading />);

    expect(screen.getByTestId('artifact-file-skeleton')).toBeInTheDocument();
  });

  it('读失败 ⇒ 中文原因的 Alert（原样给出调用方折好的那一句）', () => {
    render(<ArtifactFileContent file={undefined} error={new Error('这个候选没有这份产物：/runs/x')} isLoading={false} />);

    expect(screen.getByText('这一份产物读取失败')).toBeInTheDocument();
    expect(screen.getByText(/这个候选没有这份产物/)).toBeInTheDocument();
  });

  it('markdown ⇒ 走本仓的 markdown 外壳（标题降级渲染出可见文字）', () => {
    render(<ArtifactFileContent file={file({ text: '# 交付说明\n\n正文一段' })} error={null} isLoading={false} />);

    // 本仓外壳把 h1 降到 4 级（右栏不该长出页面级巨标题），故按文字定位
    expect(screen.getByText('交付说明')).toBeInTheDocument();
    expect(screen.getByText('正文一段')).toBeInTheDocument();
  });

  it('html ⇒ `sandbox=""` 的 iframe，正文原样进 srcdoc', () => {
    render(<ArtifactFileContent file={file({ name: 'RESULT.html', kind: 'html', text: '<p>正文</p>' })} error={null} isLoading={false} />);

    const frame = screen.getByTestId('artifact-frame');
    // 空串 = 最严一档：脚本不执行、表单 / 弹窗 / 顶层跳转全挡（改宽这一格是一处 XSS 面）
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe('<p>正文</p>');
    expect(frame.getAttribute('title')).toBe('产物 RESULT.html');
    // 固定高度（跨源读不到内容高度，见 ARTIFACT_FRAME_HEIGHT 的注释）
    expect(frame.getAttribute('style')).toContain(`height: ${ARTIFACT_FRAME_HEIGHT}px`);
  });

  it('svg ⇒ 同一档 iframe，但前置一层最小 HTML 壳（否则 SVG 落在 300×150 的默认尺寸上）', () => {
    render(<ArtifactFileContent file={file({ name: 'RESULT.svg', kind: 'svg', text: '<svg viewBox="0 0 10 10"/>' })} error={null} isLoading={false} />);

    const frame = screen.getByTestId('artifact-frame');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';

    expect(frame.getAttribute('sandbox')).toBe('');
    expect(srcdoc.startsWith('<!doctype html>')).toBe(true);
    // 宽的一侧铺满、高的一侧收回框内：`html,body{height:100%}` 是 `max-height:100%` 生效的前提
    expect(srcdoc).toContain('html,body{margin:0;height:100%}svg{display:block;width:100%;height:auto;max-height:100%}');
    expect(srcdoc.endsWith('<svg viewBox="0 0 10 10"/>')).toBe(true);
  });

  it('截断 ⇒ 一行 warning 如实说「只显示前一部分」（不让人以为它只写了这么多）', () => {
    render(<ArtifactFileContent file={file({ truncated: true })} error={null} isLoading={false} />);

    expect(screen.getByTestId('artifact-truncated')).toHaveTextContent('只显示前一部分');
  });
});
