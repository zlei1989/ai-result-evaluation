// @vitest-environment node
/**
 * 档位域算法：**一处实现、两种兜底**。
 *
 * 这个文件钉的是「两处消费只差一个参数」这件事本身——候选池兜**该家完整域**、评分兜**规范五档**，
 * 而算法只有这一份（抄第二份必然漂移）。第四条的 dsh 域**没有 `medium`** 是有意的：它是唯一能
 * 分辨「兜底那一份域有没有过智能体域这道筛」的用例（两条兜底路径在别的用例上刚好同解）。
 */
import { describe, expect, it } from 'vitest';
import { CANONICAL_EFFORT_LEVELS, intersectEfforts } from './effort';
import {
  CANONICAL_EFFORT_LEVELS as CANONICAL_FROM_BARREL,
  intersectEfforts as intersectFromBarrel,
} from './index';
import { EFFORT_OFF } from './run';

/** 上游声明的宽域（codex 那一类）：比规范五档多出 minimal / xhigh / ultra / persistent */
const codex = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'];
/** dsh 的档位域：**没有 medium**（它只认 off/low/high/max） */
const dsh = ['off', 'low', 'high', 'max'];

describe('intersectEfforts：一处实现、两种兜底', () => {
  it('上游没声明 ⇒ 用 fallbackEfforts（候选行传该家完整域、评分传规范五档）', () => {
    // 候选池那一侧：兜底就是该家完整域 ⇒ 9 档一档不少（codex 的 xhigh / ultra 不许凭空消失）
    expect(intersectEfforts({}, codex, codex)).toEqual(codex);
    // 评分那一侧：兜底是规范五档，codex 全都收得下 ⇒ 逐字保留五档
    expect(intersectEfforts({}, codex, CANONICAL_EFFORT_LEVELS)).toEqual(['off', 'low', 'medium', 'high', 'max']);
  });

  it('上游声明过 ⇒ 取交集，且关闭档不受裁剪', () => {
    expect(intersectEfforts({ supportedEfforts: ['high', 'max'] }, dsh, CANONICAL_EFFORT_LEVELS)).toEqual([
      'off',
      'high',
      'max',
    ]); // off 来自 agentEfforts，不被交集裁掉
  });

  it('dsh 没有 medium ⇒ 规范五档与它求交后要少一格', () => {
    // 兜底那一份域**同样**过智能体域：否则评分那一格会摆出 dsh 硬报错的 medium
    // （`UNSUPPORTED_REASONING_EFFORT`，正是要避免的「症状离真因很远」）
    expect(intersectEfforts({}, dsh, CANONICAL_EFFORT_LEVELS)).toEqual(['off', 'low', 'high', 'max']);
  });

  it('两边都空 ⇒ undefined（调用方据此只给「未指定」）', () => {
    expect(intersectEfforts({ supportedEfforts: [] }, [], [])).toBeUndefined();
  });

  /**
   * **兜底非空、而智能体域为空** ⇒ 同样 `undefined`。这一支今天没有别的用例覆盖：
   * 「两边都空」那条把两个入参都写成空，分辨不出「兜底那一份域**也**要过 `agentEfforts` 这道筛」
   * ——把 `declared.filter(...)` 写成「兜底直接顶上去」时，那条用例照样绿。
   *
   * 后果是实打实的：`intersectEfforts` 有 4 个生产调用点（候选池投影 `listModelOptions`、创建/编辑校验
   * `resolveRunRows`、评分那道门 `requireJudgeEffort`、设置页那一格），拿一个「该家一个档都收不了」的域去兜底，就会摆出一个运行时硬报错的档
   * （`UNSUPPORTED_REASONING_EFFORT`，正是要消灭的「症状离真因很远」）。
   */
  it('智能体域为空而兜底非空 ⇒ undefined（兜底那一份同样要过这道筛）', () => {
    expect(intersectEfforts({}, [], CANONICAL_EFFORT_LEVELS)).toBeUndefined();
  });

  /**
   * **返回的必须是新数组**。旧实现的 `[...agentEfforts]` 拷贝由 `.filter` 承担，而这条不变量
   * 没有任何内容判据看得见——交集结果与入参**逐字相同**时，「照原样返回 `declared`」省下的那次拷贝
   * 与正确实现长得一模一样，代价却是调用方一改返回值就**静默**污染上游那份
   * `metadata.reasoningEfforts`（那一家此后所有运行的候选域都跟着变）。
   *
   * 输入刻意挑「交集与 `declared` 逐字相同」的那一组（`off` 已在声明里 ⇒ 不必再并）：
   * 此时只有同一性判据（`not.toBe`）能分辨拷贝与原样返回。
   */
  it('返回的是新数组（内容相同也不例外）：直接返回 declared 会把上游元数据交给调用方随便改', () => {
    const declared = ['off', 'low', 'high', 'max'];
    const model = { supportedEfforts: declared };
    const result = intersectEfforts(model, declared, CANONICAL_EFFORT_LEVELS);
    expect(result).toEqual(['off', 'low', 'high', 'max']);
    expect(result).not.toBe(declared);
    // 调用方若把返回值当草稿改（排序 / 补一项），上游那一份必须纹丝不动
    result?.push('ultra');
    expect(declared).toEqual(['off', 'low', 'high', 'max']);

    // 兜底那一份同理：它常常是调用方持有的常量（`CANONICAL_EFFORT_LEVELS` 就是），更不能原样交出去
    const fallback = ['low', 'high'];
    const fromFallback = intersectEfforts({}, declared, fallback);
    expect(fromFallback).toEqual(['off', 'low', 'high']);
    expect(fromFallback).not.toBe(fallback);
  });

  it('上游声明了一个这家智能体不认的档 ⇒ 它进不了结果（交集删掉，不是原样透出）', () => {
    expect(intersectEfforts({ supportedEfforts: ['medium', 'high'] }, dsh, CANONICAL_EFFORT_LEVELS)).toEqual([
      'off',
      'high',
    ]);
  });

  it('声明过但不含关闭档 ⇒ 关闭档仍排第一（界面首项就是「关闭」，候选断言依赖这个次序）', () => {
    expect(intersectEfforts({ supportedEfforts: ['high', 'max'] }, codex, codex)).toEqual(['off', 'high', 'max']);
  });
});

describe('CANONICAL_EFFORT_LEVELS 与包根出口', () => {
  it('规范五档取「两条驱动方式都能表达」的那一组，且关闭档用的是契约里的同一个值', () => {
    expect(CANONICAL_EFFORT_LEVELS).toEqual(['off', 'low', 'medium', 'high', 'max']);
    // 这一条把字面量 `'off'` 与 `EFFORT_OFF` 绑死：两处各写一份字面量，改名时必漂移
    expect(CANONICAL_EFFORT_LEVELS[0]).toBe(EFFORT_OFF);
  });

  it('两个名字都从包根可用，且与模块内是同一个绑定（api 侧只 import @aieval/contracts）', () => {
    expect(intersectFromBarrel).toBe(intersectEfforts);
    expect(CANONICAL_FROM_BARREL).toBe(CANONICAL_EFFORT_LEVELS);
  });
});
