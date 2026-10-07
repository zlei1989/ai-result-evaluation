// @vitest-environment node
/**
 * codex 配置构造：`model_context_window` 只在窗口**已知**时出现。
 *
 * 为什么这条必须有：CLI 的内置模型目录里没有我们网关的模型名（实测 `codex debug models` 的 11 条
 * 全是 GPT 系），所以这个数只能由我们告诉它；而「忘了告诉」与「告诉了一个假数」在运行面上都是
 * **静默**的——运行照常成功，只是压缩时机不对（spec §6.2 / D8）。
 */
import { describe, expect, it } from 'vitest';
import { buildCodexConfig } from './sdk';

describe('buildCodexConfig 的窗口', () => {
  it('给窗口就写 model_context_window', () => {
    expect(buildCodexConfig('https://gw.example.com/v1', 1_048_576).model_context_window).toBe(1_048_576);
  });

  it('不给窗口 ⇒ 整个键都不出现（不是 undefined 值）', () => {
    // 判据用 `Object.hasOwn` 而不是 `toBeUndefined()`：钉的是「键**不存在**」这个形态本身
    // （「没意见就不写这一格」），便于逐键对账，也抗 SDK 升级漂移。
    // ⚠️ 两种形态今天**行为等价**：SDK 对值为 `undefined` 的键直接跳过（`dist/index.js:343-345`
    // 的 `if (child === void 0) continue;` ⇒ 不产出任何 `--config` 参数）。
    // 早先这里写的是「显式 `undefined` 会被序列化成字符串交给 CLI」——**那是错的**，已订正。
    expect(Object.hasOwn(buildCodexConfig('https://gw.example.com/v1'), 'model_context_window')).toBe(false);
  });

  it('其余注入项逐字不受影响（窗口是叠加，不是替换）', () => {
    const config = buildCodexConfig('https://gw.example.com/v1', 262_144);
    expect(config.model_provider).toBe('aieval');
    expect(config.tools).toEqual({ web_search: false, update_plan: { enabled: true } });
    // 多智能体**开着**（2026-10-03 用户口径：与 claude / dsh 两家口径一致，见 `buildCodexConfig` 的注释）
    expect(config.features).toEqual({ multi_agent: true });
    expect(config.model_providers.aieval?.base_url).toBe('https://gw.example.com/v1');
  });

  /**
   * 关闭档的第二格（spec §3.2 / 探针 stepF）：触发条件是 **(CLI 硬编码的 `include` ∧ `summary`) 的合取**
   * —— 只给 `model_reasoning_effort:"none"` 单独无效（探针 D-B：同批请求体里两格都在，网关照样产出
   * 137 个 reasoning token）。**不给这一格** ⇒ CLI 不往请求体里写 `summary` ⇒ 网关不再推理。
   */
  it('给 summary ⇒ 写 model_reasoning_summary', () => {
    expect(buildCodexConfig('https://gw.example.com/v1', undefined, 'none').model_reasoning_summary).toBe('none');
  });

  /**
   * 不给 summary ⇒ **键整个不出现**，且其余四格逐字不变。
   * 判据用 `Object.hasOwn`（与上面 `model_context_window` 那条同一形态判据，理由见那里的注释）：
   * 它钉的是「键不存在」这个**形态**本身。而「键不存在」正是「我们没意见」——这一格的后果是
   * CLI 照它自己的默认（`summary: "auto"`）跑，其它档位与未选沿用这个行为。
   */
  it('不给 summary ⇒ 该键不存在，其余键逐字不变（不是 undefined 值）', () => {
    const config = buildCodexConfig('https://gw.example.com/v1');
    expect(Object.hasOwn(config, 'model_reasoning_summary')).toBe(false);
    // 其余键逐字不变（spec §1.3 约束 2 的纯函数面）
    expect(config.model_provider).toBe('aieval');
    expect(config.model_providers.aieval?.base_url).toBe('https://gw.example.com/v1');
    expect(config.model_providers.aieval?.wire_api).toBe('responses');
    expect(config.model_providers.aieval?.requires_openai_auth).toBe(true);
    expect(config.model_providers.aieval?.request_max_retries).toBe(1);
    expect(config.tools).toStrictEqual({ web_search: false, update_plan: { enabled: true } });
    expect(config.features).toStrictEqual({ multi_agent: true });
    expect(Object.hasOwn(config, 'model_context_window')).toBe(false);
  });
});
