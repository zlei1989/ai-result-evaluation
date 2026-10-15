// @vitest-environment node
/**
 * `turnInjection` 声明组：**人往运行中的一轮送话**、以及**接着一条已有会话再跑一段**，
 * 这一家在两个维度上各自能做什么。
 *
 * 判据全部来自契约自身（取值域、跨字段不变量），与「哪一家今天填什么」无关——逐家取值由接入方
 * 与它自己的正面场景**同一次提交**落地（声明不许先于夹具）。
 *
 * 为什么这一组的每个不变量都要有靶子：界面完全由声明驱动，一处「声明说能投而实际投不进去」
 * 就会让界面说谎，而说谎的形态是「按钮可点、消息静默消失」——没有任何报错。
 */
import { describe, expect, it } from 'vitest';
import {
  RETRACT_ABILITIES,
  RetractAbilitySchema,
  RetractOutcomeSchema,
  InjectionBoundarySchema,
  TurnInjectionCapabilitySchema,
  TurnInjectionCellSchema,
  TurnInjectionChannelSchema,
  TurnInjectionRetractSchema,
} from './agent-message';

/**
 * 一格合法声明：非 `yes` 的四态各带必填 `reason`，`channel` 记厂商侧那条通道的代价，
 * `gate` 记版本门（`null` = 无门），`experimental` 记「wire 上有 ≠ 官方承诺稳定」，
 * `proofDriver` 记**这一格的证据是哪一档驱动器**（`synthetic-fixture` 必须说清为什么不是真路径）。
 */
const piIdleCell = {
  state: 'off-by-adapter' as const,
  reason: 'not-observed' as const,
  channel: 'in-process-sdk' as const,
  gate: null,
  experimental: false,
  proofDriver: 'synthetic-fixture' as const,
  proofDriverReason: '适配器还没挂端口，今天的证据来自假 SDK 夹具',
};

const byIdRetract = { state: 'by-id' as const, reason: '按我们自铸的 uuid 撤这一条' };

describe('turnInjection 能力格（投递两档与续接共用同一个形状）', () => {
  it('收下一份今天的合法声明（非 yes 带 reason + 通道 + 无门 + 非 experimental）', () => {
    expect(TurnInjectionCellSchema.safeParse(piIdleCell).success).toBe(true);
  });

  it('`yes` 必须说清走哪条通道，且不许再带 reason', () => {
    // `yes` 那一档还得同时给出真路径驱动器（`proofDriver` 的硬规则另有一条不变量）
    const yesCell = { ...piIdleCell, proofDriver: 'real-path' as const, proofDriverReason: null };
    expect(
      TurnInjectionCellSchema.safeParse({ ...yesCell, state: 'yes', reason: null, channel: 'wire' }).success,
    ).toBe(true);
    // yes 缺通道 ⇒ 红：能做到却说不清怎么做，界面只能编一个代价
    expect(
      TurnInjectionCellSchema.safeParse({ ...yesCell, state: 'yes', reason: null, channel: null }).success,
    ).toBe(false);
    // yes 带 reason ⇒ 红：两句话同时说「能」与「为什么不能」
    expect(
      TurnInjectionCellSchema.safeParse({ ...yesCell, state: 'yes', channel: 'wire' }).success,
    ).toBe(false);
  });

  it('非 yes 必须给出缺失原因——三句原因不许混成一句', () => {
    // 缺 reason ⇒ 红（「这家结构上没有」与「我们没接」的下一步动作完全不同）
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, reason: null }).success).toBe(false);
    // 五态词表原样复用，一个词都不加
    for (const state of ['no', 'unverified', 'off-by-adapter', 'not-projected-by-vendor'] as const) {
      expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, state }).success).toBe(true);
    }
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, state: 'maybe' }).success).toBe(false);
  });

  it('gate 是结构化的一格（版本门不许塞进 notes）：`{version}` 或 `null`，两者都必填', () => {
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, gate: { version: '0.156.1' } }).success).toBe(true);
    // 缺 gate 这一格 ⇒ 红（缺省与「没有版本门」是两件事，后者要能被读到）
    const { gate: _gate, ...withoutGate } = piIdleCell;
    expect(TurnInjectionCellSchema.safeParse(withoutGate).success).toBe(false);
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, gate: {} }).success).toBe(false);
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, gate: { version: '' } }).success).toBe(false);
  });

  it('experimental 必填（「wire 上有」≠「官方承诺稳定」）', () => {
    const { experimental: _experimental, ...withoutFlag } = piIdleCell;
    expect(TurnInjectionCellSchema.safeParse(withoutFlag).success).toBe(false);
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, experimental: true }).success).toBe(true);
  });
});

