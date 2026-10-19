// @vitest-environment node
/**
 * 表格迁移的源码形态守卫（静态扫描）。
 *
 * 三条判据，缺一条都会让「13 张表都走同一个套件」悄悄退回各自手搭：
 *   ① 清单里的每个文件都在渲染 `<DataTable>`——漏一张不会有任何运行期信号；
 *   ② 产品源码里不再出现裸 `<table>`（套件本体与 vendored 原语除外，例外逐条列在下面）；
 *   ③ `TableScrollArea` 已删除且没有引用——它那三件套（外层滚 + sticky 表头 + 手写最小宽度）
 *      是套件要退役的协议，留着就会被下一张表照抄。
 *
 * 为什么是读源码：13 张表分居两个包，其中评测列表落在 `apps/web-next`（该应用 `jsx: preserve`，
 * 不能写 `.tsx` 测试）；「有没有走套件」这件事只能在源码层钉。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '../../../../..');

/** 13 张表的清单（名字 → 渲染文件）：名字是报告与失败信息里的定位口径 */
export const TABLE_CONSUMERS: ReadonlyArray<readonly [name: string, file: string]> = [
  ['用例列表', 'packages/client/ui/src/composite/cases-table.tsx'],
  ['评测列表', 'apps/web-next/app/runs/page.tsx'],
  ['评测候选行', 'packages/client/ui/src/composite/run-create-panel.tsx'],
  ['供应商', 'packages/client/ui/src/composite/provider-table.tsx'],
  ['模型清单', 'packages/client/ui/src/composite/provider-models-modal.tsx'],
  ['模型挑选', 'packages/client/ui/src/composite/provider-model-import-modal.tsx'],
  ['MCP 服务器', 'packages/client/ui/src/composite/mcp-server-table.tsx'],
  ['MCP 键值', 'packages/client/ui/src/composite/mcp-server-form-modal.tsx'],
  ['MCP 粘贴预览', 'packages/client/ui/src/composite/mcp-paste-modal.tsx'],
  ['技能', 'packages/client/ui/src/composite/skill-table.tsx'],
  ['评分标准项', 'packages/client/ui/src/composite/rubric-table.tsx'],
  ['评分详情', 'packages/client/ui/src/composite/score-detail-view.tsx'],
  ['排名', 'packages/client/ui/src/composite/rank-table.tsx'],
];
// 计划清单（`agent-log/task-panel-card.tsx`）**不在这张清单里**：它不是表格，而是
// `Plan` 摘要行 + `Queue` 两段步骤（`TraceLine`）——把一件一件的待办塞进两列表格，
// 读「还剩几件」要在一列状态 Tag 里找颜色，正是那个形态要退役的原因。

/**
 * 允许保留裸 `<table>` 的文件。**逐个给理由**，新增例外必须先在这里说清楚：
 *   · `base/data-table.tsx`：套件本体，`<table>` 就在这里；
 *   · `components/ui/table.tsx`：vendored 原语的定义文件（不是任何一张业务表；
 *     产品表格不再引用它，保留是因为它仍在 `@aieval/ui` 的公开导出面上）。
 */
export const BARE_TABLE_EXCEPTIONS: ReadonlyArray<readonly [file: string, reason: string]> = [
  ['packages/client/ui/src/base/data-table.tsx', '套件本体'],
  ['packages/client/ui/src/components/ui/table.tsx', 'vendored 原语定义'],
];

/** 递归收集产品源码（跳过依赖、构建产物、过程目录与测试文件） */
function listSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.scratch') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSources(path));
    } else if (
      (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) &&
      !entry.name.includes('.test.')
    ) {
      files.push(path);
    }
  }
  return files;
}

const scanned = [
  ...listSources(join(repoRoot, 'packages/client/ui/src')),
  ...listSources(join(repoRoot, 'apps/web-next/app')),
  ...listSources(join(repoRoot, 'apps/web-next/src')),
];

function relative(file: string): string {
  return file.slice(repoRoot.length + 1);
}

