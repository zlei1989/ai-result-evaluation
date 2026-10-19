/**
 * 「回到某一轮」的**数据层**：一条写侧路由（`POST /api/checkpoint`）。
 *
 * 与追问（`follow-up.ts`）同一条形状，差别只有三处：
 *   · 请求体多三格定位（`segment` / `turn` / `keepAt` / `dropFrom`）；
 *   · **没有可用性读侧**：这一行能不能回到某一轮只由**能力声明**回答（`AgentOptionGroup.checkpoint`），
 *     它随候选池一次取全，不需要第二条请求；
 *   · 写侧仍回写详情与列表两个键：状态立刻变成「准备中」必须同时被两处看到。
 *
 * 界面**不判厂商**：支持与否、走哪条路、禁用原因全部来自能力声明那一格（与 `MessageCapabilityMap`
 * 同一口径）；本文件只负责把请求发出去。
 */
import { useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';
import type { CheckpointRequest, EvalRun } from '@aieval/contracts';
import { postJson } from './http';
import { RUNS_KEY, runKey } from './run-keys';

/** 回到某一轮的写侧端点（请求体即契约里的 `CheckpointRequestSchema`） */
export const CHECKPOINT_URL = '/api/checkpoint';

/**
 * 回到某一轮。**同步拿到「已经在准备中」的快照**（与追问同形）；拒绝（409 这一家不支持 /
 * 这一行此刻不能续跑，400 请求不合法，404 行不存在）抛 `ServiceError`，中文原因直接展示。
 */
export function postCheckpoint(request: CheckpointRequest): Promise<EvalRun> {
  return postJson<EvalRun>(CHECKPOINT_URL, request);
}

/**
 * 回到某一轮（写侧）。回写两个键与其它写操作同形；`isCheckingPoint` 只用于转圈与防连点，
 * **不参与可用性判据**——那个判据是能力声明与编排层的 409。
 */
export function useCheckpointRow(): {
  checkpointRow: (request: CheckpointRequest) => Promise<EvalRun>;
  isCheckingPoint: boolean;
} {
  const { mutate } = useSWRConfig();
  const [isCheckingPoint, setCheckingPoint] = useState(false);

  const checkpointRow = useCallback(
    async (request: CheckpointRequest): Promise<EvalRun> => {
      setCheckingPoint(true);
      try {
        const run = await postCheckpoint(request);
        await mutate(runKey(request.runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setCheckingPoint(false);
      }
    },
    [mutate],
  );

  return { checkpointRow, isCheckingPoint };
}
