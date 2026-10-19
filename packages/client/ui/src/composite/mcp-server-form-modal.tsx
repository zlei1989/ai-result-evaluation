'use client';

/**
 * MCP 服务器新增 / 编辑弹窗：名称 + 传输 +（两支各一套字段）。
 * 纯展示：不调接口，保存走回调；异步与错误提示留在调用方（本组件不认识提示通道）。
 *
 * 六个刻意的取舍（每条都对应一个真实会伤到用户的情形）：
 *   1. **传输切换清空另一支字段**：不清的话 `transport` 一改，上一支填过的 `url` / `command`
 *      会留在表单里，改成 http 再保存时 stdio 那半截被契约 strip 掉——用户以为填了，落盘里没有。
 *      清空是**就地做**的（`changeTransport`），不额外弹提示：切过去之后那一整套字段**当场换掉**，
 *      可见的形状变化本身就是「上一支不在了」的信号。
 *   2. **值留空 = 不修改**（掩码放 `placeholder`）：界面拿到的是掩码（服务端出口形态），
 *      原样回传会把真密钥覆盖成掩码串（症状要到下次运行以 401 现身）。服务端 `preserveUnchangedSecrets`
 *      认两种信号（空串 / 与掩码逐字相同），表单这一侧对应的写法就是**值格留空**；
 *      占位符回显当前值，是为了让用户知道「现在有个值，不填就是它」。
 *      ⚠️ 这条语义要**端到端**成立，那个空串必须真的进 PUT：`buildMcpConfig` 因此收 `current`，
 *      对「留空 + 原有条目里已有这个键」的行交空串——把它们整条丢掉等于在补丁里删掉那个键。
 *   3. **撞名不拦、只提示**：名字住在 map 的键上 ⇒ 保存到已有名字 = **覆盖**那一条。
 *      这是合法操作（贴进来的配置常需要覆盖），所以提示文案是「已存在，保存会覆盖」而不是「名字重复」。
 *   4. **`args` 一行一个参数**：一个多行文本域比可增删的行更省事，也更好从命令行粘贴过来。
 *      空行会被丢掉（粘贴时常带尾随空行），但**参数内部的空格保留**。
 *   5. **表单值只在打开 / 换目标时重灌**，且重灌只依赖 `open` 与被编辑那条的**名字**：
 *      列表每次刷新都会给出新的对象，依赖它会让 effect 在用户打字中途清空输入。
 *   6. **按钮的可访问名与可见文案逐字一致**（两个汉字不插空格）：
 *      屏读器按名字念、用例按名字定位，两者必须同源。
 *
 * 「测试连接」：入口在表单底部，用**当前表单值**测、**不落盘**——保存仍然只由「保存」按钮触发。
 * 请求本身由 `onTest` 注入（组件不调接口）；loading 与结论都留在这个弹窗里。
 *
 * 本组件**不含**：「粘贴 JSON」弹窗（它自成一个 composite，见 `mcp-paste-modal.tsx`）。
 *
 * 校验在 `mcp-server-form-schema.ts`（zod resolver）；名字的两条**警告**（字符集 / 撞名）
 * 是独立的派生状态，不进 `formState.errors`——它们必须「显示但不阻断」。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Controller, useController, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { Control, FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import type { McpProbeResult, McpServerConfig, McpServers } from '@aieval/contracts';
import type { z } from 'zod';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel, FieldTitle } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { DataTable, type DataTableColumn } from '../base/data-table';
import { Textarea } from '../components/ui/textarea';
import { FieldWarning } from '../base/field-warning';
import { McpProbeResultView, McpProbeWaiting, type McpProbeOutcome } from './mcp-probe-result';
import {
  mcpNameWarnings,
  mcpServerFormSchema,
  type McpKeyValueRowInput,
  type McpServerFormInput,
} from './mcp-server-form-schema';
import { SettingsAlert } from './settings-alert';

/** 键值两列表的一行：`env` 与 `headers` 共用同一形状（两处表格长得一样、语义也一样） */
export interface McpKeyValueRow {
  key: string;
  value: string;
}

