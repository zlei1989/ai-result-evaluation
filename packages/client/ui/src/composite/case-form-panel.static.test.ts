// @vitest-environment node
/**
 * CaseFormPanel「包含步骤」开关的**源码形态**守卫（静态扫描：本目录既有手法，见
 * `agent-log/block-renderer-registry.test.ts`）。
 *
 * 为什么 `valuePropName` 这条要靠源码扫描而不是行为测试：antd 6 的 Switch 自 5.12 起
 * `value` 是 `checked` 的官方别名，去掉 valuePropName 后 Form.Item 注入的 `value` 照样能控制
 * 开关、onChange 首参仍是布尔，提交值一个字节都不变——行为测试全部照常绿。
 * 但官方口径（antd Switch 的 Form.Item 绑定 FAQ）是显式写 `valuePropName="checked"`，
 * 依赖别名等于把「开关还能不能用」押在 antd 的一处兼容行为上，未来版本别名一收紧就是静默断绑。
 * 所以这条守卫直接钉源码形态。
 *
 * 第二条钉的是「提交必须透传表单值」：写成常量（`includeSteps: false`）类型照样绿，
 * 症状是开关在界面上照常拨动、保存后却永远落 false。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(import.meta.dirname, 'case-form-panel.tsx'), 'utf8');

describe('CaseFormPanel「包含步骤」的源码形态', () => {
  it('includeSteps 的 Form.Item 显式写 valuePropName="checked"', () => {
    // 两处必须落在**同一个 JSX 标签**里：中间不许出现 `>`，写散到别的 Form.Item 上不算数
    expect(source, 'includeSteps 的 Form.Item 少了 valuePropName="checked"').toMatch(
      /name="includeSteps"[^>]*valuePropName="checked"/,
    );
  });

  it('handleFinish 透传表单值，不许把 includeSteps 写成常量', () => {
    expect(source, '提交里必须用 values.includeSteps 而不是常量').toMatch(/includeSteps: values\.includeSteps/);
  });
});
