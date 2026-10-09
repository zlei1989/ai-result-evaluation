/**
 * VitePress 站点配置：知识库的导航与构建真源。
 *
 * 职责：定义五域导航（协议规范 / 功能说明 / 架构设计 / FAQ / 规约守卫），把三份厂商 FAQ 与
 * PowerShell / Playwright MCP 五份活文档原文编入站点（单一真源，不复制），并把冻结档案
 * （docs/superpowers/，见 GLOSSARY「冻结档案」与 ADR 0001）排除出构建——它们是提炼
 * 知识文章的临时原料，不生成页面、不进产物。站点口径为本地/内网：不含任何公网部署配置。
 *
 * 注意：nav / sidebar 只允许链向**已存在**的页面——VitePress 构建把死链当错误
 * （ignoreDeadLinks: false 是刻意的，这是构建缝的一部分）。还没有文章的域
 * （协议规范 / 功能说明 / 架构设计），nav 项锚到首页知识库地图的锚点上，
 * 待文章落地后由对应票据逐票补链。
 */
import { defineConfig } from 'vitepress';
import { SRC_EXCLUDES } from './pages.mjs';

export default defineConfig({
  // 站点标题与描述：与 GLOSSARY 的语境定义保持一致
  title: 'ai-result-evaluation 知识库',
  description: 'AI 生成代码评测平台的知识库：协议规范、功能说明、架构设计、FAQ 与规约守卫',

  // 死链即构建错误：这是「构建缝」的验收口径之一，别关
  ignoreDeadLinks: false,
  cleanUrls: true,

  // srcDir 即 docs/（root 是 docs，srcDir 相对 root）
  srcDir: '.',

  /**
   * 冻结档案排除出构建（真源在 pages.mjs 的 SRC_EXCLUDES，与 llms.txt 生成器、
   * 内容守卫共用同一份名单——漂移会在同步守卫上红）。
   */
  srcExclude: SRC_EXCLUDES,

  themeConfig: {
    // 无文章的域锚到首页地图（index.md 的标题锚点），文章落地后逐票改为真实链接
    nav: [
      { text: '协议规范', link: '/#协议规范' },
      { text: '功能说明', link: '/#功能说明' },
      { text: '架构设计', link: '/#架构设计' },
      {
        text: 'FAQ',
        items: [
          { text: 'Codex FAQ', link: '/faq/codex' },
          { text: 'Claude Code FAQ', link: '/faq/claude-code' },
          { text: 'DeepSeek Harness FAQ', link: '/faq/deepseek-harness' },
        ],
      },
      {
        text: '规约守卫',
        items: [
          { text: 'PowerShell 安全', link: '/guard/powershell' },
          { text: 'Playwright MCP', link: '/guard/playwright-mcp' },
        ],
      },
    ],
    sidebar: {
      '/': [
        {
          text: '协议规范',
          items: [
            { text: 'Provider 抽象与 run 入口', link: '/protocols/provider-run' },
            { text: '新增 SDK 接入流程', link: '/protocols/sdk-onboarding' },
            { text: '消息规范', link: '/protocols/message-spec' },
            { text: '事件流', link: '/protocols/event-stream' },
            { text: '进程生命周期', link: '/protocols/process-lifecycle' },
            { text: 'Codex 接入', link: '/protocols/codex' },
            { text: 'Claude Code 接入', link: '/protocols/claude-code' },
            { text: 'DeepSeek Harness 接入', link: '/protocols/dsh' },
            { text: '三家横向对比', link: '/protocols/comparison' },
          ],
        },
        {
          text: '功能说明',
          items: [
            { text: '功能总览', link: '/features/' },
            { text: '用例管理', link: '/features/case-management' },
            { text: '创建评测', link: '/features/run-creation' },
            { text: '修改、重跑与删除评测', link: '/features/run-edit-rerun-delete' },
            { text: '评测详情与候选行', link: '/features/run-detail' },
            { text: '行执行与日志', link: '/features/row-execution' },
            { text: '评分', link: '/features/judging' },
            { text: '设置', link: '/features/settings' },
            { text: '数据与存储', link: '/features/storage' },
          ],
        },
        {
          text: '架构设计',
          // 票 16（分层、工具链）与票 17（契约体系、界面原语）均已落地
          items: [
            { text: '仓库分层与依赖方向', link: '/architecture/layering' },
            { text: '契约体系', link: '/architecture/contracts' },
            { text: '界面原语与主题', link: '/architecture/ui-primitives-and-theme' },
            { text: '工具链与命令聚合', link: '/architecture/toolchain' },
          ],
        },
        {
          text: 'FAQ',
          items: [
            // 目录层《故障索引》：三份 FAQ 的现象条目按报错原文索引（票 05）
            { text: '故障索引', link: '/faq/' },
            { text: 'Codex FAQ', link: '/faq/codex' },
            { text: 'Claude Code FAQ', link: '/faq/claude-code' },
            { text: 'DeepSeek Harness FAQ', link: '/faq/deepseek-harness' },
          ],
        },
        {
          text: '规约守卫',
          items: [
            { text: 'PowerShell 安全', link: '/guard/powershell' },
            { text: 'Playwright MCP', link: '/guard/playwright-mcp' },
            { text: '冒烟测试方法论', link: '/guard/smoke-testing' },
            { text: '变异验证', link: '/guard/mutation-verification' },
            { text: '密钥与环境变量', link: '/guard/secrets-and-env' },
            { text: '测试策略与提速', link: '/guard/test-strategy' },
          ],
        },
      ],
    },
  },
});
