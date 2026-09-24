/**
 * 组件测试的共享 setup：注册 jest-dom 断言 + 每个用例后清理 DOM。
 * 注意：本文件不注入 matchMedia 桩——主题模块自带「无 matchMedia 时按暗色」的兜底，
 * 测试要覆盖的正是那条兜底路径。需要模拟系统偏好的用例自己注入桩。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
