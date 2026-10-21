/**
 * 候选级**技能观测格**的推导：把「我们真的装进去哪几条」与「厂商事件侧说它手里有哪几条」
 * 合成一份可落盘、可复盘的清单。
 *
 * 为什么推导只在编排层做一次（与 `candidate-mcp.ts` 逐字同源）：这一格的消费方有两个（环境抽屉的
 * 「候选技能」格、排障时的 `run.json`），各推一份必然漂移；而推导需要的两半——我们的装入清单与厂商证据
 * ——只有编排层同时拿得到。
 *
 * ⚠️ **判据不许是模型答复**（硬要求）：本模块一个字都不读消息流。真机抓到过
 * 「skill 没调上、模型却把结果编出来」——模型说「我按技能做了」在证据等级上是零。
 *
 * 判据三态（**不许互相顶替**）：
 *   1. 厂商清单**采到了**且**含**这个名字 ⇒ `installed`（`vendor-skill-list`）；
 *   2. 厂商清单**采到了**、里面**没有**它 ⇒ `missing`（**该候选失败**，点名哪家哪条）——
 *      这正是「文件在盘上被当成结论」那个坑的解药：落盘成功（L1）证明不了厂商认了它；
 *   3. 厂商清单**采不到** ⇒ `unverified`（`local-materialized`，行照跑）。
 */
import {
  CANDIDATE_SKILL_SOURCE_UNKNOWN,
  type CandidateSkillInstall,
  type VendorSkill,
} from '@aieval/contracts';

/**
 * 候选级失败的归因码（两个来源共用一个字符串）：
 *   · **落盘失败**（源目录读不到 / 写不进行配置目录）——适配器抛 `SkillMaterializeError`，
 *     归成 `AgentErrorCode` 的同一个成员，落点是该候选的事件日志；
 *   · **厂商没认**（本模块的 `missing`）——由编排层判定，走 `CandidateFailure.code`。
 *
 * ⚠️ **刻意不进 `TRANSIENT_CANDIDATE_RETRY_CODES`**（编排层那张表）：装不进去**不是瞬时故障**，
 * 重试只会把同一个失败延后 `3s × N` ⇒ 用户等到的是「重试了三次还是没装上」。
 * 它不是厂商归因（不属于 `AgentErrorCode` 词表的那一半）：`missing` 的判定由编排层做，
 * 厂商原文只进文案（与 `AGENT_MCP_UNAVAILABLE` 同一条处置）。
 */
export const AGENT_SKILLS_UNAVAILABLE = 'AGENT_SKILLS_UNAVAILABLE';

/** 推导的输入：我们的装入清单 + 厂商侧的证据 */
export interface CandidateSkillEvidence {
  /** 我们**真的装进去**的那几条的名字（顺序 = 设置页里的顺序；停用已剔除、不合格条目根本没进清单） */
  installed: readonly string[];
  /**
   * 厂商系统层事件里的**技能清单**（`vendor-system.skills` 的最后一条）。
   * **`null` = 采不到**（没有一条事件带过这一格）——它与 `[]`（采到了、确实一条都没有）
   * 是两句不同的话：后者会把我们装的每一条都判成 `missing` 并让整候选失败。
   */
  vendor: readonly VendorSkill[] | null;
}

/**
 * 合成候选级观测格。顺序 = 我们的装入清单（用户配的顺序），每条四格。
 *
 * 三条口径：
 *   · **来源采信厂商原值**（claude 的 `source` / codex 的 `scope`），厂商没给这一格记
 *     `CANDIDATE_SKILL_SOURCE_UNKNOWN`——这一格是证据，翻成我们的词表就是第二个真源；
 *   · **配对规则由契约保证**（`isValidSkillPairing`）：这里只产出三种合法组合
 *     （`installed`+清单 / `missing`+清单 / `unverified`+仅落盘）；
 *   · **厂商多报的那些不进这一格**：它回答的是「**我们装的**那几条落地了没有」，
 *     厂商内置与被测仓库自带的那几条在环境抽屉的「已下发的技能」里逐条可见。
 */
export function deriveCandidateSkillInstall(evidence: CandidateSkillEvidence): CandidateSkillInstall[] {
  const vendor = evidence.vendor;
  return evidence.installed.map((name) => {
    // 采不到 ⇒ 只有落盘这一份证据（`unverified` + `local-materialized`，行照跑）
    if (vendor === null) {
      return { name, source: CANDIDATE_SKILL_SOURCE_UNKNOWN, judgedBy: 'local-materialized', verdict: 'unverified' };
    }
    const entry = vendor.find((item) => item.name === name) ?? null;
    if (entry === null) {
      // 采到了、清单里没有它 ⇒ 厂商没认（这一档**该候选失败**）
      return { name, source: CANDIDATE_SKILL_SOURCE_UNKNOWN, judgedBy: 'vendor-skill-list', verdict: 'missing' };
    }
    return {
      name,
      source: entry.source ?? CANDIDATE_SKILL_SOURCE_UNKNOWN,
      judgedBy: 'vendor-skill-list',
      verdict: 'installed',
    };
  });
}

/**
 * 候选失败的那一条文案（模板）：只给**结论为 `missing`** 的那几条。
 *
 * 做什么：拿同一份证据跑一遍 `deriveCandidateSkillInstall`（**结论的推导只有那一处**），把其中
 * `missing` 的逐条拼成 `技能「<name>」未出现在 <家> 的技能清单里（厂商清单共 N 条，没有它）`；
 * 一条都没有 ⇒ `null`（**不编**一条「总得说点什么」的失败）。
 *
 * 为什么要点名**哪家**：`missing` 的含义是「厂商没认它」，而「厂商」是这个候选那一家
 * （同一份配置在三家上可能只有一家不认），不点名的话用户不知道该去查哪一家的技能面。
 * 多条同时没认时用 `；` 串起来，顺序跟装入清单一致（用户配的顺序）。
 */
export function skillMissingMessage(
  evidence: CandidateSkillEvidence,
  agentLabel: string,
): string | null {
  const missing = deriveCandidateSkillInstall(evidence).filter((entry) => entry.verdict === 'missing');
  if (missing.length === 0) return null;
  const total = evidence.vendor?.length ?? 0;
  return missing
    .map((entry) => `技能「${entry.name}」未出现在 ${agentLabel} 的技能清单里（厂商清单共 ${total} 条，没有它）`)
    .join('；');
}
