/**
 * McpServerFormModal：名称校验（必填 + 字符集 + **即时查重**）、传输切换清空另一支、两条分支的字段、
 * 「值留空 = 不修改」的占位符、`args` 一行一个参数，以及 `buildMcpConfig` 这个「表单值 → 契约条目」的纯变换。
 *
 * 为什么 `buildMcpConfig` 要单独测：界面显示的与保存下去的必须是**同一份**口径，而它在组件里现算的话
 * 用例只能靠「提交一次再反推」间接验——那正是「显示对了、存下去少了半截」这类缺陷最容易溜过去的地方。
 * 期望值**逐条对着契约写**（不是拿实现再算一遍）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { McpProbeResult, McpServers, Settings } from '@aieval/contracts';
import { SETTINGS_DEFAULTS, preserveUnchangedSecrets, toSettingsView } from '@aieval/contracts';
import { McpServerFormModal, buildMcpConfig, type McpServerFormValues } from './mcp-server-form-modal';
import { installResizeObserverStub } from '../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
});

const servers: McpServers = {
  context7: {
    transport: 'http',
    enabled: true,
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: 'ctx-***-0001' },
  },
};

const emptyValues: McpServerFormValues = {
  name: '',
  transport: 'stdio',
  url: '',
  command: '',
  args: '',
  env: [],
  headers: [],
};

describe('buildMcpConfig（表单值 → 契约条目）', () => {
  it('stdio：args 一行一个、丢空行、参数内部空格保留；env 摊成 map', () => {
    expect(
      buildMcpConfig({
        ...emptyValues,
        name: 'playwright',
        transport: 'stdio',
        command: 'npx',
        args: '\n-y\n@playwright/mcp@latest\n--browser chrome\n\n',
        env: [{ key: 'NODE_ENV', value: 'production' }],
      }),
    ).toEqual({
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', '--browser chrome'],
      env: { NODE_ENV: 'production' },
    });
  });

  it('http：headers 摊成 map；另一支的字段（command / args / env）一个字都不带出去', () => {
    expect(
      buildMcpConfig({
        ...emptyValues,
        name: 'context7',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: [{ key: 'CONTEXT7_API_KEY', value: '${CONTEXT7_API_KEY}' }],
        // 上一支残留的值：契约会 strip 掉，但这一层就不该把它交出去（少一处「靠别人兜底」）
        command: 'npx',
        args: '-y',
        env: [{ key: 'NODE_ENV', value: 'production' }],
      }),
    ).toEqual({
      transport: 'http',
      enabled: true,
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
    });
  });

  it('值为空串的**新键**整条丢掉：空值对服务端没有意义（一个空值格子只是文件里的噪音）', () => {
    const config = buildMcpConfig({
      ...emptyValues,
      name: 'context7',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      // 第二行是用户点了「添加请求头」但没填完：不该以 `{ '': '' }` 的形状落盘
      headers: [
        { key: 'Accept', value: 'application/json' },
        { key: 'CONTEXT7_API_KEY', value: '' },
        { key: '', value: 'orphan' },
      ],
    });

    expect(config).toEqual({
      transport: 'http',
      enabled: true,
      url: 'https://mcp.context7.com/mcp',
      headers: { Accept: 'application/json' },
    });
  });

  /**
   * 「值留空 = 不修改」的**产物侧**判据。
   *
   * `mcpServers` 是**整份 map 替换**，而编辑弹窗里每一格的值都是空的（当前值只在 placeholder 上，
   * 见 `toFormValues`）。把空值行**一律丢掉**等于在补丁里**删掉那个键**——
   * 「打开 `context7` 的编辑弹窗、一个字不改直接保存」会让 `headers.CONTEXT7_API_KEY` 从 `config.json`
   * 里消失（真密钥被抹掉，症状要到下次运行以 401 现身）。判据与服务端逐字对齐：
   * `value === ''` 且该键在**被编辑那条**里存在 ⇒ 产物里那个键存在且为空串。
   */
  it('编辑既有条目、值留空 ⇒ 该键仍在产物里且是空串（服务端据此换回落盘原值）', () => {
    const config = buildMcpConfig(
      {
        ...emptyValues,
        name: 'context7',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: [{ key: 'CONTEXT7_API_KEY', value: '' }],
      },
      servers.context7,
    );

    expect(config).toEqual({
      transport: 'http',
      enabled: true,
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: '' },
    });
  });

  it('留空的是**新键**（原有条目里没有它）⇒ 照旧丢掉，不凭空塞一个空值格子', () => {
    const config = buildMcpConfig(
      {
        ...emptyValues,
        name: 'context7',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: [
          { key: 'Accept', value: 'application/json' },
          { key: 'CONTEXT7_API_KEY', value: '' },
          { key: 'X-New-One', value: '' },
        ],
      },
      servers.context7,
    );

    expect(config).toEqual({
      transport: 'http',
      enabled: true,
      url: 'https://mcp.context7.com/mcp',
      headers: { Accept: 'application/json', CONTEXT7_API_KEY: '' },
    });
  });

  it('换过传输 ⇒ 另一支的键不算「原有」（没有可保留的键，留空照旧丢掉）', () => {
    const config = buildMcpConfig(
      {
        ...emptyValues,
        name: 'context7',
        transport: 'stdio',
        command: 'npx',
        env: [{ key: 'NODE_ENV', value: '' }],
      },
      // 被编辑那条是 http：它没有 env，切换传输时那一支的字段也已被就地清空
      { transport: 'http', enabled: true, url: 'https://mcp.context7.com/mcp', headers: { NODE_ENV: 'production' } },
    );

    expect(config).toEqual({ transport: 'stdio', enabled: true, command: 'npx' });
  });

  /**
   * **端到端**判据（界面产物 → 服务端消解 → 落盘原值）：只钉产物形状不够——这条把两半
   * 接在一起（`buildMcpConfig` 交空串 + `preserveUnchangedSecrets` 认空串），中间任何一半改口径
   * （例如服务端不再把空串当「未改动」、或界面又把它丢掉）都会在这里红。
   */
  it('端到端：编辑既有条目原样保存 ⇒ 消解后仍是**落盘那份真密钥**（不是掩码串、也不是空串）', () => {
    const stored: Settings = {
      ...SETTINGS_DEFAULTS,
      mcpServers: {
        context7: {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: 'ctx7-live-secret' },
        },
      },
    };
    // 页面手上是**出口形态**（敏感值是掩码）：表单初值就照它来（值格留空、掩码进 placeholder）
    const current = toSettingsView(stored).mcpServers.context7;
    const built = buildMcpConfig(
      {
        ...emptyValues,
        name: 'context7',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: [{ key: 'CONTEXT7_API_KEY', value: '' }],
      },
      current,
    );

    const resolved = preserveUnchangedSecrets(stored, { mcpServers: { context7: built } });

    expect(resolved.mcpServers?.context7).toEqual(stored.mcpServers.context7);
  });

  it('一张表全空时不写出那个键（`env: {}` 与「没有 env」在文件里不该是两种写法）', () => {
    const config = buildMcpConfig({ ...emptyValues, name: 'x', transport: 'stdio', command: 'uvx' });

    expect('args' in config).toBe(false);
    expect('env' in config).toBe(false);
    // enabled 反例：它**必须**显式写出（缺省 true 靠 schema，落盘不许依赖它）
    expect(config.enabled).toBe(true);
  });
});

