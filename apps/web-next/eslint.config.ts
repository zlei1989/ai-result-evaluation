import { withBoundary } from '../../eslint.shared';

export default [
  ...withBoundary('web-next'),
  // next dev / next build 生成的类型声明：内容是双引号的三斜线引用与指向 .next/ 的相对 import，
  // 既不由本仓维护（文件头自述「should not be edited」）也已被 gitignore，故不纳入 lint。
  { ignores: ['next-env.d.ts'] },
];
