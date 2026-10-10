/**
 * 评分器（**文本评分通路**）：把用例的**评分标准项表格** + 裁剪后的 diff 交给评分模型（纯文本 API），
 * 解析出逐项判定（达成 / 未达成）。另一条通路是智能体评分（`judge-agent.ts`），它复用本文件的解析与收口。
 *
 * 判据：**按评分表逐项取，缺一项即整行失败**。
 * 为什么缺项不能算「未达成」：那会让「模型漏答」与「确实没做」在分数上完全同形；
 * 当送分更糟——白送一整项权重，而分数看起来完全正常。
 *
 * 另一条不许动的口径：**总分一律按权重加总**（contracts 的 `composeTotalScore`，在 `finalizeScore` 里调用），
 * 模型**根本不给总分**（输出契约第 5 条），故「模型算错总分」这一整类问题不存在。
 *
 * 本文件里的 `parseJudgeResponse` 与 `finalizeScore` 是**两条评分通路共用的尺子**：
 * 文本通路（`judgeRow`）与智能体通路（`judge-agent.ts` 的 `judgeRowByAgent`）解析完都必须过这两个函数。
 * 各写一份必然在某处漂移，而漂移的表现是「两条通路的分数不可比」——最不该静默发生的一类。
 *
 * 结构检查不合格时回问模型（多轮修复）保留：修复只**修形状**，不改尺子——各项都取、缺一项失败、
 * 总分由权重加总这三条一个字都没动（`validateJudgeResponse` 就是 `parseJudgeResponse` 的判据本身，
 * 不存在「宽松版解析器」）。每一轮都留痕（`onProgress` → 该行事件日志）。
 *
 * 注意：本文件不碰工作区、不碰 git、不写 run.json；调用文本 API 的是 judgeRow，解析与收口是纯函数。
 */
import {
  JUDGE_OUTPUT_CONTRACT,
  ScoreResultSchema,
  ServiceError,
  composeTotalScore,
  renderRubricForJudge,
  rubricItemKeys,
  rubricMaxScore,
  type AgentKind,
  type Rubric,
  type RubricJudgment,
  type ScoreResult,
} from '@aieval/contracts';
import { callTextApiConversation, type ChatMessage, type TextRoute } from './text-api';

/** 解析失败时随错误一起保留的原文上限（字符）：够看清模型回了什么，又不至于把事件日志撑爆 */
export const RAW_KEEP_CHARS = 2_000;
/** 成功时写进 `ScoreResult.raw` 的上限：要能当「原始返回」展示，也要防模型跑飞写出几 MB */
const RAW_MAX_CHARS = 20_000;
/** 模型没给总评时的占位文案 */
const VERDICT_FALLBACK = '（模型未给出总评）';
/** 模型没给某一项理由时的占位文案 */
const REASON_FALLBACK = '（模型未给出理由）';
/**
 * 结构检查不合格后**回问模型的轮数上限**（不含首次回答）。
 * 2 轮 = 最多 3 次请求。新体系下这条机制更承重：漏一项 = 白送那一项的权重。
 */
export const JUDGE_REPAIR_ROUNDS = 2;

/** 解析失败一律 JUDGE_PARSE_FAILED：该行落 failed；raw 原文由 judgeRow 补进 context */
function parseFailed(message: string): ServiceError {
  return new ServiceError('JUDGE_PARSE_FAILED', message);
}

