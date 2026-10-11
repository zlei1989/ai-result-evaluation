/**
 * v9 探针：**差分复放**——CLI 抓下来的主请求体原样打给网关，只改一处：技能清单所在那条消息的 `role`。
 *
 * 为什么需要它：`claude-skill-mount-capture.mjs` 已证「清单确实进了请求体、`Skill` 工具也在 tools 里」，
 * 于是「模型为什么不主动读 skill」只剩两种解释：
 *   ① 模型看到了清单但**不肯调 `Skill`**（模型行为）；② 清单**到不了模型**（网关/翻译层把它丢了）。
 * 这两件事在 CLI 那一侧看不出来——必须由**同一个请求体、同一个模型、只差一个 `role`** 的对照回答。
 *
 * 机制线索：CC 2.1.281 把那一大坨 `<system-reminder>`（含技能清单）放在 `messages[]` 里一条
 * **`role: "system"`** 的消息上，而 Anthropic 的 Messages API 只定义 `user` / `assistant`。
 * 走第三方模型的网关要把这条输入翻译成上游 chat 模板 —— 翻译层怎么处置这个野生 role，就是本探针要量的。
 *
 * 五臂（内容逐字相同，只动「清单落在哪个 role」与「问不问」）：
 *   A1 原样（role=system）+ 原提示词      ⇒ 模型会不会**主动**调 Skill
 *   A2 role 改成 user  + 原提示词         ⇒ 同上，只差 role
 *   A3 删掉那条消息（对照）               ⇒ 清单缺席时会不会调（应为否）
 *   A4 原样 + 追加「列出本次会话允许你用的技能名」⇒ 直接问**看得见吗**
 *   A5 role=user + 同一追问              ⇒ 同上，只差 role
 *
 * 用法（在仓库根；先跑 capture 生成 dumps/v9/A-adapter.json）：
 * ```
 * node packages/server/agents/probe/v9/replay-role-differential.mjs [--runs=1]
 * ```
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DUMP = join(HERE, '..', 'dumps', 'v9', 'A-adapter.json');
const OUT = join(HERE, '..', 'dumps', 'v9', 'replay-role-differential.json');

/** 那一条「大 system-reminder」在抓包里的位置（`messages[1]`，见 capture 探针的落盘） */
const REMINDER_INDEX = 1;

const RUNS = Number((process.argv.find((one) => one.startsWith('--runs=')) ?? '--runs=1').slice('--runs='.length));
/** 模型覆盖：判据是「换一个模型同样成立」，故要能带着 `--model=` 重跑 */
const MODEL = process.argv.find((one) => one.startsWith('--model='))?.slice('--model='.length);

/** 追问臂的追加问题：只要名字，逼模型交出一份可核对的清单 */
const ASK_NAMES = '本次会话里，系统告诉过你哪些可用的技能（skill）？只逐行它们的名字，不要解释';

/**
 * 令牌臂：判定「整条 `role:"system"` 消息被丢」还是「只丢了技能那一段」。
 * 令牌拼在**那条消息自己的正文末尾**——它若回不出来，说明这一格整体没到模型。
 */
const TOKEN = 'PROBE-TOKEN-9d1f';
const ASK_TOKEN = `请逐字复述你在本次会话里看到的、以 PROBE-TOKEN 开头的那串令牌。如果没看到，只回答两个字：没看到。`;

function hostRoute() {
  const config = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8'));
  const provider = (config.providers ?? []).find((one) => one.protocolType === 'anthropic');
  if (provider?.baseUrl === undefined || provider.apiKey === undefined) throw new Error('宿主配置里没有 anthropic 供应商');
  return { baseUrl: provider.baseUrl.replace(/\/+$/, ''), apiKey: provider.apiKey };
}

/** SSE 原文 → 我们关心的三样：调了哪些工具、文本增量拼出的正文、stop_reason */
function parseSse(text) {
  const toolUses = [];
  let currentTool = null;
  const jsonBuffers = new Map();
  let outText = '';
  let stopReason = null;
  let error = null;
  /**
   * 入站 token 数：**判别丢弃发生在哪一跳**的关键量。
   * 网关若把那条 `role:"system"` 转发出去，它一定被计进 `input_tokens`；
   * 若「带它」与「删掉它」的入站 token 数一样，说明它在网关自己那一层就被丢了。
   */
  let inputTokens = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let event = null;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      currentTool = { name: event.content_block.name, partial: '' };
      toolUses.push(currentTool);
      jsonBuffers.set(event.index, currentTool);
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta') outText += delta.text ?? '';
      if (delta.type === 'input_json_delta') {
        const target = jsonBuffers.get(event.index);
        if (target !== undefined) target.partial += delta.partial_json ?? '';
      }
    }
    if (event.type === 'message_start' && event.message?.usage?.input_tokens !== undefined) {
      inputTokens = event.message.usage.input_tokens;
    }
    if (event.type === 'message_delta' && event.delta?.stop_reason !== undefined) stopReason = event.delta.stop_reason;
    if (event.type === 'error') error = JSON.stringify(event.error ?? event).slice(0, 300);
  }
  void currentTool;
  /**
   * 兜底：这一家的 `message_start` 里三项恒为 0，真读数在**后面的 `message_delta`** ⇒
   * 取原文里所有 `input_tokens` 的**最大值**（不是第一个，第一个必然是那个 0）。
   */
  const maxOf = (key) => {
    const hits = [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, 'g'))].map((one) => Number(one[1]));
    return hits.length === 0 ? null : Math.max(...hits);
  };
  const inputTotal = maxOf('input_tokens');
  const cacheRead = maxOf('cache_read_input_tokens');
  return { toolUses, outText, stopReason, error, inputTokens: inputTotal, cacheRead };
}

