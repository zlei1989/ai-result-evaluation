// @vitest-environment node
/**
 * 探针 03（**必须在 `HOME` 已被改写的新进程里跑**）：被 `skillsOverride` 过滤掉的技能，
 * 到底有没有进模型上下文。
 *
 * 为什么非新进程不可：`os.homedir()` 在 Node 启动时就定下来了（之后改 `process.env.HOME`
 * 不再影响它）⇒ 同一个进程里改 HOME 的写法**测不到** HOME 锚定的那条发现路径，
 * 结论会是一句「没泄漏」的假话。驱动器：`probe/v12/03-skills-home-subprocess.mjs`
 * （它给子进程 `env: { HOME, PI_CODING_AGENT_DIR }`，两者都指向临时目录）。
 *
 * 为什么必须真跑适配器而不是照抄一份装配：过滤只在 `reload()` 那一刻生效，而适配器的
 * `reload` 之后还有 `createAgentSession` 与 `bindExtensions` 两步——厂商在这两步里会不会
 * **再扫一次**技能表，抄件答不出来（抄件里根本没有那两步）。
 *
 * 判据四条：
 *   ① 假 HOME 里的金丝雀**不许**出现在出站请求里（技能段与整份请求体都要干净）；
 *   ② 同一份请求里**必须**有行技能与项目技能（否则①可能只是「技能段整体没发」）；
 *   ③ `vendor-system.skills` 里**不许**有金丝雀——这一格读的是装载器的
 *      `getSkills()`，也就是**过滤之后**的那一份（过滤前有什么由探针 04 单独量）；
 *   ④ 行技能那一格的 `origin` 是 `local-enabled`、项目技能那两格是 `repo-provided`
 *      —— 落点分档在真路径形态下成立（`classifySkillOrigin` 的实参是厂商给的 `filePath`）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTreeWithRetry } from '../../../testing/cleanup';
import {
  anthropicText,
  createPiRowLayout,
  runPiConformanceRow,
  writeSkillSource,
} from '../../../testing/pi-conformance-fixture';
import { eventOfType, vendorSkillOf } from './readings';

/** 假 HOME 里的金丝雀（由驱动器布在 `~/.agents/skills/` 与 `~/.pi/skills/` 两条路径上） */
const HOME_CANARY = 'home-canary-skill';
const ROW_SKILL = 'row-skill-probe';
const PROJECT_PI_SKILL = 'project-pi-skill-probe';

/**
 * 驱动器有没有把 HOME 指到假家目录 —— 这一条是**前置条件**，不是判据：
 * 同进程里改 `process.env.HOME` 影响不到 `os.homedir()`，所以没有假 HOME 时这一格
 * **什么都没证明**，只能跳过并明说（不许静默变成一句「没泄漏」的假话）。
 */
const drivenBySubprocess = (process.env.HOME ?? '').includes('pi-v12-home');

describe('技能过滤：HOME 锚定 / 行白名单 / 项目技能', () => {
  it.skipIf(!drivenBySubprocess)('真适配器一轮：金丝雀不进请求，行技能与项目技能进请求，厂商清单仍含金丝雀', async () => {
    const home = process.env.HOME ?? '';

    const layout = createPiRowLayout('pi-v12-skills-row-');
    try {
      const run = await runPiConformanceRow({
        script: [anthropicText('收到。')],
        prompt: '这一题只用来取证，不必真的做什么。',
        skills: [writeSkillSource(layout.root, ROW_SKILL, '行技能正文（必须进上下文）')],
        cwdSetup: (cwd) => {
          for (const [dir, name] of [['.pi', PROJECT_PI_SKILL], ['.agents', `${PROJECT_PI_SKILL}-two`]] as const) {
            const target = join(cwd, dir, 'skills', name);
            mkdirSync(target, { recursive: true });
            writeFileSync(
              join(target, 'SKILL.md'),
              `---\nname: ${name}\ndescription: 项目自带的技能\n---\n\n项目技能正文。\n`,
              'utf8',
            );
          }
        },
      });

      const requestNames = run.requestSkills.map((skill) => skill.name);
      const lastBody = JSON.stringify(run.requests.at(-1)?.body ?? {});
      const canaryOccurrences = lastBody.split(HOME_CANARY).length - 1;
      /**
       * 厂商清单：事件在产物里是 `Record<string, unknown>`（形状由契约管，类型系统管不到），
       * 故逐格经 `readings.ts` 收窄——探针不复制契约形状。
       */
      const vendorSkills = run.product.events
        .filter((event) => eventOfType(event, 'vendor-system'))
        .flatMap((event) => vendorSkillOf(event));

      const reading = {
        home,
        agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
        requestSkillNames: requestNames,
        canaryOccurrencesInRequest: canaryOccurrences,
        vendorSkills,
        sessionFile: run.outcome.sessionId,
      };
      writeProbeDump('03-skills-home-subprocess', reading);

      // ① 金丝雀不许进模型上下文（逐名 + 整份请求体两处都判）
      expect(requestNames, `出站请求里出现了宿主家目录的技能：${requestNames.join('、')}`).not.toContain(HOME_CANARY);
      expect(canaryOccurrences, '金丝雀技能名出现在请求体里（技能段之外也算命中）').toBe(0);
      // ② 行技能与项目技能必须在
      expect(requestNames).toContain(ROW_SKILL);
      expect(requestNames).toContain(PROJECT_PI_SKILL);
      // ③ 厂商清单里不许有金丝雀：这一格读的是装载器的 `getSkills()`（= 过滤之后的那一份）
      expect(vendorSkills.map((skill) => skill.name)).not.toContain(HOME_CANARY);
      // ④ 落点分档：行技能在行配置目录之下 ⇒ local-enabled；项目技能在 cwd 之下 ⇒ repo-provided
      const originOf = (name: string) => vendorSkills.find((skill) => skill.name === name)?.origin ?? null;
      expect(originOf(ROW_SKILL)).toBe('local-enabled');
      expect(originOf(PROJECT_PI_SKILL)).toBe('repo-provided');
    } finally {
      removeTreeWithRetry(layout.root);
    }
  }, 180_000);
});

/** 读数落盘到 `probe/dumps/v12/`（与 `.mjs` 探针同一处，便于并排看） */
function writeProbeDump(name: string, payload: unknown): void {
  const dir = join(import.meta.dirname, '..', '..', '..', '..', 'probe', 'dumps', 'v12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