describe('13 张表都走 DataTable 套件', () => {
  it('清单里的每一张表都渲染 <DataTable>', () => {
    const missing = TABLE_CONSUMERS.filter(([, file]) => {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      return !/<DataTable\b/.test(source);
    }).map(([name, file]) => `${name}（${file}）`);

    expect(missing, '这些表还没有换成 DataTable').toEqual([]);
  });

  it('产品源码里没有裸 <table>（例外逐条列在 BARE_TABLE_EXCEPTIONS）', () => {
    const exceptions = new Set(BARE_TABLE_EXCEPTIONS.map(([file]) => file));
    const violations = scanned
      .filter((file) => !exceptions.has(relative(file)))
      .filter((file) => /<table\b/.test(readFileSync(file, 'utf8')))
      .map(relative);

    expect(violations, '发现裸 <table>：要么迁到 DataTable，要么在例外清单里写明理由').toEqual([]);
  });
});

describe('TableScrollArea 退役', () => {
  it('文件已删除', () => {
    const file = join(repoRoot, 'packages/client/ui/src/base/table-scroll-area.tsx');
    expect(existsSync(file), 'TableScrollArea 还在（外层滚 + sticky 表头 + 手写最小宽度的协议）').toBe(false);
  });

  it('产品源码与导出面里没有 TableScrollArea / TABLE_SCROLL_STYLE 的引用', () => {
    const referencing = scanned
      .filter((file) => /TableScrollArea|\bTABLE_SCROLL_STYLE\b|table-scroll-area/.test(readFileSync(file, 'utf8')))
      .map(relative);

    expect(referencing, 'TableScrollArea 还有引用').toEqual([]);
  });
});

/**
 * 两个列表页（`/runs`、`/cases`）的**滚动与固定列**口径——原 `list-table-scroll-wiring.test.ts`
 * 里仍然有效的断言搬到这里：
 *   · 纵向滚动只能由套件的容器承担（不再有外层 `TableScrollArea`、也不许 `scroll={{ y }}`）；
 *   · 标题列（主标识）钉在起始侧，且宽度按声明值给——否则窄栏下标题先被压成省略号。
 */
describe('两个列表页的滚动与固定列口径', () => {
  const runsSource = readFileSync(join(repoRoot, 'apps/web-next/app/runs/page.tsx'), 'utf8');
  const casesSource = readFileSync(join(repoRoot, 'packages/client/ui/src/composite/cases-table.tsx'), 'utf8');
  const casesPage = readFileSync(join(repoRoot, 'apps/web-next/app/cases/page.tsx'), 'utf8');

  it('评测列表：标题列钉左并声明宽度，纵向滚动交给套件', () => {
    // `RUN_COLUMNS` 的第一项就是标题列：id + pinned + size 在同一段里
    expect(runsSource, '标题列没有钉在起始侧').toMatch(
      /id: 'caseTitle'[\s\S]{0,400}?size: RUN_COLUMN_WIDTH\.title,[\s\S]{0,200}?pinned: 'start'/,
    );
    // 页面不再自己包横向滚动容器，也不再给表格传纵向滚动
    expect(runsSource, '页面自己又包了一层横向滚动容器').not.toMatch(/overflow-x-auto/);
    expect(runsSource, '表格又传了 antd 的 scroll.y').not.toMatch(/scroll=\{\{[^}]*\by\s*:/);
  });

  it('用例列表：标题列钉左并声明宽度，页面不再套外层滚动容器', () => {
    expect(casesSource, '标题列没有钉在起始侧').toMatch(
      /id: 'title'[\s\S]{0,400}?size: CASES_TABLE_COLUMN_WIDTH\.title,[\s\S]{0,200}?pinned: 'start'/,
    );
    expect(casesPage, '用例页还包着外层滚动容器').not.toMatch(/TableScrollArea/);
    expect(casesPage, '用例页不再渲染 CasesTable').toMatch(/<CasesTable\b/);
  });
});
