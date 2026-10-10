'use client';

/**
 * MCP 服务器新增 / 编辑弹窗：名称 + 传输 +（两支各一套字段）。
 * 纯展示：不调接口，保存走回调；异步与错误提示留在调用方（本组件不认识 message）。
 *
 * 六个刻意的取舍（每条都对应一个真实会伤到用户的情形）：
 *   1. **传输切换清空另一支字段**：不清的话 `transport` 一改，上一支填过的 `url` / `command`
 *      会留在表单里，改成 http 再保存时 stdio 那半截被契约 strip 掉——用户以为填了，落盘里没有。
 *      清空是**就地做**的（`changeTransport`），不额外弹提示：切过去之后那一整套字段**当场换掉**，
 *      可见的形状变化本身就是「上一支不在了」的信号（另一个方案 `preserve: false` 会把另一支的
 *      未保存输入直接销毁，用户切回来发现白填了，比多留一个空字段更伤）。
 *   2. **值留空 = 不修改**（掩码放 `placeholder`）：界面拿到的是掩码（服务端出口形态），
 *      原样回传会把真密钥覆盖成掩码串（症状要到下次运行以 401 现身）。服务端 `preserveUnchangedSecrets`
 *      认两种信号（空串 / 与掩码逐字相同），表单这一侧对应的写法就是**值格留空**；
 *      占位符回显当前值，是为了让用户知道「现在有个值，不填就是它」。
 *      ⚠️ 这条语义要**端到端**成立，那个空串必须真的进 PUT：`buildMcpConfig` 因此收 `current`，
 *      对「留空 + 原有条目里已有这个键」的行交空串——把它们整条丢掉等于在补丁里删掉那个键（见它的 JSDoc）。
 *   3. **撞名不拦、只提示**：名字住在 map 的键上 ⇒ 保存到已有名字 = **覆盖**那一条。
 *      这是合法操作（贴进来的配置常需要覆盖），所以提示文案是「已存在，保存会覆盖」而不是「名字重复」。
 *   4. **`args` 一行一个参数**：一个 TextArea 比可增删的行更省事，也更好从命令行粘贴过来。
 *      空行会被丢掉（粘贴时常带尾随空行），但**参数内部的空格保留**——`--browser chrome` 是一个参数。
 *   5. **表单用 `forceRender` 常挂载 + effect 重灌初值**，重灌只依赖 `open` 与被编辑那条的**名字**：
 *      列表每次刷新都会给出新的对象，依赖它会让 effect 在用户打字中途清空输入（同 `ProviderFormModal`）。
 *   6. **按钮一律 `autoInsertSpace={false}`**（含 Modal 页脚）：antd 默认给两个汉字的标签中间插一个空格
 * （渲染成 `保存`），可访问名随之不再等于文案，按名字定位按钮也会失配。
 *
 * 「测试连接」：入口在表单底部，用**当前表单值**测、**不落盘**——保存仍然只由「保存」按钮触发。
 * 请求本身由 `onTest` 注入（组件不调接口）；loading 与结论都留在这个弹窗里。
 *
 * 本组件**不含**：「粘贴 JSON」弹窗（它自成一个 composite，见 `mcp-paste-modal.tsx`）。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Flex, Form, Input, Modal, Radio, Table, Tooltip, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  MCP_ENV_KEY_PATTERN,
  MCP_NAME_PATTERN,
  type McpProbeResult,
  type McpServerConfig,
  type McpServers,
} from '@aieval/contracts';
import { McpProbeResultView, McpProbeWaiting, type McpProbeOutcome } from './mcp-probe-result';

/** 键值两列表的一行：`env` 与 `headers` 共用同一形状（两处表格长得一样、语义也一样） */
export interface McpKeyValueRow {
  key: string;
  value: string;
}

/**
 * 键值编辑表的操作列宽：只够一个图标按钮（口径同 `MODEL_COLUMN_WIDTH.actions`）。
 * 与供应商模型弹窗那张 small Table 一样：**文字按钮在这一列里会占掉半张表**，宽度该还给输入格。
 */
export const MCP_KEY_VALUE_COLUMN_WIDTH = { actions: 44 } as const;

/** 表单载荷：`url` / `command` / `args` / `env` / `headers` 全在，靠 `transport` 决定用哪一支 */
export interface McpServerFormValues {
  name: string;
  transport: McpServerConfig['transport'];
  url: string;
  command: string;
  /** 一行一个参数（空行忽略），比可增删的行更省事、也更好从命令行粘过来 */
  args: string;
  env: McpKeyValueRow[];
  headers: McpKeyValueRow[];
}

