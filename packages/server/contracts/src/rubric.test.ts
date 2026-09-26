// @vitest-environment node
/**
 * 评分表契约：满分 / 引用键 / 校验 / 总分 / 送模型的渲染。
 * 五组口径各自钉住一条：空表合法、空 id 按位置引用、权重上限、id 重复被拒、单元格转义。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ITEM_WEIGHT,
  RubricSchema,
  composeTotalScore,
  renderRubricForJudge,
  rubricItemKeys,
  rubricMaxScore,
  validateRubric,
  type Rubric,
} from './rubric';

/** 一份与 spec 示例同形的表：两组共 4 项，满分 45（刻意不是 100，钉「满分由表格决定」） */
function sample(): Rubric {
  return {
    groups: [
      { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }, { id: 'A2', goal: '补 Javadoc', weight: 4 }] },
      { name: '二、测试', items: [{ id: 'D1', goal: '有值透传用例', weight: 14 }, { id: '', goal: '缺失→null 用例', weight: 9 }] },
    ],
  };
}

/**
 * 数一行里的**真列边界**：GFM 只在「前面有偶数个反斜杠」的 `|` 上切列——
 * `\|` 是转义的竖线，而 `\\|` 是「一个字面反斜杠 + 一个真分隔符」。
 * 为什么不用 `row.split(/(?<!\\)\|/)`：它只看前一个字符，`\\|` 会被当成转义而漏判，
 * 于是「反斜杠没先转义」这类缺陷能在段数断言下蒙混过关（本文件的 round 1 修复就踩过这个坑）。
 */
function countRowDelimiters(row: string): number {
  let delimiters = 0;
  let backslashes = 0;
  for (const char of row) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '|' && backslashes % 2 === 0) delimiters += 1;
    backslashes = 0;
  }
  return delimiters;
}

describe('RubricSchema', () => {
  it('空表合法（{ groups: [] }）——它是新建用例的真实初值，不能把「新建」判为非法', () => {
    expect(RubricSchema.safeParse({ groups: [] }).success).toBe(true);
  });

  it('组内可以一项都没有（表单上刚点「添加分组」的中间态）', () => {
    expect(RubricSchema.safeParse({ groups: [{ name: '一组', items: [] }] }).success).toBe(true);
  });

  it('空组名 / 空目标 / 非正权重 / 非整数权重 / 超上限权重都被 schema 拒', () => {
    expect(RubricSchema.safeParse({ groups: [{ name: '', items: [{ goal: 'g', weight: 1 }] }] }).success).toBe(false);
    expect(RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: '', weight: 1 }] }] }).success).toBe(false);
    expect(RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: 0 }] }] }).success).toBe(false);
    expect(RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: -1 }] }] }).success).toBe(false);
    expect(RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: 1.5 }] }] }).success).toBe(false);
    expect(
      RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: MAX_ITEM_WEIGHT }] }] }).success,
    ).toBe(true);
    expect(
      RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: MAX_ITEM_WEIGHT + 1 }] }] }).success,
    ).toBe(false);
  });

  it('id 缺省为空串（表格里「没写 ID」与「ID 是空串」是同一件事）', () => {
    const parsed = RubricSchema.parse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: 1 }] }] });
    expect(parsed.groups[0]?.items[0]?.id).toBe('');
  });
});

describe('rubricMaxScore', () => {
  it('满分 = 全部项权重之和（不是常量：45 分的表就该是 45）', () => {
    expect(rubricMaxScore(sample())).toBe(18 + 4 + 14 + 9);
  });

  it('空表返回 0（不返回 NaN）', () => {
    expect(rubricMaxScore({ groups: [] })).toBe(0);
  });
});

