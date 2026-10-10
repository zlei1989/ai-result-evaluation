// @vitest-environment node
/**
 * 活动摘要词表的行为契约：一句话怎么说、什么时候不给摘要。
 *
 * 逐条钉住四件事：
 *   ① **句式**：活动行是 `调用工具 <名>：<摘要主体>`、工具行只取**摘要主体**（`toolCallHint`）——
 *      工具行把工具名渲染成独立元素，带前缀就是同一件事说两遍；
 *   ② **描述优先**：`input.description` 在时用它（有目标就拼 `描述（目标）`）；
 *      不在时**按族拼**（`read-file` 给路径+行区间、`search-content` 给模式、`run-shell` 给命令……）；
 *   ③ **不给摘要的场合**：没有工具名、没有参数、参数是一坨不认识的 JSON 时才退到紧凑 JSON；
 *   ④ **名字缺失不留占位**：`已派发子任务：子任务` 那种同义反复不许再出现。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_SUMMARY_MAX_LENGTH,
  clipSummary,
  oneLine,
  planSummary,
  subagentDispatchSummary,
  subagentSettledSummary,
  toolCallHint,
  toolCallSummary,
  toolCallTitle,
  toolErrorSummary,
} from './activity';

describe('工具调用：`调用工具 <名>：<摘要主体>`', () => {
  it('**描述优先**：`input.description` 在时用它，不再拿 command / file_path 抢先', () => {
    // 真机形态（run 7f05c765 的 claude 行）：`{command, description}` 两个都在，
    // 旧口径取 command（一整串 shell），新口径取描述（模型自己写的那句话）
    expect(
      toolCallSummary('Bash', { command: 'ls && echo "---" && git status --short', description: 'List workspace and git status' }),
    ).toBe('调用工具 Bash：List workspace and git status（ls && echo "---" && git status --short）');
    // dsh 的 `bash` 同形（真机 `{command, description}`）
    expect(toolCallSummary('bash', { command: 'pwd && ls', description: 'Show working directory and list files' })).toBe(
      '调用工具 bash：Show working directory and list files（pwd && ls）',
    );
  });

  it('只有描述、没有目标时，那句描述就是答案（不留空括号）', () => {
    expect(toolCallSummary('Bash', { description: 'List workspace contents' })).toBe(
      '调用工具 Bash：List workspace contents',
    );
  });

  it('描述与目标**逐字相同**时不重复（厂商把同一句话同时写进两个键）', () => {
    expect(toolCallSummary('Bash', { command: 'ls -la', description: 'ls -la' })).toBe('调用工具 Bash：ls -la');
  });

  it('描述是空白串 / 非字符串时**不算数**，按族拼（不拿空白凑一句话）', () => {
    expect(toolCallSummary('Read', { file_path: 'a.ts', description: '   ' })).toBe('调用工具 Read：a.ts');
    expect(toolCallSummary('Read', { file_path: 'a.ts', description: 42 })).toBe('调用工具 Read：a.ts');
  });

  it('参数是 JSON **字符串**时也要解析（dsh 的 `arguments` 就是字符串），描述也在里面', () => {
    expect(toolCallSummary('pwsh', '{"command":"git status --porcelain","description":"Show working tree status"}')).toBe(
      '调用工具 pwsh：Show working tree status（git status --porcelain）',
    );
  });

  it('工具名与参数只有一个时，句子仍是一句话：不写空冒号、不编参数', () => {
    expect(toolCallSummary('Bash', null)).toBe('调用工具 Bash');
    expect(toolCallSummary(null, { command: 'ls' })).toBe('调用工具：ls');
    expect(toolCallSummary(null, null)).toBe('调用工具');
  });
});

describe('按族自己拼（没有 `description` 的那一大片：真机 130 次调用里 100+ 次）', () => {
  it('读文件：路径 + 行区间（只给一个端点也算，两个都没有给纯路径）', () => {
    expect(toolCallSummary('Read', { file_path: '/tmp/a/index.html' })).toBe('调用工具 Read：/tmp/a/index.html');
    expect(toolCallSummary('read', { file_path: 'src/index.ts', offset: 10, limit: 111 })).toBe(
      '调用工具 read：src/index.ts:10-120',
    );
    expect(toolCallSummary('read', { file_path: 'src/index.ts', limit: 120 })).toBe(
      '调用工具 read：src/index.ts:1-120',
    );
    expect(toolCallSummary('read', { file_path: 'src/index.ts', offset: 10 })).toBe('调用工具 read：src/index.ts:10-');
  });

  it('搜内容：模式（范围），三家给的键不同——`include` 与 `path` 都认', () => {
    expect(toolCallSummary('grep', { pattern: 'new FileChangeLogItemDTO' })).toBe(
      '调用工具 grep：new FileChangeLogItemDTO',
    );
    expect(toolCallSummary('grep', { pattern: '@WebMvcTest', include: '*.java' })).toBe(
      '调用工具 grep：@WebMvcTest（*.java）',
    );
    expect(toolCallSummary('Grep', { pattern: 'TODO', path: 'src' })).toBe('调用工具 Grep：TODO（src）');
  });

  it('列文件：给模式；写文件：给路径（正文那一段整段不进摘要）', () => {
    expect(toolCallSummary('glob', { pattern: '**/FileChangeLogItemDTO.java' })).toBe(
      '调用工具 glob：**/FileChangeLogItemDTO.java',
    );
    expect(toolCallSummary('Write', { file_path: 'index.html', content: '<!DOCTYPE html>…' })).toBe(
      '调用工具 Write：index.html',
    );
  });

  it('改文件：路径那一格优先；codex 的 `apply_patch` 没有它 ⇒ 列改动清单，超过两个说「等 N 个」', () => {
    expect(toolCallSummary('Edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' })).toBe(
      '调用工具 Edit：README.md',
    );
    expect(toolCallSummary('apply_patch', { changes: [{ path: 'index.html', kind: 'update' }] })).toBe(
      '调用工具 apply_patch：index.html',
    );
    expect(toolCallSummary('apply_patch', { changes: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }] })).toBe(
      '调用工具 apply_patch：a.ts、b.ts 等 3 个',
    );
  });

  it('联网：`query` 与 `url` 各一档', () => {
    expect(toolCallSummary('WebSearch', { query: 'vue 3 cdn' })).toBe('调用工具 WebSearch：vue 3 cdn');
    expect(toolCallSummary('WebFetch', { url: 'https://example.com', prompt: '取标题' })).toBe(
      '调用工具 WebFetch：https://example.com',
    );
  });

  it('派子任务：任务名在 `description` 里（按厂商定义就是子任务名）⇒ 给 `prompt` 那一档，不重复名字', () => {
    expect(toolCallSummary('Agent', { description: '检查 Vue3 hello world 文件', prompt: '请检查文件 /tmp/a' })).toBe(
      '调用工具 Agent：检查 Vue3 hello world 文件（请检查文件 /tmp/a）',
    );
    // 名字没给（不像同族的其它工具那样能编一个）⇒ 说一句同义的话，好过一坨 JSON
    expect(toolCallSummary('spawn_agent', { prompt: 'Review the page' })).toBe('调用工具 spawn_agent：Review the page');
    expect(toolCallSummary('subagent', {})).toBe('调用工具 subagent：派发子任务');
  });

  it('提问：第一个问题的正文；正文空但清单在 ⇒ 说「几问」', () => {
    expect(
      toolCallSummary('AskUserQuestion', { questions: [{ header: 'H', question: '用哪种主题？', options: [] }] }),
    ).toBe('调用工具 AskUserQuestion：用哪种主题？');
    expect(toolCallSummary('ask_user_question', { questions: [{ header: 'H' }, { header: 'G' }] })).toBe(
      '调用工具 ask_user_question：2 问',
    );
  });

  it('计划类入参给**统一的那一句**：`更新计划：N 步`（三家同形，不再是 JSON 转储）', () => {
    expect(toolCallSummary('TodoWrite', { todos: [{ content: 'a' }, { content: 'b' }] })).toBe('更新计划：2 步');
    expect(toolCallSummary('update_plan', { plan: [{ step: 'a' }] })).toBe('更新计划：1 步');
    expect(toolCallSummary('todo_write', '{"steps":[{"step":"a"},{"step":"b"},{"step":"c"}]}')).toBe('更新计划：3 步');
    // 计划类**先判**：哪怕同时给了描述，也说「几步」（那张表才是这一步在干的事）
    expect(toolCallSummary('todo_write', { todos: [{ content: 'a' }], description: '更新清单' })).toBe('更新计划：1 步');
  });
});

