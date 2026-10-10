// @vitest-environment node
/**
 * 工具名 → 族 的映射守卫。
 *
 * 为什么单独一份：这张表是**按名字查**的，漏一个别名不会报错、只会静默降级——把
 * `bash: 'run-shell'` 摘掉，其余用例一条都不会红，而 `dsh|bash` 调用会退化成
 * 「紧凑 JSON + 没有族标签」。所以别名必须有逐字的守卫，不能只靠「跑一次看看」。
 *
 * 两条判据：
 *   ① **跨家同名同族**：同一个工具在三家的不同叫法要落进同一个族（摘要的「每族一种拼法」
 *      全靠这一条成立）；
 *   ② **别名不落空**：已知存在、只是当前工具表里不出现的名字（`MultiEdit` / `LS` /
 *      `subagent_fork` / `bash`）也必须在表里——它们是同族的另一种叫法，删掉就是静默降级。
 */
import { describe, expect, it } from 'vitest';
import { classifyTool } from './tool-family';

describe('classifyTool：按名字查表，跨家同族', () => {
  it('读/写/改/搜/列/跑命令/联网/派子任务/计划/提问，十族各有三家的名字', () => {
    // 读文件：claude `Read` / dsh `read`（codex 没有独立条目）
    expect(classifyTool('Read')).toBe('read-file');
    expect(classifyTool('read')).toBe('read-file');
    // 跑命令：claude `Bash` / dsh `pwsh` **与 `bash`** / codex `exec_command`
    // `bash` 这一条不能少：dsh 侧实测调用全是 `bash`，而表里另外只列了 `pwsh`
    expect(classifyTool('Bash')).toBe('run-shell');
    expect(classifyTool('pwsh')).toBe('run-shell');
    expect(classifyTool('bash')).toBe('run-shell');
    expect(classifyTool('exec_command')).toBe('run-shell');
    expect(classifyTool('command_execution')).toBe('run-shell');
    // 计划：三家三个名字，同一个族
    expect(classifyTool('TodoWrite')).toBe('task');
    expect(classifyTool('todo_write')).toBe('task');
    expect(classifyTool('update_plan')).toBe('task');
    // 派子任务：`Task` 与 `Agent` 是同一个工具的两种叫法
    expect(classifyTool('Task')).toBe('spawn-agent');
    expect(classifyTool('Agent')).toBe('spawn-agent');
    expect(classifyTool('subagent')).toBe('spawn-agent');
    expect(classifyTool('subagent_fork')).toBe('spawn-agent');
    expect(classifyTool('spawn_agent')).toBe('spawn-agent');
    expect(classifyTool('collab_tool_call')).toBe('spawn-agent');
    // 其余各族至少一个名字（漏一族不会报错，只会让那一族的拼法永远走不到）
    expect(classifyTool('Write')).toBe('write-file');
    expect(classifyTool('Edit')).toBe('edit-file');
    expect(classifyTool('MultiEdit')).toBe('edit-file');
    expect(classifyTool('apply_patch')).toBeNull(); // codex 的条目名在适配器侧硬编码，不在表里
    expect(classifyTool('Grep')).toBe('search-content');
    expect(classifyTool('grep')).toBe('search-content');
    expect(classifyTool('Glob')).toBe('list-files');
    expect(classifyTool('LS')).toBe('list-files');
    expect(classifyTool('WebSearch')).toBe('web-search');
    expect(classifyTool('WebFetch')).toBe('web-search');
    expect(classifyTool('web_search')).toBe('web-search');
    expect(classifyTool('AskUserQuestion')).toBe('ask-user');
    expect(classifyTool('ask_user_question')).toBe('ask-user');
    expect(classifyTool('request_user_input')).toBe('ask-user');
  });

  it('认不出来就是 `null`（MCP 工具**不进这十族**：猜一个族等于编一个事实）', () => {
    expect(classifyTool('mcp__x__y')).toBeNull();
    expect(classifyTool('StructuredOutput')).toBeNull();
    // dsh 的后台任务工具：它们不是「跑命令」（那是「看/停一个已在跑的命令」）⇒ 留 null，
    // 摘要靠通用优先键里的 `job_id` 撑着（见 `activity.test.ts` 的对应用例）
    expect(classifyTool('job_output')).toBeNull();
    expect(classifyTool('job_kill')).toBeNull();
    expect(classifyTool('')).toBeNull();
  });
});