describe('McpServerFormModal', () => {
  function renderModal(overrides: Partial<ComponentProps<typeof McpServerFormModal>> = {}): {
    onSubmit: ReturnType<typeof vi.fn>;
  } {
    const onSubmit = vi.fn();
    render(
      <McpServerFormModal
        open
        initialName={null}
        initial={null}
        servers={servers}
        saving={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        {...overrides}
      />,
    );
    return { onSubmit };
  }

  /**
   * 等表单被灌上初值：弹窗在 `useEffect` 里 `setFieldsValue`（初值不能在渲染期写，见组件注释），
   * 故 `render()` 返回的那一刻编辑态字段还没换过来。等一个**编辑态才有**的字段出现再断言 ——
   * 不等的话读到的可能是上一个用例留下的 DOM（模态走 portal，卸载有延迟），
   * 那种假绿会让「预填」这类断言完全失去区分力。
   */
  async function waitForEditForm(): Promise<void> {
    await waitFor(
      () => {
        expect(screen.getByLabelText('端点地址')).toHaveValue('https://mcp.context7.com/mcp');
        expect(screen.getByLabelText('请求头名')).toHaveValue('CONTEXT7_API_KEY');
      },
      { timeout: 3000 },
    );
  }

  /** 等弹窗真的挂上（模态走 portal，卸载有延迟：不等的话可能读到上一个用例留下的 DOM） */
  async function waitForForm(): Promise<void> {
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument(), { timeout: 3000 });
  }

  it('新增态默认 stdio（本地命令是更常见的一类），没有「值留空 = 不修改」那条提示', () => {
    renderModal();

    expect(screen.getByRole('radio', { name: 'stdio（本地命令）' })).toBeChecked();
    expect(screen.getByLabelText('命令')).toBeInTheDocument();
    expect(screen.queryByLabelText('端点地址')).toBeNull();
    // 新增态没有原值可言，这条提示只会让人以为「现在有个值」
    expect(screen.queryByText('值留空 = 不修改')).toBeNull();
  });

  it('名称必填：空名字提交时拦下并给中文原因，不调 onSubmit', async () => {
    const { onSubmit } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('请填写名称')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /**
   * 字符集这条是**警告**（`warningOnly`），不是拦路虎：真源在契约，服务端会以中文拦下。
   * 判据两半都要：① 提示照给（用户填错时立刻看得见）；② 点保存**仍然提交**（界面不装成第二个真源）。
   * 只钉提示会放过「顺手改成真规则」，只钉可提交会放过「一个信号都不给」。
   */
  it('名称字符集给提示但不拦保存（拦截归契约，界面不装第二个真源）', async () => {
    const { onSubmit } = renderModal();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'my.server' } });
    expect(await screen.findByText('名称只能是字母、数字、下划线或连字符，长度 1–32')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ name: 'my.server' });
  });

  /**
   * 即时查重：撞已有名字**不拦**，只提示「保存会覆盖」——名字住在 map 的键上，
   * 存到已有名字就是覆盖那一条，那是合法操作。所以判据是「提示 + 仍能提交」两件事同时成立：
   * 只钉提示会放过「顺手把它改成硬拒」，只钉可提交会放过「撞名一个信号都不给」。
   */
  it('撞已有名字提示「已存在，保存会覆盖」，但仍然允许提交（覆盖是合法操作）', async () => {
    const { onSubmit } = renderModal();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'context7' } });

    expect(await screen.findByText('已存在，保存会覆盖')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // 提交的是**表单值**：名字没被查重那一步改掉
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ name: 'context7', transport: 'stdio', command: 'npx' });
  });

  it('编辑态不改名时不提示「已存在」（自己不该撞自己）', async () => {
    renderModal({
      initialName: 'context7',
      initial: servers.context7,
      servers,
    });
    await waitForEditForm();

    fireEvent.change(screen.getByLabelText('请求头名'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'context7' } });

    // 等一拍：validator 是异步的，提示若会出现，这里已经出现了
    await waitFor(() => expect(screen.getByLabelText('名称')).toHaveValue('context7'), { timeout: 3000 });
    expect(screen.queryByText('已存在，保存会覆盖')).toBeNull();
  });

  it('编辑 http 条目：预填 url 与 headers，值格留空并回显当前值（掩码）作占位符', async () => {
    renderModal({ initialName: 'context7', initial: servers.context7, servers });
    await waitForEditForm();

    // 值格与键格同形（都是 `Input`），按标签逐个认人
    expect(screen.getByRole('radio', { name: 'http（远端端点）' })).toBeChecked();
    expect(screen.getByLabelText('端点地址')).toHaveValue('https://mcp.context7.com/mcp');
    // 键名回显，**值格必须是空的**：留空 = 不修改。预填掩码的话用户一按保存就把真密钥顶掉了
    expect(screen.getByLabelText('请求头名')).toHaveValue('CONTEXT7_API_KEY');
    expect(screen.getByLabelText('请求头值')).toHaveValue('');
    // 当前值只以**占位符**出现（掩码原样回显），用户据此知道「现在有个值，不填就是它」
    expect(screen.getByLabelText('请求头值')).toHaveAttribute('placeholder', '留空 = 不修改（当前：ctx-***-0001）');
    expect(screen.queryByLabelText('命令')).toBeNull();
  });

  /**
   * 「值留空 = 不修改」的**端到端**判据：编辑态**原样保存**（一个字不动）时，交出去的那一行值仍是空串。
   * 服务端认两种「未改动」信号之一就是这个空串；界面若把它填成掩码串，契约那条规则照样放行
   * （值与掩码逐字相同），但用户一旦改动别的字段就会把真密钥换成掩码——这条钉的是界面这一侧的起点。
   */
  it('编辑态原样保存：交出去的值格是空串（不是掩码串）', async () => {
    const { onSubmit } = renderModal({ initialName: 'context7', initial: servers.context7, servers });
    await waitForEditForm();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: 'context7',
      transport: 'http',
      headers: [{ key: 'CONTEXT7_API_KEY', value: '' }],
    });
  });

  /**
   * 传输切换：另一支的字段必须**清空**并给提示。
   * 不清的话 antd 的 `preserve` 会把隐藏字段的值留在表单里，保存时一起交出去（再被契约 strip 掉）——
   * 用户以为填了 stdio 的命令，落盘里一个字都没有。
   */
  it('切换传输清空另一支的字段，并给一句提示', async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByLabelText('参数'), { target: { value: '-y' } });

    fireEvent.click(screen.getByRole('radio', { name: 'http（远端端点）' }));

    process.stdout.write(`DBG AFTER-SWITCH radios=${JSON.stringify(screen.getAllByRole('radio').map((el) => `${el.getAttribute('value')}:${(el as HTMLInputElement).checked}`))} tb=${JSON.stringify(screen.queryAllByRole('textbox').map((el) => el.getAttribute('placeholder')))}\n`);
    // 切过去之后 stdio 那一支的字段整块消失；http 那一支的输入框要等表单换过来。
    // 拿**空值**当同步判据（新挂上来的字段初值就是空串），再填一个新地址进去
    expect(screen.queryByLabelText('命令')).toBeNull();
    const url = await screen.findByLabelText('端点地址');
    expect(url).toHaveValue('');
    fireEvent.change(url, { target: { value: 'https://mcp.example.com/mcp' } });
    // 切回 stdio：命令与参数都该是空的（切走时清空过），而不是切走前那两笔。
    // 这里同样要先等字段换回来（拿它是个输入框当判据），否则读到的是上一个用例留下的 DOM
    fireEvent.click(screen.getByRole('radio', { name: 'stdio（本地命令）' }));
    const command = await screen.findByLabelText('命令');
    expect(command).toHaveValue('');
    expect(screen.getByLabelText('参数')).toHaveValue('');
    // 一并钉住「清空的是字段值，不是只把 DOM 藏起来」：切回 http 时端点地址也空了
    fireEvent.click(screen.getByRole('radio', { name: 'http（远端端点）' }));
    expect(await screen.findByLabelText('端点地址')).toHaveValue('');
  });

  /**
   * 形态守卫：键值行是**一张 small Table**，与模型供应商弹窗里那张模型清单同口径。
   *
   * 判据里**哪些有牙、哪些只是记录**（如实写下来）：
   *   · **`thead` 不渲染**（`showHeader: false`）—— 有牙：去掉 `showHeader: false` ⇒ 这条红；
   *   · **结构是 Table 不是 Space 行布局** —— 有牙：`getByTestId` 找不到就抛（换回 `Space` 行布局即红）；
   *   · **行的身份用 `Form.List` 的 `key`**（`data-row-key` 在场）—— 防止退回按下标复用；
   *   · `ant-table-small` 这条**只是记录效果、抓不住「有没有显式给 `size`」**：本仓全局是紧凑密度
   *     （`ConfigProvider` 的 `componentSize`），去掉 `size="small"` 它照样成立（不放红）。
   *     留它是为了写明「与供应商模型弹窗同一档尺寸」这个口径，别把它当守门的那一条。
   * 真实观感与列宽留真机冒烟量（`getBoundingClientRect()`）。
   */
  it('键值行是一张 small Table（对齐供应商模型弹窗那张表）', () => {
    renderModal({
      initialName: 'context7',
      initial: servers['context7'] as NonNullable<Parameters<typeof buildMcpConfig>[1]>,
    });

    const table = screen.getByTestId('mcp-key-value-headers');
    // 尺寸类与 `data-testid` 都落在**外层 wrapper** 上（不是它内部那个 `.ant-table`）
    expect(table.className).toContain('ant-table-small');
    // `showHeader: false` ⇒ 连 thead 都不渲染（表头只是把占位符与 aria-label 的话再说一遍）
    expect(table.querySelector('thead')).toBeNull();
    expect(table.querySelectorAll('tbody tr.ant-table-row')).toHaveLength(1);
    // 两格的可访问名给在输入框自己身上；删除按钮是图标按钮 + aria-label
    expect(screen.getByLabelText('请求头名')).toBeInTheDocument();
    expect(screen.getByLabelText('请求头值')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除这一行请求头名' })).toBeInTheDocument();
    // 行的身份用 Form.List 的 key（不是下标）：删中间一行时值不会串行错位
    expect(table.querySelectorAll('tbody tr.ant-table-row')[0]?.getAttribute('data-row-key')).toBeTruthy();
  });

  it('env 的键名按契约规则拦（带点号 / 数字开头都不行），中文原因就地给出', async () => {
    const { onSubmit } = renderModal();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'demo' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: '添加环境变量' }));
    fireEvent.change(screen.getByLabelText('变量名'), { target: { value: 'MY.KEY' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('变量名只能是字母、数字与下划线，且不以数字开头')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('stdio 分支：填完提交，表单值原样交给调用方（含 args 的多行原文）', async () => {
    const { onSubmit } = renderModal();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'playwright' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByLabelText('参数'), { target: { value: '-y\n@playwright/mcp@latest' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: 'playwright',
      transport: 'stdio',
      command: 'npx',
      args: '-y\n@playwright/mcp@latest',
    });
  });

  it('提示了密钥占位的写法（值里可以写 ${环境变量名}）', () => {
    renderModal();

    expect(screen.getByText(/值里可以写 \$\{环境变量名\}，注入时才解析/)).toBeInTheDocument();
  });

  it('编辑态给一条「值留空 = 不修改」的说明（当前值是掩码，原样回传会覆盖真密钥）', () => {
    renderModal({ initialName: 'context7', initial: servers.context7, servers });

    expect(screen.getByText('值留空 = 不修改')).toBeInTheDocument();
    expect(screen.getByText(/留空则保留原来的那份/)).toBeInTheDocument();
  });

  it('弹窗里的按钮与开关文案都不插空格（可访问名 = 文案）', () => {
    renderModal();

    for (const name of ['保存', '取消']) {
      expect(screen.queryAllByRole('button', { name: new RegExp(`^${name[0]} ${name[1]}$`) })).toHaveLength(0);
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    // 键值两列表的「添加」按钮是四字文案，同样不许插空格（antd 只处理两字，这条是反向对照）
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '添加环境变量' })).toBeInTheDocument();
  });

  /**
 * 表单里的「测试连接」：用**当前表单值**测、**不落盘**。
 * 这条与行内那个入口的差别只有一处 —— 测的是手上这份还没保存的输入；其余（loading、结果区、
 * 两段式文案）与行内共用同一个结果区组件，故这里只钉「接线」与「不落盘」这两件事。
 */
  describe('表单里的「测试连接」', () => {
    const PROBE_OK: McpProbeResult = {
      ok: true,
      tier: 'http+call',
      serverName: 'Context7',
      serverVersion: '4.3.0',
      toolCount: 2,
      elapsedMs: 1610,
      notes: [],
    };

    it('用当前表单值调 onTest（不是 initial 那一份），且**不触发保存**', async () => {
      const onTest = vi.fn(async (_values: McpServerFormValues) => PROBE_OK);
      const { onSubmit } = renderModal({ onTest });
      await waitForForm();

      fireEvent.click(screen.getByRole('radio', { name: 'http（远端端点）' }));
      fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'form-only' } });
      fireEvent.change(screen.getByLabelText('端点地址'), { target: { value: 'https://form.example.com/mcp' } });
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

      await waitFor(() => expect(onTest).toHaveBeenCalledTimes(1));
      expect(onTest.mock.calls[0]?.[0]).toMatchObject({
        transport: 'http',
        url: 'https://form.example.com/mcp',
      });
      // 「不落盘」：这条入口一个字节都不写盘 —— 保存只由「保存」按钮触发
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('结论就地出现在弹窗里，并写明这是用当前表单值测的', async () => {
      const onTest = vi.fn(async (_values: McpServerFormValues) => PROBE_OK);
      renderModal({ onTest });
      await waitForForm();

      fireEvent.click(screen.getByRole('radio', { name: 'http（远端端点）' }));
      fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'form-only' } });
      fireEvent.change(screen.getByLabelText('端点地址'), { target: { value: 'https://form.example.com/mcp' } });

      expect(screen.getByText('用当前表单值测，不落盘')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

      expect(await screen.findByText('连通：Context7 4.3.0，声明 2 个工具（耗时 1.6 s）')).toBeInTheDocument();
    });

    it('请求本身失败（onTest 抛错）也说得出中文原因', async () => {
      const onTest = vi.fn(async (_values: McpServerFormValues): Promise<McpProbeResult> => {
        throw new Error('探活超时');
      });
      renderModal({ onTest });
      await waitForForm();

      fireEvent.click(screen.getByRole('radio', { name: 'http（远端端点）' }));
      fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'form-only' } });
      fireEvent.change(screen.getByLabelText('端点地址'), { target: { value: 'https://form.example.com/mcp' } });
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

      expect(await screen.findByText('测试请求失败：探活超时')).toBeInTheDocument();
    });

    it('字段没过校验时**不发请求**（空端点地址测不出任何结论，红字由表单自己给）', async () => {
      const onTest = vi.fn(async (_values: McpServerFormValues) => PROBE_OK);
      renderModal({ onTest });
      await waitForForm();

      // 名称与端点地址都空着
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

      expect(await screen.findByText('请填写名称')).toBeInTheDocument();
      expect(onTest).not.toHaveBeenCalled();
    });

    it('没有 onTest 时按钮禁用并说明当前不可用（不留一个点了没反应的按钮）', async () => {
      renderModal();
      await waitForForm();

      expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '测试连接' })).toHaveAttribute('title', '当前不可用');
    });
  });
});
