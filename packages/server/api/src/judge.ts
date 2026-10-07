/**
 * 评分标准项的生成与识别（两个动作共用一个入口）。
 *
 * 三条必须守住的口径：
 *   1. **只读**：本模块不写任何落盘内容。失败时调用方手里已有的表格与文本必须原样保留
 *      ——失败只抛可展示的中文错误，绝不顺手改配置或清空状态；
 *   2. **只用设置页的全局默认评分模型**（`resolveJudgeRoute()`，**无参**）：这里**没有**智能体通路，
 *      也不接受任何模型 id 入参——入参里带一对 id 就等于让调用方能绕开设置页那一格；
 *   3. **两个分支的差别只有输入**：
 *      · `prompt` 为空 ⇒ 「智能生成」：校验仓库（取仓库名）→ 调模型 → **合并**；
 *      · `prompt` 非空 ⇒ 「智能识别」：**不碰仓库**（那段文本里已有全部信息）→ 调模型 → 整表替换。
 *      两分支都是**非流式**文本调用，都不落盘。
 *   顺序：两分支都先解析路由（未配置评分模型时当场抛 CONFLICT，一次上游调用都不花）；
 *   生成分支随后才校验仓库，识别分支则连 `repoPath` 都不看。
 */
import {
  RubricSchema,
  ServiceError,
  parseRepoSource,
  renderRubricForJudge,
  rubricItemKeys,
  validateRubric,
  type GenerateRubricInput,
  type Rubric,
} from '@aieval/contracts';
import { resolveRepoInfo } from '@aieval/core';
import { callTextApi, resolveJudgeRoute } from '@aieval/evaluator';

/** 转出评分模型路由解析：HTTP 层要用它做「未配置评分模型」的即时报错（契约 §6） */
export { resolveJudgeRoute } from '@aieval/evaluator';

/** 原文片段保留长度：够定位问题，又不会把几百 KB 的回复塞进错误响应 */
const RAW_EXCERPT_LENGTH = 500;

/** 生成结果：`rubric` 回填表格；`addedItems` 给界面文案用；`note` 只在需要解释时出现 */
export interface GenerateRubricResult {
  /** 回填的完整表格：生成分支是**合并后**的那张，识别分支是**整表替换**的那张（spec D9：两支都给完整表格） */
  rubric: Rubric;
  /**
   * **只有生成分支**有意义：这一次往当前表格里**新增**了多少项（0 ⇒ 模型说「已经完备」，界面显示「未新增条目」）。
   * **识别分支恒为 0**（spec §4：那一支是整表替换，「新增了几项」在那条路上没有定义）——
   * 它**绝不代表**「什么都没识别出来」：识别不出条目会直接抛 `JUDGE_PARSE_FAILED`（见 `parseGenerated`），
   * 不会以「0 项的成功」返回。调用方判识别失败要看 `rubric`，不要看这一格。
   */
  addedItems: number;
  /** 只在需要解释时出现（生成分支的「未新增条目」）。**识别分支不带它** */
  note?: string;
}

/**
 * 生成 / 识别评分标准项（非流式）。
 * 顺序有意如此：**两条分支都先解析路由**（未配置评分模型时立刻 CONFLICT，不下传任何模型 id：
 * 这一次走哪把尺子只有一个来源），生成分支**再校验仓库**——前面两步失败时一次模型调用都不该花掉
 * （限额是真的钱）；识别分支不碰仓库，故 `repoPath` 为空也必须能成功。
 */
