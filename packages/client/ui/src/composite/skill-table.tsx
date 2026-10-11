'use client';

/**
 * 技能表格：名称 / 描述 / 启用（三列）+ 卡片内工具条（技能目录路径 + 计数 + 重新扫描）。
 * 纯展示：不调接口、不认识 hooks —— 「重新扫描」「点开一条」与「切启停」都以回调交给调用方。
 *
 * 八个必须守住的点：
 *   1. **三列、两处固定**（与供应商表同款）：卡片窄到装不下时表格**内部**横向滚动，
 *      名称钉在左边、启用钉在右边，描述从它们下面滑过。三处必须同时在场，少一处就静默退回
 *      「被压扁 / 滚出去够不到」的样子：`scroll={{ x: 数值 }}`、名称列 `fixed: 'left'`、
 *      启用列 `fixed: 'right'`。⚠️ jsdom 没有布局引擎，真实吸边只有真机冒烟量得出来；
 *      单测钉的是「列定义与两处 fixed 的存在」，**不假装量到了尺寸**；
 *   2. **坏条目照旧一行**：不可用的在名字后挂红 `Tag`、原因进 Tooltip（不占一列：「一行里两套状态
 *      会互相打架」，所以不单列「状态」）；描述照旧显示——它往往是判断「哪里不合格」的线索；
 *   3. **不显示来源路径列**：所有条目同根、前缀完全相同，这一列只是把同一个前缀重复 N 遍；
 *      路径在抽屉顶部。**也没有操作列**：这一页不做增删改；
 *   4. **两套空态是两句不同的话**：「技能目录还不存在」与「这个目录里还没有技能」——
 *      前者是首次使用（连目录都没有），后者是放过又清空了。混成一句会把「还没开始用」
 *      说成「你删光了」；
 *   5. **工具条上不给「上次扫描时间」**：清单是实时扫出来的，摆一个时间戳会让人以为这是一份快照；
 *   6. **开关键盘可达、可访问名带行名**：多行各有开关，只念「启用」屏读器分不出是哪一行；
 *   7. **开关是即时落盘的写入口，不做乐观翻转**：`checked` 只读服务端给的 `disabled`，点了等父层
 *      拿回新数据；写失败时 props 不变 ⇒ 开关停在原处 + 一句中文原因（翻转了再翻回去，用户只会
 *      以为是自己点错了）。**不可用的条目照样能切**——开关是用户的意图，不因当前磁盘状态而丢；
 *   8. 中文文案**全部显式给出**、按钮一律 `autoInsertSpace={false}`（antd 默认会在两个汉字中间插
 *      一个空格，渲染成 `重 新 扫 描`，可访问名随之不再等于文案）。
 */
import { ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Flex, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ReactNode } from 'react';
import type { SkillEntry, SkillWarning } from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { EmptyState } from '../base/empty-state';

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

/** 两列申报的宽度（`描述`刻意不给宽度，吃剩余宽度） */
const SKILL_COLUMN_WIDTH = { name: 220, enabled: 90 } as const;

/** 「描述」兜底的最小宽度：卡片窄到极限时，这一列至少还得读得出一句描述的开头 */
const DESCRIPTION_MIN_WIDTH = 320;

/**
 * 表格的最小宽度（px）：卡片窄于它时**才**横向滚动，并把名称列 / 启用列钉在两侧。
 * 220 + 320 + 90 = 630 是**坏掉与没坏掉的分界**，来历与 `PROVIDER_TABLE_MIN_WIDTH` 同款
 * （那一处有完整的推导与「为什么不能给 `true` / `'max-content'`」）。
 *
 * 名称列 220：这一格里住着**两样东西**——名称本身与「不可用」小标，而列宽固定 ⇒ 两者抢同一格。
 * 160px 时名称只剩 64px（`tang-poem-meal` 渲染成 `tang-…`），**主标识被截断，而描述那列还空着大半**；
 * 220 - 16（单元格内边距）= 204，够放下常见的两段式名字 + 4px 间隙 + 小标。
 */
