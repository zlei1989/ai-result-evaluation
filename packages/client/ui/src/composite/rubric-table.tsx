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
 * 样式一律走 antd（主题 token / 紧凑密度），不手写字号、不裸写 div 做布局。
 * 按钮形态一律 `color` + `variant` **成对**给：antd 6 里 `variant` 单给会被**静默**降级成实线
 * （`variant="dashed"` 渲染成实线且没有任何可观察信号，同一处说明见 `base/empty-state.tsx`）。
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
import { Button, Card, Flex, Input, InputNumber, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ReactNode } from 'react';

export interface RubricTableProps {
  value: Rubric;
  onChange: (next: Rubric) => void;
  /** 只读形态（用例详情）：不渲染任何增删控件 */
  readOnly?: boolean;
}

/** 新评分项的初值：权重给 1（0 会被 schema 与 validateRubric 拒掉） */
const NEW_ITEM: RubricItem = { id: '', goal: '', weight: 1 };

/** 表尾汇总：满分 = 全部项权重之和。它同时是用户自查权重配置的唯一手段（满分不强制是 100） */
export function RubricSummaryText({ rubric }: { rubric: Rubric }): ReactNode {
  const count = rubric.groups.reduce((total, group) => total + group.items.length, 0);
  return (
    <Typography.Text type="secondary">
      满分 {rubricMaxScore(rubric)} 分 · 共 {count} 项
    </Typography.Text>
  );
}

