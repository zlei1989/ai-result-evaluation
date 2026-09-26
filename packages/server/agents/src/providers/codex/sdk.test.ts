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
    // 判据用 `Object.hasOwn` 而不是 `toBeUndefined()`：SDK 会把 config 摊成 `--config key=value`，
    // 一个显式的 `undefined` 会被序列化成字符串交给 CLI，而「键不存在」才是「我们没意见」。
    expect(Object.hasOwn(buildCodexConfig('https://gw.example.com/v1'), 'model_context_window')).toBe(false);
  });

  it('其余注入项逐字不受影响（窗口是叠加，不是替换）', () => {
    const config = buildCodexConfig('https://gw.example.com/v1', 262_144);
    expect(config.model_provider).toBe('aieval');
    expect(config.tools).toEqual({ web_search: false, update_plan: { enabled: true } });
    expect(config.features).toEqual({ multi_agent: false });
    expect(config.model_providers.aieval?.base_url).toBe('https://gw.example.com/v1');
  });
});
