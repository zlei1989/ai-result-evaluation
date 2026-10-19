'use client';

/**
 * `/dev/ui-probe` 的四格探针：两档明暗 × 两档密度，每格摆一组 vendored 原语与五块语义色板。
 *
 * 它只做展示，不设任何页面状态：本仓的明暗真源是 `html[data-theme]`（`globals.css` 里
 * `:root` / `html[data-theme='dark']` 两组变量），四格的颜色因此全走语义工具类、随根属性
 * 一起变。格上的 `data-theme` 是**档位标注**而不是主题覆盖——格内不再复制一份变量，
 * 因此件一律用**不带 `dark:` 变体**的默认 / 次要款式：否则格上的属性会顺手激活 `dark:`，
 * 同一格里变成「底色跟随根、边框已按格变暗」的半套效果，量到的就不是根上那套真源了。
 *
 * 密度同理：`data-density` 只挂属性，紧凑 / 默认的字号与间距由密度作用域变量供给。
 * 本组件不写死字号与行内边距；变量还没到位时四格只是「看起来一样」，DOM 契约仍可断言。
 *
 * 为什么不引旧组件库：这一页验收的是新栈（Tailwind + vendored 原语），掺进它的 token
 * 就分不清颜色到底是哪一层给的。
 */
import type { ReactNode } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Separator } from '../components/ui/separator';

type ProbeTheme = 'light' | 'dark';
type ProbeDensity = 'compact' | 'default';

interface ProbeCell {
  theme: ProbeTheme;
  density: ProbeDensity;
}

/** 四格的档位组合：先按明暗分两组，组内先紧凑后默认（与页面的阅读顺序一致） */
const CELLS: readonly ProbeCell[] = [
  { theme: 'light', density: 'compact' },
  { theme: 'light', density: 'default' },
  { theme: 'dark', density: 'compact' },
  { theme: 'dark', density: 'default' },
];

/**
 * 五块色板：每块只加**一条**待验的语义工具类，失败时能直接看出是哪条变量没接上。
 * `foreground` / `muted-foreground` 这两块是文字色，额外给底色才看得见；
 * `border` 那一块给两道边框，一像素在浅色底上不够看。
 */
const SWATCHES: ReadonlyArray<{ slot: string; label: string; className: string; base: string }> = [
  { slot: 'background', label: 'bg-background', className: 'bg-background', base: 'border border-border' },
  { slot: 'foreground', label: 'text-foreground', className: 'text-foreground', base: 'border border-border bg-background' },
  { slot: 'border', label: 'border-border', className: 'border-border', base: 'border-2 bg-background' },
  { slot: 'primary', label: 'bg-primary', className: 'bg-primary', base: 'text-primary-foreground' },
  { slot: 'muted-foreground', label: 'text-muted-foreground', className: 'text-muted-foreground', base: 'border border-border bg-background' },
];

/** 一格里的色板条：五块排成一行，标签写的就是那块要验的类名，便于对着脚本的输出读 */
function Palette(): ReactNode {
  return (
    <div className="flex flex-wrap gap-2" data-palette="">
      {SWATCHES.map(({ slot, label, className, base }) => (
        <div key={slot} className="flex min-w-0 flex-col gap-1">
          <div
            data-swatch={slot}
            className={`flex h-8 w-24 items-center justify-center rounded-md text-xs ${base} ${className}`}
          >
            {slot === 'background' || slot === 'border' ? null : 'Aa'}
          </div>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** 四个件的展示面：按钮与徽标各两个变体，卡片走完整分段，分隔线单独一条 */
function Primitives(): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button>主按钮</Button>
        <Button variant="secondary">次要按钮</Button>
        <Badge>徽标</Badge>
        <Badge variant="outline">描边徽标</Badge>
      </div>
      <Separator />
      <Card size="sm">
        <CardHeader>
          <CardTitle>卡片标题</CardTitle>
          <CardDescription>次要说明文字（muted-foreground）</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm">正文一段，验证 card / card-foreground 两个变量。</p>
        </CardContent>
        <CardFooter>
          <Badge variant="secondary">脚注徽标</Badge>
        </CardFooter>
      </Card>
    </div>
  );
}

/**
 * 四格矩阵。每格都带 `data-theme` / `data-density`，脚本与真机冒烟按这两个属性定位；
 * `data-probe-cell` 是「这一格是探针格」的唯一标记，别用 Tailwind 类名当选择器。
 */
export function UiProbeGrid(): ReactNode {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
      {CELLS.map(({ theme, density }) => (
        <section
          key={`${theme}-${density}`}
          data-probe-cell=""
          data-theme={theme}
          data-density={density}
          aria-label={`${theme} / ${density}`}
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-background p-4 text-foreground"
        >
          <header className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">明暗：{theme}</span>
            <Badge variant="outline">密度：{density}</Badge>
          </header>
          <Palette />
          <Primitives />
        </section>
      ))}
    </div>
  );
}
