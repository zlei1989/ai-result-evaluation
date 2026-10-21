/**
 * 评分阶段的「执行过程记录」证据组装：文本通路与智能体通路共用同一份产物。
 *
 * 证据的组成由用例快照 `EvalRun.includeSteps` 门控，内容只做两件事：
 *   ① `events.jsonl` 取 **raw 原文**（不做事件解析——评分模型要的是候选走过的每一步推理，
 *      坏行与缺字段的历史行同样是有意义的证据，解析侧会丢它们，证据侧必须留它们）；
 *   ② 候选 `agentKind` 在 provider 注册表元数据里声明了 `needsMessagesForReasoningEvidence`
 *      （codex 的思考全文与工具结果正文结构性不进事件流）时，追加 `messages.jsonl` raw 原文。
 *      判定走 `getProvider(kind).metadata`——厂商差异吸收在 agents 包，这里**不硬编码厂商名**。
 *
 * 截断：按 `settings.diffBudgetBytes`（字节、`Buffer.byteLength`）逐行裁剪，头尾保留、
 * 中间截断处显著标注。截断在内容进入评分上下文**之前**完成，两条通路共用同一份产物：
 * 文本通路把 `content` 拼成带 `## filename` 标题的独立 text 块；智能体通路在提示词里给 `absolutePath`、
 * 让评审者直接读磁盘原文（那一侧不截断）。
 *
 * 文件缺失（候选没跑到产出那份记录）时跳过该份而不是抛错：证据是评分的增强输入，
 * 不该反过来把评分打挂；跳过会以「files 里少一份」的形式留在日志与产物里，不静默。
 */
import { existsSync, readFileSync } from 'node:fs';
import { getProvider } from '@aieval/agents';
import { createLogger, candidateEventsFile, candidateMessagesFile } from '@aieval/core';
import type { AgentKind } from '@aieval/contracts';

const log = createLogger('process-evidence');

/** events 块的标题文件名（与 diff 块的 `candidate-diff.txt` 同一命名口径：稳定、可定位） */
export const EVENTS_ATTACHMENT_FILENAME = 'candidate-events.jsonl';
/** messages 块的标题文件名（只有元数据声明要补的候选才有它） */
export const MESSAGES_ATTACHMENT_FILENAME = 'candidate-messages.jsonl';

/**
 * 协议文件名 → 中文标签。judge-agent.ts 的提示词段按这张表给每一份证据写「它是什么」，
 * 与文件名的定义收在同一处：新证据类型在这里加一行、标签即生效，不必再动提示词那一侧。
 */
export const EVIDENCE_FILE_LABELS: Readonly<Record<string, string>> = {
  [EVENTS_ATTACHMENT_FILENAME]: '执行过程记录（events 账本：候选每一步的动作与工具调用）',
  [MESSAGES_ATTACHMENT_FILENAME]: '候选消息记录（messages 账本：候选的思考全文与工具结果正文）',
};

/** 一份执行过程证据文件：raw 原文（已按预算截断）+ 磁盘绝对路径 */
export interface ProcessEvidenceFile {
  /** 块标题文件名：文本通路把它作为 `## filename` 标题交给模型 */
  filename: string;
  /** raw 原文（按 `diffBudgetBytes` 逐行截断后的那一份）；智能体通路不用它，评审者直接读 `absolutePath` */
  content: string;
  /** 这一份是否发生过预算截断（true = content 是「头尾保留 + 中间截断标注」的产物） */
  truncated: boolean;
  /** 磁盘上的绝对路径：智能体通路在提示词里给评审者读的文件 */
  absolutePath: string;
}

/** 评分阶段交出去的证据总体；`files` 为空数组 = 开关关闭 / 两份记录都缺失 */
export interface ProcessEvidence {
  files: ProcessEvidenceFile[];
}

/**
 * 读一份证据文件并按其预算截断后放进结果。
 * 文件不存在时跳过并 WARN（配置缺失但可继续的那一档）：候选没跑到产出这份记录时，
 * 评分照常进行，只是证据里少这一份。
 */
function pushEvidenceFile(
  files: ProcessEvidenceFile[],
  file: string,
  filename: string,
  budgetBytes: number,
): void {
  if (!existsSync(file)) {
    log.warn('执行过程证据文件不存在，跳过这一份（评分照常进行）', { file, filename });
    return;
  }
  // 容忍 UTF-8 BOM（外部工具编辑过的文件首行带 U+FEFF，交给评分模型是无意义的噪声）
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const clipped = truncateRawLines(raw, budgetBytes);
  if (clipped.truncated) {
    // 截断是预算内的正常处置、不是故障：DEBUG 让「这一份为什么只剩头尾」在日志里可查
    log.debug('执行过程证据超出预算，已按行头尾截断', {
      file,
      filename,
      budgetBytes,
      rawBytes: Buffer.byteLength(raw, 'utf8'),
    });
  }
  files.push({ filename, content: clipped.text, truncated: clipped.truncated, absolutePath: file });
}

