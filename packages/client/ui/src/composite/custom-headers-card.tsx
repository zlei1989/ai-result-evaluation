'use client';

/**
 * 「自定义请求头」卡：一张可增删的两列表（左键名 / 右键值），一个「保存」。
 * 纯展示：不调接口，保存走 `onSave`；异步与错误提示留在调用方（本组件不认识 `message`）。
 *
 * 六个刻意的取舍：
 *   1. **必须显式保存**（与「界面主题」那种一改就落的开关不同）：这里一次要填好几行，逐行落盘会让
 *      「填了一半的名字」先被保存、再被自己下一击覆盖；而且用户改完半张表之前不该被发到网关。
 *      代价是「改了没点保存」——所以「保存」在有未保存改动时是主按钮，「还原」负责把那半张表扔掉。
 *   2. **键名按 HTTP 口径校验，并把撞名指到具体哪一行**：`X-Trace` 与 `x-trace` 发出去只有一条，
 *      界面上却有两行。契约层的 schema 拦得住落盘，但拦不住用户在这里造出它——两行同时标红，
 *      比下面一句「不能重复」有用得多。
 *   3. **空行不提交**：刚点「添加一行」得到的空行是**草稿**，不是一条头。整张表都空的行直接丢弃；
 *      只填了值没填名的行**拦下保存**（那不是草稿，是填了一半——静默丢掉等于用户以为自己配上了）。
 *   4. **保存前折叠成 map**：两列在界面上是数组，落盘与出站都是 map（HTTP 头同名只有一份）。
 *      折叠规则是「后出现的赢」，与用户从上往下读的顺序一致。
 *   5. **进入编辑时以服务端那份为准**（`headers` 变了一次就重灌一次）：保存后会拿到新的一份
 *      （含掩码），重灌让「已保存」这个词与界面上的内容始终对得上。判据是 `headers` 的**内容**而不是
 *      对象引用——父组件每次渲染都可能给出新对象。
 *   6. **按钮一律 `autoInsertSpace={false}`**：antd 默认给两个汉字之间插一个空格，渲染成 `保 存`，
 *      可访问名随之不再等于文案，按名字定位按钮也会失配。
 *
 * 「每一行一个 `id`」是渲染的稳定键：删掉中间一行时 key 不能变，否则 antd 的输入框会串行
 * （表现为「删了第二行，第三行的字跳到了第二行」）。
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Flex, Input, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  CUSTOM_HEADER_KEY_MESSAGE,
  CUSTOM_HEADER_VALUE_MESSAGE,
  MCP_HEADER_KEY_PATTERN,
  type CustomHeaders,
} from '@aieval/contracts';

/** 编辑中的一行：`id` 只服务于渲染键（不落盘、不发给任何人） */
interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

export interface CustomHeadersCardProps {
  /** 已保存的那份（服务端出口形态：敏感值已掩码） */
  headers: CustomHeaders;
  /** 保存在跑：三个按钮一起置灰（避免半截状态里继续点） */
  saving: boolean;
  /** 「保存」：交出折叠好的整张表（空表 = 一条都不发） */
  onSave: (headers: CustomHeaders) => void;
}

/** 把落盘那份转成编辑行（顺序即 map 的插入顺序，稳定） */
function rowsOf(headers: CustomHeaders): HeaderRow[] {
  return Object.entries(headers).map(([name, value], index) => ({ id: index, name, value }));
}

/**
 * 行级的形状问题（`null` = 这一行没问题）。判据与契约 schema **同源**（`MCP_HEADER_KEY_PATTERN` /
 * 值里不许换行），只是把「一张表」的规则拆到「一行」上——撞名要看整张表，另行处理。
 */
function rowIssue(row: HeaderRow): string | null {
  if (row.name === '') {
    // 名字空而值也空 = 刚加的空行（调用方按草稿丢弃）；只填了值 = 填了一半，要拦
    return row.value === '' ? null : '这一行还没填键名';
  }
  if (!MCP_HEADER_KEY_PATTERN.test(row.name)) return CUSTOM_HEADER_KEY_MESSAGE;
  if (/[\r\n]/.test(row.value)) return CUSTOM_HEADER_VALUE_MESSAGE;
  return null;
}

/** 撞名（忽略大小写）的那几个行 id：两行都要标红，用户才知道跟谁撞了 */
function duplicateIds(rows: readonly HeaderRow[]): Set<number> {
  const firstById = new Map<string, number>();
  const duplicated = new Set<number>();
  for (const row of rows) {
    if (row.name === '') continue;
    const folded = row.name.toLowerCase();
    const first = firstById.get(folded);
    if (first === undefined) {
      firstById.set(folded, row.id);
      continue;
    }
    duplicated.add(first);
    duplicated.add(row.id);
  }
  return duplicated;
}

