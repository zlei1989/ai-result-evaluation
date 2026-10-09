// @vitest-environment node
/**
 * `diffRubric`：把「模型改完的那张表」与「用户原来的那张表」比成一份**改动清单**。
 *
 * 它是「智能调整」唯一的把关依据：用户只看得见这份清单，看不见模型到底动了哪几行。
 * 所以本文件的钉子全部钉在**清单的准确性**上，而不是「函数跑通了」：
 *   · 七类改动各自的形状（组改名、组增删、项增删、项改写）；
 *   · 三段式配对优先级的每一条都有一个用例，尤其是**中间插一项不许产生位移假象**
 *     （无 id 的项在评分通路里按全表位置分配 `#k`，硬按引用键配会把一次插入报成「删 5 增 5」）；
 *   · 组顺序重排**如实显示**成「改组名 + 项搬家」，不猜模型的意图（设计口径 2026-10-08）。
 */
import { describe, expect, it } from 'vitest';
import { diffRubric, type Rubric, type RubricChange } from './rubric';

/** 基线表：两组 4 项，其中第 2 组的第二项**刻意没有 id**（无 id 的项是配对的主战场） */
function base(): Rubric {
  return {
    groups: [
      {
        name: '一、生产代码',
        items: [
          { id: 'A1', goal: '追加 agent 字段', weight: 18 },
          { id: 'A2', goal: '补 Javadoc', weight: 4 },
        ],
      },
      {
        name: '二、测试',
        items: [
          { id: 'D1', goal: '有值透传用例', weight: 14 },
          { id: '', goal: '缺失→null 用例', weight: 9 },
        ],
      },
    ],
  };
}

/** 深拷贝基线，供各用例改成「模型改完的那张表」 */
function edited(mutate: (rubric: Rubric) => void): Rubric {
  const next = structuredClone(base());
  mutate(next);
  return next;
}

/** 取清单里某一类，并断言条数（条数错时这里的报错比 `toEqual` 好读） */
function only(changes: RubricChange[], kind: RubricChange['kind']): RubricChange[] {
  const picked = changes.filter((change) => change.kind === kind);
  expect(picked, `期望恰好 ${kind} 一类（实际清单：${JSON.stringify(changes)}）`).toHaveLength(changes.length);
  return picked;
}

describe('diffRubric：没改就是空清单', () => {
  it('两张表逐字节相同 ⇒ 空清单（不是「改了 0 处」的一条记录）', () => {
    expect(diffRubric(base(), base())).toEqual([]);
  });

  it('空表对空表 ⇒ 空清单（两边都是合法值，不抛）', () => {
    expect(diffRubric({ groups: [] }, { groups: [] })).toEqual([]);
  });
});

describe('diffRubric：项这一层', () => {
  it('改权重 ⇒ update-item，before/after 两格原样带着（界面要显示 20 → 30）', () => {
    const changes = diffRubric(base(), edited((rubric) => {
      (rubric.groups[0]?.items[0] as { weight: number }).weight = 30;
    }));

    expect(changes).toEqual<RubricChange[]>([
      {
        kind: 'update-item',
        groupName: '一、生产代码',
        before: { id: 'A1', goal: '追加 agent 字段', weight: 18 },
        after: { id: 'A1', goal: '追加 agent 字段', weight: 30 },
      },
    ]);
  });

  it('改文字 ⇒ 也是 update-item（界面按 before/after 自己分类显示「改了文字」）', () => {
    const changes = diffRubric(base(), edited((rubric) => {
      (rubric.groups[1]?.items[1] as { goal: string }).goal = '缺失时给出 null 的用例';
    }));

    expect(changes).toEqual<RubricChange[]>([
      {
        kind: 'update-item',
        groupName: '二、测试',
        before: { id: '', goal: '缺失→null 用例', weight: 9 },
        after: { id: '', goal: '缺失时给出 null 的用例', weight: 9 },
      },
    ]);
  });

  it('新增一项 ⇒ add-item，带组名与整项', () => {
    const changes = diffRubric(base(), edited((rubric) => {
      rubric.groups[0]?.items.push({ id: 'A3', goal: '错误处理', weight: 6 });
    }));

    expect(changes).toEqual<RubricChange[]>([
      { kind: 'add-item', groupName: '一、生产代码', item: { id: 'A3', goal: '错误处理', weight: 6 } },
    ]);
  });

  it('删除一项 ⇒ remove-item，带的是**旧表**那一项（新表里已经没有它了）', () => {
    const changes = diffRubric(base(), edited((rubric) => {
      rubric.groups[0]?.items.splice(1, 1);
    }));

    expect(changes).toEqual<RubricChange[]>([
      { kind: 'remove-item', groupName: '一、生产代码', item: { id: 'A2', goal: '补 Javadoc', weight: 4 } },
    ]);
  });
});

