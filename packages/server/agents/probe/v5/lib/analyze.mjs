/**
 * v5：把一份**原始通知 JSONL** 折成能回答五个问题的读数。
 *
 * 为什么单独一层：判定口径必须与采集分开——采集只负责把**原文**落盘（不 parse 后重排），
 * 判定则完全从落盘原文重算。这样「读数不对」时可以只改判定、不重跑真机（一次真机 1~3 分钟）。
 *
 * 一条硬口径：**「键不存在」与「数组为空」是两件事**。`summary`/`content` 一律先看
 * `Object.hasOwn` 再取长度，绝不写成 `item.summary ?? []`（那会把「上游没给这个字段」
 * 抹成「给了空数组」，正是本仓上一轮误诊过的坑）。
 */

/** 拼接增量：逐条累加，同时留每条的长度，便于看「有没有逐字增量」 */
export function joinDeltas(entries) {
  return entries.map((one) => one.delta).join('');
}

/**
 * 从通知数组里取「第一次/最后一次见到某字段」的原文片段。
 * `pick` 是取值函数；返回 `{ raw, at }`（`at` = 第几条通知，便于回原文定位）。
 */
export function firstHit(notifications, pick) {
  for (let index = 0; index < notifications.length; index += 1) {
    const value = pick(notifications[index]);
    if (value !== undefined) return { raw: value, at: index };
  }
  return null;
}

/**
 * 判定一份 case 的全部读数。
 *
 * @param {object} input
 * @param {Array<{method: string, params: any}>} input.notifications 原始通知（按到达顺序）
 * @param {string} input.threadId 主线程 id
 */