/**
 * **`proofDriver`**：这一格的证据是哪一档驱动器（与询问面的 `askUserProofDriver` 同一套两档）。
 *
 * 为什么必须与 `state` 分开说：`state` 回答「这一格做不做得到」，这一格回答「这句结论是怎么证出来的」。
 * 合成一格等于让一个字段同时回答两个问题，而「夹具扮演厂商那一端」能让判据全绿却证不到厂商那一侧。
 */
describe('turnInjection 格的 proofDriver（这一格的证据是哪一档驱动器）', () => {
  it('两档取值，且是**必填格**（缺席与「没证过」是两件事）', () => {
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, proofDriver: 'real-path', proofDriverReason: null }).success).toBe(true);
    const { proofDriver: _driver, ...withoutDriver } = piIdleCell;
    expect(TurnInjectionCellSchema.safeParse(withoutDriver).success).toBe(false);
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, proofDriver: 'fake-vendor' }).success).toBe(false);
  });

  it('`yes` ⇒ 必须 `real-path`：声明得出「能做到」就得拿真路径证明', () => {
    expect(
      TurnInjectionCellSchema.safeParse({
        ...piIdleCell,
        state: 'yes',
        reason: null,
        proofDriver: 'synthetic-fixture',
        proofDriverReason: '夹具扮演厂商那一端',
      }).success,
      '夹具扮演厂商那一端时「我们传了什么」看得见、「厂商拿它做了什么」看不见',
    ).toBe(false);
  });

  it('`synthetic-fixture` ⇒ 必须给出原因（非空）；`real-path` ⇒ 原因必须为 null', () => {
    // 临时档：不说清「今天为什么驱动不了真路径」，它会静默地长期留下来
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, proofDriverReason: null }).success).toBe(false);
    expect(TurnInjectionCellSchema.safeParse({ ...piIdleCell, proofDriverReason: '   ' }).success).toBe(false);
    // 反面：real-path 那一档不需要解释，给了就是两句话在打架
    expect(
      TurnInjectionCellSchema.safeParse({ ...piIdleCell, proofDriver: 'real-path', proofDriverReason: '多余的原因' }).success,
    ).toBe(false);
  });

  it('非 `yes` 也可以是真路径驱动（真路径上**观察到做不到**也是一种证据）', () => {
    expect(
      TurnInjectionCellSchema.safeParse({ ...piIdleCell, proofDriver: 'real-path', proofDriverReason: null }).success,
    ).toBe(true);
  });
});

describe('turnInjection 撤回格（与投递分开声明）', () => {
  it('四档取值：by-id / flush-only / none / unverified', () => {
    expect([...RETRACT_ABILITIES]).toEqual(['by-id', 'flush-only', 'none', 'unverified']);
    for (const state of RETRACT_ABILITIES) {
      expect(RetractAbilitySchema.safeParse(state).success).toBe(true);
      expect(TurnInjectionRetractSchema.safeParse({ state, reason: '为什么是这一档' }).success).toBe(true);
    }
    // 「能收但不能撤」是合法的一家 ⇒ 撤回格的四档与投递格的五态**不是**同一套词表
    expect(RetractAbilitySchema.safeParse('yes').success).toBe(false);
    // 「支持撤回」这种把四档压成一格的写法不许存在
    expect(RetractAbilitySchema.safeParse('supported').success).toBe(false);
  });

  it('reason 必填（判据要在里面：按什么认人 / 是不是整条清）', () => {
    expect(TurnInjectionRetractSchema.safeParse({ state: 'by-id' }).success).toBe(false);
    expect(TurnInjectionRetractSchema.safeParse({ state: 'by-id', reason: '' }).success).toBe(false);
  });
});

/**
 * 续接那一格：**单格**（续接不是「哪一档」的问题，故不按边界分两档），字段与投递每格同形。
 * `gate` 在这一格是主力：有的家是「版本到了才有这条 wire 方法」，那一格必须能被读到。
 */
const dshResumeCell = {
  state: 'off-by-adapter' as const,
  reason: 'not-observed' as const,
  channel: 'wire' as const,
  gate: { version: '0.2.1-alpha.3' },
  experimental: false,
  proofDriver: 'synthetic-fixture' as const,
  proofDriverReason: '真路径的正向判据要等升级之后才做得出，今天的证据是假 SDK 上的反断言',
};