export async function generateRubric(input: GenerateRubricInput): Promise<GenerateRubricResult> {
  const recognizing = input.prompt.trim() !== '';
  // 未配置评分模型时这里抛 CONFLICT，message 指向设置页（不下传任何模型 id：这一次走哪把尺子只有一个来源）
  const route = resolveJudgeRoute();

  if (recognizing) {
    const raw = await callTextApi(route, {
      system: buildSystemPrompt('识别'),
      prompt: buildRecognizePrompt({ userPrompt: input.prompt, taskPrompt: input.taskPrompt }),
    });
    const parsed = parseGenerated(raw, '识别');
    // 识别分支是**整表替换**（生成分支才做合并）：调用方直接拿 `rubric` 覆盖表格，不做「按组名归位」。
    // `addedItems` 在这一支恒为 0（见 `GenerateRubricResult.addedItems` 的说明）：它只描述生成分支
    // 「补了几项」，不是「识别到几项」——识别到 0 项会抛错，不会走到这里。
    return { rubric: parsed, addedItems: 0 };
  }

  // ── 智能生成：先校验仓库（顺带把「路径早就不可用」挡在模型调用之前），再调模型，最后合并 ──
  const source = parseRepoSource(input.repoPath);
  const repoName = source.kind === 'local' ? resolveRepoInfo(source.path).repoName : source.repoName;
  const raw = await callTextApi(route, {
    system: buildSystemPrompt('生成'),
    prompt: buildGeneratePrompt({ current: input.rubric, taskPrompt: input.taskPrompt, repoName }),
  });
  const added = parseGenerated(raw, '生成');
  const merged = mergeRubric(input.rubric, added);
  return {
    rubric: merged.rubric,
    addedItems: merged.addedItems,
    ...(merged.addedItems === 0 ? { note: '当前评分标准项已覆盖本题，未新增条目' } : {}),
  };
}

/** 系统提示词：只约束「怎么回」，业务约束全在用户提示词与输出契约里 */
function buildSystemPrompt(mode: '生成' | '识别'): string {
  return [
    '你是一名资深代码评审专家，负责为「AI 生成代码评测」撰写**评分标准项**。',
    mode === '生成'
      ? '你会拿到一份**已有的**评分标准项表格：你的任务是**只补充缺的条目**，不要重复已有的条目。'
      : '用户会给你一段他自己的评分要求：你的任务是把它**原样抽取**成结构化表格。',
    '评分模型只会看到候选的代码改动（diff），看不到任何对话过程，也看不到原始仓库。',
    '你的回复必须是一个 JSON 对象，不要输出解释、不要使用 markdown 代码围栏。',
  ].join('\n');
}

/**
 * 生成分支的用户提示词：仓库名 + 题面 + **当前表格（含已有 ID 清单）** + 输出契约 + 四条硬约束。
 * 为什么必须回显当前表格：AI 要能**只增不改**，它必须先知道已有什么。
 */
function buildGeneratePrompt(context: { current: Rubric; taskPrompt: string; repoName: string }): string {
  const keys = rubricItemKeys(context.current);
  const existing = context.current.groups.length === 0
    ? '（当前表格是空的，请从零起草）'
    : renderRubricForJudge(context.current);
  return [
    `【仓库】${context.repoName}`,
    `【考题提示词】\n${context.taskPrompt}`,
    `【已有的评分标准项】\n${existing}`,
    `【已被占用的 ID】${keys.length === 0 ? '（无）' : keys.join('、')}`,
    `【输出契约】\n${GENERATE_OUTPUT_CONTRACT}`,
    [
      '【你的任务】',
      '只补充**当前表格里还没有的**条目，放进 JSON 的 groups 字段；',
      '硬性要求：',
      '1. **只新增**：已存在的条目一条都不许重复、不许改写、不许删除；',
      '2. **禁止复用上面【已被占用的 ID】里的任何 ID**；',
      '3. 同一个主题要**复用已有的组名**（例如给「二、测试」补条目就写 name: "二、测试"），新主题才用新组名；',
      '4. 如果当前表格已经足够覆盖这道考题，groups 返回**空数组**——不要为了凑数硬加条目。',
    ].join('\n'),
  ].join('\n\n');
}

