/**
 * 止损守卫决策（框架化 MVP-0/1）——纯函数、可离线单测。
 *
 * 背景（实测缘起）：rev-agent 的 stall/readHopStall 守卫是 **count-gated**（连续 N 步无进展→立即
 * 强制收尾）。EasyNotes 深多跳审计实测：守卫在 step8、**reads=0** 就 forced-finish，逼出"入口对但
 * 机制判错"的浅答；而无此守卫的 pi 反而肯读 15 个文件跟到真破解点。→ 守卫是双刃剑：给了鲁棒性，
 * 却切断了合理的深调查。
 *
 * 设计铁律（见 docs-resources/框架化-把逆向负担从模型移到框架.md）：
 *   框架只做两件事——①按硬可观测事实注入 context ②按资源硬上限收 budget；
 *   **永不替 agent 决定"下一步动作是什么"或"任务是否完成"**。
 * 落地：守卫默认动作从"计数触发的强制收尾"改成"**信号触发的注入 CHECKPOINT（明确下一步）+ 给预算**"；
 *   终止（forced-finish）**只在资源硬上限**（ctx 超顶 / 步数接近上限）触发，且标注"资源上限"而非"任务完成"。
 *   `REV_GUARD_MODE=count` 可退回旧的即时强制收尾行为，用于 A/B。
 */

export type GuardMode = 'signal' | 'count';
export type GuardTrigger = 'stall' | 'readHopStall';

/** 从 env 读守卫模式；默认 signal（本分支新行为），count=旧行为。 */
export function guardMode(): GuardMode {
  return process.env['REV_GUARD_MODE'] === 'count' ? 'count' : 'signal';
}

export interface GuardSignals {
  trigger: GuardTrigger;
  /** 已确认的 read/grep/hop 计数（ledger stats）。 */
  reads: number;
  greps: number;
  hops: number;
  /** 已为**当前 trigger** 注入过几次 CHECKPOINT（未被采纳则升级）。 */
  checkpointsIssued: number;
  /** 资源硬上限是否已达（真实 ctx 超 ctxCeiling / 步数逼近 maxSteps）。 */
  hardCeilingHit: boolean;
  /** 最近一步是否有新进展（新 read / 新 hop）——signal 模式下有进展就绝不打断。 */
  productiveRecently: boolean;
}

export interface GuardDecision {
  kind: 'continue' | 'checkpoint' | 'finish';
  reason: string;
  /** checkpoint/finish 要注入给模型的消息。 */
  message?: string;
  /** finish 是否因资源硬上限（标注"资源上限"而非"任务完成"）。 */
  resourceLimited?: boolean;
}

/** CHECKPOINT / 资源上限收尾允许的最大 checkpoint 次数（宽限）。 */
export const MAX_CHECKPOINTS = 2;

/** 旧行为（count 模式）：触发即强制收尾的消息（保留原语义）。 */
export const COUNT_FINISH_MSG =
  '你已连续多步没有任何新进展（在重复无效操作）。停止一切工具调用，立即用已确认的证据输出以「## 最终结论」开头的答案；' +
  '把已追出的每一跳写成 `A.方法 → B.方法 | 证据 类:行` 链路图，未证实的环节标"待确认"给最佳推断。不要再调用任何工具。' +
  '【反幻觉铁律】只基于你实际 read_file 读到并能引用 file:line 的内容下结论；没读到的一律明说"未能证实"，严禁编造。';

/** 资源硬上限收尾——明确标注"资源上限而非任务完成"。 */
export const RESOURCE_FINISH_MSG =
  '已达**资源上限**（上下文/步数逼近硬顶）——这是资源限制，**不代表任务已完成**。' +
  '请用你目前**实际 read_file 读到、能引用 file:line** 的证据，输出以「## 最终结论」开头的答案，' +
  '并明确区分：哪些是已证实的、哪些是因资源上限**未能证实**的（给最佳推断但标注"未证实"）。严禁编造未读到的机制/类名/字节码。';

/** reads===0 时的 CHECKPOINT：逼它去读码，而不是收尾。 */
export function checkpointReadMsg(sig: GuardSignals): string {
  return (
    `你已经 grep 了 ${sig.greps} 次却**一个方法体都还没 read_file 读过**——grep 只告诉你字符串在哪，看不到逻辑。` +
    '停止继续 grep，**立刻 read_file 打开你最有把握的那个 grep 命中所在的类，读它的方法体（≤200 行）确认**。' +
    '**这不是让你收尾**，是让你先去读码——读到能引用 file:line 的真实实现之前，不要下结论、也不要继续盲搜。'
  );
}

/** reads>0 但停滞时的 CHECKPOINT：二选一（再读关键的一个 / 收尾），而非强制收尾。 */
export function checkpointDecideMsg(sig: GuardSignals): string {
  return (
    `你已读了 ${sig.reads} 处代码但最近几步没有新进展。**二选一，别再重复已做过的 grep**：` +
    '(1) 如果还差**某一个**关键类的方法体才能定论，就现在 read_file 精读那一个；' +
    '(2) 如果证据已足够定论，就立即写以「## 最终结论」开头的完整答案。' +
    '【反幻觉】只写你实际 read 到能引用 file:line 的内容。'
  );
}

/**
 * 核心决策（纯函数）。给定当前信号 + 模式，返回该 trigger 应采取的动作。
 * - count 模式：触发即 finish（旧行为，A/B 对照）。
 * - signal 模式：资源硬上限→finish(资源标注)；仍有进展→continue(不打断深调查)；
 *   原地打转但 checkpoint 配额未尽→checkpoint(注入明确下一步+给预算)；配额用尽→finish(资源/宽限耗尽)。
 */
export function decideGuard(sig: GuardSignals, mode: GuardMode = 'signal'): GuardDecision {
  if (mode === 'count') {
    return { kind: 'finish', reason: `${sig.trigger}: count-gated 立即强制收尾（旧行为）`, message: COUNT_FINISH_MSG, resourceLimited: false };
  }
  // signal 模式：
  if (sig.hardCeilingHit) {
    return { kind: 'finish', reason: `${sig.trigger}: 资源硬上限（ctx/步数）`, message: RESOURCE_FINISH_MSG, resourceLimited: true };
  }
  if (sig.productiveRecently) {
    return { kind: 'continue', reason: `${sig.trigger}: 最近有新 read/hop，仍在有效进展，不打断深调查` };
  }
  if (sig.checkpointsIssued < MAX_CHECKPOINTS) {
    const message = sig.reads === 0 ? checkpointReadMsg(sig) : checkpointDecideMsg(sig);
    return { kind: 'checkpoint', reason: `${sig.trigger}: 原地打转，注入第 ${sig.checkpointsIssued + 1} 次 CHECKPOINT（明确下一步+给预算，不强制收尾）`, message };
  }
  return { kind: 'finish', reason: `${sig.trigger}: CHECKPOINT 宽限（${MAX_CHECKPOINTS} 次）用尽仍打转，收尾`, message: RESOURCE_FINISH_MSG, resourceLimited: true };
}
