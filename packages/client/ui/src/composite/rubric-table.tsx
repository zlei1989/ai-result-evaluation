'use client';

/**
 * 评分标准项：可编辑的二级表格（组 → 评分项），用例表单与用例详情共用。
 *
 * 四条口径：
 *   1. **受控**：`value` / `onChange(next)`，本组件不持有状态。每次改动交给调用方**整张新表**
 *      （不做「改一格清掉别的」那种就地改写——那会让 React 看不出变化）；
 *   2. **权重默认给 1**：schema 与 `validateRubric` 都拒绝 0，故新项的初值必须是一个正数，
 *      否则用户点「添加评分项」之后立刻拿到一个非法状态；
 *   3. **写侧会拒的东西当场标出**：撞车的**引用键**（有 ID 用 ID、没写 ID 的项按位置分配 `#k`——
 *      键一律取自契约的 `rubricItemKeys`，本组件**不自己拼第二套**）与**超过 `MAX_ITEM_WEIGHT`
 *      的权重**（`validateRubric` 不查上限，它由 `RubricSchema` 在提交时才拒）都当场标红 +
 *      在表格上方点名。用户不该等到点「确定」才知道。空 ID 不算重复（它们没有身份）；
 *   4. `readOnly` 供用例详情复用：不渲染任何增删控件，也不渲染输入框。
 *
 * 行内「标红」靠 `aria-invalid`：新栈的 `Input` 用它触发 `border-destructive` 与聚焦环，
 * 同时屏读器也会读出「这一格不合法」——只画一条红边等于对读屏用户没有信号。
 */
import {
  MAX_ITEM_WEIGHT,
  rubricItemKeys,
  rubricMaxScore,
  validateRubric,
  type Rubric,
  type RubricGroup,
  type RubricItem,
} from '@aieval/contracts';
import type { ReactNode } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Input } from '../components/ui/input';
import { DataTable, type DataTableColumn } from '../base/data-table';

export interface RubricTableProps {
  value: Rubric;
  onChange: (next: Rubric) => void;
  /** 只读形态（用例详情）：不渲染任何增删控件 */
  readOnly?: boolean;
  /**
   * 是否显示校验红字。
   *
   * 默认 `true`（详情 / 设置页这类「已经在用的表」随时可以说它不合规）；新建表单必须由调用方在
   * **用户动过或提交过之后**才置 true——空表是新建的合法初值，一进来就飘红等于先判用户有罪。
   */
  validationVisible?: boolean;
}

/** 新评分项的初值：权重给 1（0 会被 schema 与 validateRubric 拒掉） */
const NEW_ITEM: RubricItem = { id: '', goal: '', weight: 1 };

/** 表格的一行 = 一个评分项 + 它在组内的序号（`rowKey` 与 Controller 的定位都靠它） */
interface RubricRow {
  item: RubricItem;
  index: number;
}

/** 表尾汇总：满分 = 全部项权重之和。它同时是用户自查权重配置的唯一手段（满分不强制是 100） */
export function RubricSummaryText({ rubric }: { rubric: Rubric }): ReactNode {
  const count = rubric.groups.reduce((total, group) => total + group.items.length, 0);
  // 空表不写「满分 0 分」：那是「一张 0 分的尺子」，读起来像结论；它其实只是还没开始配
  if (count === 0) {
    return <p className="text-sm text-muted-foreground">还没有评分项 · 满分随评分项自动计算</p>;
  }
  return (
    <p className="text-sm text-muted-foreground">
      满分 {rubricMaxScore(rubric)} 分 · 共 {count} 项
    </p>
  );
}

