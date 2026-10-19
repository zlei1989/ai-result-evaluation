// @vitest-environment node
/**
 * CaseFormPanel「包含步骤」开关的**源码形态**守卫（静态扫描：本目录既有手法，见
 * `agent-log/block-renderer-registry.test.ts`）。
 *
 * 为什么开关的绑定要靠源码扫描：`Controller` 里把 `checked={field.value}` 写成 `checked={false}`
 * **类型都过**（两边都是 boolean），而症状是「开关在界面上照常拨动、保存后却永远落 false」——
 * 只有行为用例里那个 `aria-checked` 断言会红，而它挂在另一条渲染路径上，覆盖不到「只改了一处」的写法。
 * 所以这条守卫直接钉源码形态，且值 / 事件两处必须落在**同一个 JSX 标签**里（中间不许出现 `>`，
 * 写散到别的控件上不算数）。Base UI 的开关用 `onCheckedChange` 而不是原生 `onChange`。
 *
 * 第二条钉的是「提交必须透传表单值」：归一在 schema 的 transform 里完成，
 * 写成常量（`includeSteps: false`）类型照样绿，症状就是「界面拨了、落盘永远 false」。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = import.meta.dirname;
const source = readFileSync(join(HERE, 'case-form-panel.tsx'), 'utf8');
const schemaSource = readFileSync(join(HERE, 'case-form-schema.ts'), 'utf8');

describe('CaseFormPanel「包含步骤」的源码形态', () => {
  it('Switch 同一个标签里显式绑定 checked={field.value} 与 onCheckedChange', () => {
    // 两处必须落在**同一个 JSX 标签**里：中间不许出现 `>`，写散到别的控件上不算数
    expect(source, 'includeSteps 的 Switch 少了 checked={field.value} + onCheckedChange').toMatch(
      /<Switch[^>]*checked=\{field\.value\}[^>]*onCheckedChange=\{\(checked\) => field\.onChange\(checked\)\}/,
    );
  });

  it('提交归一透传表单值，不许把 includeSteps 写成常量', () => {
    expect(schemaSource, '提交里必须用 values.includeSteps 而不是常量').toMatch(
      /includeSteps: values\.includeSteps/,
    );
  });
});
