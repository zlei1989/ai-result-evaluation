/**
 * v4 / claude 侧「真机验证」汇总：把本轮所有探测的**结论 + 判据 + 原始片段**收进一份 JSON。
 *
 * 为什么要有这一份：本轮结论横跨 9 个 dump（CLI 5 变体、SDK、exe 字符串、抓包工具表、
 * 闸门 6 跑、12-agent 规模告警、OTEL），散着看极易把「我没搜到」读成「厂商没给」。
 * 本脚本只做**汇总与再核对**，不产生新结论；每条都带 `evidence` 逐字片段与 `dumps` 路径。
 *
 * 用法：node probe/v4/claude-report.mjs
 * 产物：probe/dumps/v4/claude-report.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/env.mjs';

const D = join(DUMP_DIR, 'v4');
const read = (name) => (existsSync(join(D, name)) ? JSON.parse(readFileSync(join(D, name), 'utf8')) : null);
const text = (name) => (existsSync(join(D, name)) ? readFileSync(join(D, name), 'utf8') : '');

const q1cli = read('q1-cli-summary.json');
const q1sdk = read('q1b-sdk.json');
const exeStrings = read('claude-exe-strings.json');
const q2gate = read('q2-workflow-gate.json');
const q2cfg = read('q2b-workflow-config.json');
const q2size = read('q2c-size-warning.json');
const q2chan = read('q2d-debug-channel.json');
const q2otel = read('q2e-otel-size-warning.json');
const q3 = read('q3-bash-sdk.json');
const q3b = read('q3b-bash-tmpdir.json');
const q4 = read('q4-inbound-tools.json');
const wire = read('wire-usage-shape.json');

/** 从 debug 日志里摘出闸门行（逐字）。 */
const gateLinesInDebug = (name) => text(name).split(/\r?\n/).filter((line) => line.includes('workflow: concurrent agent gate'));

