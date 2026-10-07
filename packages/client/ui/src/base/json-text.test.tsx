/**
 * JsonText：**原文是 JSON 就缩进格式化 + 语法高亮，不是 JSON 就逐字原样**。
 *
 * 为什么值得一组守卫（这一格的产物是「观感」的改动，没有任何行为断言会因此变红）：
 *   · 格式化把 `{"a":1}` 变成多行 —— 「真的格式化了」与「只是把原文原样画出来」在肉眼上很像，
 *     而后者会让这一整次改动**什么都没做**却全绿；
 *   · 高亮的颜色必须**来自 antd token**（本仓「样式一律走 antd」的口径）：写死色值的版本在默认主题下
 *     看着一样，换主题 / 换 token 时才发现它不跟着走 —— 故判据用**自定义 token**，写死任何字面量都会红；
 *   · **非 JSON 一律回落成逐字原文**：评分原文常常是散文（模型没照格式回），把它当 JSON 解析失败后
 *     自作聪明地「修一下」（补引号、去尾逗号）会把排障线索改掉 —— 判据是「原文逐字 == 输入」；
 *   · 围栏（```json）**逐字保留**：围栏本身是排障线索（提示词要求 JSON，模型有没有照做），
 *     格式化只动围栏**里面**的载荷，不减一个字。
 */
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import { JsonText } from './json-text';

/** 单行 JSON（真实 `score.raw` 的形状：一整行、无空白） */
const SINGLE_LINE = '{"name":"aieval","count":3,"ok":true,"missing":null,"items":[1]}';

/** 围栏 JSON（提示词要求 JSON，模型常常包一层） */
const FENCED = '```json\n{"totalScore":90,"judgments":[]}\n```';

/** 某个 token 种类的节点（高亮的存在性判据） */
function tokensOf(host: HTMLElement, kind: string): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(`[data-json-token="${kind}"]`)];
}

describe('JsonText', () => {
  it('单行 JSON 被缩进格式化，且五种 token 都标出来了', () => {
    render(<JsonText text={SINGLE_LINE} dataTestId="json" />);
    const host = screen.getByTestId('json');
    const text = host.textContent ?? '';

    // ① 真的格式化了：换行 + 2 空格缩进 + 键与值之间的那个空格（原文里没有）
    expect(text).toContain('\n  "name": "aieval"');
    // 反向判据：把格式化去掉、退回原文时这一条必红（`"name":"aieval"` 里没有空格）
    expect(text).not.toContain('"name":"aieval"');
    // ② 结构不塌：格式化靠 pre-wrap 才看得见换行（少了它，界面又变回一行）
    expect(host.style.whiteSpace).toBe('pre-wrap');
    // ③ 五种 token 齐全：键 / 字符串 / 数字 / 字面量 / 标点
    expect(tokensOf(host, 'key').map((node) => node.textContent)).toEqual([
      '"name"',
      '"count"',
      '"ok"',
      '"missing"',
      '"items"',
    ]);
    expect(tokensOf(host, 'string').map((node) => node.textContent)).toEqual(['"aieval"']);
    expect(tokensOf(host, 'number').map((node) => node.textContent)).toEqual(['3', '1']);
    expect(tokensOf(host, 'literal').map((node) => node.textContent)).toEqual(['true', 'null']);
    expect(tokensOf(host, 'punct').length).toBeGreaterThan(0);
  });

  /**
   * 颜色必须来自 antd 的 token（本仓「样式一律走 antd」的口径）。
   *
   * 判据用**自定义 token 值**（刻意不等于 antd 默认），于是「写死字面量」——包括写死当前默认值——
   * 都会红。归一化那一步不能省：jsdom 把 `#123456` 序列化成 `rgb(18, 52, 86)`。
   */
  it('token 的颜色从 antd token 取（换成自定义 token 后颜色跟着走）', () => {
    const custom = { colorInfo: '#123456', colorSuccess: '#234567', colorWarning: '#345678' };
    render(
      <ConfigProvider theme={{ token: custom }}>
        <JsonText text={SINGLE_LINE} dataTestId="json" />
      </ConfigProvider>,
    );
    const host = screen.getByTestId('json');
    // 同一个值在 jsdom 里走一遍同样的序列化，作为比较基准（不写死序列化后的形式）
    const probe = (color: string): string => {
      const element = document.createElement('span');
      element.style.color = color;
      return element.style.color;
    };

    expect(tokensOf(host, 'key')[0]?.style.color).toBe(probe(custom.colorInfo));
    expect(tokensOf(host, 'string')[0]?.style.color).toBe(probe(custom.colorSuccess));
    expect(tokensOf(host, 'number')[0]?.style.color).toBe(probe(custom.colorWarning));
  });

  it('非 JSON 回落成逐字原文，且一个高亮节点都不留', () => {
    const prose = '这不是 JSON，模型回了一段散文\n第二行也原样';
    render(<JsonText text={prose} dataTestId="json" maxHeight={120} />);
    const host = screen.getByTestId('json');

    expect(host.textContent).toBe(prose);
    expect(host.querySelectorAll('[data-json-token]')).toHaveLength(0);
    // 回落分支也必须吃 `maxHeight`：调用方靠它把长原文圈在一个滚动区里
    expect(host.style.maxHeight).toBe('120px');
  });

  it('围栏 JSON：围栏行逐字保留，只把里面的载荷格式化', () => {
    render(<JsonText text={FENCED} dataTestId="json" />);
    const text = screen.getByTestId('json').textContent ?? '';
    const lines = text.split('\n');

    // 围栏行逐字（首行原样、末行仍是 ```）：它们是「提示词要求 JSON，模型有没有照做」的线索
    expect(lines[0]).toBe('```json');
    expect(lines[lines.length - 1]).toBe('```');
    // 载荷格式化（原文里冒号后没有空格）
    expect(text).toContain('  "totalScore": 90');
    expect(text).not.toContain('"totalScore":90');
    expect(tokensOf(screen.getByTestId('json'), 'key').map((node) => node.textContent)).toEqual([
      '"totalScore"',
      '"judgments"',
    ]);
  });

  it('非法 JSON 原样给出（不许猜、不许修）', () => {
    // 尾逗号：模型常见的手写风格。补一个字符就能 parse，但那就把「模型没回合法 JSON」这件事抹掉了
    const broken = '{"a":1,}';
    render(<JsonText text={broken} dataTestId="json" />);

    expect(screen.getByTestId('json').textContent).toBe(broken);
    expect(screen.getByTestId('json').querySelectorAll('[data-json-token]')).toHaveLength(0);
  });

  it('标量与顶层字符串不格式化（`42`、`"散文"` 都按原文）', () => {
    // 只有对象 / 数组才值得格式化：标量格式化后与原文一样，白白多一层「这是 JSON」的错觉
    const { container } = render(
      <>
        <JsonText text="42" dataTestId="number" />
        <JsonText text={'"这其实是一句散文"'} dataTestId="string" />
      </>,
    );

    expect(screen.getByTestId('number').textContent).toBe('42');
    expect(screen.getByTestId('string').textContent).toBe('"这其实是一句散文"');
    expect(container.querySelectorAll('[data-json-token]')).toHaveLength(0);
  });
});
