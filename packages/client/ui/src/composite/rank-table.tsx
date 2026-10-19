'use client';

/**
 * 排名表：把一轮评测的候选**并排**摆成一张表看名次——列是候选，行是各项事实，
 * 左首列锁住当行标签、其余列横向滚动。**只是表**：抽屉（几何、标题、开合）由页面给。
 *
 * 七条口径：
 *   1. **列头留空，名次落在第一行里**（该行标签留空、金色 Tag 自己说明它是什么；与候选卡片上的徽标同形）：名次是这张表
 *      存在的理由，只能有一个落点——两处对同一件事的写法必须一样，列头若换成名次就会与那一行重复；
 *   2. **名次与卡片排序共用同一份判据**（`compareRows` + `rankOf`，来自 `run-detail-panel`）：
 *      总分降序 → 耗时升序 → tok（输入+输出）升序，三项全同才并列（同名次、允许跳号）。
 *      本组件**不自己排**，否则会出现「卡片挂第 1 名、表里排第 2」；
 *   3. **未出分的候选照进表**，排在有分的右侧且**不给名次**：`rankOf` 对它们返回 `undefined`
 *      ——「没有名次」是一句事实，写成「最后一名」或干脆不显示都是在替使用者下结论。
 *      它们的第一格显示行状态（失败 / 已超时 / 待开始…），评分与总分格留空；
 *   4. **判定与评分项按引用键对齐**（`rubricEntries` 一次摊平、按 `groupIndex` 分段），
 *      表里有而判定里没有的那一格**显式写「缺少判定」**：不静默跳过（那种「看起来正常」的表格
 *      比报错危险，与评分详情同一口径）；
 *   5. **行分四段**：身份（名次 / 智能体 / 模型 / 思考强度）→ 执行（耗时 / 输入 / 缓存命中 / 输出）
 *      → 评分（每组一行组名 + 各目标，带权重）→ 总分。耗时与 token 说的是**候选执行那一段**
 *      （`EvalRow.durationMs` 契约里就不含评分阶段）——把它们并进评分段会让人误读成评分开销，
 *      而 token 三行与 `compareRows` 用的那两个数**同源**（输入 + 输出），逐格摆开是为了
 *      「同分为什么有名次差」当场可查（缓存命中单列一行：它不进判据）；
 *   6. **组名只写在左锁列里**（不横跨候选列）：横跨时它是一块会跟着横向滚动滑走的横幅，
 *      而「这一段是哪个分类」正是读右边那些格子的前提——留在锁列里才始终在视野内；
 *   7. **不给任何行自定义底色**：分段靠**行的位置与字重**（组名加粗、总分那一行的值是粗体），
 *      底色交回表格自己的斑马纹与 hover——自加一层底色会与它们打架，且亮/暗两套主题下都要重调；
 *   8. **数来自传入的快照，不重算**：总分用 `score.totalScore`、满分用 `score.maxScore`
 *      （逐行各显示各的——评分表改过之后两行可能不是同一把尺子），耗时未采集写「未采集」而不是 0。
 *
 * 表格走 DataTable：首列用 `pinned: 'start'` 锁住、宽度由 `size` 声明（偏移的唯一输入），
 * 横向滚动由套件自己的容器承担；行底色、斑马纹与 hover 都交给套件。
 */
import type { ReactNode } from 'react';
import { Badge } from '../components/ui/badge';
import { Hint } from '../base/hint';
import {
  AGENT_LABELS,
  ROW_STATUS_LABELS,
  rubricEntries,
  type EvalRow,
  type EvalRun,
  type RubricEntry,
  type RubricItem,
  type RowTestSummary,
  type RunTestResults,
} from '@aieval/contracts';
import { DataTable, type DataTableColumn } from '../base/data-table';
import { formatTokens } from '../base/usage-metrics';
import { formatDuration } from '../base/metric-line';
import { orderForDisplay, rankOf } from './run-detail-panel';

/**
 * 行标签列（锁在左边的那一列）的宽度（px）：要装下**评分项的目标原文**——它是读这张表的前提
 * （不知道目标是什么，达成与否就没法比）。故这一列按「一行目标大致读完」定宽，
 * 装不下的由 `wordBreak` 折行（多行也只是那一行变高，各候选列跟着对齐）；
 * **不用 `ellipsis`**：截断之后目标就看不全了，而这张表的用途正是横向对比同一目标下各家达成情况。
 */
