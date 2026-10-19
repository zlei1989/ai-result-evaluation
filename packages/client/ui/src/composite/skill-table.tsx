'use client';

/**
 * 技能表格：名称 / 描述 / 启用（三列）+ 卡片内工具条（技能目录路径 + 计数 + 重新扫描）。
 * 纯展示：不调接口、不认识 hooks —— 「重新扫描」「点开一条」与「切启停」都以回调交给调用方。
 *
 * 八个必须守住的点：
 *   1. **三列、两处固定**（与供应商表同款）：卡片窄到装不下时表格**内部**横向滚动，
 *      名称钉在左边、启用钉在右边，描述从它们下面滑过。列固定由 `columnPinning` 表达
 *      （`pinned: 'start' | 'end'` + 每列声明的 `size`）。⚠️ jsdom 没有布局引擎，真实吸边只有
 *      真机冒烟量得出来；单测钉的是「列定义与两处 pin 的存在」，**不假装量到了尺寸**；
 *   2. **坏条目照旧一行**：不可用的在名字后挂红标、原因进 Tooltip（不占一列：「一行里两套状态
 *      会互相打架」，所以不单列「状态」）；描述照旧显示——它往往是判断「哪里不合格」的线索；
 *   3. **不显示来源路径列**：所有条目同根、前缀完全相同，这一列只是把同一个前缀重复 N 遍；
 *      路径在抽屉顶部。**也没有操作列**：这一页不做增删改；
 *   4. **两套空态是两句不同的话**：「技能目录还不存在」与「这个目录里还没有技能」——
 *      前者是首次使用（连目录都没有），后者是放过又清空了。混成一句会把「还没开始用」
 *      说成「你删光了」；
 *   5. **工具条上不给「上次扫描时间」**：清单是实时扫出来的，摆一个时间戳会让人以为这是一份快照；
 *   6. **开关键盘可达、可访问名带行名**：多行各有开关，只念「启用」屏读器分不出是哪一行；
 *   7. **开关是即时落盘的写入口，不做乐观翻转**：`checked` 只读服务端给的 `disabled`，点了等父层
 *      拿回新数据；写失败时 props 不变 ⇒ 开关停在原处 + 一句中文原因。**不可用的条目照样能切**
 *      ——开关是用户的意图，不因当前磁盘状态而丢；
 *   8. 开关的点击必须掐断冒泡：行本身是抽屉入口，不拦的话每切一次启停都会顶开预览抽屉。
 */
import { RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SkillEntry, SkillWarning } from '@aieval/contracts';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { DataTable, type DataTableColumn } from '../base/data-table';
import { Switch } from '../components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';
import { SettingsEllipsis } from './settings-ellipsis';
import { SettingsEmpty } from './settings-empty';

export interface SkillTableProps {
  skills: SkillEntry[];
  /**
   * 根级异常（现在只有「目录不存在」这一种）：空态要说的话由它决定——
   * 「技能目录还不存在」与「这个目录里还没有技能」是两句不同的话。
   */
  skillWarnings: SkillWarning[];
  /** 技能根（工具条上的只读路径） */
  root: string;
  /** 点一行：打开正文预览抽屉 */
  onOpen: (skill: SkillEntry) => void;
  /**
   * 切这一条的启停：交出去的是**期望状态** `disabled`（开关显示的是「启用」，契约收的是停用），
   * 落盘由父层走 `PUT { skills: { entries: { <名>: { disabled } } } }`。
   * 失败由父层保持原值并报中文原因——组件这一侧不留状态（见启用列的注释）。
   */
  onToggle: (skill: SkillEntry, disabled: boolean) => void;
  /** 「重新扫描」：重新发一次清单请求（父层去刷缓存） */
  onRescan: () => void;
  loading?: boolean;
}

/** 三列声明的宽度（px）：名称 / 描述 / 启用。固定列的偏移输入就是这些声明值之和 */
const SKILL_COLUMN_WIDTH = { name: 220, description: 320, enabled: 90 } as const;