export function analyzeCase({ notifications, threadId }) {
  const reasoningItemsStarted = [];
  const reasoningItemsCompleted = [];
  const textDeltas = [];
  const summaryDeltas = [];
  const summaryPartAdded = [];
  const usageUpdates = [];
  const methodCounts = new Map();
  /** 失败证据：`error` 通知 + `turn/completed` 里的 `turn.error`（**逐字原文**，不加工） */
  const errors = [];
  let turnStatus = null;
  let turnErrorMessage = null;

  for (let index = 0; index < notifications.length; index += 1) {
    const { method, params } = notifications[index];
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
    const sameThread = params?.threadId === undefined || params.threadId === threadId;

    if ((method === 'item/started' || method === 'item/completed') && params?.item?.type === 'reasoning') {
      const entry = {
        at: index,
        itemId: params.item.id ?? null,
        threadId: params.threadId ?? null,
        // 逐键存在性（不是 `?? []`）：见文件头那条硬口径
        hasSummaryKey: Object.hasOwn(params.item, 'summary'),
        hasContentKey: Object.hasOwn(params.item, 'content'),
        summaryIsArray: Array.isArray(params.item.summary),
        contentIsArray: Array.isArray(params.item.content),
        summary: Array.isArray(params.item.summary) ? params.item.summary : null,
        content: Array.isArray(params.item.content) ? params.item.content : null,
        // item 的**全部键名**（上游加/减字段时这里能直接看出来）
        itemKeys: Object.keys(params.item),
      };
      (method === 'item/started' ? reasoningItemsStarted : reasoningItemsCompleted).push(entry);
      continue;
    }
    if (method === 'item/reasoning/textDelta' && sameThread) {
      textDeltas.push({ at: index, itemId: params.itemId, contentIndex: params.contentIndex, delta: params.delta });
      continue;
    }
    if (method === 'item/reasoning/summaryTextDelta' && sameThread) {
      summaryDeltas.push({ at: index, itemId: params.itemId, summaryIndex: params.summaryIndex, delta: params.delta });
      continue;
    }
    if (method === 'item/reasoning/summaryPartAdded' && sameThread) {
      summaryPartAdded.push({ at: index, itemId: params.itemId, summaryIndex: params.summaryIndex });
      continue;
    }
    if (method === 'thread/tokenUsage/updated' && params?.threadId === threadId) {
      usageUpdates.push({ at: index, total: params.tokenUsage?.total ?? null, last: params.tokenUsage?.last ?? null });
      continue;
    }
    if (method === 'error') {
      // 形状：`{ error: { message, code?, … } }`；取不到 message 就把整个 params 原文留下
      errors.push({ at: index, method, message: params?.error?.message ?? null, params });
      continue;
    }
    if (method === 'turn/completed' && params?.threadId === threadId) {
      turnStatus = params.turn?.status ?? null;
      turnErrorMessage = params.turn?.error?.message ?? params.turn?.error ?? null;
      if (turnErrorMessage !== null) errors.push({ at: index, method, message: turnErrorMessage, params: params.turn });
    }
  }

  /** 末次用量通知里的累计值（协议只按线程报累计 ⇒ 取最后一条就是累计终值） */
  const lastUsage = usageUpdates.length === 0 ? null : usageUpdates[usageUpdates.length - 1];

  const completedItem = reasoningItemsCompleted.at(-1) ?? null;
  const textJoined = joinDeltas(textDeltas);
  const summaryJoined = joinDeltas(summaryDeltas);

  /**
   * 逐字比对：拼接结果 vs `item/completed` 的对应数组。按 `contentIndex` / `summaryIndex`
   * 分桶再比——协议给了这两个下标，说明**一个推理条目可以有多个部分**，混在一起拼是错的。
   */
  const bucketize = (entries, indexKey) => {
    const buckets = new Map();
    for (const one of entries) {
      const key = one[indexKey] ?? '<缺失>';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(one);
    }
    return [...buckets.entries()].map(([key, list]) => ({ index: key, count: list.length, text: joinDeltas(list) }));
  };

  const textBuckets = bucketize(textDeltas, 'contentIndex');
  const summaryBuckets = bucketize(summaryDeltas, 'summaryIndex');

  const compareWithArray = (buckets, array) => {
    if (array === null) return { comparable: false, reason: 'item/completed 的该数组不是数组（键缺失或类型不对）' };
    if (array.length === 0) return { comparable: false, reason: 'item/completed 的该数组为空' };
    // 单桶且条目数与数组长度一致 ⇒ 可以直接逐项比
    if (buckets.length === 1 && array.length === 1) {
      const equal = buckets[0].text === array[0];
      return {
        comparable: true,
        equal,
        joinedLength: buckets[0].text.length,
        arrayLength: array[0].length,
        // 不相等时给出「差在哪」：首个不同字符的下标 + 两侧上下文
        firstDiff: equal ? null : firstDifference(buckets[0].text, array[0]),
      };
    }
    if (buckets.length === array.length) {
      const pairs = buckets.map((bucket, position) => ({
        position,
        index: bucket.index,
        deltas: bucket.count,
        deltaLength: bucket.text.length,
        arrayLength: array[position].length,
        equal: bucket.text === array[position],
      }));
      return { comparable: true, equal: pairs.every((one) => one.equal), bucketsVsArray: pairs };
    }
    return {
      comparable: false,
      reason: `桶数(${buckets.length}) 与数组长度(${array.length}) 不一致，无法一对一比对`,
      bucketIndexes: buckets.map((one) => one.index),
      arrayLengths: array.map((one) => one.length),
    };
  };

  return {
    threadId,
    notificationCount: notifications.length,
    methodCounts: Object.fromEntries([...methodCounts.entries()].sort((a, b) => b[1] - a[1])),
    /** 失败证据（逐字）：上游 4xx 的原文最终会出现在这两格之一 */
    errors,
    turnStatus,
    turnErrorMessage,
    reasoning: {
      startedCount: reasoningItemsStarted.length,
      completedCount: reasoningItemsCompleted.length,
      started: reasoningItemsStarted,
      completed: reasoningItemsCompleted,
    },
    textDelta: {
      count: textDeltas.length,
      joinedLength: textJoined.length,
      contentIndexDistribution: distribution(textDeltas.map((one) => one.contentIndex)),
      firstDeltas: textDeltas.slice(0, 3).map((one) => ({ contentIndex: one.contentIndex, delta: one.delta })),
      buckets: textBuckets.map((one) => ({ index: one.index, count: one.count, length: one.text.length })),
    },
    summaryDelta: {
      count: summaryDeltas.length,
      joinedLength: summaryJoined.length,
      summaryIndexDistribution: distribution(summaryDeltas.map((one) => one.summaryIndex)),
      firstDeltas: summaryDeltas.slice(0, 3).map((one) => ({ summaryIndex: one.summaryIndex, delta: one.delta })),
      buckets: summaryBuckets.map((one) => ({ index: one.index, count: one.count, length: one.text.length })),
    },
    summaryPartAdded: {
      count: summaryPartAdded.length,
      summaryIndexDistribution: distribution(summaryPartAdded.map((one) => one.summaryIndex)),
      samples: summaryPartAdded.slice(0, 5),
    },
    /** 与 `item/completed` 的逐字比对（两个通道各一份） */
    equality: {
      textDeltaVsContent: compareWithArray(textBuckets, completedItem?.content ?? null),
      summaryDeltaVsSummary: compareWithArray(summaryBuckets, completedItem?.summary ?? null),
    },
    /** 旁证：`reasoningOutputTokens`（不拿它当主判据） */
    usage: {
      updateCount: usageUpdates.length,
      lastTotal: lastUsage?.total ?? null,
      lastReasoningOutputTokens: lastUsage?.total?.reasoningOutputTokens ?? null,
    },
  };
}

/** 首处不同的下标与两侧上下文（不相等时用来回答「差在哪」） */
function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return {
        at: index,
        deltaSide: left.slice(Math.max(0, index - 30), index + 30),
        arraySide: right.slice(Math.max(0, index - 30), index + 30),
      };
    }
  }
  return {
    at: limit,
    note: `前 ${limit} 字相同，长度不同（增量 ${left.length} / 数组 ${right.length}）`,
    deltaTail: left.slice(limit, limit + 60),
    arrayTail: right.slice(limit, limit + 60),
  };
}

/** 取值分布：`{ '<值>': 条数 }`（`undefined` 显式写成 `<缺失>`，键不存在也要看得见） */
export function distribution(values) {
  const out = {};
  for (const one of values) {
    const key = one === undefined ? '<缺失>' : String(one);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