/**
 * 横向滚动条那一条的高度（px）：留给它占的位置（写进套件滚动容器的 `paddingBottom`）。
 * 为什么必须留：那根滚动条是**原生浮层**，落点是滚动容器自己的底边——不留位置时它正好压在最后一行
 * 「总分」的数字上（9 候选实测）。取值比浏览器滚动条的常见高度（chromium 15px）宽一点。
 */
export const RANK_SCROLLBAR_GUTTER = 16;

export const RANK_LABEL_WIDTH = 200;

/** 每个候选列的宽度（px）：名次 Tag、厂商名、模型名各占一列，太窄会把「DeepSeek Harness」折行 */
export const RANK_CANDIDATE_WIDTH = 160;

/**
 * 排名表里几种徽标的语义色（`data-tone` 是给用例的稳定判据，颜色只是呈现）：
 * 名次与「候选未作答」沿用卡片上的金 / 红两档；判定沿用评分详情的绿 / 红。
 */
const RANK_BADGE_CLASSES = {
  // 名次是「第几」，不是告警：用前景色 + 边框，不引调色板里的琥珀
  rank: 'border-border text-foreground',
  emptyAnswer: 'border-destructive/40 text-destructive',
  achieved: 'border-success/40 text-success',
  missing: 'border-destructive/40 text-destructive',
} as const;

/**
 * 表格宽度 = 标签列 + 每候选一列；所有候选列等宽、用同一个常量，
 * 故这里是一个求和式而不是逐列累加（这是真机冒烟与用例共用的宽度口径）。
 */
export function rankTableMinWidth(candidateCount: number): number {
  return RANK_LABEL_WIDTH + candidateCount * RANK_CANDIDATE_WIDTH;
}

/**
 * 名次判据的那句话：**由具名片段拼装**，片段与 `compareRows` 的三级判据一一对应
 * （改判据时这几段必须一起改；散写成一句话就没有任何东西在守着它们一致）。
 */
export const RANK_CRITERIA_PARTS = [
  '名次：总分降序；同分按耗时升序',
  '再按 tok（输入+输出）升序',
  '三项全同即并列（同名次，允许跳号）',
  // 说「那一格」而不是「选手格」：第一行的标签已经留空（口径 1），引用一个界面上不存在的词
  // 只会让读者回头去找它
  '未出分的候选不参与排名，它那一格写行状态',
] as const;

/** 判据说明的正文（段间用 `；` 连接，末尾补句号） */
export const RANK_CRITERIA_TEXT = `${RANK_CRITERIA_PARTS.join('；')}。`;

/**
 * 名次那一行挂的标记片段：名次逐列拼成 `1,2,` 形态（**未出分的列是空串**）。
 * 它是这一行唯一的机器可读信号——列头留空（口径 1），名次只能落在这一行里。
 * 导出是为了让守卫拿到**同一份**拼法，而不是在用例里照抄一遍（照抄的那份不会跟着改）。
 */
export function rankMarker(ranked: readonly (number | undefined)[]): string {
  return ranked.map((rank) => rank ?? '').join(',');
}

/** 表格的一行 = 一个标签 + 一个「按候选取值」的渲染 */
interface RankTableRow {
  key: string;
  /** 左锁列的标签。取 `ReactNode` 而不是字符串：目标那一行把**权重**做成 Tag（见 `goalLabel`） */
  label: ReactNode;
  /** 组名分隔行：只有标签格有内容（候选格留白），底色比普通行浅一档 */
  groupHeader?: string;
  /** 这一行的渲染：给它一个候选，回这一格。组名行没有它（候选格全部留白） */
  render?: (row: EvalRow) => ReactNode;
}