export function CustomHeadersCard({ headers, saving, onSave }: CustomHeadersCardProps): ReactNode {
  const [rows, setRows] = useState<HeaderRow[]>(() => rowsOf(headers));
  // 下一行的渲染键：只增不减，删行之后新加的行也不会与还活着的那几行撞 key
  const nextId = useRef(rows.length);

  // 服务端那份变了（打开页面 / 保存之后回包）⇒ 重灌。判据是**内容**：父组件每次渲染都给新对象，
  // 按引用比会在用户打字中途被清空（与 `ProviderFormModal` 的「重灌只依赖 id」同一条理由）
  const savedJson = JSON.stringify(headers);
  const lastSaved = useRef(savedJson);
  if (lastSaved.current !== savedJson) {
    lastSaved.current = savedJson;
    setRows(rowsOf(headers));
  }

  const update = (id: number, patch: Partial<Omit<HeaderRow, 'id'>>): void => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const addRow = (): void => {
    const id = nextId.current;
    nextId.current += 1;
    setRows((current) => [...current, { id, name: '', value: '' }]);
  };
  const removeRow = (id: number): void => {
    setRows((current) => current.filter((row) => row.id !== id));
  };
  /** 还原成已保存那份（扔掉未保存的输入） */
  const reset = (): void => {
    setRows(rowsOf(headers));
  };

  const duplicates = duplicateIds(rows);
  /** 每一行的问题：形状问题或撞名（撞名优先显示——它比格式错误更常见于真实操作） */
  const issues = new Map<number, string>();
  for (const row of rows) {
    if (duplicates.has(row.id)) {
      issues.set(row.id, '键名重复（HTTP 头名不区分大小写）');
      continue;
    }
    const issue = rowIssue(row);
    if (issue !== null) issues.set(row.id, issue);
  }
  /** 有没有一条**不是草稿**的非法行：有就拦下保存，并在卡头说清为什么 */
  const hasInvalid = issues.size > 0;
  /** 折叠成要保存的那张表：丢掉整行空白的草稿行，其余按出现顺序写（同名后者覆盖前者——但撞名已被拦下） */
  const draft: CustomHeaders = {};
  for (const row of rows) {
    if (row.name === '' && row.value === '') continue;
    draft[row.name] = row.value;
  }
  const dirty = JSON.stringify(draft) !== savedJson;
  const canSave = !saving && !hasInvalid && dirty;

  return (
    <Card
      title="自定义请求头"
      size="small"
      data-testid="custom-headers-card"
      extra={
        <Flex gap={8}>
          {/* 带图标的按钮必须显式给 `aria-label`：antd 的图标自带 `role="img" aria-label="plus"`，
              会被并进可访问名（念成「plus 添加一行」），按名字定位按钮也就失配了 */}
          <Button
            size="small"
            icon={<PlusOutlined />}
            autoInsertSpace={false}
            aria-label="添加一行"
            disabled={saving}
            onClick={addRow}
          >
            添加一行
          </Button>
          <Button
            size="small"
            autoInsertSpace={false}
            aria-label="保存"
            disabled={!canSave}
            loading={saving}
            onClick={() => onSave(draft)}
          >
            保存
          </Button>
          <Button
            size="small"
            autoInsertSpace={false}
            aria-label="还原"
            disabled={saving || !dirty}
            onClick={reset}
          >
            还原
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={8}>
        <Typography.Text type="secondary">
          这几条头会挂到四家智能体发往网关的每一次模型请求上（不含 MCP 等子请求）。键名里带 key / token /
          secret / password / auth 的值不回显，界面上看到的是掩码——按原样保存即可，留空同样表示「不改」。
        </Typography.Text>
        {hasInvalid && (
          <Alert type="warning" showIcon title="有填了一半或不合法的行：改掉之后才能保存（保存会替换整张表）" />
        )}
        {rows.length === 0 ? (
          <Typography.Text type="secondary">还没有自定义请求头：点「添加一行」后保存。</Typography.Text>
        ) : (
          rows.map((row) => (
            <Flex key={row.id} gap={8} align="start">
              <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Input
                  size="small"
                  placeholder="键名，例如 X-Trace-Id"
                  value={row.name}
                  status={issues.has(row.id) ? 'error' : undefined}
                  aria-label={`第 ${rows.indexOf(row) + 1} 行的键名`}
                  onChange={(event) => update(row.id, { name: event.target.value })}
                />
                {issues.has(row.id) && (
                  <Typography.Text type="danger">{issues.get(row.id)}</Typography.Text>
                )}
              </Flex>
              <Input
                size="small"
                style={{ flex: 1, minWidth: 0 }}
                placeholder="键值"
                value={row.value}
                aria-label={`第 ${rows.indexOf(row) + 1} 行的键值`}
                onChange={(event) => update(row.id, { value: event.target.value })}
              />
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label={`删除第 ${rows.indexOf(row) + 1} 行`}
                autoInsertSpace={false}
                disabled={saving}
                onClick={() => removeRow(row.id)}
              />
            </Flex>
          ))
        )}
      </Flex>
    </Card>
  );
}