/**
 * 识别分支的用户提示词：用户原文（逐字放入）+ 可选题面 + 输出契约 + 三条硬约束。
 * **刻意不收当前表格**：识别是整表替换，把已有表格送进去只会诱导模型去「合并」——
 * 而用户粘进来的那段文本里已经有全部信息（这与生成分支必须回显当前表格正好相反）。
 */
function buildRecognizePrompt(context: { userPrompt: string; taskPrompt: string }): string {
  return [
    context.taskPrompt.trim() === '' ? '' : `【考题提示词（供你理解上下文）】\n${context.taskPrompt}`,
    `【用户给出的评分要求（原样）】\n${context.userPrompt}`,
    `【输出契约】\n${GENERATE_OUTPUT_CONTRACT}`,
    [
      '【你的任务】',
      '把上面这段评分要求**原样抽取**成结构化表格，放进 JSON 的 groups 字段；',
      '硬性要求：',
      '1. **原样抽取**：用户写了几组就几组、几个条目就几个条目，**权重数字一个都不许改**、不合并不拆分、不改写措辞；',
      '2. 忽略与条目无关的内容（标题里的「满分 100 分」、组名里的「48 分」都**不进权重**——组不带权重）；',
      '3. 用户没给 ID 时 id 留空串，**不要自己编号**。',
    ].join('\n'),
  ]
    .filter((section) => section !== '')
    .join('\n\n');
}

/**
 * 生成 / 识别分支共用的输出契约：与评分侧那份（`JUDGE_OUTPUT_CONTRACT`）**不同**——
 * 这边要求的是「表格的形状」，那边要求的是「判定的形状」。
 */
const GENERATE_OUTPUT_CONTRACT = [
  '输出要求（务必严格遵守）：',
  '1. 只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，不要使用 markdown 代码围栏；',
  '2. 字段结构固定为：',
  '   {',
  '     "groups": [',
  '       {',
  '         "name": "组名（如「一、生产代码」）",',
  '         "items": [',
  '           { "id": "短 ID（可留空串）", "goal": "目标：这一项要达成什么", "weight": 正整数 }',
  '         ]',
  '       }',
  '     ]',
  '   }',
  '3. weight 必须是**正整数**（不能是 0、负数或小数）；goal 不能为空；',
  '4. 组**不带权重**：满分由所有条目的 weight 相加得出，不需要你给总分。',
].join('\n');

/**
 * 按组名归位地合并：`added` 里的每个组，若 `current` 已有同名组则把它的项**追加到该组末尾**；
 * 否则按 `added` 给的顺序**新建组并追加到表尾**。
 * 为什么服务端做合并（而不是把「仅新增」交给前端拼）：合并规则与「新项 ID 不得与已有 ID 冲突」
 * 这两条校验必须与落库用的是同一份判据；放客户端等于同一套规则写两遍。
 *
 * 两条容易写错、而且**下游一条都拦不住**的地方：
 *   1. 组的解析与创建必须在 item 循环**之外、整组只做一次**。放进循环里，每个新组的**每一项**都会
 *      新建一个同名组（模型的「一、生产代码」两项变成两个「一、生产代码」），而 `validateRubric`
 *      不查组名重复 ⇒ 一张被切碎的表格会一路绿到落库（新用例的空表 + 整表生成正是最容易踩中的形状）；
 *   2. 合并后仍是**空表**时不能把责任推给模型（`{ groups: [] }` 是它按契约给出的合法答复）——
 *      那说明当前表格本来就是空的、模型也没补上，如实说清并给一条出路。
 */
