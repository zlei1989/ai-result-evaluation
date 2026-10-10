// @vitest-environment node
/**
 * MCP 播种守卫：**判据是「归一化时该键缺失」**，不是「值为空」。
 *
 * 为什么这条必须单独立一个文件、且必须从 `loadConfig` / `saveConfig` 这条**真实读盘路径**上验：
 *   1. 播种判据住在这里（`normalizeSettings` 的键表取自 `SETTINGS_DEFAULTS`）——拿
 *      `SettingsSchema.parse()` 或直接读 `SETTINGS_DEFAULTS` 来验的话，走的根本不是播种那段代码；
 *   2. 「键缺失才播、删光不复播」这**两半必须成对钉住**：只钉前一半（首开有预置两项）时，
 *      「空 map 就当作没配过、重新播种」的实现照样绿——而它让用户删光之后一刷新两台又回来了；
 *      只钉后一半则连播种本身都没验。两半各一条用例，缺一条判据就少一半。
 *
 * 与 `config-store.test.ts` 分开的理由：那个文件已经 388 行、压着原子写与 rename 两套 fs 打桩，
 * 播种是另一条业务线（「什么时候补默认值」vs「怎么写盘」），混进去只会让两边都难读。
 * 测试一律用 `setConfigDirForTesting` 指向临时目录，不碰真实 `~/.aieval`。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from './config-store';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;

/** 落盘那份 config.json 的原文（断言「键在不在文件里」时用，读的是磁盘事实而不是内存对象） */
function configFileText(): string {
  return readFileSync(join(dir, 'config.json'), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-mcp-seed-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  setConfigDirForTesting(null);
  removeTreeWithRetry(dir);
});

describe('MCP 播种：键缺失才播', () => {
  it('没有配置文件时，读出来的就是预置两台（首次打开设置页的那条路径）', () => {
    const config = loadConfig();

    // 期望值取自契约的默认值字面量：本文件要守的是「core 的读盘路径也没把这一格丢掉」，
    // 内容对不对由 `contracts/src/settings.test.ts` 那条逐字抄 spec 的守卫负责。
    expect(Object.keys(config.settings.mcpServers)).toEqual(['context7', 'playwright']);
    expect(config.settings.mcpServers).toEqual(SETTINGS_DEFAULTS.mcpServers);
  });

  it('旧配置里缺 mcpServers 这一键时补上预置两台，其余字段照常读回', () => {
    // 早期落盘的 config.json 就是这个形状：settings 有，但根本没有 mcpServers 这一格
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ settings: { theme: 'dark' }, providers: [] }),
      'utf8',
    );

    const config = loadConfig();

    expect(config.settings.theme).toBe('dark');
    expect(Object.keys(config.settings.mcpServers)).toEqual(['context7', 'playwright']);
  });
});

describe('MCP 播种：删光不复播', () => {
  /**
   * 关键的一态：键在文件里、值是空 map。按「值是不是空」判的实现会把它当成「没配过」
   * 而重新补上两台 —— 用户删光后一刷新，两台又回来了。
   *
   * 刻意走**完整往返**（界面的保存路径就是它）：读 → 原样存回 → 再读。
   * 只读一次文件里没有键的场景（上一条）区分不了两种判据；只有「键在、值空」这一态能区分。
   */
  it('显式存下空 map 后，读回来仍是空（键在文件里 = 配过了，不再播种）', () => {
    const empty = loadConfig();
    empty.settings.mcpServers = {};
    saveConfig(empty);

    // 前置条件：键必须真的落在文件里（写成「压根不写这一格」的话，下面那条断言验的是别的东西）
    expect(JSON.parse(configFileText())).toMatchObject({ settings: { mcpServers: {} } });

    expect(loadConfig().settings.mcpServers).toEqual({});
  });

  it('只读一次再原样保存（用户没碰 MCP 那一段）也不会把预置两台写回文件', () => {
    const config = loadConfig();
    config.settings.mcpServers = {};
    saveConfig(config);
    // 第二次读到的空 map 原样存回：这一步在旧实现里会把空 map 当成「没配过」而播种
    saveConfig(loadConfig());

    expect(loadConfig().settings.mcpServers).toEqual({});
    expect(configFileText()).not.toContain('context7');
  });
});