/** 判定格的引用键由行闭包带住，故 `render` 只收候选行 */
function identityRows(rows: EvalRow[]): RankTableRow[] {
  return [
    {
      key: 'rank',
      // **标签留空**（用户口径）：这一行的内容是名次 Tag，它自己会说话——「选手」两个字既
      // 不解释什么，还占着锁列里最值钱的第一格
      label: '',
      render: (row) =>
        row.score === null ? (
          // 未出分：写的是行状态而不是名次——它是「这行为什么没分」的第一句话（口径 3）
          <Badge variant="outline" data-tone="status">
            {ROW_STATUS_LABELS[row.status]}
          </Badge>
        ) : (
          /**
           * 金色名次 Tag（与候选卡片上的徽标同色同字，口径 1）；**真的没答时**再挂一个红 Tag。
           *
           * 为什么与名次并列而不是替换：两者是两件事 —— 名次说的是「它排第几」，
           * 这一格说的是「那次评分评的是一个**没答**的候选」。只显示名次，
           * 横向对比里就会把一次空答复排得和正常一样（与候选卡片同一口径）。
           *
           * 判据 `=== true`：三态里**键缺席与 `null` 都是「未记录」**，不该显示成任何一个结论
           * （旧数据属于这一档）。⇒ 既有用例的行没有这一格 ⇒ 多出来的 Tag **不会出现**，
           * 因此不改变它们断言的 `textContent`。
           */
          <>
            <Badge variant="outline" className={RANK_BADGE_CLASSES.rank} data-tone="rank">
              第 {rankOf(rows, row)} 名
            </Badge>
            {row.emptyAnswer === true ? (
              <Badge variant="outline" className={RANK_BADGE_CLASSES.emptyAnswer} data-tone="empty-answer">
                候选未作答
              </Badge>
            ) : null}
          </>
        ),
    },
    { key: 'agent', label: '智能体', render: (row) => <span>{AGENT_LABELS[row.agentKind]}</span> },
    { key: 'model', label: '模型', render: (row) => <span>{row.modelId}</span> },
    { key: 'effort', label: '思考强度', render: (row) => <span>{row.effort ?? '未指定'}</span> },
  ];
}

/**
 * 「没采到」的统一样子（耗时 / 用量四格共用）：**绝不写 0**——0 是一个读数（真的没花），
 * 而这一格说的是「压根没采到」。
 */
function notCollected(): ReactNode {
  return <span className="text-muted-foreground">未采集</span>;
}

/**
 * 执行那一段（口径 5）：耗时 + token 三格，四个数都与卡片计量行同源同格式。
 * **未出分的列整段留白**（不逐格写「未采集」）：那一行要么没跑到采集、要么跑挂了，
 * 五个「未采集」只是噪音——名次那一格里的行状态已经把原因说清了。
 */
function executionRows(): RankTableRow[] {
  return [
    {
      key: 'duration',
      label: '耗时',
      render: (row) =>
        row.score === null ? (
          ''
        ) : row.durationMs === null ? (
          notCollected()
        ) : (
          // 悬浮给精确实数：判据是毫秒，而这一格显示的是进过位的 `1m02s`——同分靠耗时拆名次时，
          // 「表上看起来一样却名次不同」只能靠这一格核实
          <Hint label={`${row.durationMs} 毫秒（候选执行那一段，不含评分）`}>
            <span>{formatDuration(row.durationMs)}</span>
          </Hint>
        ),
    },
    {
      key: 'tokens-input',
      label: '输入',
      render: (row) => (row.score === null ? '' : row.tokens === null ? notCollected() : <span>{formatTokens(row.tokens.input)}</span>),
    },
    {
      key: 'tokens-cached',
      label: '缓存命中',
      render: (row) => (row.score === null ? '' : row.tokens === null ? notCollected() : <span>{formatTokens(row.tokens.cached)}</span>),
    },
    {
      key: 'tokens-output',
      label: '输出',
      render: (row) => (row.score === null ? '' : row.tokens === null ? notCollected() : <span>{formatTokens(row.tokens.output)}</span>),
    },
  ];
}

/**
 * 测试通过率：**缺数据写「未采集」，不写 0%**。
 *
 * 通过率的分母只算「通过 + 失败」：跳过不是失败，把它塞进分母会让一次「跳过三条、通过两条」
 * 被读成 40%。`total` 里包含跳过，故分子分母单独从两格拼，不拿 `total` 当分母。
 * 分母为 0（全跳过 / 一条有效用例都没有）时写「无有效用例」——0% 是一个读数，而这里没有读数。
 */
function testPassRateCell(summary: RowTestSummary | undefined): ReactNode {
  if (summary === undefined || summary.status === 'not-collected') return notCollected();
  if (summary.status === 'unparsed') {
    return (
      <Hint label={summary.reason}>
        <span className="text-muted-foreground" data-hint={summary.reason}>
          未采集
        </span>
      </Hint>
    );
  }
  const denominator = summary.passed + summary.failed;
  if (denominator === 0) return <span className="text-muted-foreground">无有效用例</span>;
  const percent = Math.round((summary.passed / denominator) * 100);
  return (
    <span data-tone="test-pass-rate">
      {`${percent}%（${summary.passed}/${denominator}）`}
    </span>
  );
}

/** 测试通过率那一行：缺数据与原文明示「未采集」，不把没采到折成 0 */
function testPassRateRow(testResults: RunTestResults | undefined): RankTableRow {
  const byRow = new Map((testResults?.rows ?? []).map((row) => [row.rowId, row]));
  return {
    key: 'test-pass-rate',
    label: '测试通过率',
    render: (row) => testPassRateCell(byRow.get(row.id)),
  };
}