describe('diffRubric：组这一层（组没有 id，只能按位置配对）', () => {
  it('组改名 ⇒ rename-group（按位置：第 1 组对第 1 组）', () => {
    const changes = diffRubric(base(), edited((rubric) => {
      (rubric.groups[0] as { name: string }).name = '一、代码实现';
    }));

    expect(changes).toEqual<RubricChange[]>([{ kind: 'rename-group', from: '一、生产代码', to: '一、代码实现' }]);
  });

  it('新增一组（追加在表尾）⇒ add-group，只报组名不报项', () => {
    const changes = diffRubric(base(), edited((rubric) => {
      rubric.groups.push({ name: '三、文档', items: [{ id: 'E1', goal: 'README 说明用法', weight: 5 }] });
    }));

    expect(changes).toEqual<RubricChange[]>([{ kind: 'add-group', name: '三、文档' }]);
  });

  it('删掉一组 ⇒ remove-group，带的是旧表那一组的名字', () => {
    const changes = diffRubric(base(), edited((rubric) => {
      rubric.groups.splice(1, 1);
    }));

    expect(changes).toEqual<RubricChange[]>([{ kind: 'remove-group', name: '二、测试' }]);
  });

  it('两组顺序对调 ⇒ **空清单**（组没有 id，名字就是它的身份；只换顺序不算改动内容）', () => {
    // 这一条钉的是「按名字一对一」那一轮配对：少了它，顺序对调会被报成两条 rename-group
    // 外加若干条项改写（位置配对把两组的项两两错配），用户会以为整套标准被换掉了。
    const changes = diffRubric(base(), edited((rubric) => {
      rubric.groups.reverse();
    }));

    expect(changes).toEqual<RubricChange[]>([]);
  });
});

describe('diffRubric：三段式配对优先级', () => {
  it('第一段（按 id）：同一项挪到组内别的位置，仍认得出是它', () => {
    const changes = diffRubric(base(), edited((rubric) => {
      // A1 挪到 A2 后面，内容一个字没改
      rubric.groups[0]?.items.reverse();
    }));

    expect(changes).toEqual<RubricChange[]>([]);
  });

  it('第二段（按目标文字）：**中间插一项**不许产生位移假象（无 id 的项靠文字认亲）', () => {
    // 这一条是本文件的核心：旧表第 2 组是 [D1(有 id), 无id「缺失→null 用例」]，
    // 在**组首**插一项之后，无 id 那项的引用键从 #4 变成 #5。硬按引用键配 ⇒ 会报成
    // 「删掉 缺失→null 用例 / 新增 缺失→null 用例」两条，用户以为标准被动了，其实一个字没变。
    const changes = diffRubric(base(), edited((rubric) => {
      rubric.groups[1]?.items.unshift({ id: 'D0', goal: '空仓库的用例', weight: 3 });
    }));

    expect(changes).toEqual<RubricChange[]>([
      { kind: 'add-item', groupName: '二、测试', item: { id: 'D0', goal: '空仓库的用例', weight: 3 } },
    ]);
  });

  it('第三段（按组内位置）：无 id 的项被改了文字 ⇒ 报成 update-item，而不是「一删一增」', () => {
    // 文字变了 ⇒ 第二段认不出，落到第三段按位置配对：位置没变，故它是「同一项被改写」。
    // 这条钉的是「AI 重写了一项的措辞」这个最常见的改动，必须显示成改写而不是删+增。
    const changes = diffRubric(base(), edited((rubric) => {
      (rubric.groups[1]?.items[1] as { goal: string }).goal = '完全改写的措辞';
    }));

    expect(only(changes, 'update-item')).toHaveLength(1);
    expect(changes).toEqual<RubricChange[]>([
      {
        kind: 'update-item',
        groupName: '二、测试',
        before: { id: '', goal: '缺失→null 用例', weight: 9 },
        after: { id: '', goal: '完全改写的措辞', weight: 9 },
      },
    ]);
  });

  it('配对只发生在组内：一项从 A 组搬到 B 组 ⇒ 如实报成「A 组删 + B 组增」', () => {
    const changes = diffRubric(base(), edited((rubric) => {
      const moved = rubric.groups[0]?.items.pop();
      if (moved) rubric.groups[1]?.items.push(moved);
    }));

    expect(changes).toEqual<RubricChange[]>([
      { kind: 'remove-item', groupName: '一、生产代码', item: { id: 'A2', goal: '补 Javadoc', weight: 4 } },
      { kind: 'add-item', groupName: '二、测试', item: { id: 'A2', goal: '补 Javadoc', weight: 4 } },
    ]);
  });
});