export function SkillTable({
  skills,
  skillWarnings,
  root,
  onOpen,
  onToggle,
  onRescan,
  loading = false,
}: SkillTableProps): ReactNode {
  const unusableCount = skills.filter((skill) => !skill.ok).length;
  // 计数只说两件事：有几条、其中几条现在不可用。逐条状态在行上，这里不重复
  const countText =
    unusableCount === 0 ? `共 ${skills.length} 条` : `共 ${skills.length} 条，其中 ${unusableCount} 条不可用`;
  const rootMissing = skillWarnings.some((warning) => warning.path === root);

  /** 三列定义：名称钉左、启用钉右（偏移来自声明的 `size`），描述列居中吃剩余宽度 */
  const columns: DataTableColumn<SkillEntry>[] = [
    {
      id: 'name',
      header: '名称',
      accessorKey: 'name',
      size: SKILL_COLUMN_WIDTH.name,
      pinned: 'start',
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <SettingsEllipsis text={row.original.name} strong />
          {/* 不可用只用标签表达，**不占一列**：一行里两套「状态」（可用性 + 启停）会互相打架 */}
          {!row.original.ok && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Badge
                      data-testid="skill-bad-tag"
                      variant="outline"
                      className="border-destructive/30 bg-destructive/10 text-destructive"
                    />
                  }
                >
                  不可用
                </TooltipTrigger>
                <TooltipContent>{row.original.reason ?? '这一条现在不可用'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      ),
    },
    {
      id: 'description',
      header: '描述',
      accessorKey: 'description',
      size: SKILL_COLUMN_WIDTH.description,
      cell: ({ row }) => <SettingsEllipsis text={row.original.description} />,
    },
    {
      id: 'enabled',
      header: '启用',
      accessorFn: (skill) => !skill.disabled,
      size: SKILL_COLUMN_WIDTH.enabled,
      pinned: 'end',
      cell: ({ row }) => (
        // 掐断冒泡：行本身是抽屉的入口（`onClick`），不拦的话每切一次启停都会顶开预览抽屉。
        // 包一层 `span` 而不是指望 Switch 的事件签名——原语是原生按钮语义，事件照常冒泡。
        <span onClick={(event) => event.stopPropagation()}>
          <Switch
            size="sm"
            // checked 读服务端算好的 disabled（界面不做「缺省 = 开启」的推理）
            checked={!row.original.disabled}
            // 可访问名带上行名：只念「启用」的话屏读器与按名字定位的用例都分不出是哪一行
            aria-label={`启用 ${row.original.name}`}
            // **不做乐观翻转**：这一格没有本地 state，点了就等父层拿服务端的新数据回来。
            // **不可用的条目也照样能切**：开关是用户的意图，目录修好之后那个意图立刻生效。
            onCheckedChange={(checked) => onToggle(row.original, !checked)}
          />
        </span>
      ),
    },
  ];

  return (
    <Card size="sm" data-testid="skill-table-card">
      <CardHeader>
        <CardTitle>技能</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          {/* 工具条：根目录路径（只读）+ 计数 + 重新扫描。**不给「上次扫描时间」**（见文件头第 5 点） */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-sm text-muted-foreground">技能目录</span>
              {/* `min-w-0` 不是装饰：这一格是 flex 子项，默认 `min-width: auto` 会让它按内容撑开，
                  `SettingsEllipsis` 的 `max-width: 100%` 当场失效——长路径把工具条顶出去而不是显示省略号 */}
              <SettingsEllipsis text={root} monospace />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground" data-testid="skill-count">
                {countText}
              </span>
              <Button size="sm" variant="outline" onClick={onRescan}>
                <RefreshCwIcon aria-hidden />
                重新扫描
              </Button>
            </div>
          </div>

          <div data-testid="skill-table-scroll">
            <DataTable
              columns={columns}
              // 描述列吃剩余宽度：技能名很短，余量给描述才读得到全文
              fillColumnId="description"
              data={skills}
              rowKey={(skill) => skill.name}
              rowHeight={40}
              virtualize={false}
              rowAttributes={(skill) => ({ className: 'cursor-pointer', onClick: () => onOpen(skill) })}
              emptyText={
                <SettingsEmpty
                  title={rootMissing ? '技能目录还不存在' : '这个目录里还没有技能'}
                  // 路径两处都给：工具条上是常显的那一份，空态里再写一遍省得用户回头找
                  description={rootMissing ? `把一个技能目录放进这里即可：${root}` : '把一个技能目录放进这里即可'}
                  actions={[
                    { label: '重新扫描', icon: <RefreshCwIcon aria-hidden />, onClick: onRescan },
                  ]}
                />
              }
              tableAttributes={{ 'aria-busy': loading }}
              ariaLabel="技能"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
