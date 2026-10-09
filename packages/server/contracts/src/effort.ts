/**
 * 档位域算法（spec D10）：**一处实现、两种兜底**（2026-10-07 从 `api/runs.ts` 提到 contracts）。
 *
 * 两处消费只有**一个**参数不同——上游没声明 `supportedEfforts` 时兜哪一份域：
 *   · 候选池（`api/runs.ts` 的 `listModelOptions`）传**该家智能体的完整域**（codex 9 档就该能点 9 档）；
 *   · 评分（设置页那一格 + 服务端校验）传 `CANONICAL_EFFORT_LEVELS`（两条驱动方式都能表达的那一组）。
 * 算法本身**只有这一份**：抄第二份必然漂移（本仓在 `formatUsageTriple` 上吃过一次）。
 *
 * 两个变化，各自都有靶子（2026-10-06 放宽）：
 *   · **上游没声明 ⇒ 给该家完整档位域**：本机两个 provider 都是 `source: fetched` 且不带
 *     `supportedEfforts` ⇒ 旧写法让候选为空、界面只给「默认」，用户**连档位都点不到**
 *     （更别说点「关闭」）；
 *   · **关闭档不受交集裁剪**：它表达的是「我们这一侧关掉思考」，不是模型声明的能力
 *     ⇒ 上游即使声明过、且不含它，也照样出现在候选里。
 *
 * 兜底那一份域**同样要过 `agentEfforts` 这道筛**（2026-10-07）：评分侧兜的是规范五档，而 dsh 没有
 * `medium` ⇒ 求交后必须少一格，否则那一格会摆出一个 dsh 硬报错的档（`UNSUPPORTED_REASONING_EFFORT`，
 * 正是本计划要避免的「症状离真因很远」）。
 */
import { EFFORT_OFF } from './run';

/**
 * 上游没声明档位时给**评分**用的规范档位域（用户 2026-10-07 口径）：
 * 取的是「智能体通路与文本通路都能表达」的那一组（DeepSeek 认 `low/medium/high/max`，
 * 关闭走 `thinking.disabled`）。**不要**拿它去改候选池的兜底——那会让 codex 的 `xhigh` / `ultra` 凭空消失。
 * 它与该家智能体域仍要求交：dsh 收不了 `medium`，评分那一格就不该出现它。
 */
export const CANONICAL_EFFORT_LEVELS: readonly string[] = ['off', 'low', 'medium', 'high', 'max'];

/**
 * 某个模型**可选**的档位域：上游声明过 ⇒ 取「模型声明 ∩ 该家智能体域」；上游没声明 ⇒ 拿
 * `fallbackEfforts` 顶上去（再与该家智能体域求交，见文件头）。两种情形都**并上关闭档**
 * `EFFORT_OFF`（若该家能收它、且交集里还没有），且它排在第一位。
 *
 * 返回 `undefined` = 一个档位都没有（调用方据此只给「未指定」）：候选池那侧只有该家档位域为空时才会；
 * 评分那侧还可能是「规范五档与该家域无交集」（今天三家都不会）。
 */
export function intersectEfforts(
  model: { supportedEfforts?: string[] },
  agentEfforts: readonly string[],
  fallbackEfforts: readonly string[],
): string[] | undefined {
  const supported = model.supportedEfforts ?? [];
  // 上游声明过就是它、没声明就是调用方给的兜底域；两者都要过 agentEfforts 这道筛
  // （上游声明了这家收不了的档，同样进不了结果）
  const declared = supported.length === 0 ? fallbackEfforts : supported;
  const base = declared.filter((effort) => agentEfforts.includes(effort));
  const off = agentEfforts.includes(EFFORT_OFF) && !base.includes(EFFORT_OFF) ? [EFFORT_OFF] : [];
  const allowed = [...off, ...base];
  return allowed.length === 0 ? undefined : allowed;
}