/**
 * 评分那一段：每组一行组名（整行铺满）+ 每项一行（标签带权重）。
 * 判定按**引用键**取（口径 4），取不到就显式写「缺少判定」——不静默跳过。
 * 分组用的是契约摊平结果上的 `groupIndex`（**不自己按组项数切片**：同一条枚举规则写两份必然漂移）。
 */
function scoringRows(run: EvalRun): RankTableRow[] {
  const byGroup = new Map<number, RubricEntry[]>();
  for (const entry of rubricEntries(run.rubric)) {
    const list = byGroup.get(entry.groupIndex);
    // 首见这一组就开一个桶（不写 `??=` 里再取一次：那个写法读不出「这里在建桶」）
    if (list === undefined) byGroup.set(entry.groupIndex, [entry]);
    else list.push(entry);
  }
  const rows: RankTableRow[] = [];
  run.rubric.groups.forEach((group, groupIndex) => {
    rows.push({ key: `group-${groupIndex}`, label: group.name, groupHeader: group.name });
    for (const entry of byGroup.get(groupIndex) ?? []) {
      rows.push({
        key: `item-${entry.key}`,
        label: goalLabel(entry.item),
        // 权重是这把尺子的一部分，不带就无法解释总分是怎么来的（口径 6）
        render: (row) => {
          if (row.score === null) return '';
          const judgment = row.score.judgments.find((item) => item.id === entry.key);
          if (judgment === undefined) {
            return (
              <Badge variant="outline" className={RANK_BADGE_CLASSES.missing} data-tone="missing">
                缺少判定
              </Badge>
            );
          }
          const badge = (
            <Badge
              variant="outline"
              className={judgment.achieved ? RANK_BADGE_CLASSES.achieved : RANK_BADGE_CLASSES.missing}
              data-tone={judgment.achieved ? 'achieved' : 'not-achieved'}
            >
              {judgment.achieved ? '达成' : '未达成'}
            </Badge>
          );
          // 理由是这个表唯一能解释「为什么没达成」的东西；空理由不挂浮层（否则弹出一个空框）
          return judgment.reason === '' ? badge : <Hint label={judgment.reason}>{badge}</Hint>;
        },
      });
    }
  });
  return rows;
}

/**
 * 目标行的标签：**目标原文 + 权重的 Tag**。
 * 为什么权重单独包一个 Tag 而不是跟在文本后面：它是这一行的**另一类事实**（这一项值多少分），
 * 与目标原文（这一项要做什么）不是一句话；混在一行纯文本里只能靠一个分隔符区分，扫一列时眼睛要
 * 逐字读。Tag 把它定成一个可跳读的记号，也顺手把两种信息在视觉上分开。
 */
function goalLabel(item: RubricItem): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span>{item.goal}</span>
      <Badge variant="outline" data-tone="weight">
        {item.weight} 分
      </Badge>
    </div>
  );
}

/**
 * 总分那一段：**单元格只写这一行拿到的分**，满分写在左锁列的标签里（用户口径）。
 * 为什么满分不放单元格：各列都是同一把尺子量出来的，把 `100 / 100` 在每个候选下重复一遍
 * 只占宽度、不加信息；真正的对比发生在「谁拿了多少分」这一列上。
 * 满分取**有分的第一行**的 `score.maxScore`（它是这一分生成时那张表的权重之和，口径 6）：
 * 全列都没有分时标签就只写「总分」——没有尺子可报。
 * 措辞是「满分 N」（用户口径：短到一眼扫完；`总分` 二字由这一行的位置自己说清——它在最后一行）。
 */
function totalRow(rows: EvalRow[]): RankTableRow {
  const maxScore = rows.find((row) => row.score !== null)?.score?.maxScore;
  return {
    key: 'total',
    label: maxScore === undefined ? '总分' : `满分 ${maxScore}`,
    render: (row) => (row.score === null ? '' : <span className="font-medium">{row.score.totalScore}</span>),
  };
}

export interface RankTableProps {
  run: EvalRun;
  /**
   * 此刻正在执行的候选行数（`isRunningRow` 的行数，含准备与评分两段）。
   * 缺省 0 = 全部终态：那一行实时提示不渲染。数的是**行**而不是 `hasLiveRows(run)` 那个布尔
   * ——后者的轮级那一格（`status: 'running'` 而行还没翻状态）数不出 N，用它会出现
   * 「有 0 行正在执行」这种自相矛盾的句子。
   */
  runningCount?: number;
  /**
   * 测试结果的只读投影（`/api/runs/{id}/test-results`）。**缺省 = 读不到 / 还没读**，
   * 通过率那一列据此写「未采集」；传一个空 rows 也是同一句话，不会变成 0%。
   */
  testResults?: RunTestResults;
}

