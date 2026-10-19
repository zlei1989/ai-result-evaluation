'use client';

/**
 * 「智能调整」弹窗：**两段式**——先写下要求，再看改动清单，**点了「应用改动」才把新表交回去**。
 *
 * 它与「智能识别」弹窗的区别只有一处、但足够分成两个组件：识别是「粘一段文本 → 整表替换」，
 * 调整是「说一句话 → 基于**现有**表改 → 用户看清单确认」。把两者塞进一个组件，会让「什么时候写回表格」
 * 这件事出现两条分支，而那正是本功能唯一的把关点。
 *
 * 四条口径：
 *   1. **不确认就不写回**（本组件的全部意义）：新表只暂存在 `preview` 这个 state 里，
 *      只有点「应用改动」才通过 `onApply` 交出去；取消 / 关闭 / 返回修改都不碰表格一个字；
 *   2. **失败不清空、不关窗**（同识别弹窗）：文本在**自己的 state** 里，一次抖动不会抹掉用户刚写的要求；
 *   3. **在途取消 ⇒ 这次结果作废**（同识别弹窗的代次口径）：用户按了取消就是「这次不要了」，
 *      让请求回来时把清单糊到他已经关掉的窗上是最难被发现的一种错；
 *   4. **本组件不调接口**（纯展示）：`onAdjust` 由调用方实现，错误也由调用方提示（与 CaseFormPanel 同一分工）。
 *
 * 清单里「权重变了」与「只是文字变了」**分类显示**（`updateLabel`）：模型有顺手润色的倾向，
 * 分开显示才能让用户一眼看出哪些改动不是他要的。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Rubric, RubricChange, RubricItem } from '@aieval/contracts';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Textarea } from '../components/ui/textarea';
import { EllipsisText } from '../base/ellipsis-text';

export interface RubricAdjustModalProps {
  open: boolean;
  /** 请求在途：按钮转圈并禁用（避免连点两次花两次钱） */
  adjusting: boolean;
  onCancel: () => void;
  /** 把要求交给调用方去调整；返回「改完的新表 + 改动清单」，抛错即失败（本组件据此保留文本） */
  onAdjust: (instruction: string) => Promise<{ rubric: Rubric; changes: RubricChange[] }>;
  /** 用户点了「应用改动」：调用方据此把新表写回表格（**这是唯一会改动表格的出口**） */
  onApply: (rubric: Rubric) => void;
}

/** 每条改动的分类徽标：新增绿 / 删除红 / 改动蓝（方向一眼可辨） */
const CHANGE_STYLE: Record<RubricChange['kind'], string> = {
  'add-group': 'border-success/40 text-success',
  'remove-group': 'border-destructive/40 text-destructive',
  'rename-group': 'border-info/40 text-info',
  'add-item': 'border-success/40 text-success',
  'remove-item': 'border-destructive/40 text-destructive',
  'update-item': 'border-info/40 text-info',
};

/** 项的显示名：写了 ID 就用 ID 领头（与评分通路里模型看到的引用键同口径），否则退回目标文字 */
function itemLabel(item: RubricItem): string {
  const id = item.id.trim();
  return id === '' ? item.goal : `${id} · ${item.goal}`;
}

/**
 * 一条改动的中文描述。故意写得比「改了 3 项」啰嗦：这是用户**唯一**的把关依据，
 * 说得越具体，他越不用凭信任点「应用」。
 */
function ChangeRow({ change }: { change: RubricChange }): ReactNode {
  const tag = (label: string): ReactNode => (
    <Badge variant="outline" className={CHANGE_STYLE[change.kind]}>
      {label}
    </Badge>
  );

  switch (change.kind) {
    case 'add-group':
      return (
        <div className="flex items-center gap-2">
          {tag('新增组')}
          <span className="font-medium">{change.name}</span>
        </div>
      );
    case 'remove-group':
      return (
        <div className="flex items-center gap-2">
          {tag('删除组')}
          <span className="font-medium line-through">{change.name}</span>
        </div>
      );
    case 'rename-group':
      return (
        <div className="flex items-center gap-2">
          {tag('组改名')}
          <span className="text-muted-foreground line-through">{change.from}</span>
          <span>→ {change.to}</span>
        </div>
      );
    case 'add-item':
      return (
        <div className="flex items-center gap-2">
          {tag('新增项')}
          <span className="text-muted-foreground">{change.groupName}</span>
          <EllipsisText text={itemLabel(change.item)} />
          <span className="text-muted-foreground">{`${change.item.weight} 分`}</span>
        </div>
      );
    case 'remove-item':
      return (
        <div className="flex items-center gap-2">
          {tag('删除项')}
          <span className="text-muted-foreground">{change.groupName}</span>
          <span className="line-through">{itemLabel(change.item)}</span>
        </div>
      );
    case 'update-item': {
      // 两格分开显示：模型顺手润色文字时，用户看到的是一条「改文字」而不是被塞进「改权重」里
      const weightChanged = change.before.weight !== change.after.weight;
      const goalChanged = change.before.goal !== change.after.goal;
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            {tag(updateLabel(weightChanged, goalChanged))}
            <span className="text-muted-foreground">{change.groupName}</span>
            <EllipsisText text={itemLabel(change.before)} />
          </div>
          {weightChanged && (
            <span className="text-sm text-muted-foreground">
              {`权重 ${change.before.weight} → `}
              <span className="font-medium text-foreground">{change.after.weight}</span>
            </span>
          )}
          {goalChanged && (
            <div className="flex flex-col">
              <span className="text-sm text-muted-foreground line-through">{change.before.goal}</span>
              <span className="text-sm">{change.after.goal}</span>
            </div>
          )}
        </div>
      );
    }
  }
}

