/**
 * 探针共用的小工具：**把 `Record<string, unknown>` 里的事件读成能编译的窄形状**。
 *
 * 为什么需要：一致性夹具把产物里的事件收成 `Array<Record<string, unknown>>`（类型系统管不到形状，
 * 形状本该由契约管，见 `conformance/kit.ts` 的注释）。探针要读某一格时，直接点属性会得到 `{}`，
 * 或者干脆编译不过。这里只做两件事——**认事件类型**、**认技能条目**——不复制任何契约形状：
 * 认出来的东西仍是 `Record<string, unknown>`，逐格取值由探针自己收窄。
 *
 * ⚠️ 探针不属于产品代码：这些函数只服务于 `probe/` 下的用例，不进任何产品导出面。
 */

/** 事件是不是某个 `type`（探针唯一需要的运行时判别） */
export function eventOfType(event: Record<string, unknown>, type: string): boolean {
  return event['type'] === type;
}

/** 一条技能条目的四格（缺格一律 `null`，不猜） */
export function vendorSkillOf(event: Record<string, unknown>): Array<{
  name: string | null;
  source: string | null;
  path: string | null;
  origin: string | null;
}> {
  const skills = event['skills'];
  if (!Array.isArray(skills)) return [];
  return skills.flatMap((one) => {
    if (one === null || typeof one !== 'object') return [];
    const record = one as Record<string, unknown>;
    const text = (key: string): string | null => (typeof record[key] === 'string' ? (record[key] as string) : null);
    return [{ name: text('name'), source: text('source'), path: text('path'), origin: text('origin') }];
  });
}

/** 某一格的字符串值（不是字符串就是 `null`——与产品侧 `readString` 同一条口径，探针不引它） */
export function textOf(event: Record<string, unknown>, key: string): string | null {
  return typeof event[key] === 'string' ? (event[key] as string) : null;
}

/** 某一格的字符串数组（不是数组就回空数组） */
export function textsOf(event: Record<string, unknown>, key: string): string[] {
  const value = event[key];
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
}
