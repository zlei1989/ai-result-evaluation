/**
 * 技能清单服务：`GET /api/skills` 的那一份。
 *
 * 两件事，都不外放：
 *   1. **扫盘**（`scanSkills`）：识别单位与准入判据都在 core / contracts，这里只是调用方；
 *   2. **合并停用名单**：`settings.skills.entries` 里有名字 ⇒ 关着，没有 ⇒ **开着**。
 *      「缺省 = 开启」这条规则**只留这一处**：界面拿到的是每条恒给的 `disabled: boolean`，
 *      它不做「这一格缺了是不是等于开着」的推理——那种推理只要界面与配置文件各写一遍，
 *      就会出现「界面显示开着、注入时被跳过」这类谁也说不清的结果。
 *
 * 排序不在这一层（唯一实现在 core 的 `compareSkillNames`）：扫盘输出已是码位升序，
 * 这一层逐条 map 不改顺序。
 */
import { getSkillsRoot, isSkillDisabled, loadConfig, scanSkills } from '@aieval/core';
import type { SkillList } from '@aieval/contracts';

/**
 * 当前技能清单：磁盘上的每一条（含坏条目）+ 停用状态 + 根级异常。
 *
 * 停用状态的判据收在 core 的 `isSkillDisabled`（**唯一**一处）：这里算出来的 `disabled` 与
 * 装入时剔掉的那一批必须是同一把尺——两处各写一遍「缺省 = 开启」的推理，就会出现
 * 「界面显示开着、注入时被跳过」。同理 `skills` 整格不是对象时按「没有停用名单」处置
 * （= 全部开启）：一条手改坏的值不该让设置页打不开。
 */
export function listSkills(): SkillList {
  const { skills, skillWarnings } = scanSkills();
  const entries = loadConfig().settings.skills?.entries;

  return {
    // 技能根本身也下行：工具条要显示它，而空列表时界面无从反推（见契约里 SkillList.root 的注释）
    root: getSkillsRoot(),
    skills: skills.map((skill) => ({ ...skill, disabled: isSkillDisabled(entries, skill.name) })),
    skillWarnings,
  };
}