/**
 * 键值编辑表的操作列宽：只够一个图标按钮（口径同 `MODEL_COLUMN_WIDTH.actions`）。
 * 与供应商模型弹窗那张表一样：**文字按钮在这一列里会占掉半张表**，宽度该还给输入格。
 */
/**
 * 键值表三列声明的宽度（px）：键 / 值 / 操作。
 * 旧表用百分比（42%）表达「键固定、值吃剩余」；套件的列宽输入是数值，故键给固定宽、
 * 值给一个与弹窗宽度同档的宽（两者之和 + 操作列落在弹窗内容宽以内）。
 */
export const MCP_KEY_VALUE_COLUMN_WIDTH = { key: 220, value: 300, actions: 44 } as const;

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

/** 新增态的空白初值：默认 stdio（本地命令是更常见的一类，playwright 就是它） */
const EMPTY: McpServerFormInput = {
  name: '',
  transport: 'stdio',
  url: '',
  command: '',
  args: '',
  env: [],
  headers: [],
};

/** 每次重灌给一份新的空数组：共享同一份数组会让两次 reset 之间互相看见对方的增删 */
function emptyValues(): McpServerFormInput {
  return { ...EMPTY, env: [], headers: [] };
}

/** 弹窗宽度：两列键值表要放得下「变量名 + 值」两格（窄了值格只剩几个字符） */
export const MCP_FORM_MODAL_WIDTH = 640;

/**
 * `McpServerConfig` → 表单初值：两张表各摊成行数组，args 拼成多行文本（反向变换见 `buildMcpConfig`）。
 *
 * ⚠️ **值格一律置空**，当前值只以**占位符**回显（见下）。这不是偷懒，是「值留空 = 不修改」那条语义的
 * 落点：界面拿到的是**掩码**（服务端出口形态），把掩码灌进值格里，用户一按保存就把真密钥覆盖成
 * `ctx-***-0001` —— 症状要到下次运行以 401 才现身。
 */
