/**
 * v12 探针共用：**真包装配、零模型调用**的那一半事实。
 *
 * 为什么单独一份：本批探针要回答的问题（装载器把哪几条技能交出去、`filePath` 长什么样、
 * 扩展表里有什么、会话文件落在哪）**全部发生在发出第一个请求之前**。它们不需要网关、
 * 不需要凭据，因此读数不受模型抖动影响——「模型没照做」与「装配面就是错的」在噪声上完全两类。
 *
 * 三条硬口径：
 *   · **不写真实家目录**：`PI_CODING_AGENT_DIR` 一律指到本次探针的临时目录（子智能体扩展与
 *     SDK 的进程级全局路径只认它，`createAgentSession({ agentDir })` 管不到）；
 *   · **仓内源码优先**：能 import 适配器就 import 适配器（判据落在生产代码上），
 *     不能 import 的那几格再退回「与适配器逐字同形的窄装配」；
 *   · **读数原样落盘**：`probe/dumps/v12/*.json`，路径里的临时根做一次短标记替换，
 *     但**不做美化**——读数是要拿去对代码的，不是给人读的故事。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DUMP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dumps', 'v12');
export const SDK = '@earendil-works/pi-coding-agent';
export const AI = '@earendil-works/pi-ai';

/** 统一进度前缀 */
export function note(...parts) {
  console.log('[v12]', ...parts);
}

/** 造一棵临时根（`mkdtempSync`——不手写递归删除，规则见 docs/guard/powershell.md 的精神） */
export function makeRoot(prefix = 'pi-v12-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 把 `PI_CODING_AGENT_DIR` 指到临时目录并返回还原函数。
 *
 * 为什么必须：子智能体扩展与 SDK 的进程级全局路径**只认这个变量**（或真实 `~/.pi/agent`），
 * 装载器的 `agentDir` 那一格管不到它们。忘了设 = 每次探测都往开发者真实家目录写子会话转写。
 */
export function isolateAgentDir(dir) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
}

/** 读数落盘（探针产物，绝不带密钥——本文件的探针本来就不碰密钥） */
export function writeDump(name, payload) {
  mkdirSync(DUMP_DIR, { recursive: true });
  const file = join(DUMP_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

/** 一棵行目录：`cwd` 与 `configHome` 各一份（与编排层同形） */
export function makeRow(prefix = 'pi-v12-row-') {
  const root = makeRoot(prefix);
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  return { root, cwd, configHome };
}

/** 删掉一棵临时根（`force` 只用于「本来就没建」的那一档；不吞真实错误） */
export function dropRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

/** 写一条技能源目录（`SKILL.md` 的 frontmatter 是厂商的识别入口） */
export function writeSkill(dir, name, body = '正文') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 探针技能\n---\n\n${body}\n`, 'utf8');
  return dir;
}

/** 稀疏化读数：只留判据要的几格，避免把整个 SDK 对象塞进 JSON */
export function skillFacts(skills) {
  return {
    skills: (skills?.skills ?? []).map((skill) => ({
      name: skill.name,
      filePath: skill.filePath,
      scope: skill.sourceInfo?.scope ?? null,
      sourceInfoKeys: skill.sourceInfo === undefined ? null : Object.keys(skill.sourceInfo),
    })),
    diagnostics: (skills?.diagnostics ?? []).map((one) => one),
  };
}

export function extensionFacts(extensions) {
  return {
    extensions: (extensions?.extensions ?? []).map((extension) => extension.path),
    errors: (extensions?.errors ?? []).map((error) => {
      if (error === null || typeof error !== 'object') return { raw: String(error) };
      return {
        path: error.path ?? null,
        message: error.error instanceof Error ? error.error.message : String(error.error ?? error),
      };
    }),
  };
}
