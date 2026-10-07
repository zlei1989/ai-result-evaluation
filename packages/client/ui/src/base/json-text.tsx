'use client';

/**
 * 原文的「**是 JSON 就缩进格式化 + 语法高亮**」那一档：模型原始返回、工具结果原文、
 * 未识别的厂商载荷、结构化结果共用。
 *
 * 五条口径：
 *   1. **只有对象 / 数组才格式化**：散文、非法 JSON（尾逗号那种）、裸标量（`42` / `"一句话"`）
 *      一律**逐字原样**——补一个引号、去掉一个尾逗号就能 parse，但那就把「模型没回合法 JSON」
 *      这件事从界面上抹掉了，而它正是排障要看的那条事实；
 *   2. **围栏行逐字保留**：提示词要求「只输出 JSON、不要 markdown 围栏」，模型有没有照做本身就是线索，
 *      故 ` ```json ` 与收尾的 ` ``` ` 原样各占一行（弱化显示），只格式化**围栏里面**的载荷；
 *   3. **非 JSON 分支直接复用 `MonoText`**：那一档的行为与这一格改造前逐字一致（同样的等宽、
 *      `pre-wrap`、`maxHeight` 滚动），两条分支共用同一个件，日后不会各改各的；
 *   4. **颜色全取 antd token**（本仓「样式一律走 antd」的口径）：键 `colorInfo`、字符串 `colorSuccess`、
 *      数字 `colorWarning`、`true/false/null` 用 `colorTextSecondary`、标点 `colorTextTertiary`。
 *      `literal` 刻意**不借语义色**（把 JSON 里的 `false` 染成"错误色"会被读成出错了）；
 *   5. **它是 `ui` 包的内部件，不从包根转出**（与 `NestedDrawer` 同一口径）：四个调用点都在包内，
 *      转出去等于承诺一套还没有外部消费者的 API（要有外部消费者时再转，顺带补用例）。
 *
 * 高亮的可测面是 `data-json-token`（`key` / `string` / `number` / `literal` / `punct`）：
 * 观感类的改动没有任何行为断言会因此变红，判据只能挂在**结构**上（见 json-text.test.tsx）。
 */
import { Flex, theme, Typography } from 'antd';
import type { ReactNode } from 'react';
import { MonoText } from './mono-text';

export interface JsonTextProps {
  text: string;
  /** 限高（px）；不传则由父容器决定（与 `MonoText` 同形） */
  maxHeight?: number;
  /** 宿主的 data-testid：与 `MonoText` 同一个位置，调用方的既有断言不必改 */
  dataTestId?: string;
}

/** 高亮的种类：颜色与 `data-json-token` 都由它决定 */
type JsonTokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct';

/** 一段输出：`kind === null` 的是**空白与缩进**（原样给出，不打标记） */
interface Piece {
  kind: JsonTokenKind | null;
  text: string;
}

/**
 * 整段围栏：三个捕获组分别是**开围栏行（含换行）、载荷、闭围栏行（含它前面的换行）**。
 * 行内空白也捕获（围栏行要逐字还原）。与 `packages/server/api/src/judge.ts` 的剥离口径一致：
 * 只认「整段就是一个围栏」，中间夹散文的那种**故意不救**（那不是我们能替模型猜的东西）。
 */
const FENCE = /^(```[a-zA-Z]*[ \t]*\r?\n)([\s\S]*?)(\r?\n?```)[ \t]*$/;

/**
 * 切分格式化后的 JSON：字符串 / 数字 / 字面量 / 标点各一支。
 *
 * 刻意**不用** `\b`：`"a":1` 里的 `1` 前面是 `:`，而 `-1` 的 `-` 与数字之间没有词边界以外的信息，
 * 按首个字符分类（见 `kindOf`）比按词边界猜更稳。
 */
const TOKEN = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g;

/** 按首个字符分类：`"` 是字符串（跟在冒号后的算键）、数字与 `-` 是数字、`t/f/n` 是字面量、其余是标点 */
function kindOf(token: string, isKey: boolean): JsonTokenKind {
  const head = token[0] ?? '';
  if (head === '"') return isKey ? 'key' : 'string';
  if (head === '-' || (head >= '0' && head <= '9')) return 'number';
  if (head === 't' || head === 'f' || head === 'n') return 'literal';
  return 'punct';
}