export function mergeRubric(current: Rubric, added: Rubric): { rubric: Rubric; addedItems: number } {
  const groups = current.groups.map((group) => ({ name: group.name, items: [...group.items] }));
  const taken = new Set(groups.flatMap((group) => group.items.map((item) => item.id)).filter((id) => id !== ''));
  let addedItems = 0;

  for (const group of added.groups) {
    // 组名归位：同名组复用**同一个对象引用**，整组只创建一次（理由见函数头第 1 条）
    let known = groups.find((candidate) => candidate.name === group.name);
    if (known === undefined) {
      known = { name: group.name, items: [] };
      groups.push(known);
    }
    for (const item of group.items) {
      if (item.id !== '') {
        if (taken.has(item.id)) {
          throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型新增的条目复用了已有的 ID「${item.id}」：请重试或换一个模型`, {
            context: { id: item.id },
          });
        }
        taken.add(item.id);
      }
      known.items.push(item);
      addedItems += 1;
    }
  }

  const rubric: Rubric = { groups };
  if (groups.length === 0) {
    // 空表 + 什么都没补：这不是「已经完备」（空表覆盖不了任何东西），也不该说成「模型的表格不合法」
    // （它回的空数组完全合法）。如实说清是哪一边的问题，并给出一条能照做的出路。
    throw new ServiceError('INVALID_QUERY', '当前评分标准项是空的，模型也没有补充任何条目：请先把题面写具体一些，或换一个模型再试', {
      context: { addedItems },
    });
  }
  const checked = validateRubric(rubric);
  if (!checked.ok) {
    // 模型给的形状越过了业务边界（典型是权重 0）——折成可展示的中文，而不是把一张坏表交给调用方
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型返回的表格不合法：${checked.message}`, { context: { message: checked.message } });
  }
  return { rubric, addedItems };
}

/**
 * 解析模型回复：剥围栏 → JSON.parse → 形状校验 → 业务校验（`validateRubric`）。
 * 全部失败路径都折成 JUDGE_PARSE_FAILED（HTTP 500），message 必须是能直接给用户看的中文。
 *
 * `mode` 只影响**空表**这一条判据（两支的语义不同，见下面那段注释），其余判据两支逐字相同。
 */
function parseGenerated(raw: string, mode: '生成' | '识别'): Rubric {
  const jsonText = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型返回的不是合法 JSON，请重试或换一个模型：${excerpt(raw)}`, {
      context: { raw: excerpt(raw) },
    });
  }

  const checked = RubricSchema.safeParse(parsed);
  if (!checked.success) {
    const detail = checked.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '（根对象）'}：${describeIssue(issue)}`)
      .join('；');
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型返回的表格形状不合法（${detail}）：请重试或换一个模型`, {
      context: { raw: excerpt(raw) },
    });
  }
  // **空表在两支里的含义正好相反**：
  //   · 识别分支**不允许**：用户明明粘了一段评分要求，却识别出空表——那一定是我们或模型错了。
  //     放它过去等于「把用户的输入静默丢掉」再回一个 200（这一支是整表替换，空表就是最终结果）；
  //   · 生成分支**允许**：空数组是模型按契约给出的「当前表格已经覆盖本题，我没什么可补的」，
  //     那是设计内的成功答复（调用方据此显示「未新增条目」），见 mergeRubric 与调用点的 note。
  if (mode === '识别' && checked.data.groups.length === 0) {
    throw new ServiceError('JUDGE_PARSE_FAILED', '评分模型没有从这段评分要求里识别出任何条目：请重试或换一个模型（也请确认粘进来的文本里有评分要求）', {
      context: { raw: excerpt(raw) },
    });
  }
  const business = validateRubric(checked.data);
  if (!business.ok && checked.data.groups.length > 0) {
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型返回的表格不合法：${business.message}`, {
      context: { raw: excerpt(raw), message: business.message },
    });
  }
  return checked.data;
}

