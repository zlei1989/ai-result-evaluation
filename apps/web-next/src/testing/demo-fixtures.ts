/**
 * 示例页假数据（**仅 /demo 使用**）。
 * 字段刻意覆盖后续真实需求会用到的渲染难点：长中文标题、深路径、40 位哈希、
 * 五态枚举、字节数、ISO 时间、多段长文本（用来验证右栏内部滚动）。
 * 功能阶段实现真实用例页后，本文件随 /demo 一并删除。
 */

/** 状态枚举：用来验证 Tag 的五态颜色映射 */
export type DemoStatus = 'draft' | 'running' | 'done' | 'failed' | 'skipped';

export interface DemoRecord {
  id: string;
  title: string;
  path: string;
  hash: string;
  status: DemoStatus;
  size: number;
  updatedAt: string;
  note: string;
}

/** 状态 → 中文标签与 Tag 颜色 */
export const DEMO_STATUS_META: Record<DemoStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  running: { label: '运行中', color: 'processing' },
  done: { label: '已完成', color: 'success' },
  failed: { label: '失败', color: 'error' },
  skipped: { label: '已跳过', color: 'warning' },
};

export const DEMO_RECORDS: DemoRecord[] = [
  {
    id: '1',
    title: '为多协议入站补齐 Anthropic 到 Chat 的转换与流式回归',
    path: 'D:\\projects\\gateway\\lib\\convert\\anthropic-to-chat.ts',
    hash: '71e628091bf7134a6e677a58cc1e0f29b9302e6f',
    status: 'done',
    size: 18_432,
    updatedAt: '2026-09-22T02:30:00.000Z',
    note: '这一行用来验证右栏的内部滚动。\n\n正文可能很长：提交说明、评分理由、执行日志摘要都会落在这里，而右栏宿主默认 overflow:hidden，不给 auto 就会被裁掉且没有滚动条。\n\n第三段用来把内容撑到超过视口高度，这样「页面本身不出现纵向滚动条、右栏内部出现滚动条」这条断言才有意义。',
  },
  {
    id: '2',
    title: '修复流式响应在 in-band error 下的方言选择',
    path: 'D:\\projects\\gateway\\lib\\streaming\\driver.ts',
    hash: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    status: 'running',
    size: 4_096,
    updatedAt: '2026-09-22T03:10:00.000Z',
    note: '运行中的记录：卡片上应显示 processing 状态的 Tag。',
  },
  {
    id: '3',
    title: '工具名长度校验与 id 分配器',
    path: 'D:\\projects\\gateway\\lib\\tool-id.ts',
    hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    status: 'failed',
    size: 1_024,
    updatedAt: '2026-09-21T22:05:00.000Z',
    note: '失败记录：错误信息在详情栏里要可读、可定位。',
  },
  {
    id: '4',
    title: '结构化输出的 schema 归一化',
    path: 'D:\\projects\\gateway\\lib\\convert\\structured-output.ts',
    hash: 'ffffffffffffffffffffffffffffffffffffffff',
    status: 'skipped',
    size: 512,
    updatedAt: '2026-09-21T18:44:00.000Z',
    note: '被跳过的记录：串行模式下用户终止时未轮到的行就是这一态。',
  },
  {
    id: '5',
    title: '草稿：请求上下文透传',
    path: 'D:\\projects\\gateway\\lib\\request-context.ts',
    hash: '0123456789abcdef0123456789abcdef01234567',
    status: 'draft',
    size: 0,
    updatedAt: '2026-09-20T09:00:00.000Z',
    note: '0 字节用来验证 formatBytes 的边界显示。',
  },
  // 其余 7 条：字段结构相同，用于把列表撑到需要滚动、验证虚拟滚动之外的常规滚动
  ...Array.from({ length: 7 }, (_, index): DemoRecord => {
    const n = index + 6;
    return {
      id: String(n),
      title: `示例记录 ${n}：列表需要足够长才能验证滚动与固定表头`,
      path: `D:\\projects\\gateway\\lib\\module-${n}\\index.ts`,
      hash: `${n}`.repeat(40).slice(0, 40),
      status: 'done',
      size: n * 13_107,
      updatedAt: `2026-09-${String(10 + index).padStart(2, '0')}T08:00:00.000Z`,
      note: `第 ${n} 条记录的说明文本。`,
    };
  }),
];