describe('工具行的摘要主体（`toolCallHint`）：不带 `调用工具 <名>：` 前缀', () => {
  it('与活动行同源同词表，只差前缀', () => {
    const input = { file_path: 'src/index.ts' };
    expect(toolCallSummary('Read', input)).toBe(`调用工具 Read：${toolCallHint('Read', input)}`);
    expect(toolCallHint('Read', input)).toBe('src/index.ts');
    expect(toolCallHint('Bash', { command: 'git status', description: 'Show working tree status' })).toBe(
      'Show working tree status（git status）',
    );
  });

  it('计划类在工具行是 `N 步`（工具名由界面自己渲染，不再带「更新计划」这四个字）', () => {
    expect(toolCallHint('todo_write', { todos: [{ content: 'a' }, { content: 'b' }] })).toBe('2 步');
    expect(toolCallHint('update_plan', { plan: [{ step: 'a' }] })).toBe('1 步');
  });

  it('什么都没给就是空串（界面据此说「参数未采集」），不编一句话', () => {
    expect(toolCallHint('Bash', null)).toBe('');
    expect(toolCallHint('Bash', '')).toBe('');
    expect(toolCallHint(null, null)).toBe('');
  });

  it('前缀本身也是公开口径（名字缺失不留空冒号、不编名字）', () => {
    expect(toolCallTitle('Bash')).toBe('调用工具 Bash');
    expect(toolCallTitle('  Bash  ')).toBe('调用工具 Bash');
    expect(toolCallTitle(null)).toBe('调用工具');
    expect(toolCallTitle('')).toBe('调用工具');
  });
});

