/**
 * 组件测试的共享 setup：注册 jest-dom 断言 + 每个用例后清理 DOM。
 * 注意：这里不注入 matchMedia 桩——主题模块自带「无 matchMedia 时按暗色」的兜底，
 * 测试要覆盖的正是那条兜底路径。需要模拟系统偏好的用例自己注入桩。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * `waitFor` / `findBy*` 的默认上限从 **1s** 提到 **10s**（理由与 ui 包的同名文件一致）：
 * 默认那 1 秒在全量并发下会把「机器慢」判成「渲染错」，制造假红。提上限不放松任何断言。
 */
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
});