/**
 * 评分表里那几格的「错在哪」：zod 的默认文案是英文（`Number must be greater than 0` / `Expected number, received string`），
 * 而这条 message 会原样出现在界面上——用户既看不懂、也无从照做。
 *
 * 中文提示必须**同时看字段与 issue code**，而且要把「缺了这一格」与「类型/取值不对」分开
 * （实测 zod 3.25：缺格是 `invalid_type` + `received: 'undefined'` + `Required`）：
 * 只看字段会把 `weight: "18"`（模型最常见的滑法：数字被引号包住）说成「必须是正整数」、
 * 把 `name: 123` 说成「组名不能为空」、把**缺了** `items` 说成「items 必须是数组」——
 * 每一句都**指对了格子、却说错了原因**，那正是「编造的翻译比英文原文更坏」的那种错。
 * 故：缺格给缺格提示、类型错给类型提示、范围错给范围提示；并把 zod 原文**附在中括号里**
 * ——中文说这一格该长什么样，原文说它实际哪里不对，两条一起才既认得出格子、也看得见真正的原因。
 */
const RUBRIC_FIELD_HINTS: Record<string, { missing: string; type: string; range?: string }> = {
  weight: {
    missing: '缺少权重（每一项都必须给一个正整数权重）',
    type: '权重必须是整数、不能是字符串或小数',
    range: '权重必须是正整数（不能是 0、负数或小数，且不超过 10000）',
  },
  goal: {
    missing: '缺少目标（每一项都必须给目标）',
    type: '目标必须是字符串',
    range: '目标不能为空',
  },
  name: {
    missing: '缺少组名（每一组都必须给组名）',
    type: '组名必须是字符串',
    range: '组名不能为空',
  },
  groups: {
    missing: '缺少 groups（评分表形如 { "groups": [ … ] }）',
    type: 'groups 必须是数组',
  },
  items: {
    missing: '缺少 items（每一组都必须给条目数组）',
    type: 'items 必须是数组',
  },
};

/** 根对象本身不合法时的中文提示（否则整句中文里会突兀地夹一句英文） */
const ROOT_OBJECT_HINT = '评分表必须是一个对象（形如 { "groups": [ … ] }）';

/** 数组元素本身不合法时的中文提示：照路径倒数第二段判断是哪一级的元素，别让中文框里只剩英文 */
function elementHint(path: readonly (string | number)[]): string {
  const parent = path[path.length - 2];
  if (parent === 'groups') return '这一组必须是对象（形如 { "name": "组名", "items": [ … ] }）';
  if (parent === 'items') return '这一个评分项必须是对象（形如 { "id": "…", "goal": "…", "weight": 1 }）';
  return '这一项的形状不对';
}

/** 按「字段 + issue code（+ 是缺格还是类型错）」取中文提示；认不出的组合原样返回 zod 的文案（不编） */
function describeIssue(issue: { code: string; path: readonly (string | number)[]; message: string; received?: unknown }): string {
  if (issue.path.length === 0) return `${ROOT_OBJECT_HINT}［${issue.message}］`;
  const field = issue.path[issue.path.length - 1];
  // 数组元素的错：路径末段是下标 ⇒ 中文要说的是「这一组 / 这一项」的形状
  if (typeof field !== 'string') return `${elementHint(issue.path)}［${issue.message}］`;
  const hints = RUBRIC_FIELD_HINTS[field];
  // 表里没登记、但位置已经点明的字段（今天只有 `id`）：给一句**不编原因**的中文
  //（「取值不合法」对任何 zod issue 都成立），后面仍附原文——别让中文框里只剩一句英文
  if (hints === undefined) return `这一格的取值不合法［${issue.message}］`;
  if (issue.code !== 'invalid_type') return hints.range === undefined ? issue.message : `${hints.range}［${issue.message}］`;
  return `${issue.received === 'undefined' ? hints.missing : hints.type}［${issue.message}］`;
}

/**
 * 剥掉 markdown 代码围栏：模型即使被要求「只输出 JSON」也常常包一层 ```json。
 * 只处理开头/结尾的围栏，不动正文。
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenceMatch?.[1] ?? trimmed;
}

/** 原文片段：截断到合理长度（排障够用，又不会把整个回复塞进错误上下文） */
function excerpt(raw: string): string {
  return raw.length <= RAW_EXCERPT_LENGTH ? raw : `${raw.slice(0, RAW_EXCERPT_LENGTH)}…（已截断）`;
}