export function RubricTable({
  value,
  onChange,
  readOnly = false,
  validationVisible = true,
}: RubricTableProps): ReactNode {
  /** 校验结果：表格上方直接显示原因（用户不该等到点「确定」才知道哪一格有问题） */
  const validation = validateRubric(value);
  /**
   * 全表的**引用键**按组切开：`keysByGroup[g][i]` = 第 g 组第 i 项的引用键。
   *
   * 键**一律取自契约的 `rubricItemKeys`**（它在 `rubric.ts` 里自述是「引用键生成的唯一实现」），
   * 本组件不再自己拼一套：手写那套只覆盖「字符串相等」，漏掉「没写 ID 的项按 `#k` 按位置引用」这一半——
   * `[{ id: '' }, { id: '#1' }]` 在写侧是两把相同的键（`validateRubric` 会拒），
   * 而在「按 id 字符串比较」的判据下两把键都不算重复，表格一个红框都不给。
   * `rubricItemKeys` 的展平顺序就是「组序 → 项序」，与表格行的顺序逐行对齐，故按各组的项数切片即可。
   */
  const keysByGroup = ((): string[][] => {
    const keys = rubricItemKeys(value);
    const sliced: string[][] = [];
    let cursor = 0;
    for (const group of value.groups) {
      sliced.push(keys.slice(cursor, cursor + group.items.length));
      cursor += group.items.length;
    }
    return sliced;
  })();

  /** 第 g 组第 i 项的引用键。越界给 `''`：真键要么是 ID、要么是 `#k`，永远不是空串，故不会误判成撞车 */
  const keyAt = (groupIndex: number, itemIndex: number): string => keysByGroup[groupIndex]?.[itemIndex] ?? '';

  /** 撞车的引用键（出现 > 1 次）：行内红框就是它，判据与写侧同一份 */
  const duplicatedKeys = ((): Set<string> => {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const keys of keysByGroup) {
      for (const key of keys) {
        if (seen.has(key)) duplicated.add(key);
        seen.add(key);
      }
    }
    return duplicated;
  })();

  /** 该组是否含撞车的引用键：徽标只挂在真有问题的组上（挂在 `groups.map` 里会让三组的表挂三个徽标，冤枉两组） */
  const groupHasDuplicatedKey = (groupIndex: number): boolean =>
    keysByGroup[groupIndex]?.some((key) => duplicatedKeys.has(key)) ?? false;

  /**
   * 权重超过上限的项：上界 `MAX_ITEM_WEIGHT` 是契约**给本表**设的（防「手滑多按几个 0」），
   * 但 `validateRubric` **不查上限**（只查正整数）——它由 `RubricSchema` 在提交那一步才拒。
   * 表格若不自己标出来，用户就会「点着点着进了非法状态，直到点确定才知道」，
   * 正是引用键撞车那条口径要避免的事。上界只从契约取，这里不写第二个数字。
   */
  const overweight: { groupIndex: number; itemIndex: number; weight: number }[] = [];
  for (const [groupIndex, group] of value.groups.entries()) {
    for (const [itemIndex, item] of group.items.entries()) {
      if (item.weight > MAX_ITEM_WEIGHT) overweight.push({ groupIndex, itemIndex, weight: item.weight });
    }
  }

  /**
   * 表格上方那一句：**先显示 `validateRubric`**（写侧 / 表单提交 / 设置页用的是同一份判据），
   * 它通过了才轮到「超上限」这条补充提示（理由见 `overweight`）——不另立第二套提示组件。
   */
  const validationMessage = ((): string | undefined => {
    if (!validation.ok) return validation.message;
    const first = overweight[0];
    if (first === undefined) return undefined;
    return `第 ${first.groupIndex + 1} 组的第 ${first.itemIndex + 1} 项权重 ${first.weight} 超过了上限 ${MAX_ITEM_WEIGHT}：提交会被拒绝`;
  })();

  /** 整表替换某一组（其余组原样）。**按 groupIndex 定位，不按对象引用反查**——两项内容完全相同时反查会永远命中的是第一组 */
  const replaceGroup = (groupIndex: number, items: RubricItem[]): void => {
    onChange({ groups: value.groups.map((group, index) => (index === groupIndex ? { ...group, items } : group)) });
  };

  /** 改一项的某个字段（其余原样） */
  const patchItem = (groupIndex: number, itemIndex: number, patch: Partial<RubricItem>): void => {
    const items = value.groups[groupIndex]?.items ?? [];
    replaceGroup(
      groupIndex,
      items.map((item, index) => (index === itemIndex ? { ...item, ...patch } : item)),
    );
  };

  /** 操作列：编辑态才有（只读形态不渲染任何增删控件），按组的当前项集删这一行 */
  const actionColumn = (groupIndex: number, group: RubricGroup): DataTableColumn<RubricRow> => ({
    id: 'actions',
    header: '',
    size: 72,
    cell: ({ row }) => {
      const { index } = row.original;
      return (
        <Button
          size="xs"
          variant="ghost"
          data-testid={`rubric-remove-item-${groupIndex}-${index}`}
          onClick={() => replaceGroup(groupIndex, group.items.filter((_, itemIndex) => itemIndex !== index))}
        >
          删除
        </Button>
      );
    },
  });

  const columnsFor = (groupIndex: number, group: RubricGroup): DataTableColumn<RubricRow>[] => [
    {
      id: 'id',
      header: 'ID',
      size: 96,
      accessorFn: (row) => row.item.id,
      cell: ({ row: { original: { item, index } } }) =>
        readOnly ? (
          // 「这一项写没写 ID」**只有一条判据**：`trim()` 之后为空 = 没写（与 `rubricItemKeys` 内部
          // 决定「用 ID 还是用按位置的 `#k`」的那一行为同一条）。写成 `item.id === ''` 会让
          // 纯空白 ID 在只读态渲染成一段空白——同一个问题在同一个表格里出现两个答案。
          <span>{item.id.trim() === '' ? '—' : item.id}</span>
        ) : (
          <Input
            value={item.id}
            aria-invalid={duplicatedKeys.has(keyAt(groupIndex, index))}
            aria-label={`第 ${groupIndex + 1} 组第 ${index + 1} 项的 ID`}
            data-testid={`rubric-item-id-${groupIndex}-${index}`}
            onChange={(event) => patchItem(groupIndex, index, { id: event.target.value })}
          />
        ),
    },
    {
      id: 'goal',
      header: '目标',
      size: 360,
      accessorFn: (row) => row.item.goal,
      cell: ({ row: { original: { item, index } } }) =>
        readOnly ? (
          <span>{item.goal}</span>
        ) : (
          <Input
            value={item.goal}
            placeholder="既说清改哪里，也说清怎样算达成"
            aria-label={`第 ${groupIndex + 1} 组第 ${index + 1} 项的目标`}
            data-testid={`rubric-item-goal-${groupIndex}-${index}`}
            onChange={(event) => patchItem(groupIndex, index, { goal: event.target.value })}
          />
        ),
    },
    {
      id: 'weight',
      header: '权重',
      size: 96,
      accessorFn: (row) => row.item.weight,
      cell: ({ row: { original: { item, index } } }) =>
        readOnly ? (
          <span>{item.weight}</span>
        ) : (
          <Input
            type="number"
            min={1}
            // 上界与 schema 同一个常量（`RubricSchema` 的 `.max(MAX_ITEM_WEIGHT)`）：
            // 没有它，用户能一路敲到提交才被拒（`validateRubric` 不查上限，见 `overweight` 的注释）
            max={MAX_ITEM_WEIGHT}
            value={item.weight}
            aria-invalid={item.weight > MAX_ITEM_WEIGHT}
            aria-label={`第 ${groupIndex + 1} 组第 ${index + 1} 项的权重`}
            data-testid={`rubric-item-weight-${groupIndex}-${index}`}
            // 清空输入框（`''`）与解析不出数字时落回 1：权重 0 会被 schema 与 validateRubric 拒掉，
            // 让用户点着点着就进一个非法状态是可用性问题
            onChange={(event) => {
              const next = Number(event.target.value);
              patchItem(groupIndex, index, { weight: Number.isFinite(next) && next >= 1 ? next : 1 });
            }}
          />
        ),
    },
    ...(readOnly ? [] : [actionColumn(groupIndex, group)]),
  ];

  return (
    <div className="flex flex-col gap-2">
      {/* 校验原因直接显示在表格上方：用户不该等到点「确定」才知道哪一格有问题。
          首判据是写侧 / 表单提交 / 设置页共用的**同一份** `validateRubric`（这里只显示它）；
          「超过权重上限」那一条不在 `validateRubric` 里（它由 `RubricSchema` 在提交时才拒），
          故由 `validationMessage` 在 `validateRubric` 通过之后补上——不另立第二套提示组件。
          `validationVisible=false` 时（新建表单、用户还没动过）空表不飘红，只说一句中性的下一步。 */}
      {!readOnly && validationMessage !== undefined && validationVisible && (
        <p className="text-sm text-destructive" role="alert" data-testid="rubric-validation-error">
          {validationMessage}
        </p>
      )}
      {!readOnly && !validationVisible && value.groups.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="rubric-empty-hint">
          还没有评分项。先添加一组，再给每项写目标与权重；满分随评分项自动计算。
        </p>
      )}
      {value.groups.map((group, groupIndex) => (
        <Card key={`rubric-group-${groupIndex}`} size="sm" data-testid={`rubric-group-${groupIndex}`}>
          <CardHeader>
            <CardTitle className="flex min-w-0 items-center gap-2">
              {readOnly ? (
                <span className="font-medium">{group.name}</span>
              ) : (
                <Input
                  value={group.name}
                  placeholder="组名，例如：一、生产代码"
                  aria-label={`第 ${groupIndex + 1} 组的组名`}
                  data-testid={`rubric-group-name-${groupIndex}`}
                  onChange={(event) =>
                    onChange({
                      groups: value.groups.map((candidate, index) =>
                        index === groupIndex ? { ...candidate, name: event.target.value } : candidate,
                      ),
                    })
                  }
                />
              )}
            </CardTitle>
            {readOnly ? null : (
              <CardAction>
                <Button
                  size="xs"
                  variant="destructive"
                  data-testid={`rubric-remove-group-${groupIndex}`}
                  onClick={() => onChange({ groups: value.groups.filter((_, index) => index !== groupIndex) })}
                >
                  删除组
                </Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {!readOnly && groupHasDuplicatedKey(groupIndex) && (
                <Badge variant="destructive">引用键有重复</Badge>
              )}
            </div>
            <DataTable
              columns={columnsFor(groupIndex, group)}
              data={group.items.map((item, index) => ({ item, index }))}
              rowKey={(record) => `${groupIndex}-${record.index}`}
              virtualize={false}
              rowHeight={40}
              ariaLabel={`${group.name || `第 ${groupIndex + 1} 组`}的评分项`}
            />
            {readOnly ? null : (
              <Button
                size="xs"
                variant="outline"
                className="self-start border-dashed"
                data-testid={`rubric-add-item-${groupIndex}`}
                onClick={() => replaceGroup(groupIndex, [...group.items, { ...NEW_ITEM }])}
              >
                添加评分项
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
      {!readOnly && (
        <Button
          size="xs"
          variant="outline"
          className="self-start border-dashed"
          data-testid="rubric-add-group"
          onClick={() => onChange({ groups: [...value.groups, { name: '', items: [{ ...NEW_ITEM }] }] })}
        >
          添加分组
        </Button>
      )}
      <RubricSummaryText rubric={value} />
    </div>
  );
}
