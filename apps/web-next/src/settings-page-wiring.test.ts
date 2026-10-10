// @vitest-environment node
/**
 * 设置页两张卡的**接线**守卫：评分配置卡的协议 / 档位域投影，以及工作区卡的用例目录与用例同步。
 *
 * 协议过滤的判据在卡片里（`JudgeSettingsCard` 自己的用例钉住了「协议不匹配的智能体被禁用且说明原因」），
 * 但卡片看不见「页面有没有把那张表传进来」——`agentProtocols` 在卡片上是可选 prop，漏传时
 * `pnpm typecheck` 不响，过滤静默退化成「一个都不过滤」：
 * 每家智能体照旧全部可选，直到创建 / 评分时被服务端的 CONFLICT 拦下，用户才知道自己选错了。
 *
 * 工作区那一段同一条理由：用例目录与同步的 props 虽然必填（漏传会红），
 * 但**回调体接错线**（写错 SettingsPatch 的键）类型查不出、界面上两格长得一模一样，只有源码锚点拦得住。
 *
 * 同目录 `runs-page-wiring.test.ts` 的文件头记着同一类缺陷（纯函数全绿而调用方漏喂输入），本文件是它在设置页的对应物。
 *
 * 为什么读源码而不是渲染页面：`apps/web-next` 保留 `jsx: preserve`（Next 需要），
 * 该应用内**不能写 `.tsx` 测试**（AGENTS.md 的硬约束：报错来自 Vite 的 import-analysis，改 esbuild 配置也无效），
 * 页面这一层没有渲染测试面——这也正是本仓库的「页面接线」守卫都是读源码的 `.ts` 的原因。
 *
 * 断言手法与同目录其它接线用例一致：把 `<JudgeSettingsCard … />` 的**开标签**抠出来只扫这一段，
 * 再顺着「表 ← agentOptions ← useRunModelOptions()」这条链各钉一环；抠不到就抛（守卫不许静默失效）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 设置页源码（用文件自身位置推导，不依赖 `process.cwd()`） */
const pagePath = join(import.meta.dirname, '..', 'app', 'settings', 'page.tsx');
const source = readFileSync(pagePath, 'utf8');

/** 抠出某个 JSX 组件的开标签；抠不到直接抛，避免守卫变成永远为真的空断言 */
function openingTag(component: string): string {
  const start = source.indexOf(`<${component}`);
  if (start < 0) throw new Error(`app/settings/page.tsx 里找不到 <${component} … />`);
  const end = source.indexOf('/>', start);
  if (end < 0) throw new Error(`${component} 的开标签没有在预期处结束（找不到 \`/>\`）`);
  return source.slice(start, end);
}

/**
 * 抠出页面里一个动作函数的**函数体**（从 `const <名字> = ` 到下一个 `const `）。
 * 与 `openingTag` 同一条口径：抠不到直接抛——**静默返回空串的守卫比没有守卫更坏**
 * （断言恒真，而缺陷照过）。
 */
function actionBody(name: string): string {
  const start = source.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`app/settings/page.tsx 里找不到 const ${name} = …`);
  const next = source.indexOf('\n  const ', start);
  if (next < 0) throw new Error(`${name} 的函数体没有在预期处结束（找不到下一个动作函数）`);
  return source.slice(start, next);
}

/**
 * 抠出某个 Tab 的条目源码（从 `key: '<键>'` 到下一个 Tab 的 `key: '` 之前）。
 * 与两个 helper 同一条口径：抠不到直接抛——静默切出空串会让下面的断言恒真。
 */
