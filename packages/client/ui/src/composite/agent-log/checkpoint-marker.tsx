'use client';

/**
 * **轮末**的「回到这里」：把「会话从这一轮重新接起」这件事做成一个可读的标记 + 一颗按钮。
 *
 * 四条口径：
 *   1. **不判厂商**：能不能点、为什么不能点、文件会不会跟着回退，全部从**能力声明**
 *      （`CheckpointCapability`）读。组件里出现 `agentKind` 分支就是把第二份真源写进了界面；
 *   2. **不可用时按钮必须禁用并给出原因**（与 `MessageCapabilityMap` 同一套词表）：
 *      「能点但无声失败」是最坏的一种——用户以为回到了第 N 轮，模型其实什么都记得；
 *   3. **文案不承诺撤销**：回到这里只是把**账本**标作废、从这一点续跑；旧内容不删、不改写，
 *      已经发生的动作也不会被「撤回」；
 *   4. **工作区是否跟着回退逐厂商说明**（只有 CC 声明了 `filesRewind`）：
 *      声明为 `false` 的家明确写「不修改工作区文件」，声明为 `true` 的家也只说「支持回退、
 *      本次不自动改文件」——不把厂商能力说成这一次已经做了的事。
 */
import { Button } from '../../components/ui/button';
import { Marker, MarkerContent } from '../../components/ui/marker';
import type { CheckpointCapability } from '@aieval/contracts';
import type { ReactNode } from 'react';
import { MISSING_REASON_LABELS } from './types';

/** 「回到这里」的定位：段号 + 段内轮次（厂商条目 id 由调用方从消息账本取，不进这一层） */
export interface CheckpointTarget {
  segment: number;
  turn: number;
}

export interface CheckpointMarkerProps {
  segment: number;
  turn: number;
  /**
   * 能力声明（注册表元数据 `checkpoint` 原样透出）。
   * `null` / 缺席 = **不知道**（声明还没到）——与 `MessageCapabilityMap` 同一条口径：
   * 不编一份「都支持」，如实按「没验证过」置灰。
   */
  capability: CheckpointCapability | null | undefined;
  /** 额外的禁用原因（如「这一轮没有可用的厂商条目」）；能力不支持时以能力原因为准 */
  disabledReason?: string | null;
  onCheckpoint?(target: CheckpointTarget): void;
}

/**
 * 这一格能不能点的**唯一判据**：`null` = 能点，非空 = 那句要显示的原因。
 *
 * 三种「不能点」必须说成三句不同的话（与消息能力那四句同源）：
 *   · 声明缺席 ⇒ 「没验证过」（不是「这家不支持」——我们不能替厂商下结论）；
 *   · `supported === false` ⇒ 按 `reason` 取那四句里的一句；
 *   · 声明支持、但这一轮缺厂商条目 ⇒ 调用方给的 `disabledReason`（这是**这一次**的事实，
 *     不是厂商能力，不能混进静态声明）。
 */
export function checkpointReasonOf(
  capability: CheckpointCapability | null | undefined,
  disabledReason?: string | null,
): string | null {
  if (capability === null || capability === undefined) return MISSING_REASON_LABELS.unverified;
  if (!capability.supported) return MISSING_REASON_LABELS[capability.reason ?? 'unverified'];
  return disabledReason ?? null;
}

/** 文件回退那一句：逐厂商说明，且不承诺「本次已经回退」 */
export function checkpointFileNote(capability: CheckpointCapability | null | undefined): string {
  if (capability?.filesRewind === true) {
    return '这家支持把工作区文件回退到这一轮（本次不自动改文件）';
  }
  return '不修改工作区文件';
}

export function CheckpointMarker({ segment, turn, capability, disabledReason, onCheckpoint }: CheckpointMarkerProps): ReactNode {
  const reason = checkpointReasonOf(capability, disabledReason);
  const disabled = reason !== null;
  return (
    <Marker variant="border" data-testid="checkpoint-marker" data-supported={capability?.supported === true ? 'true' : 'false'}>
      <MarkerContent className="flex flex-wrap items-center gap-2">
        <span>{`第 ${turn} 轮结束`}</span>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          title={reason ?? '从这一轮重新接上会话，旧内容标为作废（不删除）'}
          onClick={() => onCheckpoint?.({ segment, turn })}
        >
          回到这里
        </Button>
        {disabled ? (
          // 禁用原因**可见**（不只在 title 里）：触屏与键盘用户点不到 tooltip，
          // 而「为什么这颗按钮是灰的」正是这一格要回答的问题。
          <span className="text-muted-foreground">{`不可用：${reason}`}</span>
        ) : (
          <span className="text-muted-foreground">
            {`只把会话回到这一轮；${checkpointFileNote(capability)}；旧内容标为作废、不删除`}
          </span>
        )}
      </MarkerContent>
    </Marker>
  );
}