/** `update-item` 的标签：两格都变了要说出来（只标「改权重」会让用户漏看被改掉的措辞） */
function updateLabel(weightChanged: boolean, goalChanged: boolean): string {
  if (weightChanged && goalChanged) return '改权重 + 改文字';
  return weightChanged ? '改权重' : '改文字';
}

export function RubricAdjustModal({ open, adjusting, onCancel, onAdjust, onApply }: RubricAdjustModalProps): ReactNode {
  const [text, setText] = useState('');
  /** 预览：模型改完的新表 + 由服务端算出来的改动清单。**它是唯一的暂存处**，取消即丢 */
  const [preview, setPreview] = useState<{ rubric: Rubric; changes: RubricChange[] } | null>(null);
  /** 请求代次：在途取消后回来的结果一律作废（见文件头要点 3） */
  const epochRef = useRef(0);

  /**
   * 关窗即丢弃：留着上次的清单，下次打开会让人以为「已经应用过了」。
   * 挂在 `open` 上而不是动画结束事件上——受控弹窗的开关由父组件决定，
   * jsdom 里没有动画，等动画事件会把清理变成一条在生产才跑的分支。
   */
  useEffect(() => {
    if (!open) {
      setText('');
      setPreview(null);
    }
  }, [open]);

  const handleCancel = (): void => {
    epochRef.current += 1;
    onCancel();
  };

  /** 点「生成改动」：拿到清单后停在预览段，**不写回表格** */
  const requestPreview = async (): Promise<void> => {
    const epoch = epochRef.current;
    const next = await onAdjust(text);
    // 用户在途按了取消 / 关了窗：这次结果作废（表格本来也没动，只是别把清单糊上去）
    if (epoch !== epochRef.current) return;
    setPreview(next);
  };

  const hasChanges = preview !== null && preview.changes.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleCancel();
      }}
    >
      <DialogContent
        data-testid="rubric-adjust-dialog"
        style={{ maxWidth: 720 }}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>智能调整评分标准项</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2" data-testid="rubric-adjust-body">
          {preview === null ? (
            <>
              <p className="text-sm text-muted-foreground">
                写下你要怎么改这份评分标准（例如「把 A1 的权重提到 30，并加一条关于错误处理的条目」）。
                会先给你一份改动清单，确认之后才会写进表格。
              </p>
              <Textarea
                rows={6}
                value={text}
                aria-label="调整要求"
                data-testid="rubric-adjust-text"
                onChange={(event) => setText(event.target.value)}
              />
            </>
          ) : preview.changes.length === 0 ? (
            <Alert data-testid="rubric-adjust-empty" className="border-border bg-muted/40">
              <AlertTitle>模型认为这份评分标准不需要修改</AlertTitle>
              <AlertDescription>可以把要求写得更具体一些，或者直接在上面的表格里手动改</AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {`共 ${preview.changes.length} 处改动。确认无误后再点「应用改动」——在那之前表格一点都没变。`}
              </p>
              <div className="flex flex-col gap-2" data-testid="rubric-adjust-changes">
                {preview.changes.map((change, index) => (
                  // 清单是一次性的静态列表（没有增删改），用下标当 key 是安全的
                  <ChangeRow key={index} change={change} />
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          {preview === null ? (
            <>
              <Button variant="outline" data-testid="rubric-adjust-cancel" onClick={handleCancel}>
                取消
              </Button>
              <Button
                data-loading={adjusting ? 'true' : undefined}
                // 空要求不发请求：一次调用是真的钱，而空指令必然只换回一次「保持原样」
                disabled={adjusting || text.trim() === ''}
                data-testid="rubric-adjust-submit"
                // 本组件不看这个 promise 的结果（失败时本来就不关窗、不清文本，原因由调用方提示），
                // 但 `.catch` 不能省：被拒绝的 promise 会变成未处理的 rejection
                onClick={() => void requestPreview().catch(() => {})}
              >
                {adjusting && (
                  <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
                )}
                生成改动
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                data-testid="rubric-adjust-back"
                onClick={() => setPreview(null)}
              >
                返回修改
              </Button>
              <Button
                // 清单为空 = 模型认为不用改：此时新表与旧表逐字节相同，没有可应用的东西
                disabled={!hasChanges}
                data-testid="rubric-adjust-apply"
                onClick={() => {
                  if (preview !== null) onApply(preview.rubric);
                }}
              >
                应用改动
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