/**
 * 组装评分阶段要用的执行过程证据。
 * `includeSteps` 是**这一轮的快照**（`EvalRun.includeSteps`）：开关关闭直接返回空证据，
 * 连一次文件读取与注册表查询都不发生。`budgetBytes` 取 `settings.diffBudgetBytes`，
 * 与 diff 的裁剪同一条预算口径（字节）。
 */
export function assembleProcessEvidence(input: {
  workspaceBase: string;
  runId: string;
  candidateId: string;
  includeSteps: boolean;
  agentKind: AgentKind;
  budgetBytes: number;
}): ProcessEvidence {
  if (!input.includeSteps) return { files: [] };

  const files: ProcessEvidenceFile[] = [];
  pushEvidenceFile(
    files,
    candidateEventsFile(input.workspaceBase, input.runId, input.candidateId),
    EVENTS_ATTACHMENT_FILENAME,
    input.budgetBytes,
  );
  // 推理证据要不要补 messages.jsonl 是**厂商差异**：只问注册表元数据，不写 `agentKind === 'codex'`
  if (getProvider(input.agentKind).metadata.needsMessagesForReasoningEvidence) {
    pushEvidenceFile(
      files,
      candidateMessagesFile(input.workspaceBase, input.runId, input.candidateId),
      MESSAGES_ATTACHMENT_FILENAME,
      input.budgetBytes,
    );
  }
  return { files };
}

/**
 * 按字节预算逐行裁剪 raw 原文：头尾保留、中间截断处显著标注。
 * 与 diff 的 `truncateDiff` 同一条口径：预算是**字节**（`Buffer.byteLength`），
 * 中文与 emoji 的字符数与字节数差 3 倍，用字符数会超预算。
 * 保留策略与 `truncateDiff`（core/git.ts）刻意不同、不复用：diff 按**文件段**整段取舍
 * （一个文件要么全留要么整段丢，丢的逐个列名——保持 diff 的可读性）；这里按**行**做头尾保留
 * （事件账本是带序号的时间线，评分要看的是起点与收尾，中间被截的候选用标注占位）。两者粒度
 * 不同，复用一个就伤另一个：按文件段切事件账本，超预算时整个账本被丢、证据静默消失；
 * 按行切 diff，会把一个文件的正文拦腰切断，diff 侧「文件段」粒度的记账随之失真。
 *
 * 算法：先把截断标注自身的字节**预留**出来（按「被截行数的最大可能位数」估一个上界，
 * 真实标注只会更短），剩余预算再从头尾**交替**各取一行（含换行符计字节）——
 * 交替保证两边都保得住，而不是先到先得把预算吃光；头部是时间线起点，先取。
 * 已知边界：预算小到连标注都装不下时，产物只有标注自身（会超预算），
 * 那是「预算给得不合理」的输入问题，如实登记而不是静默兜成空串。
 */
export function truncateRawLines(raw: string, budgetBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(raw, 'utf8') <= budgetBytes) return { text: raw, truncated: false };

  const lines = raw.split('\n');
  // 每个候选的字节数含换行符：join 回来时的总字节才是「这个候选真正占的」预算
  const sizeOf = (line: string): number => Buffer.byteLength(line, 'utf8') + 1;

  // 标注字节上界：被截行数 ≤ 总行数，用总行数的位数估（真实标注只短不长）
  const markerUpperBound = `…（中间 ${lines.length} 行已截断，预算 ${budgetBytes} 字节）…`;
  const contentBudget = Math.max(0, budgetBytes - Buffer.byteLength(markerUpperBound, 'utf8') - 2);

  const head: string[] = [];
  const tail: string[] = [];
  let headIndex = 0;
  let tailIndex = lines.length - 1;
  let used = 0;
  let fromHead = true;
  while (headIndex <= tailIndex) {
    const line = fromHead ? (lines[headIndex] ?? '') : (lines[tailIndex] ?? '');
    const size = sizeOf(line);
    if (used + size > contentBudget) break;
    if (fromHead) {
      head.push(line);
      headIndex += 1;
    } else {
      tail.unshift(line);
      tailIndex -= 1;
    }
    used += size;
    fromHead = !fromHead;
  }

  const build = (tailLines: string[]): string => {
    const dropped = lines.length - head.length - tailLines.length;
    const marker = `…（中间 ${dropped} 行已截断，预算 ${budgetBytes} 字节）…`;
    return `${head.join('\n')}\n${marker}\n${tailLines.join('\n')}`;
  };

  let text = build(tail);
  // 安全阀：sizeOf 对换候选的计法偏保守，理论上不会超预算；留着它拦「预估错位」这一类回归
  while (tail.length > 0 && Buffer.byteLength(text, 'utf8') > budgetBytes) {
    tail.shift();
    text = build(tail);
  }
  return { text, truncated: true };
}