/** 续接可用的那一档：`yes` 必须说清通道，且不再带原因；驱动器必须是真的那条路 */
const ccResumeCell = {
  state: 'yes' as const,
  reason: null,
  channel: 'wire' as const,
  gate: null,
  experimental: false,
  proofDriver: 'real-path' as const,
  proofDriverReason: null,
};

describe('turnInjection 声明组：家 × 两档 × 两件事 + 续接', () => {
  const group = {
    delivery: { round: piIdleCell, idle: piIdleCell },
    retract: { round: { state: 'flush-only' as const, reason: '只有整条清空' }, idle: byIdRetract },
    resume: ccResumeCell,
    notes: ['同一进程内的 `round` 与跨进程续接不组合：续接之后的追问天然落在 `idle` 档'],
  };

  it('收得下完整的组（投递两档 + 撤回两档 + 续接 + 前提 notes）', () => {
    expect(TurnInjectionCapabilitySchema.safeParse(group).success).toBe(true);
  });

  it('续接是**单格**：不按两档分（写成两档形状即红）', () => {
    expect(TurnInjectionCapabilitySchema.safeParse({ ...group, resume: { round: ccResumeCell, idle: ccResumeCell } }).success).toBe(false);
    expect(TurnInjectionCapabilitySchema.safeParse({ ...group, resume: dshResumeCell }).success).toBe(true);
  });

  it('续接缺格即红（没有它，「不支持续接的家收到 resume 要抛错」无处声明）', () => {
    const { resume: _resume, ...withoutResume } = group;
    expect(TurnInjectionCapabilitySchema.safeParse(withoutResume).success).toBe(false);
  });

  it('续接那一格走同一套不变量：yes ⇒ 通道必填、非 yes ⇒ 原因必填、gate 必填', () => {
    // yes 缺通道 ⇒ 红（能续接却说不清走哪条通道）
    expect(TurnInjectionCellSchema.safeParse({ ...ccResumeCell, channel: null }).success).toBe(false);
    // 非 yes 缺原因 ⇒ 红
    expect(TurnInjectionCellSchema.safeParse({ ...dshResumeCell, reason: null }).success).toBe(false);
    // gate 是必填格：`null`（没有版本门）与缺席是两件事
    const { gate: _gate, ...withoutGate } = dshResumeCell;
    expect(TurnInjectionCellSchema.safeParse(withoutGate).success).toBe(false);
  });

  it('续接的版本门逐字保留（dsh 那一格靠它说清「哪个版本起才有那条 wire 方法」）', () => {
    const parsed = TurnInjectionCapabilitySchema.parse({ ...group, resume: dshResumeCell });
    expect(parsed.resume.gate).toEqual({ version: '0.2.1-alpha.3' });
    expect(parsed.resume.state).toBe('off-by-adapter');
  });

  it('两档缺一档即红（矩阵不许留空洞）', () => {
    expect(
      TurnInjectionCapabilitySchema.safeParse({ ...group, delivery: { round: piIdleCell } }).success,
    ).toBe(false);
    expect(
      TurnInjectionCapabilitySchema.safeParse({ ...group, retract: { round: byIdRetract } }).success,
    ).toBe(false);
  });

  it('投递与撤回各占一格：只声明投递不声明撤回即红', () => {
    expect(TurnInjectionCapabilitySchema.safeParse({ delivery: group.delivery, notes: [] }).success).toBe(false);
  });

  it('notes 必填（这一族能力成立的前提：路由 / 开关 / 版本）', () => {
    expect(TurnInjectionCapabilitySchema.safeParse({ delivery: group.delivery, retract: group.retract }).success).toBe(
      false,
    );
  });
});

describe('词表', () => {
  it('两档边界只有 round / idle（刻意避开厂商的 turn / step 两套命名）', () => {
    expect([...InjectionBoundarySchema.options]).toEqual(['round', 'idle']);
  });

  it('通道三值：wire / in-process-plugin / in-process-sdk', () => {
    expect([...TurnInjectionChannelSchema.options]).toEqual(['wire', 'in-process-plugin', 'in-process-sdk']);
  });

  it('撤回结果四值（不许只回布尔：撤不到与 id 不对必须分得开）', () => {
    expect([...RetractOutcomeSchema.options]).toEqual(['retracted', 'already-consumed', 'unsupported', 'unknown']);
  });
});
