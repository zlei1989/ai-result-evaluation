/**
 * MCP 服务器弹窗的 form-local 校验 + 两条「只警告不拦」的派生信号。
 *
 * 三条边界：
 *   1. **不整份复用 `McpServerConfigSchema`**：它是 `discriminatedUnion('transport')`，要求判别式与
 *      该支的全部必填字段同时在场，而表单是逐步填的（`EMPTY` 初值只有 `transport`）——
 *      半填状态在 union 下必然报错。这里按当前分支逐字段校验，只有**在用的那一支**参与。
 *   2. **键值表在契约里是 `Record`、在表单里是行数组**：校验按行做，提交形状的转换在
 *      `buildMcpConfig`（组件与用例共用），不在这里重复一份。
 *   3. **名字的字符集与撞名永远不进 resolver**：真源在契约（`MCP_NAME_PATTERN` 的 zod 校验），服务端
 *      会以中文拦下并给出原因；界面拦死的话同一条规则就有两个实现、两句会各自漂移的文案。
 *      提示留着（`mcpNameWarnings`），拦截归契约——`warningOnly` 在 RHF / zod 里没有对位，
 *      所以它是一条**独立的派生状态**，不进 `formState.errors`。
 */
import { MCP_ENV_KEY_PATTERN, MCP_NAME_PATTERN, type McpServers } from '@aieval/contracts';
import { z } from 'zod';

/** 键值两列表的一行：`env` 与 `headers` 共用同一形状（两处表格长得一样、语义也一样） */
export interface McpKeyValueRowInput {
  key: string;
  value: string;
}

export const mcpKeyValueRowSchema = z.object({
  key: z.string(),
  value: z.string(),
});

/** 表单载荷：`url` / `command` / `args` / `env` / `headers` 全在，靠 `transport` 决定用哪一支 */
export interface McpServerFormInput {
  name: string;
  transport: 'stdio' | 'http';
  url: string;
  command: string;
  /** 一行一个参数（空行忽略），比可增删的行更省事、也更好从命令行粘过来 */
  args: string;
  env: McpKeyValueRowInput[];
  headers: McpKeyValueRowInput[];
}

export function mcpServerFormSchema() {
  return z
    .object({
      name: z.string().min(1, '请填写名称'),
      // 这一条今天不可能触发（新建初值就是 stdio，Radio 又不能取消选中），补 message 只是把
      // zod 的英文默认出口堵死
      transport: z.enum(['stdio', 'http'], {
        errorMap: () => ({ message: '请选择传输方式' }),
      }),
      url: z.string(),
      command: z.string(),
      args: z.string(),
      env: z.array(mcpKeyValueRowSchema),
      headers: z.array(mcpKeyValueRowSchema),
    })
    .superRefine((values, ctx) => {
      // 只校验**在用的那一支**：另一支的字段已由 `changeTransport` 就地清空，
      // 校验它只会让刚切过来的用户在没填的格子上看到一堆红字
      if (values.transport === 'http') {
        if (values.url === '') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: '请填写端点地址' });
        }
        values.headers.forEach((row, index) => {
          if (row.key === '') {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['headers', index, 'key'], message: '请填写请求头名' });
          }
        });
        return;
      }
      if (values.command === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: '请填写命令' });
      }
      values.env.forEach((row, index) => {
        if (row.key === '') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['env', index, 'key'], message: '请填写变量名' });
          return;
        }
        // 键名规则来自契约（`MCP_ENV_KEY_PATTERN`）：带 `=` / 空格 / 点号在子进程环境里行为不可控，
        // 早报比晚报好；这里只是把它变成表单上的一行中文提示
        if (!MCP_ENV_KEY_PATTERN.test(row.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['env', index, 'key'],
            message: '变量名只能是字母、数字与下划线，且不以数字开头',
          });
        }
      });
    });
}

export type McpServerFormSchema = ReturnType<typeof mcpServerFormSchema>;

/** 名字的两条**警告**（不是错误）：显示但不阻断提交 */
export interface McpNameWarnings {
  charset?: string;
  duplicate?: string;
}

/**
 * 从当前名字派生警告：
 *   · 字符集 —— 与契约 `MCP_NAME_PATTERN` 那条逐字一致；空名字不说（那是必填的事）；
 *   · 撞名 —— 名字住在 map 的键上，保存到已有名字 = 覆盖那一条，这是**合法操作**，
 *     所以文案是「已存在，保存会覆盖」而不是「名字重复」。编辑态排除自己。
 *
 * 纯函数：警告的出现条件必须能被直接测到，而不是靠「界面上有没有那行字」反推。
 */
export function mcpNameWarnings(
  name: string,
  servers: McpServers,
  initialName: string | null,
): McpNameWarnings {
  if (name === '') return {};
  const warnings: McpNameWarnings = {};
  if (!MCP_NAME_PATTERN.test(name)) {
    warnings.charset = '名称只能是字母、数字、下划线或连字符，长度 1–32';
  }
  if (name !== initialName && name in servers) {
    warnings.duplicate = '已存在，保存会覆盖';
  }
  return warnings;
}
