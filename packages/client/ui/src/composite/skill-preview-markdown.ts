/**
 * 技能预览的 markdown 预处理：把 frontmatter 段包进 ```yaml 围栏。
 *
 * 为什么必须有这一步（`---` 在 CommonMark 里的两副面孔）：首行那条 `---` 前面没有段落，
 * 只是 thematic break（`<hr>`）；而**收尾那条 `---`** 前面是 `name:` / `description:` 两行
 * ——软换行让它们同属一个段落——于是命中 setext 标题下划线规则，整段 YAML 被提升成 `<h2>`，
 * 经共享外壳降两级后长成 `Typography.Title level={5}`。表现就是「YAML 渲染坏了」：
 * 一份 frontmatter 变成页面里最大的那行字。
 *
 * 包一层围栏之后它逐字落在代码块里（首尾 `---` 也在内），字段一个字都不改：界面上仍然只有
 * 「整份文件」这一份真相，不摆第二份解析结果，只是不再让 markdown 把 YAML 当正文读。
 *
 * 识别复用服务端准入那把尺（`splitSkillMarkdown`）：首行 `---` 且有闭合成块，未闭合的半个块
 * 按普通正文原样渲染。「预览认它有 frontmatter」与「服务端按 frontmatter 判准入」因此永远
 * 同一个答案——两处各写一份识别规则迟早漂开。
 *
 * **已知边界**：frontmatter 内部若出现三反引号行会提前闭合这个代码块（YAML 里没有这种合法值；
 * 不为它加长围栏——那会让「围栏就是三反引号」这条视觉约定变得难认）。
 */
import { splitSkillMarkdown } from '@aieval/contracts';

/** 围栏行；语言标注只为让读者一眼看出这段是 YAML，本仓不做语法高亮 */
const FENCE = '```yaml';
const CLOSING_FENCE = '```';

export function fenceFrontmatter(raw: string): string {
  const { frontmatter, body } = splitSkillMarkdown(raw);
  if (frontmatter === null) return raw;
  return [FENCE, frontmatter, CLOSING_FENCE, body].join('\n');
}
