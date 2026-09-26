/**
 * 组件测试的共享 setup：注册 jest-dom 断言 + 每个用例后清理 DOM。
 * 注意：本文件不注入 matchMedia 桩——主题模块自带「无 matchMedia 时按暗色」的兜底，
 * 测试要覆盖的正是那条兜底路径。需要模拟系统偏好的用例自己注入桩。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * `waitFor` / `findBy*` 的默认上限从 **1s** 提到 **10s**。
 *
 * 为什么必须提：默认那 1 秒是本仓全量并发下最容易制造**假红**的一处——jsdom 里 antd 组件树
 * （`Select` 的占位、`Form` 的校验文案）在机器被进程创建拖满时要几秒才落定。
 * 实测 `run-create-panel.test.tsx` 的两条用例独占跑全绿、与其他文件同跑就在
 * `waitFor(() => getByText('请选择模型'))` 上红——错误信息是「找不到文本」，指向的是渲染时机而不是断言。
 * 提上限**不放松任何断言**：等不到照旧失败，只是不再把「机器慢」判成「组件错」。
 */
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
});