export interface McpServerFormModalProps {
  open: boolean;
  /** 正在编辑的那一条；null = 新增。名字单独给：它住在 map 的键上，不在条目里 */
  initialName: string | null;
  initial: McpServerConfig | null;
  /** 现有服务器（含自己）：即时查重要用整张表 */
  servers: McpServers;
  saving: boolean;
  onSubmit: (values: McpServerFormValues) => void;
  onCancel: () => void;
  /**
   * 「测试连接」：交出去的是**当前表单值**（不是已保存的那份），返回本次探活的结论。
   * 调用方负责把它变成 `probeMcpServer({ entry })`（**不落盘**）。不传时按钮禁用并说明原因。
   */
  onTest?: (values: McpServerFormValues) => Promise<McpProbeResult>;
}

/**新增态的空白初值：默认 stdio（本地命令是更常见的一类， 的 playwright 就是它） */
const EMPTY: McpServerFormValues = {
  name: '',
  transport: 'stdio',
  url: '',
  command: '',
  args: '',
  env: [],
  headers: [],
};

/** 弹窗宽度：两列键值表要放得下「变量名 + 值」两格（窄了值格只剩几个字符） */
export const MCP_FORM_MODAL_WIDTH = 640;

/**
 * `McpServerConfig` → 表单初值：两张表各摊成行数组，args 拼成多行文本（反向变换见 `buildMcpConfig`）。
 *
 * ⚠️ **值格一律置空**，当前值只以**占位符**回显（见下）。这不是偷懒，是「值留空 = 不修改」那条语义的
 * 落点：界面拿到的是**掩码**（服务端出口形态），把掩码灌进值格里，用户一按保存就把真密钥覆盖成
 * `ctx-***-0001` —— 症状要到下次运行以 401 才现身（这一格预填掩码时，
 * 「留空 = 不修改」在界面上就是假的）。
 */
function toFormValues(name: string, config: McpServerConfig): McpServerFormValues {
  // 只搬**键**：值留空，占位符回显当前值（掩码或明文原样，出口给的是什么就显示什么）
  const rowsOf = (map: Record<string, string> | undefined): McpKeyValueRow[] =>
    Object.entries(map ?? {}).map(([key]) => ({ key, value: '' }));
  if (config.transport === 'http') {
    return {
      ...EMPTY,
      name,
      transport: 'http',
      url: config.url,
      headers: rowsOf(config.headers),
    };
  }
  return {
    ...EMPTY,
    name,
    transport: 'stdio',
    command: config.command,
    args: (config.args ?? []).join('\n'),
    env: rowsOf(config.env),
  };
}
/**
 * 被编辑那条**同传输**的键值表（`http` 看 `headers`、`stdio` 看 `env`）。
 * 传输被改过（或本来就没有这一条）⇒ `undefined`：另一支的键名在这一支里无从谈起，
 * 而切换传输时那一支的字段已被 `changeTransport` 就地清空。
 */
function editedValues(
  values: McpServerFormValues,
  current: McpServerConfig | undefined,
): Record<string, string> | undefined {
  if (current === undefined || current.transport !== values.transport) return undefined;
  return current.transport === 'http' ? current.headers : current.env;
}

/**
 * 表单值 → 契约条目。
 *
 * 三条口径都落在这一处（组件与用例共用，避免「界面显示的」与「保存下去的」各算一遍）：
 *   · **值格留空**分两种：这一格在**被编辑那条里已经存在**（`current` 的同传输键集合里有它）
 * ⇒ **交空串**——服务端把「敏感键 + 空串」认作未改动、换回落盘原值；
 *     它是**新键**（原有条目里没有） ⇒ **整条丢掉**：空值对服务端没有意义（`KEY: ''` 只是文件里的噪音）；
 *   · 键名为空串的残行一律丢掉（用户点了「添加请求头」还没填完）；
 *   · `args` 按行切、**丢掉空行**、参数内部空格保留。
 *
 * 为什么必须收 `current`：`mcpServers` 是**整份 map 替换**，
 * 而表单里每一格的值都是空的（当前值只在 placeholder 上，见 `toFormValues`）。把空值行**一律丢掉**
 * 等于在补丁里**删掉那个键**⇒ 打开 `context7` 的编辑弹窗、一个字不改直接保存，
 * `headers.CONTEXT7_API_KEY` 就从 `config.json` 里消失（真密钥被抹掉，症状要到下次运行以 401 现身）。
 * 交出去的空串则是对服务端说的那句「这一格我没动」。
 *
 * ⚠️ `current` 是**出口形态**的那一条（页面手上那份，敏感值是掩码）——它只用来回答「这个键原来在不在」，
 * 值一个字节都不从这里走（值格为空时交空串，非空时交用户输入）。
 */