/**
 * 错误对象 → 可读原因。
 * 为什么 `export`：两条评分通路的错误折叠共用它，各写一份的坏处与尺子一样——漂移了没人看得出来。
 */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 剥掉 markdown 围栏。
 * 只在「整段回答以 ``` 开头」时剥：中间夹散文的情况故意不救——契约要求只输出 JSON，
 * 从散文里抠 JSON 会把「模型没守契约」静默变成「成功」，而暴露它正是解析器的职责。
 */
function stripCodeFence(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('```')) return text;
  const fenced = /^```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/**
 * `achieved` 的**宽容读**：接受布尔，以及它在两种语言里最常见的字符串写法，**大小写不敏感**：
 *   · 达成：`true` / `"true"` / `"是"` / `"达成"`（`"True"` / `"TRUE"` 同样算）
 *   · 未达成：`false` / `"false"` / `"否"` / `"未达成"`
 * 为什么宽容：模型很爱把布尔写成字符串，而 schema 那一关只在**上游认了**的时候才拦得住
 * （网关不透传时形同虚设）；此处不宽容会让一次格式小毛病变成整行失败。
 * 为什么连「达成 / 未达成」也收：那正是本工具自己的两个词（评分口径、界面、输出契约都用它们），
 * 模型照着题面用词回答是最可能的一种中文写法——不收它等于专挑最自然的那个词失败。
 * 大小写不敏感是同一条理由的延伸（`"True"` 与 `"true"` 没有语义差别）。
 * **不再多收**：`"优秀"` / `"yes"` / `1` 这类要另立一张对照表，而每加一格都是「换个词就能过」的新口子，
 * 判据停在「布尔 + 这两种语言的两个词」上。
 * 认不出就返回 null（调用方按「这一项的判定不合法」处理）。
 * 这一段清单就是**唯一的受理面**：`judge.test.ts` 的正向表逐词钉住它，改这里必须同时改那里
 * （「文档写着四个、代码收六个」就是要防的那种分家）。
 */
function coerceAchieved(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === '是' || text === '达成') return true;
  if (text === 'false' || text === '否' || text === '未达成') return false;
  return null;
}

/** 理由：缺了就给占位文案，不让界面出现空白（理由是展示项，不是判据） */
function coerceReason(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : REASON_FALLBACK;
}

/**
 * 结构检查的**单一真源**：把模型的原文收成契约的逐项判定 + 总评。
 * 返回「合格 / 不合格 + 可直接展示的中文原因」，**不抛**——调用方要拿这条原因去回问模型，
 * 而异常是给「已经决定失败」的那条路用的。`parseJudgeResponse` 与 `validateJudgeResponse`
 * 都只是它的一层皮：**同一个判据**，不存在「宽松版解析器」这种第二把尺子。
 *
 * 四条口径：
 *   1. 不合法 JSON / 空内容 / 顶层不是对象 / 没有 judgments 数组 → 不合格；
 *   2. markdown 围栏先剥（只剥「整段以 ``` 开头」的），中间夹散文故意不救；
 *   3. 按评分表的引用键**逐个**取：缺一项不合格（点名引用键与目标）、多余判定忽略、
 *      重复引用键取第一条、`achieved` 宽容读、理由缺失给占位文案；
 *   4. 总评缺失给占位文案（总评不是判据）。
 */
function collectJudgeJudgments(
  raw: string,
  rubric: Rubric,
): { ok: true; parsed: { judgments: RubricJudgment[]; verdict: string } } | { ok: false; message: string } {
  const text = stripCodeFence(raw);
  if (text === '') return { ok: false, message: '评分模型返回了空内容' };

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `评分模型返回的不是合法 JSON（${reason(error)}）` };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: '评分模型返回的 JSON 顶层不是对象' };
  }

  const list = (payload as { judgments?: unknown }).judgments;
  if (!Array.isArray(list)) return { ok: false, message: '评分模型返回的 JSON 里没有 judgments 数组' };

  // 先按引用键归并：重复的键以第一条为准（模型偶尔会把同一项说两遍）
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || byId.has(id)) continue;
    byId.set(id, record);
  }

  // 按评分表的引用键**逐个**取。刻意写成 for 循环而不是 map/filter：
  // 「缺一项就不合格」必须是**一行**可被守卫钉住的分支（把它改成 continue 就是那个缺陷本身）
  const keys = rubricItemKeys(rubric);
  const items = rubric.groups.flatMap((group) => group.items);
  const judgments: RubricJudgment[] = [];
  for (const [index, key] of keys.entries()) {
    const goal = items[index]?.goal ?? '';
    const found = byId.get(key);
    if (found === undefined) {
      return { ok: false, message: `缺少对 ${key}（${goal}）的判定：评分表里的每一项都必须恰好给出一条判定` };
    }
    const achieved = coerceAchieved(found.achieved);
    if (achieved === null) {
      return { ok: false, message: `${key}（${goal}）的 achieved 不是布尔值（收到 ${JSON.stringify(found.achieved) ?? 'undefined'}）` };
    }
    judgments.push({ id: key, achieved, reason: coerceReason(found.reason) });
  }

  const rawVerdict = (payload as { verdict?: unknown }).verdict;
  const verdict = typeof rawVerdict === 'string' && rawVerdict.trim() !== '' ? rawVerdict.trim() : VERDICT_FALLBACK;
  return { ok: true, parsed: { judgments, verdict } };
}