async function replay({ label, route, mutate, runs }) {
  const results = [];
  for (let round = 1; round <= runs; round += 1) {
    const body = JSON.parse(readFileSync(DUMP, 'utf8'));
    if (MODEL !== undefined) body.model = MODEL;
    mutate(body);
    const response = await fetch(`${route.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': route.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = parseSse(text);
    const row = {
      label,
      round,
      status: response.status,
      stopReason: parsed.stopReason,
      toolNames: parsed.toolUses.map((one) => one.name),
      skillCalls: parsed.toolUses.filter((one) => one.name === 'Skill').map((one) => one.partial.slice(0, 200)),
      mentionsOurSkill: parsed.outText.includes('tang-poem-meal'),
      mentionsToken: parsed.outText.includes(TOKEN),
      inputTokens: parsed.inputTokens,
      cacheRead: parsed.cacheRead,
      textHead: parsed.outText.slice(0, 320),
      error: parsed.error ?? (response.status === 200 ? null : text.slice(0, 300)),
    };
    results.push(row);
    console.log(
      `[${label} #${round}] HTTP ${row.status} stop=${row.stopReason ?? '—'} 入站token=${row.inputTokens ?? '—'} 缓存读=${row.cacheRead ?? '—'} 工具=${JSON.stringify(row.toolNames)} ` +
        `Skill调用=${row.skillCalls.length} 正文提到我们的skill=${row.mentionsOurSkill} 错误=${row.error ?? '—'}`,
    );
    console.log(`    正文头：${JSON.stringify(row.textHead)}`);
    if (row.skillCalls.length > 0) console.log(`    Skill 入参：${JSON.stringify(row.skillCalls)}`);
  }
  return results;
}

async function main() {
  const route = hostRoute();
  const base = JSON.parse(readFileSync(DUMP, 'utf8'));
  console.log(`复放抓包：${DUMP}`);
  console.log(`模型：${MODEL ?? base.model}（抓包内为 ${base.model}）请求体 ${JSON.stringify(base).length} 字节 清单所在条：messages[${REMINDER_INDEX}].role=${base.messages[REMINDER_INDEX]?.role}`);
  console.log(`轮数/臂：${RUNS}\n`);

  const arms = [
    {
      label: 'A1-原样(system)',
      mutate: (body) => {},
    },
    {
      label: 'A2-role改user',
      mutate: (body) => {
        body.messages[REMINDER_INDEX].role = 'user';
      },
    },
    {
      label: 'A3-删掉清单条',
      mutate: (body) => {
        body.messages.splice(REMINDER_INDEX, 1);
      },
    },
    {
      label: 'A4-原样+追问名字',
      mutate: (body) => {
        body.messages.push({ role: 'user', content: [{ type: 'text', text: ASK_NAMES }] });
      },
    },
    {
      label: 'A5-user+追问名字',
      mutate: (body) => {
        body.messages[REMINDER_INDEX].role = 'user';
        body.messages.push({ role: 'user', content: [{ type: 'text', text: ASK_NAMES }] });
      },
    },
    {
      label: 'A6-令牌(system)',
      mutate: (body) => {
        body.messages[REMINDER_INDEX].content[0].text += `\n\n${TOKEN}`;
        body.messages.push({ role: 'user', content: [{ type: 'text', text: ASK_TOKEN }] });
      },
    },
    {
      label: 'A7-令牌(user)',
      mutate: (body) => {
        body.messages[REMINDER_INDEX].content[0].text += `\n\n${TOKEN}`;
        body.messages[REMINDER_INDEX].role = 'user';
        body.messages.push({ role: 'user', content: [{ type: 'text', text: ASK_TOKEN }] });
      },
    },
  ];

  const all = [];
  for (const arm of arms) {
    all.push(...(await replay({ label: arm.label, route, mutate: arm.mutate, runs: RUNS })));
    console.log('');
  }

  console.log('=== 判定表 ===');
  for (const row of all) {
    console.log(
      `${row.label.padEnd(18)} #${row.round}  Skill调用=${row.skillCalls.length}  正文提到skill名=${row.mentionsOurSkill}`,
    );
  }
  writeFileSync(OUT, JSON.stringify({ dump: DUMP, runs: RUNS, rows: all }, null, 2), 'utf8');
  console.log(`\n原文落盘：${OUT}`);
}

await main();