const SKILL_TABLE_MIN_WIDTH = SKILL_COLUMN_WIDTH.name + DESCRIPTION_MIN_WIDTH + SKILL_COLUMN_WIDTH.enabled;

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

  const columns: TableColumnsType<SkillEntry> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: SKILL_COLUMN_WIDTH.name,
      // 钉在左边（见文件头第 1 点）：横向滚动时描述从它下面滑过，「这一行是谁」始终看得见
      fixed: 'left',
      render: (_value, skill) => (
        <Flex gap={4} align="center">
          <EllipsisText text={skill.name} strong />
          {/* 不可用只用标签表达，**不占一列**：一行里两套「状态」（可用性 + 启停）会互相打架 */}
          {!skill.ok && (
            <Tooltip title={skill.reason ?? '这一条现在不可用'}>
              <Tag color="red" data-testid="skill-bad-tag">
                不可用
              </Tag>
            </Tooltip>
          )}
        </Flex>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      // 不给宽度（与供应商表的「API 地址」同款）：它是唯一吃剩余宽度的列，省略号只在真的放不下时出现；
      // 「放不下」的分母由 `tableLayout="fixed"` + `scroll.x` 兜住
      render: (description: string) => <EllipsisText text={description} />,
    },
    {
      title: '启用',
      key: 'enabled',
      width: SKILL_COLUMN_WIDTH.enabled,
      // 钉在右边（见文件头第 1 点）：横向滚动时这一列始终够得到
      fixed: 'right',
      render: (_value, skill) => (
        <Switch
          size="small"
          // checked 读服务端算好的 disabled（界面不做「缺省 = 开启」的推理）
          checked={!skill.disabled}
          // 可访问名带上行名：只念「启用」的话屏读器与按名字定位的用例都分不出是哪一行
          aria-label={`启用 ${skill.name}`}
          // **不做乐观翻转**：这一格没有本地 state，点了就等父层拿服务端的新数据回来。
          // 写失败时父层那份 props 不变 ⇒ 开关停在原处 + 一句中文原因（翻转了再翻回去，
          // 用户只会以为是自己点错了）。**不可用的条目也照样能切**：开关是用户的意图，
          // 目录修好、名字改对之后那个意图立刻生效，禁用它的代价是「修好了还得回来再点一次」。
          onChange={(checked) => onToggle(skill, !checked)}
          // 掐断冒泡：行本身是抽屉的入口（`onRow` 的 onClick），不拦的话每切一次启停都会顶开预览抽屉。
          // ⚠️ antd 的 Switch 把 `onClick` 重定义成「先给 checked」的签名，事件在第 2 个参数上
          onClick={(_checked, event) => event.stopPropagation()}
        />
      ),
    },
  ];

  return (
    <Card size="small" data-testid="skill-table-card" title="技能">
      <Flex vertical gap={8}>
        {/* 工具条：根目录路径（只读）+ 计数 + 重新扫描。**不给「上次扫描时间」**（见文件头第 5 点） */}
        <Flex align="center" justify="space-between" gap={8} wrap>
          <Flex align="center" gap={8} style={{ minWidth: 0 }}>
            <Typography.Text type="secondary">技能目录</Typography.Text>
            {/* `minWidth: 0` 不是装饰：这一格是 flex 子项，默认 `min-width: auto` 会让它按内容撑开，
                `EllipsisText` 的 `max-width: 100%` 当场失效——长路径把工具条顶出去而不是显示省略号 */}
            <EllipsisText text={root} monospace />
          </Flex>
          <Flex align="center" gap={8}>
            <Typography.Text type="secondary" data-testid="skill-count">
              {countText}
            </Typography.Text>
            <Button size="small" autoInsertSpace={false} icon={<ReloadOutlined aria-hidden />} onClick={onRescan}>
              重新扫描
            </Button>
          </Flex>
        </Flex>
        <Table<SkillEntry>
          rowKey="name"
          size="small"
          columns={columns}
          dataSource={skills}
          loading={loading}
          pagination={false}
          // 必须给 `x`，且必须是数值：这一格就是「宽度不足」的判据本身（见 `SKILL_TABLE_MIN_WIDTH`）
          scroll={{ x: SKILL_TABLE_MIN_WIDTH }}
          // `fixed` 是「描述」那格省略号能成立的前提（列宽由表头算，`max-width: 100%` 才有分母）
          tableLayout="fixed"
          // 点一行开预览抽屉：这一页没有操作列，行本身就是入口
          onRow={(skill) => ({ onClick: () => onOpen(skill), style: { cursor: 'pointer' } })}
          locale={{
            emptyText: (
              <EmptyState
                title={rootMissing ? '技能目录还不存在' : '这个目录里还没有技能'}
                // 路径两处都给：工具条上是常显的那一份，空态里再写一遍省得用户回头找
                description={rootMissing ? `把 skill 放进这个目录即可：${root}` : '把 skill 放进这个目录即可'}
                action={{ label: '重新扫描', icon: <ReloadOutlined aria-hidden />, onClick: onRescan }}
              />
            ),
          }}
        />
      </Flex>
    </Card>
  );
}