describe('rubricItemKeys', () => {
  it('有 id 用 id，没 id 用 #k；k 是**全表顺序号**，跨组连续', () => {
    expect(rubricItemKeys(sample())).toEqual(['A1', 'A2', 'D1', '#4']);
  });

  it('空 id 的项与有 id 的项混排时，顺序号仍然只按位置递增', () => {
    const rubric: Rubric = {
      groups: [
        { name: 'g1', items: [{ id: '', goal: 'a', weight: 1 }] },
        { name: 'g2', items: [{ id: 'X', goal: 'b', weight: 1 }, { id: '', goal: 'c', weight: 1 }] },
      ],
    };
    // 第二项有 id 但仍占第 2 个位置 ⇒ 第三项是 #3（不是 #2）
    expect(rubricItemKeys(rubric)).toEqual(['#1', 'X', '#3']);
  });

  it('ID 前后空白被 trim 掉、纯空白 ID 按位置引用（引用键是模型照抄的那串字符，隐形空格会让它对不上）', () => {
    const rubric: Rubric = {
      groups: [{ name: 'g', items: [{ id: '  A1  ', goal: 'a', weight: 1 }, { id: '   ', goal: 'b', weight: 2 }] }],
    };
    expect(rubricItemKeys(rubric)).toEqual(['A1', '#2']);
  });
});

