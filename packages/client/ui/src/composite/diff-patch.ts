/**
 * 把一段统一 diff（`@@` hunk）还原成「旧侧 / 新侧」两份正文。
 *
 * 为什么必须还原：`react-diff-viewer-continued` 的 `oldValue` / `newValue` 收的是**完整文件正文**，
 * 不是 diff 文本。把 diff 文本当 `newValue`、空串当 `oldValue` 传进去，它会渲染出
 * 「把这份 diff 当新文件全文」——`+foo` 会显示成新增了一行字面量 `+foo`，是一份完全错误的 diff。
 *
 * 三条不能动的口径（写错任何一条都会**静默**给出错误的对照关系）：
 *   ① 按 hunk 头的行号**定位**，不做顺序拼接——否则相隔 200 行的两处改动会被画成相邻行；
 *   ② 两侧按**同一个 origin**（所有 hunk 里 oldStart / newStart 的最小值）平移：
 *      不平移的话，文件第 498 行的改动前面会多出 497 行空白；平移量相同故不影响彼此对齐；
 *   ③ **不做**「短的一侧补空串到等长」：组件不是按下标逐行比较，而是把两个字符串重新 diff
 *      （见 `reconstructSides` 里那段注释与实测）——补空串会让两侧**结尾不同**，jsdiff 于是把
 *      未修改的行也画成改动。保留空洞由 `join('\n')` 自然变成空行，行数不同**不会**错位。
 */

/** hunk 头：`@@ -旧起点[,旧行数] +新起点[,新行数] @@` */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function reconstructSides(patch: string): { oldValue: string; newValue: string } {
  // 丢掉整体结尾的那个空元素：段落文本以换行收尾，`split('\n')` 于是多给一个 `''`，
  // 它会作为一条**上下文行**混进 hunk 末尾，凭空多出一行并把内容整体挤上一格。
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const hunks: { oldStart: number; newStart: number; body: string[] }[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = HUNK_HEADER.exec(lines[i] ?? '');
    if (header === null) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const raw = lines[j] ?? '';
      // 下一个 hunk 或下一个文件都意味着本 hunk 结束
      if (HUNK_HEADER.test(raw) || raw.startsWith('diff --git ')) break;
      // `\ No newline at end of file` 是元信息，不是内容行
      if (raw.startsWith('\\')) continue;
      body.push(raw);
    }
    // 只有两个**捕获**组：起点行号。两个行数都在 `(?:…)` 非捕获组里，
    // 故新起点是 header[2] 而**不是** header[3]——写成 [3] 会得到 undefined ⇒ NaN ⇒ 每一行都写到
    // NaN 下标上并静默丢失（症状是「所有用例都返回空串」，而不是报错）。
    hunks.push({ oldStart: Number(header[1]), newStart: Number(header[2]), body });
    i = j - 1;
  }

  if (hunks.length === 0) return { oldValue: '', newValue: '' };

  const origin = Math.min(...hunks.map((hunk) => Math.min(hunk.oldStart, hunk.newStart)));
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const hunk of hunks) {
    // 下标 = 行号 - origin，origin = 所有 hunk 起点的最小值。
    // 这会让每处 hunk **多出一格**：真实行号从 1 起算、数组下标从 0 起算，
    // 而 diff 并不包含文件开头到第一处 hunk 之间的内容（那是前面那些行）。
    // 于是第 1 行落在下标 1、文件第 L 行落在下标 L-origin：**绝对行号被如实保留**。
    // 两处 hunk 之间的间距也因此与现实一致（相隔 200 行的改动不会被画成相邻行）。
    let oldNo = hunk.oldStart - origin;
    let newNo = hunk.newStart - origin;
    for (const raw of hunk.body) {
      if (raw.startsWith('+')) {
        newLines[newNo] = raw.slice(1);
        newNo += 1;
        continue;
      }
      if (raw.startsWith('-')) {
        oldLines[oldNo] = raw.slice(1);
        oldNo += 1;
        continue;
      }
      // 上下文行以空格开头；空行（diff 里表示一个空内容行）原样保留
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      oldLines[oldNo] = content;
      newLines[newNo] = content;
      oldNo += 1;
      newNo += 1;
    }
  }

  // **不做「把短的一侧补空串到等长」**（理由见下面那条用例）：
  // 组件不是按下标逐行比较两侧字符串，而是把两个字符串**重新做一次 diff**
  // （`diff.diffLines(old, new, { newlineIsToken: false })`）。
  // 补空串会让两侧**结尾不同**（一侧以 `\n` 收尾、另一侧以内容收尾），jsdiff 于是把尾部重新配对，
  // 把**未修改的行也画成改动**——实测本仓一次真实改动（补丁 +3/−1）：
  //   补空串 → removed=3 added=4（多出 2 行假删除、1 行假新增）；不补 → removed=1 added=3，与补丁**完全一致**。
  // 保留空洞由 `join('\n')` 自然变成空行，两侧行数不同**不会**错位。
  //
  // 关于行号：下标 = 行号 - origin，故第一处 hunk 之前会留一格空白（真实行号被如实保留），
  //   origin = 所有 hunk 起点的最小值，作用是让深处的改动不会带上几百行前导空白。
  return { oldValue: oldLines.join('\n'), newValue: newLines.join('\n') };
}

/** 扩展名 → 组件认识的语言名；不认识就返回 undefined（组件会退化成不高亮） */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'markup',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  sh: 'bash',
  sql: 'sql',
};

export function languageOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return LANGUAGE_BY_EXT[path.slice(dot + 1).toLowerCase()];
}
