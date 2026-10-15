// @vitest-environment node
/**
 * **注入端口接线的源码守卫**：适配器源码（`providers/**` 的非测试文件）不许读 `input.inject`。
 *
 * 为什么必须是源码扫描：裸端口（`AgentRunInput.inject`）的唯一合法消费方是骨架（`turn.ts`）——
 * 它把端口包一层（`withInjectionWait`，登记「在等人工消息」的 enter/leave）再放进
 * `TurnContext.inject`，且把「调用方没传」与「传了关着的端口」归一成同一个关闭档。
 * 适配器一旦绕过包装层直接读 `input.inject`：
 *   · drain / 撤回在功能上等价（同一个底层对象），**单测全绿**；
 *   · 但等待登记被绕过——`pendingInjects` 对这一家永远是 0，
 *     豁免表（`INJECTION_WAIT_SUSPENDS_WATCHDOG`）对它翻 `true` 时**静默无效**（开关没接线）。
 * 「写对了」与「绕过了」没有任何运行期可观测差异（今天四家豁免全关），只有源码看得见。
 *
 * 两条边界：
 *   · **词边界不误伤 `input.injectMessages`**（dsh 有这个不相干的字段读法）：`\binput\.inject\b`
 *     里结尾的 `\b` 要求 `inject` 之后不是单词字符，紧跟 `M` 不构成边界 ⇒ 天然不匹配
 *     （下面有反向用例钉住这件事）；
 *   · **测试文件与 `testing/` 夹具不扫**：它们是端口的**调用方**（构造 `input.inject` 合法），
 *     规则只管适配器这一侧。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `providers/` 目录：本文件住在 `providers/conformance/`，往上一层就是它 */
const PROVIDERS_DIR = join(import.meta.dirname, '..');

/** 命中即违规：适配器直接读骨架入参上的裸端口（合法的读法只有 `context.inject`） */
const BARE_PORT_READ = /\binput\.inject\b/;

/**
 * `providers/**` 下的全部非测试源码（相对 `providers/`），Windows 分隔符统一成正斜杠。
 * 扩展名走正向白名单（与 `static-assertions.test.ts` 同一条口径：只认 `.ts` 时，
 * 放一个 `.mjs` 就能整份绕开扫描）；排除 `*.test.ts` 与 `testing/` 夹具——它们是调用方。
 */
function providerSources(): string[] {
  return readdirSync(PROVIDERS_DIR, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter(
      (entry) =>
        /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry)
        && !entry.endsWith('.test.ts')
        && !entry.split('/').includes('testing'),
    );
}

describe('注入端口接线：适配器只许读骨架包装过的端口', () => {
  it('providers/** 的非测试源码里没有 `input.inject` 这个读法', () => {
    const files = providerSources();
    // 自检：扫描范围真的收到了各家的入口文件（范围静默塌缩时这条先红，别让空名单假绿）
    expect(files.some((file) => file.endsWith('/index.ts')), '扫描范围里没有任何 index.ts——范围塌缩').toBe(true);
    const violations = files.filter((file) => BARE_PORT_READ.test(readFileSync(join(PROVIDERS_DIR, file), 'utf8')));
    expect(
      violations,
      '这些适配器源码直接读了裸端口 `input.inject`——必须改读 `context.inject`（骨架包装过的那一份，'
      + '等待登记在包装层）；裸端口的唯一合法消费方是 turn.ts',
    ).toEqual([]);
  });

  it('反向：`input.injectMessages` 不触发（词边界把它挡在规则外）', () => {
    expect(BARE_PORT_READ.test('...(input.injectMessages === true')).toBe(false);
  });

  it('自检：规则认得出裸端口的两种写法形状（正则失去区分力时这里先红）', () => {
    expect(BARE_PORT_READ.test('port: input.inject ?? null,')).toBe(true);
    expect(BARE_PORT_READ.test('input.inject !== undefined && input.inject.available')).toBe(true);
  });
});