/** 结构检查的结果：合格带解析结果，不合格带**可直接写进纠错提示**的中文原因 */
export type JudgeValidation =
  | { ok: true; parsed: { judgments: RubricJudgment[]; verdict: string } }
  | { ok: false; message: string };

/** 结构检查（**不抛**）：模型的原文合不合契约。`judgeRow` 的修复循环靠它决定要不要再问一轮 */
export function validateJudgeResponse(raw: string, rubric: Rubric): JudgeValidation {
  return collectJudgeJudgments(raw, rubric);
}

/**
 * 解析评分模型的返回（纯函数）。**仍是抛异常的那一层皮**：判据全部来自 `collectJudgeJudgments`，
 * 这里只负责把「不合格」翻成 `JUDGE_PARSE_FAILED`。
 */
export function parseJudgeResponse(raw: string, rubric: Rubric): { judgments: RubricJudgment[]; verdict: string } {
  const checked = collectJudgeJudgments(raw, rubric);
  if (!checked.ok) throw parseFailed(checked.message);
  return checked.parsed;
}

/**
 * 把「已解析的判定 + 原文」收口成契约认可的 `ScoreResult`。
 * 为什么**必须**是一个函数：文本通路与智能体通路共用同一把尺子的全部口径——逐项取、缺一项失败在先、
 * 总分一律按权重加总、满分取评分表、raw 的截断上限、以及「形状漂移在这里就炸」的自检。
 *
 * `structuredOutput` 与 `judgeEffort` 也走同一条口径（**都必填**）：两条通路各自表一次态，
 * 而不是让收口函数吃一个「谁也没选过」的默认值。
 */
