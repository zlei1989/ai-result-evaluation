'use client';

/**
 * 全局命令面板（⌘K / Ctrl-K）：模糊搜索后跳转到用例、评测或导航项。
 *
 * 纯 props 驱动——ui 包不调接口、不依赖路由：条目由调用方按业务分组喂进来，选中后把条目交给
 * `onSelect`，跳不跳、跳哪由应用层决定。导航项也因此只有一份真源（应用侧从 `NAV_ITEMS` 派生出
 * 本面板的分组）：面板是同一批条目的另一个入口，不是第二份清单。
 *
 * 三条键盘不变量（都在这里，应用侧不必各自记得）：
 *   1. **唤起用捕获阶段**的全局 `keydown`：焦点在 textarea / input 里时，冒泡阶段的监听可能被
 *      输入控件自己的按键处理吃掉；捕获先到，⌘K 在哪儿按都算数。
 *   2. **Esc 关闭**并把焦点还给唤起前的元素：命令面板是一次「借焦点」的操作，关闭后必须回到原处，
 *      否则从长表单里唤起一次就丢了输入位置。
 *   3. `↑↓` 选、`Enter` 执行由 `cmdk` 的选中态负责，本组件只接 `CommandItem` 的 `onSelect`。
 *
 * 数据侧的**门**在 `GatedCommandPalette`：列表分组要读接口，而面板是全站挂着的——不设门的话
 * 每一个路由进来都会为「可能会按 ⌘K」预取一遍列表。门只认一件事：**第一次打开过之后**才挂载
 * 列表来源，收起状态下一次都不调用；导航项走 `staticGroups`，因此唤起的那一刻就在，不等网络。
 */
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../components/ui/command';

/**
 * 打开命令面板的**唯一事件名**。
 *
 * 面板挂在应用根（`Providers`），顶栏在页面里——两层没有父子关系，不能靠 props 传回调。
 * 于是用一条 window 事件把「可见入口」接到面板自己的开关上（面板监听、注册表里没有第二份 open 状态）。
 * 顶栏按钮与 ⌘K 走的是同一条路。
 */
export const COMMAND_PALETTE_OPEN_EVENT = 'aieval:open-command-palette';

/** 从任意位置请求打开面板（顶栏的搜索按钮用它） */
export function requestCommandPalette(): void {
  window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
}

/** 面板里的一条可跳转项；`hint` 是次要说明（仓库、状态等），也参与模糊匹配 */
export interface CommandPaletteEntry {
  /** 稳定标识：`cmdk` 的条目 id 与 React key 都用它 */
  id: string;
  label: string;
  href: string;
  hint?: string;
}

/** 一组条目（一次操作范围一个分组，如「导航」「用例」「评测」） */
export interface CommandPaletteGroup {
  heading: string;
  items: CommandPaletteEntry[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: CommandPaletteGroup[];
  onSelect: (entry: CommandPaletteEntry) => void;
  placeholder?: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  onSelect,
  placeholder = '搜索用例、评测或导航…',
}: CommandPaletteProps): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);

  // 唤起后焦点直接落在输入框：接着就能打字，不必再点一下。
  // 本 effect 在子组件（浮层）的 effect 之后跑，所以浮层自己的聚焦不会把它盖掉。
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // 捕获阶段收 ⌘K / Ctrl-K：焦点在 textarea 里时冒泡监听会被输入控件的按键处理吃掉
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        // 浏览器里 Ctrl-K 在部分输入控件上是「删到行尾」，不拦就会被连带执行
        event.preventDefault();
        onOpenChange(true);
      }
    };
    // 可见入口（顶栏那个「搜索」按钮）走同一条事件：面板的开关状态只在这里，别处不开第二份
    const handleRequest = (): void => onOpenChange(true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handleRequest);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handleRequest);
    };
  }, [onOpenChange]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="命令面板"
      description="搜索并跳转到用例、评测或导航项"
      // 面板里一次列 20+ 条（导航 + 用例 + 评测）：vendored 默认的 `sm:max-w-sm`（384px）
      // 在长标题上会折成两行，给到 560px 才够一眼扫完。任意值写在应用侧，不动原语默认档。
      className="sm:max-w-[560px]"
    >
      <Command>
        <CommandInput ref={inputRef} placeholder={placeholder} />
        <CommandList>
          <CommandEmpty>没有匹配项</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.id}
                  // `value` 决定模糊匹配的文本：`hint` 里的仓库名 / 状态也要能被搜到
                  value={item.hint === undefined ? item.label : `${item.label} ${item.hint}`}
                  onSelect={() => {
                    onOpenChange(false);
                    onSelect(item);
                  }}
                >
                  <span className="truncate">{item.label}</span>
                  {item.hint === undefined ? null : <CommandShortcut>{item.hint}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}


/** 带「数据门」的面板：收起状态下不读列表，第一次打开之后保持挂载（再次唤起命中缓存） */
export interface GatedCommandPaletteProps {
  /** 不依赖网络的分组（如导航项）：唤起的那一刻就渲染，首屏不被数据卡住 */
  staticGroups: CommandPaletteGroup[];
  /**
   * 列表分组的来源，**hook 形态**：只有面板第一次打开过之后，本组件才会把它挂进树里调用。
   * 收成 hook 而不是现成数组，是因为「调不调用」本身就是门——调用方在外面先调了，
   * 请求就已经发出去了，这里再 gate 也来不及。
   */
  useListGroups: () => CommandPaletteGroup[];
  onSelect: (entry: CommandPaletteEntry) => void;
  placeholder?: string;
}

export function GatedCommandPalette({
  staticGroups,
  useListGroups,
  onSelect,
  placeholder,
}: GatedCommandPaletteProps): ReactNode {
  const [open, setOpen] = useState(false);
  /** 一旦打开过就保持真：列表探针保持挂载，关掉再唤起时直接用缓存，不重发请求 */
  const [everOpened, setEverOpened] = useState(false);
  const [listGroups, setListGroups] = useState<CommandPaletteGroup[]>([]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) setEverOpened(true);
    setOpen(next);
  }, []);

  // 空分组（列表还没读回来 / 一条都没有）不渲染：面板里只剩导航，不留空标题
  const groups = useMemo(
    () => [...staticGroups, ...listGroups.filter((group) => group.items.length > 0)],
    [staticGroups, listGroups],
  );

  return (
    <>
      <CommandPalette
        open={open}
        onOpenChange={handleOpenChange}
        groups={groups}
        onSelect={onSelect}
        placeholder={placeholder}
      />
      {/* 只在第一次打开之后才挂：收起状态下这一行不产生任何 hook 调用，也就没有请求 */}
      {everOpened ? <ListGroupsProbe useListGroups={useListGroups} onChange={setListGroups} /> : null}
    </>
  );
}

/**
 * 列表分组的探针：调调用方给的 hook，把结果回灌给上面那层面板。
 * 它只在 `everOpened` 之后被挂载——门就落在这里，别把它移进 `GatedCommandPalette` 本体
 * （在那里调 hook 就得无条件调用，门会失效）。
 */
function ListGroupsProbe({
  useListGroups,
  onChange,
}: {
  useListGroups: () => CommandPaletteGroup[];
  onChange: (groups: CommandPaletteGroup[]) => void;
}): null {
  const groups = useListGroups();
  // 列表读回来（或之后变化）时同步给面板；`onChange` 是 setState，引用稳定，不会自激
  useEffect(() => {
    onChange(groups);
  }, [groups, onChange]);
  return null;
}
