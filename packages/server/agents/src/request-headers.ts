/**
 * 自定义请求头**在 agents 里的唯一入口**：把入参那张中性的表整成「能真的发给网关」的形状。
 *
 * 为什么要有这一层而不是四家各自 `Object.entries` 一遍：
 *   · **形状闸只有一处**。`loadConfig` 不做 schema 校验、手改 `config.json` 也能绕过界面的校验，
 *     于是「一条含空格的键名 / 一个带换行的值」必须在发出之前被摘掉——四家各写一遍必然漂成
 *     「三家摘、一家照发」，而那家的形态是请求被网关判 400，看起来像「模型挂了」；
 *   · **日志口径只有一处**：被摘掉的条目要 WARN 且**只记键名**。键名是排障要的（哪一条没出去），
 *     值可能是密钥——整条打出来就是把用户填的密钥写进日志。
 *
 * 摘掉（而不是让整次运行失败）是刻意的：设置里有一条手改坏的头，不该让这个候选一行都跑不了；
 * 它是一条 WARN，下一次运行照样会再 WARN 一次，直到用户去设置页改掉。
 */
import { createLogger } from '@aieval/core';

const log = createLogger('agents/request-headers');

/**
 * cc 的自定义头环境变量名：CLI / SDK 读它，值是**换行分隔**的 `名字: 值` 行。
 * 名字写在这里而不是散在适配器里，是因为「键名拼错」的失败形态是**静默地一条都不加**。
 */
export const ANTHROPIC_CUSTOM_HEADERS_ENV = 'ANTHROPIC_CUSTOM_HEADERS';

/**
 * 一条头是不是真的发得出去：`Headers` 的构造就是 fetch 侧的裁定（契约里的字符集校验是它的前置版，
 * 这里兜的是「手改配置文件绕过了校验」那一档）。它在 Node 与浏览器里同一个语义，不引任何实现。
 */
function isSendableHeader(name: string, value: string): boolean {
  try {
    new Headers([[name, value]]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把入参那张表整成**可发送**的那份：逐条过 `Headers`，不合法的摘掉并 WARN（只记键名）。
 *
 * 返回的永远是**新对象**；空表回 `undefined`（不是 `{}`）——四家都按「有头才注」分支，
 * 「给了一个空表」与「没给」在它们那一侧必须是同一个形状，否则 codex / dsh 会写出一个空方言键。
 */
export function sendableRequestHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const sendable: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (isSendableHeader(name, value)) sendable[name] = value;
    else rejected.push(name);
  }
  if (rejected.length > 0) {
    // 只记键名：值可能是密钥（用户填的就是要发给网关的那几个字）
    log.warn('自定义请求头的条目发不出去，本次已摘掉（去设置页改掉这一条）', { rejected });
  }
  return Object.keys(sendable).length === 0 ? undefined : sendable;
}

/**
 * cc 的落点：`ANTHROPIC_CUSTOM_HEADERS` 的**换行分隔**格式（`名字: 值`，一行一条）。
 *
 * 值里不许出现换行是在契约层拦的；这里不重复校验，但**依赖**它——一个换行就等于把后面半截
 * 变成一条新头。返回 `undefined` = 不加这个环境变量（空串会把宿主同名变量顶成「值为空」，
 * 那与「没设」在 CLI 侧不是同一件事）。
 */
export function formatCustomHeaderLines(headers: Record<string, string> | undefined): string | undefined {
  if (headers === undefined) return undefined;
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return lines.length === 0 ? undefined : lines.join('\n');
}
