# 事故记录：Next dev 被自己的「代码框高亮」panic 打崩（2026-09-29 凌晨）

> 结论先写：**不是本仓的代码错误**，是 Next.js 内部 Rust 组件在上游未修的 bug 上 abort 了进程。
> 本仓能做的是「认得出它、重启恢复、盯住上游 PR」；本文只记实测到的东西。

## 1. 症状（`.dev-server-5.log` 原文）

```
✓ Compiled in 1188ms

thread '<unnamed>' (87756) panicked at crates\next-code-frame\src\highlight.rs:10
11:45:
end byte index 93 is not a char boundary; it is inside '什' (bytes 91..94) of `/**
 解析失败时随错误一起保留的原文上限（字符）：够看清模型回了什么，又不至于把事件日志撑爆 */`
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @aieval/web-next@0.0.0 dev: `next dev -p 3083`
Exit status 3221226505
```

- 退出码 `3221226505`（= `0xC0000409`，Windows fail-fast；PowerShell 里显示成 `-1073740791`）——
  **不是**普通非零退出，是被 abort 掉了。
- 崩之前日志里**没有任何 error/warning 诊断行**，只有一串 `✓ Compiled in`（HMR 重编译）：
  panic 发生在「准备渲染代码框」的那一刻，不是渲染完之后。
- 被引用的那一行是 `packages/server/evaluator/src/judge.ts:46` 的中文注释
  （`apps/web-next` 的 API 路由会 import `@aieval/evaluator`，所以它在 Next 的模块图里）。

## 2. 根因（上游已定位，**修复未合并**）

Next 的 `next-code-frame` 把**显示列宽**当**字节偏移**算可见窗口，窗口末端落在多字节字符中间时，
高亮 span 的 end 就不是 char boundary，随后 `&visible_content[start..end]` 直接 panic；
`#[napi]` 绑定没有 `catch_unwind`，于是进程级 abort。

- 上游 issue：#92641；两个修复 PR **都还开着、都没合**：
  [vercel/next.js#92646](https://github.com/vercel/next.js/pull/92646)（2026-04-11 起）、
  [vercel/next.js#96805](https://github.com/vercel/next.js/pull/96805)（draft）。
- 上游自述两条要点：崩溃**取决于终端宽度**（同一个源文件可能触发也可能不触发，所以它不是每次必现）；
  另一个可达入口是 dev-only 的 `POST /__nextjs_original-stack-frames`。
- 本机版本：`next@16.2.7`（Turbopack）。**升级目前解决不了**——修复还没进任何 release。

## 3. 处置与恢复（实测）

1. 重启 `pnpm dev`（本仓 :3083）。
2. 重启后日志出现：`⚠ Turbopack's filesystem cache has been deleted because we previously detected
   an internal error in Turbopack.` ⇒ 上次那份 FS 缓存被判废，**首次编译会明显变慢**
   （实测 `/runs` 冷编译 36.8s，之后各页恢复正常）。
3. 恢复判据（都实测过）：`:3083` 有监听、`/api/settings` 200、`/api/runs` 200、`/runs` 200，
   浏览器里运行列表 7 条、状态列（已完成 / 部分完成）、导航与「创建评测」按钮都在，
   控制台只剩一条无害的 `favicon.ico 404`。

## 4. 还能做什么

- 再遇到同一签名（`panicked at crates\next-code-frame`）⇒ **直接重启**，不要去改产品代码；
- 兜底选项：`next dev --webpack`（本机 `next dev --help` 里确有该 flag，Next 16.2.7）。
  **未验证**它是否会绕开这个 panic（不 panic 的前提是 webpack 通路不用这个 Rust 代码框）——
  真出现第二次再试，并把结果补进本文；
- 上游两个 PR 合并进 release 后升级 Next，是本问题的唯一根治。