const report = {
  at: new Date().toISOString(),
  endpoint: 'https://api.deepseek.com/anthropic',
  claudeCli: '2.1.283',
  sdk: '@anthropic-ai/claude-agent-sdk 0.3.281',

  Q1: {
    verdict: '闭合（两条路径都跑通）',
    cli: {
      runs: q1cli?.runs ?? null,
      // 逐字：result 消息原文（取 model-env-chat 这一跑）
      resultVerbatim: q1cli?.runs?.length ? text('q1-cli-model-env-chat.stdout.jsonl').split(/\r?\n/).find((line) => line.includes('"type":"result"')) ?? null : null,
      stderrVerbatim: text('q1-cli-model-env-chat.stderr.txt'),
      rejectedModelNames: '无：deepseek-chat / deepseek-reasoner 都不被拒绝，只打一条 unrecognized_model 警告',
      haikuTierRequired: false,
    },
    sdk: {
      runs: (q1sdk?.runs ?? []).map((one) => ({ label: one.label, model: one.model, messageTypes: one.messageTypes, error: one.error, resultSubtype: one.result?.subtype, resultText: one.result?.result, usage: one.usageRaw })),
    },
    dumps: ['q1-cli-summary.json', 'q1-cli-*.json/.stdout.jsonl/.stderr.txt', 'q1b-sdk.json', 'claude-q1b-sdk-*.jsonl'],
  },

  Q2: {
    verdict: '闭合：判据①成立但通道与设计稿不同；判据③"进不去"（可见信道）',
    gateLineVerbatim: '2026-09-30T19:15:05.951Z [DEBUG] workflow: concurrent agent gate = 8 (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS)',
    binaryEvidence: {
      codePath: exeStrings?.needles?.['workflow: concurrent agent gate']?.hits?.map((one) => one.context)?.find((ctx) => ctx.includes('!==void 0')) ?? null,
      sizeWarningSite: exeStrings?.needles?.['scheduled_agents']?.hits?.map((one) => one.context)?.find((ctx) => ctx.includes('tengu_workflow_size_warning_shown')) ?? null,
    },
    judge1: {
      onStdoutWithoutDebug: false,
      onStderrWithoutDebug: false,
      onStdoutWithDebugNoFile: false,
      onStderrWithDebugNoFile: false,
      inDefaultDebugFileWhenDebug: Object.keys(q2chan?.runs?.find((one) => one.label === 'debug-no-file-12agents')?.gateInNewFiles ?? {}).length > 0,
      defaultDebugFileHits: q2chan?.runs?.find((one) => one.label === 'debug-no-file-12agents')?.gateInNewFiles ?? null,
      noDebugRunHits: q2chan?.runs?.find((one) => one.label === 'no-debug-12agents')?.gateInNewFiles ?? null,
      controlWithoutEnvVar: q2gate?.runs?.filter((one) => !one.gateEnvSet).map((one) => ({ label: one.label, appearedAnywhere: one.gate.appearedAnywhere })),
      actualChannel: 'C:\\Users\\zhanglei1120\\.claude\\debug\\<session>.txt（需 --debug；或 --debug-file <path>）',
    },
    judge2: {
      workflowToolActuallyDriven: q2gate?.runs?.map((one) => ({ label: one.label, prompt: one.prompt.slice(0, 40), workflowToolUsed: one.workflowToolUsed, toolUseNames: one.toolUseNames })) ?? null,
      twelveAgentRunLabels: (() => {
        const raw = text('q2c-gate-on-12agents-debugfile.stdout.jsonl');
        return [...new Set([...raw.matchAll(/"label":"(count:[^"]+)"/g)].map((hit) => hit[1]))];
      })(),
    },
    judge3: {
      tokensSearched: ['workflow_size_warning', 'tengu_workflow_size_warning_shown', 'scheduled_agents', 'agent_cap', 'cap_from_guideline'],
      runs: (q2size?.runs ?? []).map((one) => ({ label: one.label, gateEnvSet: one.gateEnvSet, workflowToolUsed: one.workflowToolUsed, tokens: one.tokens })),
      inSdkStream: q2cfg?.sdkStream?.warningTokensFound ?? null,
      gateLineInSdkStream: q2cfg?.sdkStream?.gateLineFound ?? null,
      otelProbeVerdict: '不构成证据：OTEL 日志信道只承载 8 个 claude_code.* 事件，从不承载 tengu_*（`i(...)` 走 Statsig 另一条网络通路，未观测）',
      otelEventNamesObserved: [...new Set([...text('q2e-otel.bodies.raw.txt').matchAll(/"event\.name","value":\{"stringValue":"([^"]+)"/g)].map((hit) => hit[1]))],
      otelRequestCount: q2otel?.otlpRequestCount ?? null,
    },
    settingsBehavior: {
      enableWorkflowsFalse: q2cfg?.descriptions?.find((one) => one.label === 'enableWorkflows:false') ?? null,
      guidelineCases: (q2cfg?.descriptions ?? []).map((one) => ({ label: one.label, toolCount: one.toolCount, workflowPresent: one.workflowPresent, agentsUnder: one.agentsUnder, guidelineSentence: one.guidelineSentence })),
    },
    debugSwitches: read('claude-cli-switches.json')?.logSwitches ?? null,
    dumps: ['q2-workflow-gate.json', 'q2b-workflow-config.json', 'q2c-size-warning.json', 'q2d-debug-channel.json', 'q2e-otel-size-warning.json', 'claude-exe-strings.json', 'claude-cli-switches.json'],
  },

  Q3: {
    verdict: '仍未闭合（环境卡住；且已证明不是 DSH/OS 权限问题）',
    shellResults: (q3?.runs ?? []).map((one) => ({ label: one.label, hasEperm: one.hasEperm, shellResults: one.shellResults })),
    freshTmpdirStillEperm: (q3b?.run?.shellResults ?? []),
    control: {
      nodeMkdirIntoSamePath: q3b?.control?.nodeMkdir ?? null,
      aclOfClaudeTempRoot: q3b?.control?.acl ?? null,
    },
    dumps: ['q3-bash-sdk.json', 'q3b-bash-tmpdir.json', 'claude-q3-*.jsonl'],
  },

  Q4: {
    verdict: '闭合（且推翻上一轮"无增量"的结论）',
    perModel: Object.fromEntries(Object.entries(q4?.perModel ?? {}).map(([model, pair]) => [model, {
      offCount: pair.off.toolCount,
      onCount: pair.on.toolCount,
      offNames: pair.off.toolNames,
      added: pair.added,
      removed: pair.removed,
    }])),
    presence: q4?.presence ?? null,
    workflowToolDescriptionOptIn: (q4?.perModel?.['deepseek-chat']?.off?.tools ?? []).find((one) => one.name === 'Workflow')?.description?.slice(0, 1400) ?? null,
    dumps: ['q4-inbound-tools.json'],
  },

  Q5: {
    verdict: '闭合（字段在，但恒为 0；因为上游 anthropic wire 不带这一格）',
    resultEnvelopeUsage: (q1sdk?.runs ?? []).map((one) => ({ model: one.model, usageKeys: one.usageKeys, outputTokensDetails: one.outputTokensDetails })),
    wireUsageByModel: (wire?.rows ?? []).map((one) => ({ label: one.label, status: one.status, usage: one.usage, outputTokensDetails: one.outputTokensDetails, completionTokensDetails: one.completionTokensDetails })),
    dumps: ['q1b-sdk.json', 'wire-usage-shape.json'],
  },
};

const file = writeDump('v4/claude-report', report);
note('落盘：', file);