export function finalizeScore(input: {
  parsed: { judgments: RubricJudgment[]; verdict: string };
  /** 这一分用的评分表（**快照**：改了用例的评分表不该影响已有分数与它的满分） */
  rubric: Rubric;
  raw: string;
  judgeProviderId: string;
  judgeModelId: string;
  /** null ⇔ 走纯文本 API（见 contracts 的 ScoreResult.judgeAgentKind） */
  judgeAgentKind: AgentKind | null;
  /**
   * 这一分用什么强度打的（**必填**；`null` ⇔ 我们没指定强度）。
   * 与 `structuredOutput` 同一条处置：两条通路各自表一次态，而不是让收口函数吃一个「谁也没选过」的
   * 默认值——`null` 与档名都是合法值，给缺省会让「忘了传下来」与「确实没指定」在数据上完全同形。
   */
  judgeEffort: string | null;
  /** 这一分是不是在 schema 约束下拿到的（必填；文本通路传 false，智能体通路取适配器报回的 `applied`） */
  structuredOutput: boolean;
  /**
   * **评分这一次调用自己**的用量与耗时（必填）。与 `judgeEffort` / `structuredOutput`
   * 同一条处置：两条通路各自表一次态，给缺省会让「忘了传下来」与「确实没采到」在数据上同形。
   * `null` = 没采到（**不是 0**）——界面据此显示「用量未采集 / 耗时未采集」。
   * 语义：文本侧是**各轮成功调用之和**（结构修复是额外请求，钱要算进去）与整段的掐表；
   * 智能体侧是适配器自报的 `result.tokens` / `result.durationMs`（与候选行同一份原料）。
   */
  judgeTokens: { input: number; cached: number; output: number } | null;
  judgeDurationMs: number | null;
}): ScoreResult {
  const result: ScoreResult = {
    judgments: [...input.parsed.judgments],
    // 总分一律按权重加总：模型根本不给总分，故这里不存在「采信 / 不采信」的取舍
    totalScore: composeTotalScore(input.rubric, input.parsed.judgments),
    // 满分取**快照**而不是当前用例：评分表改了之后，这一分与它自己的满分仍自洽
    maxScore: rubricMaxScore(input.rubric),
    verdict: input.parsed.verdict,
    raw: truncateRaw(input.raw, RAW_MAX_CHARS),
    judgeProviderId: input.judgeProviderId,
    judgeModelId: input.judgeModelId,
    judgeAgentKind: input.judgeAgentKind,
    // 强度按调用方给的记（两条通路各自表一次态，来源是同一格配置）。
    // `null` 只表达「我们**没指定**」：不是「关闭」（关闭档是上游词汇 `off`），
    // 也**不等于**两条通路当时跑在同一个强度上——未指定时文本侧一个强度键都不发（听网关缺省）、
    // 智能体侧走该家适配器自己的缺省（dsh 会落到它的 `high`），两边可以不落到一处。
    judgeEffort: input.judgeEffort,
    structuredOutput: input.structuredOutput,
    judgeTokens: input.judgeTokens,
    judgeDurationMs: input.judgeDurationMs,
    judgedAt: new Date().toISOString(),
  };
  // 契约自检：形状漂移在这里就炸，而不是把脏数据写进 run.json 等读的时候才发现。
  // 抛的必须是中文 ServiceError（code 用 INTERNAL：这不是模型答错，而是我们自己的形状漂移）
  const checked = ScoreResultSchema.safeParse(result);
  if (!checked.success) {
    const issues = checked.error.issues;
    const detail = issues
      .slice(0, 3)
      .map((issue) => `${issue.path.length === 0 ? '（根对象）' : issue.path.join('.')}：${issue.message}`)
      .join('；');
    const more = issues.length > 3 ? `；另有 ${issues.length - 3} 处` : '';
    throw new ServiceError('INTERNAL', `评分结果不符合契约（本包形状漂移，本不该发生）：${detail}${more}`, {
      cause: checked.error,
      context: {
        judgeModelId: input.judgeModelId,
        issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
  }
  return checked.data;
}

/**
 * 拼「你上一次的输出不合格」那一轮用户消息（**纯函数**，可单独断言）。
 * 三样缺一不可：点名具体原因、附上它自己的原文（截断）、**把评分表的引用键与目标再列一遍**
 * ——「缺项」这一类错误靠散文描述纠正不了，模型需要的是照抄一份清单。
 */
export function buildJudgeFeedback(input: { message: string; raw: string; rubric: Rubric }): string {
  const keys = rubricItemKeys(input.rubric);
  const items = input.rubric.groups.flatMap((group) => group.items);
  const fields = keys.map((key, index) => `   - ${key}：${items[index]?.goal ?? ''}（权重 ${items[index]?.weight ?? 0}）`).join('\n');
  return [
    '你上一次的输出没有通过结构检查，**不能**作为评分结果使用。',
    '',
    `具体问题：${input.message}`,
    '',
    '你上一次的输出是（可能被截断）：',
    '```',
    truncateRaw(input.raw, RAW_KEEP_CHARS),
    '```',
    '',
    '请重新给出**修正后**的评分结果。硬性要求：',
    '1. 只输出一个 JSON 对象：不要解释、不要道歉、不要 markdown 代码围栏、不要输出 JSON 以外的任何文字；',
    '2. judgments 必须**恰好**含下面这些引用键，一个都不能少、名字不能改、顺序照抄：',
    fields,
    '3. 每一项的 achieved 只能是 true 或 false（达成 / 未达成），reason 用一句中文说明；',
    '4. 顶部给出 verdict（一句话中文总评）；**不要**给总分。',
  ].join('\n');
}

/**
 * 一次结构修复的进度事件：由调用方（编排层）写进该行的日志抽屉。
 * 为什么必须有它：修复是**额外请求**，使用者在日志里必须能看到「为什么这一行多花了十几秒」。
 */
export interface JudgeProgress {
  /** 已经失败的轮次序号（第 1 次回答不合格 ⇒ 1） */
  round: number;
  /** 结构检查给出的中文原因 */
  message: string;
}

/**
 * 一次评分请求的全部输入。
 * `rubric` 是**这一轮的快照**（由编排层从 `run.rubric` 传入，不是从用例现取）：改了用例的评分表
 * 之后重评，用的仍应是当初那把尺子。
 */
export interface JudgeInput {
  rubric: Rubric;
  diffText: string;
  taskPrompt: string;
  route: TextRoute;
  judgeProviderId: string;
  /**
   * 这一次评分要求的思考强度（来自 `settings.defaultJudge.effort`，由调用方读配置后传进来）。
   * 为什么是**入参**：`judgeRow` 今天是纯入参的（不读配置、不碰落盘），读点只有一个
   * （`judge-route.ts` 的 `resolveJudgeEffort`）。为什么不做成 `route` 的一格：那是**连接事实**，
   * 而强度是**请求参数**（与候选侧 `AgentRunInput.effort` 同一口径）。
   * 未指定 = 一个强度键都不发（听网关的缺省，**不是**关闭）；档名可不可用不在这一层判（本层只把值递下去）。
   */
  judgeEffort?: string;
  /** 这一行的停止信号（可选：不传即「不可中止」） */
  signal?: AbortSignal;
  /** 结构修复的进度回调（可选；编排层把它接到该行的事件日志上） */
  onProgress?: (progress: JudgeProgress) => void;
  /** 「编排层开始了一次新的行尝试」的接缝（可选；生产代码里它是一个 no-op） */
  onAttemptStart?: () => void;
}

/**
 * 截断原文并留明确标记：要能区分「模型只说了这么多」与「我们截了」。
 * **两条评分通路共用**：截断标记一旦在某一侧漂移，另一侧的 `context.raw` 就会缺标记。
 */
export function truncateRaw(text: string, max = RAW_KEEP_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（原始返回共 ${text.length} 字符，此处截断）`;
}

/**
 * 拼评分请求：题面 → **评分标准项表格** → 待评的改动。
 * 为什么把改动放最后：长输入里尾部内容最不容易被忽略；空 diff 显式写「（无改动）」，
 * 否则模型会把「看不到改动」当成「没改」。
 */
function buildJudgePrompt(input: JudgeInput): string {
  const diff = input.diffText.trim() === '' ? '（无改动）' : input.diffText;
  return [
    '## 考题（候选拿到的任务）',
    input.taskPrompt,
    '',
    '## 评分标准项（逐项判定：达成给 true，未达成给 false）',
    renderRubricForJudge(input.rubric),
    '',
    '## 候选的代码改动',
    diff,
  ].join('\n');
}

/**
 * 跑一次评分：调用文本 API → **结构检查** → 不合格就把原因发回给模型再问一轮 → 收口（`finalizeScore`）。
 *
 * 失败面分三类，处置不同：
 *   - 调用失败（网络 / 鉴权 / 限流）→ **透传原错误码**（「没问到」与「答错了」是两回事）；
 *   - 结构检查不合格 → 回问模型，最多 `JUDGE_REPAIR_ROUNDS` 轮；仍不合格才折成 `JUDGE_PARSE_FAILED`，
 *     并把**最后一轮**的原文放进 `context.raw`；
 *   - 形状不合契约 → 由 `finalizeScore` 里的 `ScoreResultSchema` 兜住，并折成中文 `ServiceError`。
 */
export async function judgeRow(input: JudgeInput): Promise<ScoreResult> {
  const prompt = buildJudgePrompt(input);
  // system 用 contracts 的输出契约文本：生成侧与解析侧共用同一份字段名
  const system = JUDGE_OUTPUT_CONTRACT;
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  /**
   * 这一分的花销：文本通路没有适配器替我们记账，两格都只能在这里采。
   * 耗时从**进函数就开始掐**：结构修复的每一轮与瞬时重试的退避都算这一次评分的成本，
   * 而「这一行为什么多花了十几秒」正是靠它回答的（口径与 `EvalRow.durationMs` 的掐表那一支同源）。
   * 用量**逐轮累加**：修复是额外的上游调用，只记最后一轮会把一次评分报成半价。
   */
  const startedAt = Date.now();
  /**
   * 用量的累加器用**三个数加一个「报过没有」的标记**，而不是一个可空的 `usage` 对象：
   * 「上游一次都没报」必须与「报了三格 0」分得开（前者是 `null`，后者是真实的读数），
   * 而一个 `null` 初值的对象变量在循环里累加时，赋值右侧读到的是被窄化过的它自己
   * （实测 tsc 报 TS7022 / 「Property does not exist on type 'never'」——两个都是这个形状的症状）。
   */
  let usedInput = 0;
  let usedCached = 0;
  let usedOutput = 0;
  let sawUsage = false;

  let raw: string;
  let parsed: { judgments: RubricJudgment[]; verdict: string };
  let repairs = 0;
  try {
    for (;;) {
      const called = await callTextApiConversation(input.route, {
        system,
        messages,
        // 强度按需带（未给 = 这一格不存在）：两协议的线上字段由 text-api 的 `reasoningFields` 独家负责，
        // 本层只把值递过去——在这里补一个缺省档就等于替用户做了「用什么强度」的决定
        ...(input.judgeEffort === undefined ? {} : { effort: input.judgeEffort }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      raw = called.text;
      // 上游没报（`null`）时**什么都不加**：把「没报」当成 `{0,0,0}` 累进去会让合计看起来像
      // 「真的一个 token 都没花」，而两者在界面上是两句相反的话
      if (called.usage !== null) {
        sawUsage = true;
        usedInput += called.usage.input;
        usedCached += called.usage.cached;
        usedOutput += called.usage.output;
      }

      const checked = validateJudgeResponse(raw, input.rubric);
      if (checked.ok) {
        parsed = checked.parsed;
        break;
      }
      if (repairs >= JUDGE_REPAIR_ROUNDS) {
        throw new ServiceError(
          'JUDGE_PARSE_FAILED',
          `评分解析失败：${checked.message}（结构检查已回问模型 ${repairs} 轮，仍未得到合格输出）`,
          { context: { raw: truncateRaw(raw), repairs, reason: checked.message } },
        );
      }

      repairs += 1;
      input.onProgress?.({ round: repairs, message: checked.message });
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: buildJudgeFeedback({ message: checked.message, raw, rubric: input.rubric }) });
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('INTERNAL', `调用评分模型失败：${reason(error)}`, { cause: error });
  }

  return finalizeScore({
    parsed,
    rubric: input.rubric,
    raw,
    judgeProviderId: input.judgeProviderId,
    judgeModelId: input.route.modelId,
    judgeAgentKind: null,
    // 两条通路各自表一次态：文本侧这一格就是调用方传进来的强度（没传 = 未指定）
    judgeEffort: input.judgeEffort ?? null,
    // 文本通路本期不开 schema：它有自己的回问机制
    structuredOutput: false,
    judgeTokens: sawUsage ? { input: usedInput, cached: usedCached, output: usedOutput } : null,
    judgeDurationMs: Date.now() - startedAt,
  });
}