/** 把格式化后的 JSON 切成「带标记的 token」与「原样的空白」两类片段，顺序不变 */
function tokenize(source: string): Piece[] {
  const pieces: Piece[] = [];
  const re = new RegExp(TOKEN.source, 'g');
  let cursor = 0;
  for (let match = re.exec(source); match !== null; match = re.exec(source)) {
    const token = match[0] ?? '';
    if (match.index > cursor) pieces.push({ kind: null, text: source.slice(cursor, match.index) });
    /**
     * 「键」与「值」的唯一区别是**后面跟不跟冒号**（合法 JSON 里冒号只跟在键后面）。
     * 只看到 `":"` 就够：`JSON.stringify` 的产物里键的冒号紧随其后，中间不会有别的字符。
     */
    const isKey = token[0] === '"' && source.slice(match.index + token.length).trimStart().startsWith(':');
    pieces.push({ kind: kindOf(token, isKey), text: token });
    cursor = match.index + token.length;
  }
  if (cursor < source.length) pieces.push({ kind: null, text: source.slice(cursor) });
  return pieces;
}

/** 解析结果：围栏行（逐字，无围栏时是空串）+ 格式化后的载荷 */
interface Formatted {
  fenceOpen: string;
  fenceClose: string;
  body: string;
}

/**
 * 原文 → 可高亮的格式化结果；**解析不出对象 / 数组时返回 `null`**（由调用方回落成逐字原文）。
 *
 * 顺序是「先按整段 parse，失败才剥围栏再 parse」：没有围栏的裸 JSON 走第一支，
 * 有围栏的走第二支，两支的载荷都必须 parse 成功才格式化。
 */
function formatJson(text: string): Formatted | null {
  const trimmed = text.trim();
  const fenced = FENCE.exec(trimmed);
  const payload = fenced?.[2] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  // 只有对象 / 数组才格式化（口径 1）：标量格式化后与原文一样，只会多一层「这是 JSON」的错觉
  if (typeof value !== 'object' || value === null) return null;
  let body: string;
  try {
    body = JSON.stringify(value, null, 2);
  } catch {
    // 理论上 `JSON.parse` 的产物不会是循环引用，兜住即可（序列化不动时不假装格式化过）
    return null;
  }
  // 围栏行逐字保留（口径 2）：捕获组里带的是行尾 / 行首的换行，渲染时自己控制换行，故剥掉
  return {
    fenceOpen: (fenced?.[1] ?? '').replace(/\r?\n$/, ''),
    fenceClose: (fenced?.[3] ?? '').replace(/^\r?\n/, ''),
    body,
  };
}

export function JsonText({ text, maxHeight, dataTestId }: JsonTextProps): ReactNode {
  const { token } = theme.useToken();
  const formatted = formatJson(text);

  // 不是 JSON：逐字原样（口径 3）。走同一个 `MonoText`，那一档的行为与改造前逐字一致
  if (formatted === null) return <MonoText text={text} maxHeight={maxHeight} dataTestId={dataTestId} />;

  const colors: Record<JsonTokenKind, string> = {
    key: token.colorInfo,
    string: token.colorSuccess,
    number: token.colorWarning,
    // 语义色一律不借（口径 4）：`false` / `null` 是**值**，不是「出错了」
    literal: token.colorTextSecondary,
    punct: token.colorTextTertiary,
  };
  const pieces = tokenize(formatted.body);

  return (
    <Flex
      vertical
      data-testid={dataTestId}
      style={{
        fontFamily: token.fontFamilyCode,
        whiteSpace: 'pre-wrap',
        overflow: 'auto',
        ...(maxHeight === undefined ? {} : { maxHeight }),
      }}
    >
      <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>
        {formatted.fenceOpen !== '' && (
          <Typography.Text type="secondary">{formatted.fenceOpen}</Typography.Text>
        )}
        {formatted.fenceOpen !== '' && '\n'}
        {pieces.map((piece, index) =>
          piece.kind === null ? (
            piece.text
          ) : (
            <span key={index} data-json-token={piece.kind} style={{ color: colors[piece.kind] }}>
              {piece.text}
            </span>
          ),
        )}
        {formatted.fenceClose !== '' && '\n'}
        {formatted.fenceClose !== '' && (
          <Typography.Text type="secondary">{formatted.fenceClose}</Typography.Text>
        )}
      </Typography.Text>
    </Flex>
  );
}