function tabSlice(key: string): string {
  const start = source.indexOf(`key: '${key}'`);
  if (start < 0) throw new Error(`app/settings/page.tsx 里找不到 key: '${key}'`);
  const next = source.indexOf('key: \'', start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

/**
 * Tab「基础」的接线。
 *
 * 模型供应商、界面主题、存储目录三块都住在这**一个** Tab 里，且按「开始评测之前先配一次」的先后排：
 * 供应商 → 主题 → 存储目录。其余守卫都只扫各自组件的开标签，看不见「它们住在哪个 Tab、谁在前」——
 * 把某一块挪回独立 Tab（或调乱顺序）时类型检查一个字都不报，界面上只是少了一张卡片，只有源码锚点拦得住。
 */
describe('settings 页面的「基础」Tab 接线', () => {
  it('Tab 的 key 是 basic、label 是「基础」', () => {
    expect(source, 'Tab 的 key 不是 basic').toContain('key: \'basic\'');
    expect(source, 'Tab 的 label 不是基础').toContain('label: \'基础\'');
  });

  it('三块同住在「基础」这一个 Tab 里：模型供应商、界面主题、存储目录', () => {
    const tab = tabSlice('basic');

    expect(tab, '基础 Tab 里没有模型供应商表格').toContain('<ProviderTable');
    expect(tab, '基础 Tab 里没有界面主题卡').toContain('data-testid="theme-card"');
    expect(tab, '基础 Tab 里没有存储目录卡').toContain('<WorkspaceSettingsCard');
  });

  it('上下顺序是 模型供应商 → 界面主题 → 存储目录（顺序即导航路径，别随手调）', () => {
    const tab = tabSlice('basic');
    const providerAt = tab.indexOf('<ProviderTable');
    const themeAt = tab.indexOf('data-testid="theme-card"');
    const storageAt = tab.indexOf('<WorkspaceSettingsCard');

    expect(providerAt, '基础 Tab 里找不到供应商表').toBeGreaterThan(-1);
    expect(themeAt, '基础 Tab 里找不到主题卡').toBeGreaterThan(-1);
    expect(storageAt, '基础 Tab 里找不到存储目录卡').toBeGreaterThan(-1);
    expect(providerAt, '模型供应商不在最上面').toBeLessThan(themeAt);
    expect(themeAt, '界面主题不在模型供应商之后').toBeLessThan(storageAt);
  });

  it('存储目录不再单开 Tab（`key: \'workspace\'` 不许复活）', () => {
    expect(source, '存储目录又被拆成了独立 Tab').not.toContain('key: \'workspace\'');
  });

  /**
   * 供应商表单弹窗必须**挂载后**才渲染。
   *
   * 它内部是 antd `Modal` + `forceRender`（表单要常挂 useForm 实例），而它住在默认激活的 Tab 里 ⇒
   * 参与首屏 SSR：服务端渲染不出 Modal 的 portal 容器、客户端首帧却渲染出来，于是**每次**打开设置页
   * 都报一条 hydration mismatch（React 之后整棵重渲染，用户看不出，但控制台都是红的）。
   * 这条回归没有别的测试面——单测全绿、界面照常可用，`mounted` 门控是它唯一的守卫。
   * 判据取「`<ProviderFormModal` 之前一小段里有门控」：拿 `{true && (` 顶替门控即可复现。
   */
  it('供应商表单弹窗在 mounted 门控里渲染——去掉门控，每次打开设置页都会报 hydration mismatch', () => {
    const tab = tabSlice('basic');
    const at = tab.indexOf('<ProviderFormModal');

    expect(at, '基础 Tab 里找不到 <ProviderFormModal').toBeGreaterThan(-1);
    expect(tab.slice(0, at).slice(-160), 'ProviderFormModal 没有被 mounted 门控包住').toContain(
      '{mounted && (',
    );
  });
});

describe('settings 页面的评分配置卡接线', () => {
  it('把「智能体 → 协议」表喂进评分配置卡——漏了它，协议过滤静默退化成不过滤', () => {
    const tag = openingTag('JudgeSettingsCard');

    expect(tag, '少了 agentProtocols——协议不匹配的智能体又变成全部可选').toContain('agentProtocols=');
  });

  it('表按卡片认得的形状投影（agentKind + protocolTypes，少一个卡片就查不出协议）', () => {
    const tag = openingTag('JudgeSettingsCard');

    expect(tag, '投影里少了 agentKind').toContain('agentKind:');
    // 形状是**集合**：写成单数 `protocolType:` 会让卡片读不到值，
    // 而卡片读不到时会「一个都不过滤」（见它的 agentProtocols 注释），红不出来就是静默退化
    expect(tag, '投影里少了 protocolTypes').toContain('protocolTypes:');
  });

  /**
   * 档位域与协议表**同一条理由**，但后果更硬：卡片的「思考强度」候选就是写下侧的**唯一**把关
   * （`settings.defaultJudge.effort` 的 schema 只看「非空字符串」）。漏了这一格 ⇒ 卡片只能兜规范五档
   * ⇒ dsh 的 `medium` 摆到界面上并被存下 ⇒ 生成 / 识别时被 `requireJudgeEffort` 硬拒。
   * 而它是可选 prop，漏传时 `pnpm typecheck` 一个字都不报。
   */
  it('把「思考强度」的档位域也喂进去——漏了它，候选退化成规范五档，dsh 的 medium 就摆上了界面', () => {
    expect(openingTag('JudgeSettingsCard'), '投影里少了 efforts，档位域只能兜规范五档').toContain('efforts:');
  });

  it('这张表来自服务端的注册表投影（useRunModelOptions），不是页面自己抄的一份', () => {
    // 值写死成字面量（例如自己列几家协议）也能让上面两条绿，故这里要求值的来源是那份投影
    expect(openingTag('JudgeSettingsCard'), 'agentProtocols 不是从 agentOptions 现算的').toContain('agentOptions');
    expect(source, '页面没有调用 useRunModelOptions()').toContain('useRunModelOptions()');
    expect(source, 'agentOptions 不是 useRunModelOptions() 的 options 投影').toContain('options: agentOptions');
  });
});

/**
 * 存储目录卡的「用例目录」与「用例同步」两块的接线。
 *
 * 卡片自己的用例钉住了显隐与禁用（组件那一侧），但卡片看不见「页面有没有把状态与回调喂进来」：
 * 这些都是必填 prop（漏了 typecheck 会红），真正红不出来的是**回调体接错线**——
 * 用例目录的校验写成 `update({ workspaceRoot })` 时 props 一个不少、类型也对，
 * 而两格的输入框与按钮长得一模一样，肉眼冒烟分不出来，症状是「用例目录改了没生效」。
 */
describe('settings 页面的用例目录与用例同步接线', () => {
  it('接上同步状态与动作两个 hook——漏了它们，卡片只能一直画骨架屏且没有任何动作按钮', () => {
    expect(source, '页面没有调用 useCaseSyncStatus()').toContain('useCaseSyncStatus()');
    expect(source, '页面没有调用 useCaseSyncAction()').toContain('useCaseSyncAction()');

    const tag = openingTag('WorkspaceSettingsCard');
    expect(tag, '少了 syncStatus=').toContain('syncStatus=');
    expect(tag, '少了 onSyncAction=').toContain('onSyncAction=');
    expect(tag, '少了 syncing=').toContain('syncing=');
  });

  it('把用例目录那一格交给卡片：settings（含 casesRoot）+ 独立回调 + 开关都在开标签里', () => {
    const tag = openingTag('WorkspaceSettingsCard');
    expect(tag, '少了 settings=——casesRoot 就在它里面').toContain('settings=');
    expect(tag, '少了 onValidateCasesRoot=').toContain('onValidateCasesRoot=');
    expect(tag, '少了 lastValidatedCases=').toContain('lastValidatedCases=');
    expect(tag, '少了 onToggleAutoCommit=').toContain('onToggleAutoCommit=');
  });

  it('两个回调体各自写到对的键（用例目录写成 workspaceRoot 是静默错线，类型查不出）', () => {
    expect(source, '用例目录没有落到 PUT { casesRoot }').toContain('update({ casesRoot: root })');
    expect(source, '自动提交开关没有落到 PUT { casesAutoCommit }').toContain('update({ casesAutoCommit: value })');
  });

  it('同步状态读失败要显式渲染——否则一次 GET 失败就只剩一个永远转不完的骨架屏', () => {
    expect(source, 'syncError 没有被渲染出来').toContain('loadFailure(syncError');
  });
});

/**
 * Tab「MCP」的接线。
 *
 * 卡片自己的用例钉住了表格与表单的行为，但看不见**页面有没有把它们接上**：这些 props 有的是必填
 * （漏了 typecheck 会红），真正红不出来的是三类静默错线：
 *   · 集合传错键（例如喂 `settings.providers`，或干脆给一个空常量）：界面看起来照常，只是永远空着；
 *   · 回调体接错线（启停写成整条替换、保存忘了把旧名字传给改名那一半）；
 *   · 静态说明**又摆回页面这一层**（落点已按收进卡片，两处都印就是两处真源）。
 * 判据口径与上面的评分配置 / 工作区两段一致：把开标签抠出来只扫这一段，抠不到就抛。
 */
describe('settings 页面的 MCP 卡接线', () => {
  it('Tab 的 key 是 mcp、label 是 MCP，且**排在最后**（基础 → 评分 → MCP）', () => {
    expect(source, 'Tab 的 key 不是 mcp').toContain('key: \'mcp\'');
    expect(source, 'MCP Tab 的 label 不对').toContain('label: \'MCP\'');
    // 顺序靠源码位置钉，**三个都钉**：只钉「在基础之后」挡不住「被挤到中间」，
    // 「评分」那一格另有一条 label 守卫
    const basicAt = source.indexOf('key: \'basic\'');
    const judgeAt = source.indexOf('key: \'judge\'');
    const mcpAt = source.indexOf('key: \'mcp\'');
    expect(basicAt).toBeGreaterThan(-1);
    expect(judgeAt).toBeGreaterThan(-1);
    expect(basicAt).toBeLessThan(judgeAt);
    expect(judgeAt, 'MCP 必须排在「评分」之后').toBeLessThan(mcpAt);
  });

  it('Tab 的 key 是 judge、label 是「评分」', () => {
    expect(source, '评分 Tab 的 key 不是 judge').toContain('key: \'judge\'');
    expect(source, '评分 Tab 的 label 不对').toContain('label: \'评分\'');
  });

  it('表格吃到的是这份 settings 的 mcpServers，四个回调都接上', () => {
    const tag = openingTag('McpServerTable');

    expect(tag, '少了 servers=').toContain('servers=');
    expect(tag, 'servers 不是从 settings 那份集合来的').toContain('mcpServers');
    for (const prop of ['onToggle=', 'onEdit=', 'onDelete=', 'onCreate=']) {
      expect(tag, `少了 ${prop}`).toContain(prop);
    }
  });

  it('弹窗记的是被编辑那条的**名字**，initial 从当前集合现取', () => {
    const tag = openingTag('McpServerFormModal');

    expect(tag, '少了 initialName=').toContain('initialName=');
    expect(tag, '少了 initial=').toContain('initial=');
    expect(tag, '少了 servers=（即时查重要用整张表）').toContain('servers=');
    // 名字住在 map 的键上：改名的「挪旧键」那一步靠的就是它，接错线时保存会静默留下幽灵条目
    expect(source, 'editingMcpName 没有被当 previousName 传给 upsertServer').toContain(
      'upsertServer(mcpServers, editingMcpName',
    );
  });

  it('四个动作各自落到对的键（全部走 PUT { mcpServers }，不新增端点）', () => {
    // 保存 / 启停都必须是 `mcpServers` 这一个键；写成别的键类型也过（SettingsPatch 全是可选的），
    // 而界面上看起来「改好了」——只有源码锚点拦得住
    expect(source, '保存没有落到 PUT { mcpServers }').toContain('update({ mcpServers:');
    expect(source, '删除没有落到 PUT { mcpServers }').toContain('removeServer(mcpServers');
    // 启停沿用当前那条的其余字段（整份替换语义下，只写 enabled 会把 url / headers 一起抹掉）
    expect(source, '启停没有沿用当前那条的字段').toContain('{ ...entry, enabled }');
  });

  /**
   * 静态说明（同名优先级那三句）的**落点**：卡片内、表格上方那一行（`McpServerTable` 里）。
   * 页面这一层不得再印一份——两处都印就是两处真源，措辞迟早漂移成两句不同的话，而用户同时看到它们
   * （这正是这条守卫写成「页面里不许有」而不是「页面里有」的原因）。
   * 文案本身与「永远显示」由卡片自己的用例钉：`packages/client/ui/src/composite/mcp-server-table.test.tsx`
   * 的「卡片内那条静态说明常显」。
   */
  it('静态说明不摆页面这一层：落点在卡片内，页面再印一份就是两处真源', () => {
    expect(source, '页面又抄了一遍 MCP 优先级说明的文案').not.toContain(
      '同名时以设置页为准；仓库自带的其它条目仍会生效；要改仓库自带的那条得去改那个仓库',
    );
  });

  it('MCP 集合读不到时兜空 map（不许替服务端播种那两台）', () => {
    expect(source, 'settings 未就绪时 mcpServers 没有兜底').toContain('settings?.mcpServers ?? {}');
  });

  /**
   * 测试连接两个入口的接线：两个入口各喂一份，**喂错的那一份不会红**——
   * 行内喂成 `entry` 就测不到「已保存的那份」（用户改完没保存，行内会去测还没落盘的值），
   * 表单喂成 `name` 则测的是旧配置（表单里新填的地址根本没被测）。两处都只有源码锚点拦得住。
   */
  it('行内入口测**已保存**的那份（{ name }），表单入口测**表单当前值**（{ entry }）', () => {
    const tableTag = openingTag('McpServerTable');
    const modalTag = openingTag('McpServerFormModal');

    expect(tableTag, '行内少了 onTest=').toContain('onTest={testMcpServer}');
    expect(modalTag, '表单少了 onTest=').toContain('onTest={testMcpForm}');

    // 两个入口的请求体形状必须**分开**：混用不会报错，只会静默测错那一份
    expect(source, '行内入口没有用 { name }').toContain('probeMcpServer({ name: row.name })');
    expect(source, '表单入口没有用 { entry }').toContain('probeMcpServer({ entry:');
  });

  it('表单入口的 enabled 沿用被编辑那条（表单里没有启停这一格，缺省 true 会把「已停用」说反）', () => {
    expect(source, '表单入口没有沿用当前那条的 enabled').toContain(
      'enabled: current?.enabled ?? built.enabled',
    );
  });

  /**
   * 「值留空 = 不修改」的**接线**（`buildMcpConfig` 的第二个参数）。
   *
   * 编辑弹窗里每一格的值都是空的（当前值只在 placeholder 上），而 `mcpServers` 是**整份 map 替换**：
   * `buildMcpConfig` 只有拿到**被编辑那条**才知道哪些键原来就在（那些行要交空串，服务端才认得出
   * 「这一格没动」并换回落盘原值）。少喂这一个参数**不会红**——弹窗照常关、界面照常显示已保存，
   * 而那条敏感键已经从 PUT 体里消失（`headers.CONTEXT7_API_KEY` 被抹掉，下次运行以 401 现身）。
   * 组件那一侧钉的是「交出去的值格是空串」，钉不到「页面有没有把原有键集合喂进去」——这一格只有源码锚点拦得住。
   */
  it('保存时把**被编辑那条**喂给 buildMcpConfig：少了它，值留空的敏感键会从 PUT 体里消失', () => {
    const body = actionBody('submitMcpServer');

    expect(body, 'buildMcpConfig 没拿到被编辑那条（留空的值格会被整条丢掉）').toContain(
      'buildMcpConfig(values, current)',
    );
    // `current` 必须从**当前集合**里现取（编辑按打开弹窗记下的名字、新增按表单里的名字）：
    // 换成别的来处（例如只按 values.name 取）时改名那一半会取到空的那条，原有键集合当场丢一半
    expect(body, 'current 不是从当前集合里现取的').toContain('mcpServers[editingMcpName ?? values.name]');
  });

  it('探活入口**不**喂 current（探活发的是要出网的那一份，留空只能当作「没有这一格」）', () => {
    // 与上面那条互为正反面：两处都喂会让探活把空值请求头发给上游（换回一句「需要鉴权」），
    // 两处都不喂则保存会抹掉密钥。判据是「保存那处有、探活那处没有」。
    expect(actionBody('testMcpForm'), '探活也把 current 喂进了 buildMcpConfig').toContain(
      'buildMcpConfig(values)',
    );
  });
});

/**
 * 粘贴导入的接线。
 *
 * 组件自己那一侧钉住了「预览说了什么、确认交出了哪份 map」，但看不见**页面有没有把它接上**：
 *   · 卡片头部漏传 `onPasteJson` ⇒ 整个导入路径在界面上不可达（按钮禁用，用户只能一条条手填）；
 *   · 弹窗漏喂 `servers` ⇒ 预览永远说「新增」（覆盖判定要读现有集合）；
 *   · 回调体写错键（例如 `update({ providers: … })`）类型也过（SettingsPatch 全是可选的），
 *     而界面上看起来「导入成功了」。
 * 判据口径与上面几段一致：把开标签抠出来只扫这一段，抠不到就抛。
 */
describe('settings 页面的粘贴 JSON 导入接线', () => {
  it('卡片头部接上「粘贴 JSON」入口——漏了它整条导入路径在界面上不可达', () => {
    expect(openingTag('McpServerTable'), '少了 onPasteJson=').toContain('onPasteJson=');
  });

  it('弹窗吃到这份 settings 的 mcpServers、保存态与两个回调', () => {
    const tag = openingTag('McpPasteModal');

    expect(tag, '少了 servers=').toContain('servers=');
    expect(tag, 'servers 不是从 settings 那份集合来的').toContain('mcpServers');
    for (const prop of ['open=', 'saving=', 'onImport=', 'onCancel=']) {
      expect(tag, `少了 ${prop}`).toContain(prop);
    }
  });

  it('导入是**一次** PUT { mcpServers }：弹窗交出的整份 map 直接落盘，页面不再合并第二次', () => {
    expect(source, '粘贴导入没有落到 PUT { mcpServers }').toContain('update({ mcpServers: next })');
  });
});
