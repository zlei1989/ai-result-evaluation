/**
 * 自定义请求头那张表的**工具函数**：形状检查（一句话原因，界面行内校验用）、出口掩码、补丁消解。
 *
 * 形状本体（`CustomHeadersSchema`、两份报错文案）与默认值住在 `settings.ts`；本文件向下取那几条。
 * 两个文件互相 import 成环，而它在求值期成立：本文件在求值期只声明函数（提升），不读对方的任何值，
 * 于是「谁先加载」都成立（口径的另一半在 `settings.ts` 那条 schema 的注释里）。
 *
 * 敏感值的判定与掩码与 MCP 的 `headers` 共用同一把尺（`isSensitiveKey` / `maskApiKey`），
 * 本文件不另写第二份正则——漂移的表现是「MCP 的密钥保住了、请求头的密钥被掩码覆盖」。
 */
import { maskApiKey } from './provider';
import { CustomHeadersSchema, isSensitiveKey, type CustomHeaders } from './settings';

/**
 * 这张表合不合法：合法回 `null`，否则回第一处问题的一句话（界面行内校验用）。
 * 判据与 `CustomHeadersSchema` 同源——这里只是把「一次报第一处」抽出来，不另写一套规则。
 */
export function customHeaderIssue(headers: Record<string, string>): string | null {
  const parsed = CustomHeadersSchema.safeParse(headers);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? '自定义请求头不合法';
}

/** 掩码一张头表：敏感键走 `maskApiKey`，其余键原样；**新建**对象，不改入参 */
export function maskCustomHeaders(headers: CustomHeaders): CustomHeaders {
  const masked: CustomHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = isSensitiveKey(key) ? maskApiKey(value) : value;
  }
  return masked;
}

/**
 * 补丁里那张表的「未改动」消解：敏感键的值是空串、或与**落盘值**的掩码串逐字相同 ⇒ 换回落盘原值。
 *
 * 与 MCP 的 `preserveUnchangedSecrets` **同一条理由**，只是那张表住在第二个位置：
 * 设置页拿到的是掩码，原样回传就会把真值覆盖成掩码串——错误要到下一次运行才以 401 现身，
 * 而落盘文件里看上去一切正常。非敏感键**不做消解**：空串是用户真填的值（改成空 = 这条头发空值）。
 * 落盘里没有这个键时不给「原值」，补丁值照收——否则用户新填的密钥会被静默吃掉。
 *
 * 同名按 HTTP 口径（大小写不敏感）在落盘里找原值：用户把 `X-Token` 改成 `x-token` 只是重敲了一遍，
 * 不该因此丢掉密钥。返回的是**整张新表**（与 `customHeaders` 的整份替换语义一致）。
 */
export function preserveUnchangedCustomHeaders(current: CustomHeaders, incoming: CustomHeaders): CustomHeaders {
  const resolved: CustomHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    const original = findStoredValue(current, key);
    const unchanged =
      isSensitiveKey(key) && original !== undefined && (value === '' || value === maskApiKey(original));
    resolved[key] = unchanged ? original : value;
  }
  return resolved;
}

/** 落盘里同名的那个键（HTTP 头名不区分大小写：`X-Token` 与 `x-token` 是同一个头） */
function findStoredValue(current: CustomHeaders, key: string): string | undefined {
  if (current[key] !== undefined) return current[key];
  const folded = key.toLowerCase();
  for (const [name, value] of Object.entries(current)) {
    if (name.toLowerCase() === folded) return value;
  }
  return undefined;
}
