#!/usr/bin/env node
/**
 * 判据层（`criteria.mjs`）的**零成本自检**：不调模型、不落读数，只把判定表逐条钉一遍。
 *
 * 为什么值得单起一支：`gateOf` 的判定表是本目录的全部结论口径——「投影成立而答复落空**不算**不支持」、
 * 「阴性对照泄漏 ⇒ 结论作废」、「跑不起来 ⇒ inconclusive / not-runnable 而不是 unsupported」这几条
 * 全靠它。这一支把六档判定与暗号命中（含**空暗号必须恒不命中**那一格）做成断言，
 * 改坏任何一条都会以非 0 退出码当场见红，不必再去烧一次真机额度。
 *
 * 用法：`node packages/server/agents/probe/v11/resume-readback/criteria.selfcheck.mjs`
 * 退出码：`0` = 全部成立；`2` = 有断言不成立（会逐条打印期望与实际）。
 */
import { GATE, gateOf, hitOf } from './criteria.mjs';

/** 造一条判据读数（`ok` 三态：true / false / null=读不出）。 */
const reading = (ok) => ({ ok, detail: '', evidence: [] });

/** 造一面（投影 + 答复 [+ 跑不起来的原因]）。 */
const side = (projection, reply, notRun = null) => ({ projection: reading(projection), reply: reading(reply), notRun });

/** 判定表的断言表：输入 → 期望档。 */
const GATE_CASES = [
  ['正面两条都成立 + 阴性对照干净', { resume: side(true, true), control: side(false, false), broken: [] }, GATE.SUPPORTED],
  ['投影成立、答复落空（单次答不出）', { resume: side(true, false), control: side(false, false), broken: [] }, GATE.MODEL_FLAKED],
  ['投影为否（机制没接上）', { resume: side(false, false), control: side(false, false), broken: [] }, GATE.UNSUPPORTED],
  ['答对但厂商侧投影查不到（无法归因）', { resume: side(false, true), control: side(false, false), broken: [] }, GATE.INCONCLUSIVE],
  ['阴性对照答出了暗号（泄漏）', { resume: side(true, true), control: side(false, true), broken: [] }, GATE.LEAKED],
  ['阴性对照的投影里带了暗号（泄漏）', { resume: side(true, true), control: side(true, false), broken: [] }, GATE.LEAKED],
  ['载体进程没跑起来（跑不起来 ≠ 不支持）', { resume: side(null, null), control: side(null, null), broken: ['cc：read 退出码 2'] }, GATE.INCONCLUSIVE],
  ['正面显式跑不起来（版本门）', { resume: side(null, null, '本仓 pin 的 wire 上没有 session/resume'), control: side(false, false), broken: [] }, GATE.NOT_RUNNABLE],
];

/** 命中判定的断言表：「厂商侧投影 / 模型答复里有没有暗号」这一件事只允许一种读法。 */
const HIT_CASES = [
  ['逐字命中', '暗号是 AIEVAL-ABCD1234 。', 'AIEVAL-ABCD1234', { ok: true, mode: 'exact' }],
  ['大小写与分隔符不同也算命中', 'aieval abcd1234', 'AIEVAL-ABCD1234', { ok: true, mode: 'loose' }],
  ['没答出', '不知道', 'AIEVAL-ABCD1234', { ok: false, mode: 'none' }],
  ['空暗号必须恒不命中（空串是任何字符串的子串）', '任意文本', '', { ok: false, mode: 'none' }],
];

let failures = 0;

for (const [name, input, want] of GATE_CASES) {
  const got = gateOf(input).gate;
  if (got === want) {
    console.log(`✅ 判定 ${name} ⇒ ${got}`);
  } else {
    failures += 1;
    console.log(`❌ 判定 ${name} ⇒ ${got}（期望 ${want}）`);
  }
}

for (const [name, text, nonce, want] of HIT_CASES) {
  const got = hitOf(text, nonce);
  if (got.ok === want.ok && got.mode === want.mode) {
    console.log(`✅ 命中 ${name} ⇒ ${JSON.stringify(got)}`);
  } else {
    failures += 1;
    console.log(`❌ 命中 ${name} ⇒ ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
  }
}

if (failures > 0) {
  console.log(`\n⚠️ ${failures} 条断言不成立 ⇒ 判据层的口径被改动了，退出码 2`);
  process.exitCode = 2;
} else {
  console.log(`\n判据层自检全过：${GATE_CASES.length} 条判定 + ${HIT_CASES.length} 条命中（零模型成本）`);
}