export function RankTable({ run, runningCount = 0, testResults }: RankTableProps): ReactNode {
  /**
   * 顺序与名次都取自 `run-detail-panel` 的同一份判据（口径 2）：本组件不重排、也不自己算名次。
   * 名次是**整轮行集**的性质（`rankOf(run.rows, row)`），故各处的 `rankOf` 一律传 `run.rows`。
   */
  const ordered = orderForDisplay(run.rows);

  const scoring = scoringRows(run);
  const tableRows: RankTableRow[] = [
    ...identityRows(run.rows),
    ...executionRows(),
    testPassRateRow(testResults),
    ...scoring,
    totalRow(run.rows),
  ];


  const labelColumn: DataTableColumn<RankTableRow> = {
    id: 'label',
    header: '',
    accessorKey: 'label',
    size: RANK_LABEL_WIDTH,
    pinned: 'start',
    // 装不下的长目标**折行**而不是截断：目标原文是读这一行的前提（见 `RANK_LABEL_WIDTH` 的注释）
    cell: ({ row }) =>
      row.original.groupHeader === undefined ? (
        <span className="text-muted-foreground">{row.original.label}</span>
      ) : (
        <span className="font-medium">{row.original.label}</span>
      ),
  };

  const candidateColumns: DataTableColumn<RankTableRow>[] = ordered.map((candidate) => ({
    id: candidate.id,
    header: '',
    size: RANK_CANDIDATE_WIDTH,
    cell: ({ row }) => (row.original.render === undefined ? '' : (row.original.render(candidate) ?? '')),
  }));

  return (
    <div
      className="flex flex-col gap-2"
      style={{ height: '100%', padding: 16, display: 'flex', flexDirection: 'column' }}
    >
      <div>
        <DataTable<RankTableRow>
          columns={[labelColumn, ...candidateColumns]}
          data={tableRows}
          rowKey={(row) => row.key}
          // 行高由内容决定（目标会折行）：虚拟化的固定行高前提在这里不成立
          virtualize={false}
          rowHeight={40}
          // **不显示表头**：列头没有任何内容（名次落在第一行里，见口径 1），
          // 留一行空白只占高度；固定列的吸边偏移按声明宽度算，与表头无关
          showHeader={false}
          // 滚动条的落点就是这一层（套件的滚动容器）：给它留一条下内边距，
          // 滚动条就落在表格与说明之间，而不是压在最后一行「总分」上
          scrollStyle={{ paddingBottom: RANK_SCROLLBAR_GUTTER }}
          tableAttributes={{ 'data-testid': 'rank-table' }}
          rowAttributes={(row) => ({
            'data-testid': `rank-table-row-${row.key}`,
            // 名次标记是**列序**的事实（不是某一格的事实），故只在名次那一行给
            'data-rank': row.key === 'rank' ? rankMarker(ordered.map((r) => rankOf(run.rows, r))) : '',
          })}
          cellAttributes={(row, columnId) =>
            columnId === 'label'
              ? {
                'data-testid': `rank-label-${row.key}`,
                // 长目标折行（中文与长串都没有词边界 ⇒ `break-word` 不够，要 `break-all`）：
                // 截断会让「这一项到底要做什么」看不见，而那是判断达成与否的前提
                style: { wordBreak: 'break-word' },
              }
              : { 'data-testid': `rank-cell-${row.key}-${columnId}` }
          }
          ariaLabel="排名"
        />
      </div>
      {/* 判据说明：**读这张表的规则**，贴在表下方（用户口径：把它从表格上方挪下来）。
          挂在这一层（而不是抽屉的 `title` 区）是为了不随表格的横向滚动一起动，
          窄屏下也不会被标题截断。 */}
      <span className="text-sm text-muted-foreground" data-testid="rank-criteria">
        {RANK_CRITERIA_TEXT}
      </span>
      {/* 实时提示：跑动中名次会自己跳，这句是给「截到一个中途快照」兜底的（有行在跑才出现） */}
      {runningCount > 0 && (
        <span className="text-sm text-warning" data-testid="rank-live-note">
          有 {runningCount} 行正在执行，名次可能变化
        </span>
      )}
    </div>
  );
}