export function buildMcpConfig(values: McpServerFormValues, current?: McpServerConfig): McpServerConfig {
  const known = editedValues(values, current);
  const toMap = (rows: McpKeyValueRow[]): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const row of rows) {
      if (row.key === '') continue;
      // 留空 + 原有条目里没有这个键 ⇒ 丢掉；留空 + 原来就有 ⇒ 交空串（= 未改动）
      if (row.value === '' && known?.[row.key] === undefined) continue;
      map[row.key] = row.value;
    }
    return map;
  };
  if (values.transport === 'http') {
    const headers = toMap(values.headers);
    return {
      transport: 'http',
      enabled: true,
      url: values.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  const args = values.args
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const env = toMap(values.env);
  return {
    transport: 'stdio',
    enabled: true,
    command: values.command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/** 键值两列表（`env` 与 `headers` 共用）：可增删、键名规则由调用方给（env 严、headers 只要非空） */
function KeyValueList({
  name,
  addLabel,
  keyLabel,
  valueLabel,
  keyPlaceholder,
  keyRules,
  valuePlaceholder,
}: {
  name: 'env' | 'headers';
  addLabel: string;
  keyLabel: string;
  valueLabel: string;
  keyPlaceholder: string;
  keyRules: { validator: (rule: unknown, value: unknown) => Promise<void> }[];
  /**
   * 值格的占位符，按**键**取当前值：编辑态回显「留空 = 不修改（当前：…）」。
   * 为什么逐行现算而不是给一句统一的提示：密钥是**逐键**的（`CONTEXT7_API_KEY` 有值、`Accept` 没有），
   * 一句统括的话在「这一行本来就没值」的画面上是假话，用户会以为不填就会保留某个并不存在的东西。
   */
  valuePlaceholder: (key: unknown) => string;
}): ReactNode {
  // 取外层 Form 实例（本组件不自己建 Form）：占位符要读**键格**当前的值
  const form = Form.useFormInstance();
  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        /**
         * 键值行 = **small Table**（对齐模型供应商弹窗里那张模型清单的效果）。
         * 四条与那张表一致的口径：
         *   · `size="small"` + **隐藏表头**：两格的含义由输入框的 `aria-label` 与占位符承担，
         *     表头只是把同样的话再说一遍，还多占一行高度；
         *   · 操作列**右对齐、只放一个图标按钮**：两个汉字的文字按钮在这一列里会占掉半张表，
         *     可访问名靠 `aria-label`（Tooltip 不产生可访问名）；
         *   · 列宽**显式给**（值列吃掉剩余）：`tableLayout` 一旦按内容算，输入框会把列挤成不可预期的宽度；
         *   · 行身份用 `Form.List` 给的 `field.key`，不用下标：删中间一行时按下标复用会把值串行错位。
         */
        <Flex vertical gap={4}>
          {fields.length > 0 && (
            <Table
              size="small"
              rowKey="key"
              // 弹窗里不分页：这几行就是全部（翻页只会把「我正要改的那一行」藏起来）
              pagination={false}
              showHeader={false}
              dataSource={fields}
              data-testid={`mcp-key-value-${name}`}
              columns={[
                {
                  title: keyLabel,
                  width: '42%',
                  render: (_value, field) => (
                    <Form.Item name={[field.name, 'key']} rules={keyRules} style={{ marginBottom: 0 }}>
                      {/* 可访问名给**输入框自己**的 `aria-label`：挂在 `Form.Item` 上会落在外层行 div 上，
                          进不了输入框（屏读器与按名字定位的用例都读不到「这一格是什么」） */}
                      <Input size="small" aria-label={keyLabel} placeholder={keyPlaceholder} />
                    </Form.Item>
                  ),
                },
                {
                  title: valueLabel,
                  render: (_value, field) => (
                    // `shouldUpdate` 让值格在**任意表单值**变化时重渲染：占位符得跟着键格走
                    // （用户改了键名，提示要换到新键的当前值上）
                    <Form.Item name={[field.name, 'value']} shouldUpdate style={{ marginBottom: 0 }}>
                      <Input
                        size="small"
                        aria-label={valueLabel}
                        placeholder={valuePlaceholder(form.getFieldValue([name, field.name, 'key']) as unknown)}
                      />
                    </Form.Item>
                  ),
                },
                {
                  title: '操作',
                  width: MCP_KEY_VALUE_COLUMN_WIDTH.actions,
                  align: 'right',
                  render: (_value, field) => (
                    <Tooltip title="删除这一行">
                      <Button
                        size="small"
                        type="text"
                        danger
                        aria-label={`删除这一行${keyLabel}`}
                        icon={<DeleteOutlined aria-hidden />}
                        onClick={() => remove(field.name)}
                      />
                    </Tooltip>
                  ),
                },
              ]}
            />
          )}
          <Button
            size="small"
            color="default"
            variant="dashed"
            icon={<PlusOutlined aria-hidden />}
            autoInsertSpace={false}
            onClick={() => add({ key: '', value: '' })}
            // 虚线按钮不跟着表格拉满整行（拉满了它读起来像「再加一整块」而不是「再加一行」）
            style={{ alignSelf: 'flex-start' }}
          >
            {addLabel}
          </Button>
        </Flex>
      )}
    </Form.List>
  );
}