function toFormValues(name: string, config: McpServerConfig): McpServerFormInput {
  // 只搬**键**：值留空，占位符回显当前值（掩码或明文原样，出口给的是什么就显示什么）
  const rowsOf = (map: Record<string, string> | undefined): McpKeyValueRowInput[] =>
    Object.entries(map ?? {}).map(([key]) => ({ key, value: '' }));
  if (config.transport === 'http') {
    return {
      ...emptyValues(),
      name,
      transport: 'http',
      url: config.url,
      headers: rowsOf(config.headers),
    };
  }
  return {
    ...emptyValues(),
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
 *     它是**新键**（原有条目里没有） ⇒ **整条丢掉**：空值对服务端没有意义；
 *   · 键名为空串的残行一律丢掉（用户点了「添加请求头」还没填完）；
 *   · `args` 按行切、**丢掉空行**、参数内部空格保留。
 *
 * 为什么必须收 `current`：`mcpServers` 是**整份 map 替换**，
 * 而表单里每一格的值都是空的（当前值只在 placeholder 上）。把空值行**一律丢掉**
 * 等于在补丁里**删掉那个键**⇒ 打开 `context7` 的编辑弹窗、一个字不改直接保存，
 * `headers.CONTEXT7_API_KEY` 就从 `config.json` 里消失。
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

/**
 * 键值表里的一个输入格：`useController` 让错误跟着**这一格**走
 * （`errors.env?.[0]?.key` 这类层级路径由 RHF 自己拼，不在这里手写下标）。
 * 可访问名给**输入框自己**的 `aria-label`：挂在 Field 上只会落在外层行 div 上，
 * 进不了输入框（屏读器与按名字定位的用例都读不到「这一格是什么」）。
 */
function KeyValueCell({
  control,
  path,
  label,
  placeholder,
}: {
  control: Control<McpServerFormInput>;
  path: FieldPath<McpServerFormInput>;
  label: string;
  placeholder: string;
}): ReactNode {
  const { field, fieldState } = useController({ control, name: path });
  return (
    <>
      <Input
        {...field}
        // `path` 是 `'env' | 'headers'` 两条数组路径的联合，RHF 只能推出「所有字段值的联合」；
        // 这里是键值表的文本格，值一定是字符串——断言只在这一格上成立
        value={field.value as string}
        aria-label={label}
        aria-invalid={fieldState.invalid}
        placeholder={placeholder}
      />
      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
    </>
  );
}

/** 键值两列表（`env` 与 `headers` 共用）：可增删、键名规则由 schema 给（env 严、headers 只要非空） */
/** 键值表的一行：`id` 来自 `useFieldArray`（行身份），`index` 用于拼 Controller 路径 */
interface KeyValueTableRow {
  id: string;
  index: number;
  key: unknown;
  value: unknown;
}

function KeyValueList({
  control,
  name,
  addLabel,
  keyLabel,
  valueLabel,
  keyPlaceholder,
  valuePlaceholder,
}: {
  control: Control<McpServerFormInput>;
  name: 'env' | 'headers';
  addLabel: string;
  keyLabel: string;
  valueLabel: string;
  keyPlaceholder: string;
  /**
   * 值格的占位符，按**键**取当前值：编辑态回显「留空 = 不修改（当前：…）」。
   * 为什么逐行现算而不是给一句统一的提示：密钥是**逐键**的（`CONTEXT7_API_KEY` 有值、`Accept` 没有），
   * 一句统括的话在「这一行本来就没值」的画面上是假话。
   */
  valuePlaceholder: (key: unknown) => string;
}): ReactNode {
  const { fields, append, remove } = useFieldArray<McpServerFormInput, 'env' | 'headers'>({ control, name });
  // 值格的占位符要跟着**键格当前的值**走（用户改了键名，提示要换到新键的当前值上）
  const rows = (useWatch({ control, name }) ?? []) as McpKeyValueRowInput[];

  /**
   * 键值行 = 无表头的表格。三条与模型清单那张表一致的口径：
   *   · 两格的含义由输入框的 `aria-label` 与占位符承担，表头只是把同样的话再说一遍；
   *   · 操作列**右对齐、只放一个图标按钮**；可访问名靠 `aria-label`；
   *   · 行身份用 `useFieldArray` 给的 `id`，不用下标：删中间一行时按下标复用会把值串行错位。
   */
  const tableRows: KeyValueTableRow[] = fields.map((field, index) => ({
    id: field.id,
    index,
    key: rows[index]?.key,
    value: rows[index]?.value,
  }));

  const columns: DataTableColumn<KeyValueTableRow>[] = [
    {
      id: 'key',
      header: keyLabel,
      accessorKey: 'key',
      size: MCP_KEY_VALUE_COLUMN_WIDTH.key,
      cell: ({ row }) => (
        <KeyValueCell
          control={control}
          path={`${name}.${row.index}.key` as FieldPath<McpServerFormInput>}
          label={keyLabel}
          placeholder={keyPlaceholder}
        />
      ),
    },
    {
      id: 'value',
      header: valueLabel,
      accessorKey: 'value',
      size: MCP_KEY_VALUE_COLUMN_WIDTH.value,
      cell: ({ row }) => (
        <KeyValueCell
          control={control}
          path={`${name}.${row.index}.value` as FieldPath<McpServerFormInput>}
          label={valueLabel}
          placeholder={valuePlaceholder(rows[row.index]?.key)}
        />
      ),
    },
    {
      id: 'actions',
      header: '',
      size: MCP_KEY_VALUE_COLUMN_WIDTH.actions,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-destructive"
            aria-label={`删除这一行${keyLabel}`}
            title="删除这一行"
            onClick={() => remove(row.index)}
          >
            <Trash2Icon aria-hidden />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-1">
      {fields.length > 0 && (
        <div data-testid={`mcp-key-value-${name}`} className="w-full">
          <DataTable
            columns={columns}
            data={tableRows}
            rowKey={(row) => row.id}
            showHeader={false}
            virtualize={false}
            rowHeight={40}
            rowAttributes={(row) => ({ 'data-row-key': row.id })}
            ariaLabel={name === 'env' ? '环境变量' : '请求头'}
          />
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        className="self-start border-dashed"
        onClick={() => append({ key: '', value: '' })}
      >
        <PlusIcon aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}

export function McpServerFormModal(props: McpServerFormModalProps): ReactNode {
  const { open, initialName, initial, servers, saving, onSubmit, onCancel, onTest } = props;
  const isEdit = initialName !== null && initial !== null;
  /** 探活在跑 + 本次探活的结论（与表格行内那份共用渲染，见 `mcp-probe-result.tsx`） */
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<McpProbeOutcome | null>(null);

  const schema = mcpServerFormSchema();
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY,
  });
  const { control, getValues, setValue, clearErrors, trigger, reset, handleSubmit } = form;
  /**
   * 分支判据必须**订阅式**（`useWatch` 在始终渲染的本组件里）：`getValues` 快照不会让父组件重渲染，
   * 症状是「单选框跳过去了、字段还是上一支的」。订阅与它 gate 的 JSX 同处这个函数体。
   */
  const transport = useWatch({ control, name: 'transport' }) ?? 'stdio';
  const nameValue = useWatch({ control, name: 'name' }) ?? '';
  /** 两条警告是派生状态，不是校验结果：它们不参与 `handleSubmit` 的放行判定 */
  const warnings = mcpNameWarnings(nameValue, servers, initialName);

  /**
   * 用**当前表单值**测一次，不落盘。
   * 先跑一遍校验：空端点地址 / 空命令测不出任何结论，而「点了没反应」比一条红字更难懂；
   * 校验红字由字段自己显示，这里不重复说话。校验通过才发请求，并把结论就地渲染出来。
   */
  const runTest = async (): Promise<void> => {
    if (onTest === undefined) return;
    const valid = await trigger();
    if (!valid) return;
    setTesting(true);
    setOutcome(null);
    try {
      setOutcome({ kind: 'result', result: await onTest(getValues()) });
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
    // 重灌一步到位：既换值也清掉上一次失败的校验红字
    reset(initial !== null && initialName !== null ? toFormValues(initialName, initial) : emptyValues());
    // 上一次的探活结论也必须撤掉：它对应的是**上一份**输入，留着会被读成「本次也测过了」
    setOutcome(null);
    setTesting(false);
  }, [open, initialName, initial, reset]);

  /**
   * 传输切换：清空另一支的字段 + 撤掉刚显现那一支的红字。
   * 清空必须在这里**显式**做：隐藏字段的值仍留在表单里，
   * 不改传输直接保存就会把上一支那半截一起交出去（然后被契约 strip 掉，用户以为填了）。
   */
  const changeTransport = (next: McpServerConfig['transport']): void => {
    if (next === 'http') {
      setValue('command', '');
      setValue('args', '');
      setValue('env', []);
    } else {
      setValue('url', '');
      setValue('headers', []);
    }
    // 清掉刚显现那一支的校验红字：字段是刚换过来的，红字只会让人以为「还没填就错了」
    clearErrors();
  };

  const submit = handleSubmit((values) => onSubmit(values));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-[640px]"
        style={{ maxWidth: MCP_FORM_MODAL_WIDTH }}
        data-testid="mcp-server-form-dialog"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <Controller
            control={control}
            name="name"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="mcp-name">名称</FieldLabel>
                <Input {...field} id="mcp-name" placeholder="如 context7" aria-invalid={fieldState.invalid} />
                {/* 两条警告：**显示但不阻断**。它们不是 `FieldError`（红色、role=alert），
                    也不进 formState.errors——进去就会被 resolver 拦住保存 */}
                {warnings.charset !== undefined && (
                  <FieldWarning data-testid="mcp-name-charset-warning">{warnings.charset}</FieldWarning>
                )}
                {warnings.duplicate !== undefined && (
                  <FieldWarning data-testid="mcp-name-duplicate-warning">{warnings.duplicate}</FieldWarning>
                )}
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          <Controller
            control={control}
            name="transport"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldTitle>传输</FieldTitle>
                <RadioGroup
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                    changeTransport(value as McpServerConfig['transport']);
                  }}
                  data-testid="mcp-transport"
                  aria-label="传输"
                  aria-invalid={fieldState.invalid}
                  className="flex flex-row gap-4"
                >
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="stdio" />
                    stdio（本地命令）
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="http" />
                    http（远端端点）
                  </label>
                </RadioGroup>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          {/* 两支字段的显隐由**表单当前值**决定（切换传输要换一整套字段） */}
          {transport === 'http' ? (
            <>
              <Controller
                control={control}
                name="url"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="mcp-url">端点地址</FieldLabel>
                    <Input
                      {...field}
                      id="mcp-url"
                      placeholder="https://mcp.example.com/mcp"
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Field>
                <FieldTitle>请求头</FieldTitle>
                <KeyValueList
                  control={control}
                  name="headers"
                  addLabel="添加请求头"
                  keyLabel="请求头名"
                  valueLabel="请求头值"
                  keyPlaceholder="如 Authorization"
                  valuePlaceholder={(key) =>
                    currentHeaderValue(key) === undefined ? '留空 = 不修改' : `留空 = 不修改（当前：${currentHeaderValue(key)}）`
                  }
                />
              </Field>
            </>
          ) : (
            <>
              <Controller
                control={control}
                name="command"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="mcp-command">命令</FieldLabel>
                    <Input {...field} id="mcp-command" placeholder="如 npx" aria-invalid={fieldState.invalid} />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={control}
                name="args"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="mcp-args">参数</FieldLabel>
                    <Textarea
                      {...field}
                      id="mcp-args"
                      rows={3}
                      placeholder={'如\n-y\n@playwright/mcp@latest'}
                      aria-invalid={fieldState.invalid}
                    />
                    <FieldDescription>一行一个参数；空行会被忽略</FieldDescription>
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Field>
                <FieldTitle>环境变量</FieldTitle>
                <KeyValueList
                  control={control}
                  name="env"
                  addLabel="添加环境变量"
                  keyLabel="变量名"
                  valueLabel="值"
                  keyPlaceholder="如 CONTEXT7_API_KEY"
                  valuePlaceholder={(key) =>
                    currentEnvValue(key) === undefined ? '留空 = 不修改' : `留空 = 不修改（当前：${currentEnvValue(key)}）`
                  }
                />
              </Field>
            </>
          )}

          {/* 尾巴这三块**自成一条 12px 节奏**（它们不是字段）：
              提示语 → 测试入口（含结果区） → 「值留空 = 不修改」的说明 */}
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              值里可以写 {'${环境变量名}'}，注入时才解析（密钥因此不必落盘）
            </p>

            {/* 表单里的测试入口：测的是**手上这份还没保存的输入**。
                与行内那个入口共用同一个结果区组件，故两处说出来的话逐字一致 */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="测试连接"
                  data-loading={testing ? 'true' : undefined}
                  disabled={onTest === undefined || testing}
                  title={onTest === undefined ? '当前不可用' : undefined}
                  onClick={() => void runTest()}
                >
                  {testing && (
                    <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
                  )}
                  测试连接
                </Button>
                <span className="text-sm text-muted-foreground">用当前表单值测，不落盘</span>
              </div>
              {testing && <McpProbeWaiting />}
              {!testing && outcome !== null && <McpProbeResultView outcome={outcome} />}
            </div>
            {isEdit && (
              <SettingsAlert
                tone="info"
                title="值留空 = 不修改"
                description="当前值以占位符回显（密钥只显掩码）；填了新值才会替换，留空则保留原来的那份。"
              />
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" type="button" onClick={onCancel}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && (
                <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
              )}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
