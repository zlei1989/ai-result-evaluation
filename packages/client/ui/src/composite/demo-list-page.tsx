'use client';

/**
 * 列表 + 右边栏示例页的**纯展示部分**（数据与选中态由应用层注入）。
 * 它的存在意义是验证脚手架：左栏列表 + 右栏可拖拽详情栏能否真的组合出来。
 * 功能阶段实现真实用例页时会以同一形态替换本页。
 */
import { Button, Card, Descriptions, Flex, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ReactNode } from 'react';
import { EllipsisText } from '../base/ellipsis-text';
import { EmptyState } from '../base/empty-state';
import { ListDetailLayout } from '../base/list-detail-layout';
import { Toolbar } from '../base/toolbar';
import { formatBytes, formatDateTime, shortHash } from '../base/format';

/**
 * 示例记录：字段与假数据文件保持一致。
 * 刻意**不**在本包重复声明业务类型——ui 包不 import 应用代码，
 * 应用层负责把业务模型映射成这里需要的展示字段（见 app/demo/page.tsx 的映射）。
 */
export interface DemoRecordView {
  id: string;
  title: string;
  path: string;
  hash: string;
  status: string;
  statusLabel: string;
  statusColor: string;
  size: number;
  updatedAt: string;
  note: string;
}

export interface DemoListPageProps {
  records: DemoRecordView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClear: () => void;
}

export function DemoListPage({ records, selectedId, onSelect, onCreate, onClear }: DemoListPageProps): ReactNode {
  const selected = records.find((record) => record.id === selectedId) ?? null;

  // 用 antd 顶层的 TableColumnsType（ColumnsType 的别名）——不要深路径导入 antd/es/*，
  // 那会绕开包的公开入口、且与「样式与组件一律走 antd」的口径不一致
  const columns: TableColumnsType<DemoRecordView> = [
    {
      title: '标题',
      dataIndex: 'title',
      // 长中文标题必须省略，否则会把列宽撑开、把右栏挤没
      render: (title: string) => <EllipsisText text={title} width={320} />,
    },
    {
      title: '路径',
      dataIndex: 'path',
      width: 260,
      render: (path: string) => <EllipsisText text={path} width={240} monospace />,
    },
    {
      title: '哈希',
      dataIndex: 'hash',
      width: 110,
      // 表格里只给短哈希，全量在 Tooltip 与详情栏里
      render: (hash: string) => <EllipsisText text={shortHash(hash)} width={90} monospace />,
    },
    {
      title: '状态',
      dataIndex: 'statusLabel',
      width: 96,
      render: (_: string, record) => <Tag color={record.statusColor}>{record.statusLabel}</Tag>,
    },
    {
      title: '大小',
      dataIndex: 'size',
      width: 96,
      align: 'right',
      render: (size: number) => formatBytes(size),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 150,
      render: (updatedAt: string) => formatDateTime(updatedAt),
    },
  ];

  const list = (
    <Flex vertical style={{ height: '100%', minHeight: 0 }}>
      <Toolbar title="示例记录" extra={<Button type="primary" size="small" onClick={onCreate}>新建示例</Button>} />
      {records.length === 0 ? (
        <EmptyState title="还没有记录" description="点右上「新建示例」加一条" action={{ label: '新建示例', onClick: onCreate }} />
      ) : (
        <Table<DemoRecordView>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={records}
          pagination={false}
          scroll={{ y: 'calc(100vh - 220px)' }}
          onRow={(record) => ({
            onClick: () => onSelect(record.id),
            style: record.id === selectedId ? { background: 'var(--app-selected)', cursor: 'pointer' } : { cursor: 'pointer' },
          })}
        />
      )}
    </Flex>
  );

  const detail = selected === null ? (
    <EmptyState title="未选中记录" description="点左侧任意一行查看详情" />
  ) : (
    <Flex vertical gap={8}>
      <Card
        size="small"
        title="记录详情"
        extra={
          <Button size="small" onClick={onClear}>
            关闭
          </Button>
        }
      >
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="标题">{selected.title}</Descriptions.Item>
          <Descriptions.Item label="路径">
            <Typography.Text code>{selected.path}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="完整哈希">
            <Typography.Text code>{selected.hash}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={selected.statusColor}>{selected.statusLabel}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="大小">{formatBytes(selected.size)}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{formatDateTime(selected.updatedAt)}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Card size="small" title="说明">
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{selected.note}</Typography.Paragraph>
      </Card>
    </Flex>
  );

  return (
    <ListDetailLayout
      list={list}
      detail={detail}
      detailOpen={selected !== null}
      widthStorageKey="demo-detail-width"
    />
  );
}