export function RubricTable({ value, onChange, readOnly = false }: RubricTableProps): ReactNode {
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

  /** 该组是否含撞车的引用键：Tag 只挂在真有问题的组上（挂在 `groups.map` 里会让三组的表挂三个 Tag，冤枉两组） */
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

  /**
   * 某一组的列定义。**必须按组生成**（闭包捕获 groupIndex），不能用一份共享的 columns
   * 再去数据里反查组索引——那在「两项内容完全相同」时会改错项（典型场景：连点两次「添加评分项」）。
   */
  const columnsFor = (groupIndex: number, group: RubricGroup): TableColumnsType<{ item: RubricItem; index: number }> => [
    {
      title: 'ID',
      width: 96,
      render: (_, { item, index }) =>
        readOnly ? (
          // 「这一项写没写 ID」**只有一条判据**：`trim()` 之后为空 = 没写（与 `rubricItemKeys` 内部
          // 决定「用 ID 还是用按位置的 `#k`」的那一行为同一条）。写成 `item.id === ''` 会让
          // 纯空白 ID 在只读态渲染成一段空白——同一个问题在同一个表格里出现两个答案。
          <Typography.Text>{item.id.trim() === '' ? '—' : item.id}</Typography.Text>
        ) : (
          <Input
            size="small"
            value={item.id}
            status={duplicatedKeys.has(keyAt(groupIndex, index)) ? 'error' : undefined}
            data-testid={`rubric-item-id-${groupIndex}-${index}`}
            onChange={(event) => patchItem(groupIndex, index, { id: event.target.value })}
          />
        ),
    },
    {
      title: '目标',
      render: (_, { item, index }) =>
        readOnly ? (
          <Typography.Text>{item.goal}</Typography.Text>
        ) : (
          <Input
            size="small"
            value={item.goal}
            placeholder="既说清改哪里，也说清怎样算达成"
            data-testid={`rubric-item-goal-${groupIndex}-${index}`}
            onChange={(event) => patchItem(groupIndex, index, { goal: event.target.value })}
          />
        ),
    },
    {
      title: '权重',
      width: 96,
      render: (_, { item, index }) =>
        readOnly ? (
          <Typography.Text>{item.weight}</Typography.Text>
        ) : (
          <InputNumber
            size="small"
            min={1}
            // 上界与 schema 同一个常量（`RubricSchema` 的 `.max(MAX_ITEM_WEIGHT)`）：
            // 没有它，用户能一路敲到提交才被拒（`validateRubric` 不查上限，见 `overweight` 的注释）
            max={MAX_ITEM_WEIGHT}
            value={item.weight}
            status={item.weight > MAX_ITEM_WEIGHT ? 'error' : undefined}
            data-testid={`rubric-item-weight-${groupIndex}-${index}`}
            // `null`（清空输入框）落回 1：权重 0 会被 schema 与 validateRubric 拒掉，
            // 让用户点着点着就进一个非法状态是可用性问题
            onChange={(next) => patchItem(groupIndex, index, { weight: next ?? 1 })}
          />
        ),
    },
    ...(readOnly
      ? []
      : [
        {
          title: '',
          width: 72,
          render: (_: unknown, { index }: { item: RubricItem; index: number }) => (
            <Button
              size="small"
              color="default"
              variant="text"
              autoInsertSpace={false}
              data-testid={`rubric-remove-item-${groupIndex}-${index}`}
              onClick={() => replaceGroup(groupIndex, group.items.filter((_, itemIndex) => itemIndex !== index))}
            >
              删除
            </Button>
          ),
        },
      ]),
  ];

  return (
    <Flex vertical gap={8}>
      {/* 校验原因直接显示在表格上方：用户不该等到点「确定」才知道哪一格有问题。
          首判据是写侧 / 表单提交 / 设置页共用的**同一份** `validateRubric`（这里只显示它）；
          「超过权重上限」那一条不在 `validateRubric` 里（它由 `RubricSchema` 在提交时才拒），
          故由 `validationMessage` 在 `validateRubric` 通过之后补上——不另立第二套提示组件。 */}
      {!readOnly && validationMessage !== undefined && (
        <Typography.Text type="danger" data-testid="rubric-validation-error">
          {validationMessage}
        </Typography.Text>
      )}
      {value.groups.map((group, groupIndex) => (
        <Card
          key={`rubric-group-${groupIndex}`}
          size="small"
          data-testid={`rubric-group-${groupIndex}`}
          title={
            readOnly ? (
              <Typography.Text strong>{group.name}</Typography.Text>
            ) : (
              <Flex align="center" gap={8}>
                <Input
                  size="small"
                  value={group.name}
                  placeholder="组名，例如：一、生产代码"
                  data-testid={`rubric-group-name-${groupIndex}`}
                  onChange={(event) =>
                    onChange({
                      groups: value.groups.map((candidate, index) =>
                        index === groupIndex ? { ...candidate, name: event.target.value } : candidate,
                      ),
                    })
                  }
                />
                {groupHasDuplicatedKey(groupIndex) && <Tag color="error">引用键有重复</Tag>}
              </Flex>
            )
          }
          extra={
            readOnly ? undefined : (
              <Button
                size="small"
                danger
                autoInsertSpace={false}
                data-testid={`rubric-remove-group-${groupIndex}`}
                onClick={() => onChange({ groups: value.groups.filter((_, index) => index !== groupIndex) })}
              >
                删除组
              </Button>
            )
          }
        >
          <Table
            size="small"
            rowKey={(record) => `${groupIndex}-${record.index}`}
            pagination={false}
            dataSource={group.items.map((item, index) => ({ item, index }))}
            columns={columnsFor(groupIndex, group)}
          />
          {!readOnly && (
            <Button
              size="small"
              color="default"
              variant="dashed"
              autoInsertSpace={false}
              data-testid={`rubric-add-item-${groupIndex}`}
              onClick={() => replaceGroup(groupIndex, [...group.items, { ...NEW_ITEM }])}
            >
              添加评分项
            </Button>
          )}
        </Card>
      ))}
      {!readOnly && (
        <Button
          size="small"
          color="default"
          variant="dashed"
          autoInsertSpace={false}
          data-testid="rubric-add-group"
          onClick={() => onChange({ groups: [...value.groups, { name: '', items: [{ ...NEW_ITEM }] }] })}
        >
          添加分组
        </Button>
      )}
      <RubricSummaryText rubric={value} />
    </Flex>
  );
}