describe('不认识的工具（`family: null`）：既不假装认识形状，也不假装没有参数', () => {
  it('优先键里一个都没有 ⇒ 紧凑 JSON；不是 JSON 时原样用', () => {
    expect(toolCallSummary('mcp__x__y', { a: 1 })).toBe('调用工具 mcp__x__y：{"a":1}');
    expect(toolCallSummary('pwsh', 'Get-ChildItem env:')).toBe('调用工具 pwsh：Get-ChildItem env:');
  });

  it('`job_id` 在优先键里（dsh 的 `job_output` / `job_kill` 只有这一格，漏了就退化成整串 JSON）', () => {
    expect(toolCallSummary('job_output', '{"job_id":"pwsh-16","timeout_ms":420000,"wait":true}')).toBe(
      '调用工具 job_output：pwsh-16',
    );
    // `job_kill` 的 `reason` 是审批/原因语义，**不进摘要**：只给 job_id
    expect(toolCallSummary('job_kill', { job_id: 'bash-3', reason: 'Fix unnecessary Mockito stubbing' })).toBe(
      '调用工具 job_kill：bash-3',
    );
  });

  it('认得族但目标那一格拿不到 ⇒ 用族的那一句同义话', () => {
    expect(toolCallHint('Agent', { prompt: '' })).toBe('派发子任务');
    expect(toolCallHint('ask_user_question', {})).toBe('提问');
  });
});

describe('单行化与截断（一行里只放得下一句话）', () => {
  it('换行压成空格、超长带省略号；长度上限只管摘要主体', () => {
    const command = `echo a\necho b\n${'x'.repeat(ACTIVITY_SUMMARY_MAX_LENGTH + 40)}`;
    // 截断按**整段目标**算（换行先压成空格再数长度），不是从那一串 x 起算
    const hint = clipSummary(oneLine(command));
    expect(toolCallSummary('Bash', { command })).toBe(`调用工具 Bash：${hint}`);
    expect(toolCallHint('Bash', { command })).toBe(hint);
  });

  it('描述本身超长也截断（描述优先不等于不限长）', () => {
    const description = 'd'.repeat(ACTIVITY_SUMMARY_MAX_LENGTH + 10);
    expect(toolCallHint('Bash', { description })).toBe(`${'d'.repeat(ACTIVITY_SUMMARY_MAX_LENGTH)}…`);
  });
});

describe('工具报错：`工具报错：<内容>`', () => {
  it('内容单行化截断；一个字的错误也说得出「报错」', () => {
    expect(toolErrorSummary('Error: DeepSeek search has no API key')).toBe(
      '工具报错：Error: DeepSeek search has no API key',
    );
    expect(toolErrorSummary('')).toBe('工具报错');
    expect(toolErrorSummary(null)).toBe('工具报错');
  });
});

describe('子任务：派发与收场', () => {
  it('派发 / 收场各有固定句式，状态用中文档位', () => {
    expect(subagentDispatchSummary('Review Vue 3 page')).toBe('已派发子任务：Review Vue 3 page');
    expect(subagentSettledSummary('Review Vue 3 page', 'completed')).toBe('子任务已完成：Review Vue 3 page');
    expect(subagentSettledSummary('Review Vue 3 page', 'failed')).toBe('子任务失败：Review Vue 3 page');
    expect(subagentSettledSummary('Review Vue 3 page', 'stopped')).toBe('子任务已停止：Review Vue 3 page');
  });

  it('**名字缺失时不留占位名**（旧实现写的是「已派发子任务：子任务」，同义反复）', () => {
    expect(subagentDispatchSummary(null)).toBe('已派发子任务');
    expect(subagentDispatchSummary('')).toBe('已派发子任务');
    expect(subagentSettledSummary(null, 'completed')).toBe('子任务已完成');
    expect(subagentSettledSummary('  ', null)).toBe('子任务已结束');
  });

  it('不认识的厂商状态不假装认识：折成「已结束」（原文仍在原始负载里）', () => {
    expect(subagentSettledSummary('x', 'weird-status')).toBe('子任务已结束：x');
  });
});

describe('计划与通用工具', () => {
  it('计划更新按步数说话', () => {
    expect(planSummary(4)).toBe('更新计划：4 步');
    expect(planSummary(0)).toBe('更新计划：0 步');
  });

  it('单行化与截断是公开口径（三家适配器都要按同一把尺子用）', () => {
    expect(oneLine('a\n\n b\tc ')).toBe('a b c');
    expect(clipSummary('y'.repeat(ACTIVITY_SUMMARY_MAX_LENGTH + 1))).toBe(`${'y'.repeat(ACTIVITY_SUMMARY_MAX_LENGTH)}…`);
    expect(clipSummary('短')).toBe('短');
  });
});
