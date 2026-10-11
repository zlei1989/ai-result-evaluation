// @vitest-environment node
/**
 * 行级**技能观测格**的推导（`row-skill.ts`）。
 *
 * 判据三态里最要紧的一对是 `missing` 与 `unverified`——它们是**两句相反的话**：
 *   · `missing` = 「有证据说明厂商没认它」（采到了清单、里面没有）⇒ **该行失败**；
 *    · `unverified` = 「没有证据」（清单采不到）⇒ 行照跑，如实标未验证。
 * 把两者互相顶替，就是「文件在盘上被当成结论」那个坑的镜像：一边把缺陷放过，另一边把
 * 一条正常跑完的行判死。
 *
 * ⚠️ **判据一个字都不读模型答复**（硬要求）：本文件里没有一条输入来自消息流。
 */
import { describe, expect, it } from 'vitest';
import { isValidSkillPairing, type VendorSkill } from '@aieval/contracts';
import { AGENT_SKILLS_UNAVAILABLE, deriveRowSkillInstall, skillMissingMessage } from './row-skill';

/** 厂商清单里的一条（只有名字与原值两格参与判据） */
function vendorSkill(name: string, source: string | null = 'userSettings'): VendorSkill {
  return { name, source, path: null, origin: 'local-enabled' };
}

describe('deriveRowSkillInstall（三态与配对规则）', () => {
  it('清单里有它 ⇒ installed + 厂商清单；来源照抄厂商原值', () => {
    const rows = deriveRowSkillInstall({ installed: ['alpha'], vendor: [vendorSkill('alpha', 'userSettings'), vendorSkill('other')] });

    expect(rows).toEqual([{ name: 'alpha', source: 'userSettings', judgedBy: 'vendor-skill-list', verdict: 'installed' }]);
    expect(isValidSkillPairing(rows[0]!)).toBe(true);
  });

  it('清单采到了、里面没有它 ⇒ missing（这一档该行失败）', () => {
    const rows = deriveRowSkillInstall({ installed: ['alpha'], vendor: [vendorSkill('beta')] });

    expect(rows).toEqual([{ name: 'alpha', source: 'unknown', judgedBy: 'vendor-skill-list', verdict: 'missing' }]);
    expect(isValidSkillPairing(rows[0]!)).toBe(true);
  });

  it('清单采到了、但确实是空的（`[]`）⇒ 每一条都 missing（「厂商说一条都没有」是证据）', () => {
    const rows = deriveRowSkillInstall({ installed: ['alpha', 'beta'], vendor: [] });

    expect(rows.map((row) => row.verdict)).toEqual(['missing', 'missing']);
  });

  it('清单采不到（`null`）⇒ unverified + 仅落盘，绝不判失败', () => {
    const rows = deriveRowSkillInstall({ installed: ['alpha', 'beta'], vendor: null });

    expect(rows).toEqual([
      { name: 'alpha', source: 'unknown', judgedBy: 'local-materialized', verdict: 'unverified' },
      { name: 'beta', source: 'unknown', judgedBy: 'local-materialized', verdict: 'unverified' },
    ]);
    // 「采不到」与「采到了、没有它」不许互相顶替（这一条就是那条纪律的守卫）
    expect(rows.some((row) => row.verdict === 'missing')).toBe(false);
  });

  it('一条都没装 ⇒ `[]`（观测到零条，不是「没观测」）', () => {
    expect(deriveRowSkillInstall({ installed: [], vendor: [vendorSkill('alpha')] })).toEqual([]);
  });

  it('产出的每一条都满足配对规则（推导与守卫读同一份判据）', () => {
    const rows = deriveRowSkillInstall({
      installed: ['alpha', 'beta', 'gamma'],
      vendor: [vendorSkill('beta'), vendorSkill('gamma', null)],
    });

    expect(rows.map((row) => row.verdict)).toEqual(['missing', 'installed', 'installed']);
    for (const row of rows) expect(isValidSkillPairing(row)).toBe(true);
    // 厂商没给来源 ⇒ `unknown`（我们这一格的如实交代，不是厂商的取值）
    expect(rows[2]?.source).toBe('unknown');
  });
});

describe('skillMissingMessage（行失败文案）', () => {
  it('点名哪家哪条，并如实说清单里有几条', () => {
    const evidence = { installed: ['alpha'], vendor: [vendorSkill('beta'), vendorSkill('gamma')] };

    expect(skillMissingMessage(evidence, 'Claude Code')).toBe(
      '技能「alpha」未出现在 Claude Code 的技能清单里（厂商清单共 2 条，没有它）',
    );
  });

  it('多条同时没认 ⇒ 逐条点名，顺序跟装入清单（用户配的顺序）', () => {
    const evidence = { installed: ['alpha', 'beta'], vendor: [] };

    expect(skillMissingMessage(evidence, 'Codex')).toBe(
      '技能「alpha」未出现在 Codex 的技能清单里（厂商清单共 0 条，没有它）；技能「beta」未出现在 Codex 的技能清单里（厂商清单共 0 条，没有它）',
    );
  });

  it('没有 missing / 采不到 ⇒ null（不编一条「总得说点什么」的失败）', () => {
    expect(skillMissingMessage({ installed: ['alpha'], vendor: [vendorSkill('alpha')] }, 'Codex')).toBeNull();
    expect(skillMissingMessage({ installed: ['alpha'], vendor: null }, 'Codex')).toBeNull();
  });

  it('归因码与 MCP 那条同一个字符串（两个来源共用一份）', () => {
    expect(AGENT_SKILLS_UNAVAILABLE).toBe('AGENT_SKILLS_UNAVAILABLE');
  });
});