export function McpServerFormModal(props: McpServerFormModalProps): ReactNode {
  const { open, initialName, initial, servers, saving, onSubmit, onCancel, onTest } = props;
  const [form] = Form.useForm<McpServerFormValues>();
  const isEdit = initialName !== null && initial !== null;
  /** 探活在跑 + 本次探活的结论（与表格行内那份共用渲染，见 `mcp-probe-result.tsx`） */
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<McpProbeOutcome | null>(null);

  /**
   * 用**当前表单值**测一次，不落盘。
   * 先 `validateFields`：空端点地址 / 空命令测不出任何结论，而「点了没反应」比一条红字更难懂；
   * 校验红字由 antd 自己显示，这里不重复说话。校验通过才发请求，并把结论就地渲染出来。
   */
  const runTest = async (): Promise<void> => {
    if (onTest === undefined) return;
    let values: McpServerFormValues;
    try {
      values = await form.validateFields();
    } catch {
      // 校验失败：字段上已经有中文红字（`请填写端点地址` 这类），这里刻意不再叠一句
      return;
    }
    setTesting(true);
    setOutcome(null);
    try {
      setOutcome({ kind: 'result', result: await onTest(values) });
    } catch (error) {
      // 请求本身失败（网络断 / 500 / 条目被删）：折成结果区的第三种内容，不冒充探活档位
      setOutcome({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  /**
   * 键 → 当前值（只读被编辑那一条的**原始值**，这里不做任何加工）。
   * 为什么原样回显而不是只给敏感键：用户要判断的是「这一格不填会保留什么」，
   * 而出入口的口径是一致的——界面拿到的本来就是出口形态（敏感值已是掩码），
   * 这里再掩一次反而会与 `placeholder` 里显示的东西对不上。
   */
  const currentHeaderValue = (key: unknown): string | undefined =>
    typeof key === 'string' && initial?.transport === 'http' ? initial.headers?.[key] : undefined;
  const currentEnvValue = (key: unknown): string | undefined =>
    typeof key === 'string' && initial?.transport === 'stdio' ? initial.env?.[key] : undefined;

  // 依赖里只放 open 与被编辑那条的名字，**不放对象本身**：列表每次刷新都会给出新对象，
  // 放进来会让 effect 在用户打字中途重灌表单、清掉没保存的输入。
  useEffect(() => {
    if (!open) return;
    // 先 resetFields 再 setFieldsValue：只 setFieldsValue 会把上一次失败的校验红字留在界面上
    form.resetFields();
    // 上一次的探活结论也必须撤掉：它对应的是**上一份**输入，留着会被读成「本次也测过了」
    setOutcome(null);
    setTesting(false);
    form.setFieldsValue(initial !== null && initialName !== null ? toFormValues(initialName, initial) : EMPTY);
  }, [open, initialName, initial, form]);

  /**
   * 传输切换：清空另一支的字段 + 提示。
   * 清空必须在这里**显式**做：antd 的 `preserve` 默认 true，被隐藏字段的值仍留在表单里，
   * 不改传输直接保存就会把上一支那半截一起交出去（然后被契约 strip 掉，用户以为填了）。
   */
  const changeTransport = (next: McpServerConfig['transport']): void => {
    if (next === 'http') {
      form.setFieldsValue({ command: '', args: '', env: [] });
    } else {
      form.setFieldsValue({ url: '', headers: [] });
    }
    // 清掉刚显现那一支的校验红字：字段是刚挂上来的，红字只会让人以为「还没填就错了」
    form.setFields([]);
  };

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => form.submit()}
      onCancel={onCancel}
      width={MCP_FORM_MODAL_WIDTH}
      // 「保存」/「取消」都是两个汉字：不关掉 autoInsertSpace，可访问名会是「保 存」/「取 消」
      okButtonProps={{ autoInsertSpace: false }}
      cancelButtonProps={{ autoInsertSpace: false }}
      // 表单要始终连着 useForm 实例，否则首次打开时 setFieldsValue 落空（值灌不进去）。
      // 刻意**不用** destroyOnHidden：与 forceRender 叠加会在「打开」这一帧留下「表单尚未挂载」的窗口。
      forceRender
    >
      <Form form={form} layout="vertical" size="small" initialValues={EMPTY} onFinish={(values) => onSubmit(values)}>
        <Form.Item
          name="name"
          label="名称"
          // 规则顺序 = 提示优先级（`validateFirst`）：空名字只说「请填写名称」，不再叠一条字符集的红字
          validateFirst
          rules={[
            { required: true, message: '请填写名称' },
            {
              /**
               * 字符集——**只是警告，不拦保存**。
               * 故意的：真源在契约（`MCP_NAME_PATTERN` 的 zod 校验），服务端会以中文拦下并给出原因；
               * 这里拦死的话，同一条规则就有两个实现、两句会各自漂移的文案（契约一放宽长度，
               * 表单就成了那个静默的拦路者）。提示留着，拦截归契约；文案与契约那条逐字一致。
               */
              pattern: MCP_NAME_PATTERN,
              message: '名称只能是字母、数字、下划线或连字符，长度 1–32',
              warningOnly: true,
            },
            {
              /**
               * 即时查重：命中已有名字**只提示、不拦保存**，文案是「保存会覆盖」——
               * 名字住在 map 的键上，保存到已有名字 = 覆盖那一条，这是**合法操作**（贴进来的配置常需要它）。
               * `warningOnly` 是这条语义的唯一正确写法：写成真规则时，想覆盖的用户会**存不下去**，
               * 而界面上那句「保存会覆盖」当场成了假话（阻塞式规则下点保存毫无反应）。
               * 编辑态排除自己：不改名时不提示「已存在」。
               */
              validator: (_rule, value: unknown) => {
                if (typeof value !== 'string' || value === '' || value === initialName) return Promise.resolve();
                if (!(value in servers)) return Promise.resolve();
                return Promise.reject(new Error('已存在，保存会覆盖'));
              },
              warningOnly: true,
            },
          ]}
        >
          <Input placeholder="如 context7" />
        </Form.Item>

        {/* 应用没有配 antd locale，缺 message 的规则会渲染英文默认文案：这条规则今天不可能触发
            （新建初值就是 stdio，Radio 又不能取消选中），补 message 只是把英文默认出口堵死 */}
        <Form.Item name="transport" label="传输" rules={[{ required: true, message: '请选择传输方式' }]}>
          <Radio.Group data-testid="mcp-transport" onChange={(event) => changeTransport(event.target.value as McpServerConfig['transport'])}>
            <Radio value="stdio">stdio（本地命令）</Radio>
            <Radio value="http">http（远端端点）</Radio>
          </Radio.Group>
        </Form.Item>

        {/* 两支字段的显隐由**表单当前值**决定（切换传输要换一整套字段）。
            这里用 `Form.Item` 的 `shouldUpdate` 渲染函数而不是 `Form.useWatch`：
            `useWatch('transport', form)` 在「effect 里 setFieldsValue 初值」这条路径上**没有**被通知到，
            点 http 单选后 `form.getFieldValue('transport')` 已是 'http' 而渲染分支仍停在 stdio ——
            症状是「单选框跳过去了、字段还是上一支的」，而所有断言都还绿。
            `shouldUpdate` 由 Field 的更新机制直接驱动，不依赖 watch 的注册时机。 */}
        <Form.Item noStyle shouldUpdate>
          {(boundForm) => ((boundForm as { getFieldValue: (name: string) => unknown }).getFieldValue('transport') ?? 'stdio') === 'http' ? (
            <>
              <Form.Item name="url" label="端点地址" rules={[{ required: true, message: '请填写端点地址' }]}>
                <Input placeholder="https://mcp.example.com/mcp" />
              </Form.Item>
              <Form.Item label="请求头">
                <KeyValueList
                  name="headers"
                  addLabel="添加请求头"
                  keyLabel="请求头名"
                  valueLabel="请求头值"
                  keyPlaceholder="如 Authorization"
                  valuePlaceholder={(key) =>
                    currentHeaderValue(key) === undefined ? '留空 = 不修改' : `留空 = 不修改（当前：${currentHeaderValue(key)}）`
                  }
                  keyRules={[
                    {
                      validator: (_rule, value: unknown) =>
                        typeof value === 'string' && value !== ''
                          ? Promise.resolve()
                          : Promise.reject(new Error('请填写请求头名')),
                    },
                  ]}
                />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="command" label="命令" rules={[{ required: true, message: '请填写命令' }]}>
                <Input placeholder="如 npx" />
              </Form.Item>
              <Form.Item name="args" label="参数" extra="一行一个参数；空行会被忽略">
                <Input.TextArea rows={3} placeholder={'如\n-y\n@playwright/mcp@latest'} />
              </Form.Item>
              <Form.Item label="环境变量">
                <KeyValueList
                  name="env"
                  addLabel="添加环境变量"
                  keyLabel="变量名"
                  valueLabel="值"
                  keyPlaceholder="如 CONTEXT7_API_KEY"
                  valuePlaceholder={(key) =>
                    currentEnvValue(key) === undefined ? '留空 = 不修改' : `留空 = 不修改（当前：${currentEnvValue(key)}）`
                  }
                  keyRules={[
                    {
                    // 键名规则来自契约（`MCP_ENV_KEY_PATTERN`）：带 `=` / 空格 / 点号在子进程环境里
                    // 行为不可控，早报比晚报好；这里只是把它变成表单上的一行中文提示
                      validator: (_rule, value: unknown) => {
                        if (typeof value !== 'string' || value === '') {
                          return Promise.reject(new Error('请填写变量名'));
                        }
                        return MCP_ENV_KEY_PATTERN.test(value)
                          ? Promise.resolve()
                          : Promise.reject(new Error('变量名只能是字母、数字与下划线，且不以数字开头'));
                      },
                    },
                  ]}
                />
              </Form.Item>
            </>
          )}
        </Form.Item>

        {/* 尾巴这三块**自成一条 12px 节奏**（`Form.Item` 给不出这个间距：它们不是字段）：
            提示语 → 测试入口（含结果区） → 「值留空 = 不修改」的说明。
            为什么不能让它们当**兄弟**节点：它们之间是 **0px**——Alert 直接贴在
            测试连接那一行下面，而表单里相邻字段的节奏是 24px，那一处「贴着」正是视觉上不对的来源 */}
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            值里可以写 {'${环境变量名}'}，注入时才解析（密钥因此不必落盘）
          </Typography.Text>

          {/* 表单里的测试入口：测的是**手上这份还没保存的输入**。
              与行内那个入口共用同一个结果区组件，故两处说出来的话逐字一致 */}
          <Flex vertical gap={4}>
            <Flex gap={8} align="center">
              <Button
                size="small"
                autoInsertSpace={false}
                disabled={onTest === undefined}
                loading={testing}
                title={onTest === undefined ? '当前不可用' : undefined}
                onClick={() => void runTest()}
              >
                测试连接
              </Button>
              <Typography.Text type="secondary">用当前表单值测，不落盘</Typography.Text>
            </Flex>
            {testing && <McpProbeWaiting />}
            {!testing && outcome !== null && <McpProbeResultView outcome={outcome} />}
          </Flex>
          {isEdit && (
            <Alert
              type="info"
              showIcon
              title="值留空 = 不修改"
              description="当前值以占位符回显（密钥只显掩码）；填了新值才会替换，留空则保留原来的那份。"
            />
          )}
        </Flex>
      </Form>
    </Modal>
  );
}