describe('validateRubric', () => {
  it('合格的表格返回 ok', () => {
    expect(validateRubric(sample())).toEqual({ ok: true });
  });

  it('空表被拒，且原因是可直接展示的中文', () => {
    const result = validateRubric({ groups: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('至少需要一组');
  });

  it('空组被拒并点名是哪一组', () => {
    const result = validateRubric({ groups: [{ name: '一、生产代码', items: [] }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('一、生产代码');
  });

  it('空目标被拒并点名是第几项', () => {
    const result = validateRubric({
      groups: [{ name: 'g', items: [{ id: '', goal: 'ok', weight: 1 }, { id: '', goal: '   ', weight: 2 }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('第 2 项');
  });

  it('有值的 id 重复被拒并点名那个 id（放行会让一次判定同时记到两项上）', () => {
    const result = validateRubric({
      groups: [
        { name: 'g1', items: [{ id: 'A1', goal: 'a', weight: 1 }] },
        { name: 'g2', items: [{ id: 'A1', goal: 'b', weight: 2 }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('A1');
  });

  /**
   * 守卫（Review round 1）：逐项 ID 不重复**不等于**引用键不重复——没写 ID 的项按位置拿 `#k`，
   * 于是「第 2 项的 ID 直接写成 `#1`」会与「第 1 个没写 ID 的项」撞在同一把键上。
   * 放行的后果：`rubricItemKeys` 会返回两把 `#1`，模型的一次判定被同时算进两项的权重
   * （10 + 20 = 30），界面上却一切正常。Task 3 的解析侧按引用键逐项取判定，这条是它的前提。
   */
  it('引用键撞车被拒：ID 写成 `#1` 与第 1 个没写 ID 的项拿到同一把键（放行会让一次判定加两次权重）', () => {
    const result = validateRubric({
      groups: [{ name: 'g', items: [{ id: '', goal: 'a', weight: 10 }, { id: '#1', goal: 'b', weight: 20 }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('#1');
  });

  it('ID 恰好写成自己位置的那把引用键是合法的（只要不与别的项撞车）', () => {
    // 第 1 项没写 ID ⇒ `#1`；第 2 项的 ID 就叫 `#2` ⇒ 两把键不同，放行
    expect(
      validateRubric({
        groups: [{ name: 'g', items: [{ id: '', goal: 'a', weight: 1 }, { id: '#2', goal: 'b', weight: 2 }] }],
      }),
    ).toEqual({ ok: true });
  });

  it('空白 ID 与空 ID 同档（`trim()` 后才判「写没写」，否则空白会变成隐形引用键）', () => {
    const result = validateRubric({
      groups: [{ name: 'g', items: [{ id: '   ', goal: 'a', weight: 1 }, { id: '#1', goal: 'b', weight: 2 }] }],
    });
    // 第 1 项 trim 后为空 ⇒ 按位置拿 `#1`，与第 2 项的 ID 撞车（不 trim 就会静默放行）
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('#1');
  });

  it('空 id 重复是合法的（它们没有身份）', () => {
    // ⚠️ 字面量必须显式写 `id: ''`：`Rubric` 是 schema 的**输出**类型（`id: string`），
    // `.default('')` 只在 `.parse()` 时生效——直接构造对象时漏掉 id，运行期 `undefined !== ''` 为真，
    // 第二项会被当成「重复的 id」拦下（而那正是这条用例要证明不会发生的事）
    expect(
      validateRubric({
        groups: [
          { name: 'g', items: [{ id: '', goal: 'a', weight: 1 }, { id: '', goal: 'b', weight: 2 }] },
        ],
      }),
    ).toEqual({ ok: true });
  });
});

describe('composeTotalScore', () => {
  it('总分 = 达成项权重之和（含两个端点：一项没达成 = 0、全达成 = 满分）', () => {
    // 判定就是 `RubricJudgment`（`reason` 必填）：这里用它的真实形状，而不是一个「没有理由」的窄类型
    const rubric = sample();
    expect(
      composeTotalScore(rubric, [
        { id: 'A1', achieved: true, reason: '字段进了契约' },
        { id: 'A2', achieved: false, reason: '没补 Javadoc' },
        { id: 'D1', achieved: true, reason: '有值透传用例在' },
        { id: '#4', achieved: false, reason: '缺缺失分支用例' },
      ]),
    ).toBe(32);
    expect(composeTotalScore(rubric, [])).toBe(0);
    expect(
      composeTotalScore(rubric, [
        { id: 'A1', achieved: true, reason: '达成' },
        { id: 'A2', achieved: true, reason: '达成' },
        { id: 'D1', achieved: true, reason: '达成' },
        { id: '#4', achieved: true, reason: '达成' },
      ]),
    ).toBe(rubricMaxScore(rubric));
  });

  it('总分可以大于 100（300 分的表全达成就是 300）', () => {
    const rubric: Rubric = { groups: [{ name: 'g', items: [{ id: 'A', goal: 'a', weight: 200 }, { id: 'B', goal: 'b', weight: 100 }] }] };
    expect(
      composeTotalScore(rubric, [
        { id: 'A', achieved: true, reason: '达成' },
        { id: 'B', achieved: true, reason: '达成' },
      ]),
    ).toBe(300);
  });
});

describe('renderRubricForJudge', () => {
  it('含组名、每条引用键、权重与表尾汇总', () => {
    const text = renderRubricForJudge(sample());
    expect(text).toContain('一、生产代码');
    expect(text).toContain('二、测试');
    for (const key of ['A1', 'A2', 'D1', '#4']) expect(text).toContain(key);
    expect(text).toContain('| 18 |');
    expect(text).toContain('以上共 4 项，满分 45 分。');
  });

  /**
   * 守卫（Review Focus 4）：目标里带竖线或换行时**列不能错位**。
   * 错位的后果不是报错，而是模型读到一张与界面不同的表——它会按错位后的列去理解权重。
   */
  it('目标里的竖线被转义、换行被压成空格（列不错位）', () => {
    const text = renderRubricForJudge({
      groups: [{ name: 'g', items: [{ id: 'A', goal: '第一行\n第二行|带竖线', weight: 7 }] }],
    });
    const row = text.split('\n').find((line) => line.startsWith('| A |')) ?? '';
    expect(row).not.toContain('\n');
    // 三列的表行有 4 个真分隔符；目标里那个竖线被转义，所以它不算边界
    expect(countRowDelimiters(row)).toBe(4);
    expect(row).toContain('第一行 第二行');
  });

  /**
   * 守卫（Review round 1）：目标里**先出现反斜杠、再出现竖线**（`foo\|bar`）时，
   * 只转义竖线是不够的——`foo\\|bar` 里那个 `|` 仍然是真分隔符，列照旧错位。
   * 所以 `escapeCell` 必须先转义反斜杠。断言方式与上面几条一致：**数这一行的真列边界**
   * （`countRowDelimiters` 按反斜杠的奇偶判 `|` 算不算分隔符），三列的行必须是 4 个。
   */
  it('目标里的反斜杠先被转义：`\\|` 不会把分隔符吃掉（列仍不错位）', () => {
    const text = renderRubricForJudge({
      groups: [{ name: 'g', items: [{ id: 'A', goal: 'foo\\|bar', weight: 7 }] }],
    });
    const row = text.split('\n').find((line) => line.startsWith('| A |')) ?? '';
    // 先断言结构：只转义竖线时这里渲染成 `foo\\|bar`，两个反斜杠（偶数）⇒ 那个竖线在 GFM 里是真分隔符
    expect(countRowDelimiters(row)).toBe(4);
    // 再断言文本：反斜杠被转义成 `\\`、竖线被转义成 `\|` ⇒ 目标整段是 `foo\\\|bar`（三反斜杠 + 一竖线）
    expect(row).toContain('foo\\\\\\|bar');
  });

  it('组名里的竖线与换行同样被转义（组名一样会让整行列错位）', () => {
    const text = renderRubricForJudge({
      groups: [{ name: '一|二\n三', items: [{ id: 'A', goal: 'g', weight: 1 }] }],
    });
    expect(text.split('\n')[0]).toBe('一\\|二 三');
  });

  /**
   * 守卫（整支复审 Finding 1）：**第一列（引用键）曾是表里唯一没走转义的格子**——组名与目标都过
   * `escapeCell`，而键直接来自用户填的 `item.id`（`RubricSchema` 只管它是字符串、`validateRubric`
   * 只 `trim()` 与查重，两处都不限定字符）。于是 ID 里带一个 `|` 就让这一行多出一个**真分隔符**、
   * 带一个换行就让它裂成两行：模型读到的是一张与界面不同的表（哪把权重属于哪一项全错），
   * 而测试、校验、界面三处都不作声——与目标里带竖线是**同一个**后果。
   *
   * 断言的形状是**行纪律**（一项一行、每行恰好三列），不是「字符串里有没有 `\|`」：后者对
   * 「键转义了但换行没压掉」这类缺陷是空转的。两种字符**各占一条用例**（输入只有一个缺陷）：
   * 合在一起时，换行那条会先把总行数断言打红，竖线那条就永远得不到自己的红——
   * 变异验证会看到一条「红了，但红在别的性质上」的记录。输入可达性也各自自证：
   * 这样的 ID 真的过得了 schema 与 `validateRubric`（否则守卫防的是一个到不了的形状）。
   */
  describe('引用键（用户填的 ID）也必须走转义', () => {
    /** 一项的表：只有引用键是变量，其余形状固定，行数才可以被逐字钉住 */
    function oneItem(id: string): Rubric {
      return { groups: [{ name: 'g', items: [{ id, goal: '目标', weight: 7 }] }] };
    }

    /** 渲染结果的总行数 + 表内行（以 `|` 开头的行）。两者都要看：换行裂缝的后半截不以 `|` 开头 */
    function renderLines(rubric: Rubric): { lines: string[]; tableRows: string[] } {
      const lines = renderRubricForJudge(rubric).split('\n');
      return { lines, tableRows: lines.filter((line) => line.startsWith('|')) };
    }

    it('ID 里的竖线被转义：这一行仍是三列（4 个真分隔符），不把权重挤到第四列去', () => {
      const rubric = oneItem('A|B');
      expect(RubricSchema.safeParse(rubric).success).toBe(true);
      expect(validateRubric(rubric)).toEqual({ ok: true });

      const { lines, tableRows } = renderLines(rubric);
      // 组名 + 表头 + 分隔行 + 一项 + 组尾空行 + 表尾汇总
      expect(lines).toHaveLength(6);
      expect(tableRows).toHaveLength(3);
      expect(countRowDelimiters(tableRows[2] ?? '')).toBe(4);
      // 转义后的原文仍可读：竖线留着，只是不再当分隔符
      expect(lines).toContain('| A\\|B | 目标 | 7 |');
    });

    it('ID 里的换行被压成空格：仍是一项一行（不会裂成两行把权重甩到表外）', () => {
      const rubric = oneItem('C\nD');
      expect(RubricSchema.safeParse(rubric).success).toBe(true);
      expect(validateRubric(rubric)).toEqual({ ok: true });

      const { lines, tableRows } = renderLines(rubric);
      // 换行没被压掉时这里会多一行（`| C` 与 `D | 目标 | 7 |` 各占一行），而表内行数仍是 3
      expect(lines).toHaveLength(6);
      expect(tableRows).toHaveLength(3);
      expect(countRowDelimiters(tableRows[2] ?? '')).toBe(4);
      expect(lines).toContain('| C D | 目标 | 7 |');
    });
  });
});
