/**
 * 云端顾问 —— 混合后端「本地执行器卡住 → 脱敏问云端拿思路 → 思路回本地落地续跑」。
 *
 * 设计依据：docs-resources/混合后端-云端顾问-实现方案.md §5。
 * 关键定位：云端是**获取思路的途径**，不是主执行器。它只看到**已脱敏的抽象困境**（真实类名/方法/
 * 字符串已被 <CLS_n>/<PKG_n> 占位符替代），只回「下一步该怎么查」的方法论，占位符原样带回。
 *
 * 返回值签名正好是 Agent 的 `askStrategy: (report)=>Promise<string|null>`——直接塞进去即可，agent 主循环零改动。
 * fail-closed：脱敏后 leaks 非空 → 不出境返回 null（回退本地强制收尾）；云端超时/不可用 → 返回 null 干净回退。
 * 串行铁律：此调用发生在 agent step 之间（stuckIntervene 内 await），与本地 lemonade 调用天然不并发。
 */
import { generateText, type LanguageModel } from 'ai';
import type { Backend } from './config.ts';
import { createLLM } from './llm.ts';
import {
  knownIdentifiersFromLedger,
  type LedgerSnapshot,
  redact,
  type RedactLevel,
  restore,
} from './redact.ts';

/** runtime 层共用的顾问接线参数（来自 CLI --consult-cloud 等）。 */
export interface AdvisorWiring {
  consultCloud?: boolean;
  advisorBackend?: Backend;
  advisorModel?: string;
  advisorBaseURL?: string;
  advisorApiKey?: string;
  /** 脱敏档 0/1/2 */
  redactLevel?: number;
  maxConsults?: number;
}

const ADVISOR_SYSTEM = `你是安卓逆向"方法论顾问"。你只会看到一个【已脱敏的抽象困境报告】——
真实类名/方法名/字符串/路径已被 <CLS_n>/<SYM_n>/<PKG_n>/<PATH_n> 等占位符替代。

**硬性要求：**
- **不要索要真实代码、真实类名或标识符**（脱敏是刻意的，你拿不到也不需要）。
- 只输出"下一步该怎么查"的**思路/方法论**：该 grep 什么模式、该验证哪种指纹、常见的短路/恒真/校验旁路/
  反射/native 跳转套路、该从哪个锚点反向追踪、是否需要动态分析（frida/日志）等。
- 可以、且应该**引用占位符**来指代具体对象（如"读 <CLS_3> 的方法体，确认 <SYM_1> 是否恒返回 true"），
  这样本地执行器能把你的思路精确落到真实类上。
- 给**可执行的探索策略**（具体到工具动作），不要泛泛而谈"多分析多调试"。
- 简洁，直接给步骤。`;

export interface CloudAdvisorOpts {
  backend: Backend;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  /** 脱敏档 0/1/2，默认 2（最严） */
  level?: RedactLevel;
  /** 从 agent 取台账快照（每次求助实时取，标识符清单随探索增长） */
  getLedger: () => LedgerSnapshot;
  /** 云端调用超时 ms，默认 60s（离 lemonade 串行链，独立超时） */
  timeoutMs?: number;
  /**
   * 出境透明/审批钩子：拿到**脱敏后**的 clean payload（出网唯一内容）。
   * 返回 false → 不出境（回退）；返回 true/undefined → 放行。默认只做日志、放行。
   */
  onEgress?: (info: { clean: string; leaks: string[]; level: RedactLevel }) => boolean | Promise<boolean>;
  /** 结构化事件回调（供 runtime 打日志/UI 展示：脱敏面、是否出境、云端是否成功）。 */
  onEvent?: (ev: AdvisorEvent) => void;
}

export type AdvisorEvent =
  | { type: 'redacted'; level: RedactLevel; tokenCount: number; leaks: number; cleanChars: number }
  | { type: 'blocked'; reason: 'leaks' | 'egress-denied' }
  | { type: 'consulting'; backend: Backend; model?: string }
  | { type: 'advice'; chars: number }
  | { type: 'error'; message: string };

/**
 * 造一个云端顾问回调。返回 `(report)=>Promise<string|null>`：
 *   report → redact → (onEgress 门) → 云端 generateText(方法论-only) → restore(占位符→真值) → 交回 askStrategy。
 * 任何一步失败/被拦 → 返回 null（agent 干净回退，绝不阻塞、不裸抛）。
 */
export function createCloudAdvisor(opts: CloudAdvisorOpts): (report: string) => Promise<string | null> {
  const level: RedactLevel = opts.level ?? 2;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let model: LanguageModel;
  try {
    model = createLLM({
      backend: opts.backend,
      model: opts.model,
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
    });
  } catch (e) {
    // 造 client 就失败（缺 key 等）→ 顾问不可用，恒回退 null（不影响本地主流程）
    opts.onEvent?.({
      type: 'error',
      message: `顾问初始化失败: ${e instanceof Error ? e.message : String(e)}`,
    });
    return async () => null;
  }

  return async (report: string): Promise<string | null> => {
    // 1) 脱敏（唯一出网收口）
    const known = knownIdentifiersFromLedger(opts.getLedger());
    const { clean, map, leaks } = redact(report, { level, knownIdentifiers: known });
    opts.onEvent?.({
      type: 'redacted',
      level,
      tokenCount: map.toReal.size,
      leaks: leaks.length,
      cleanChars: clean.length,
    });

    // 2) fail-closed：脱敏后仍疑似泄露 → 不出境
    if (leaks.length) {
      opts.onEvent?.({ type: 'blocked', reason: 'leaks' });
      return null;
    }

    // 3) 出境门（透明日志 / 人工审批）
    if (opts.onEgress) {
      let allow = true;
      try {
        allow = (await opts.onEgress({ clean, leaks, level })) !== false;
      } catch {
        allow = false; // 审批钩子抛错 → 保守不出境
      }
      if (!allow) {
        opts.onEvent?.({ type: 'blocked', reason: 'egress-denied' });
        return null;
      }
    }

    // 4) 调云端（独立超时；失败/超时干净回退 null）
    opts.onEvent?.({ type: 'consulting', backend: opts.backend, model: opts.model });
    try {
      const { text } = await generateText({
        model,
        system: ADVISOR_SYSTEM,
        messages: [{ role: 'user', content: clean }],
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      if (!text?.trim()) {
        opts.onEvent?.({ type: 'error', message: '云端返回空' });
        return null;
      }
      // 5) 还原占位符 → 交回本地落地续跑
      const advice = restore(text, map);
      opts.onEvent?.({ type: 'advice', chars: advice.length });
      return advice;
    } catch (e) {
      opts.onEvent?.({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
}

/**
 * runtime 接线一站式：根据 CLI 参数决定是否启用云端顾问。
 * 返回 { askStrategy, escalateWhenStuck, maxEscalations, enabled }——直接摊进 new Agent({...}) 即可。
 * 未开 --consult-cloud → enabled=false，askStrategy=undefined（保持各 runtime 原有 stuck 行为）。
 * clampLevel 把非法档位夹到 0/1/2。日志/事件通过 log 回调输出（runtime 自己决定打到 stderr / WS / TUI）。
 */
export function wireAdvisor(
  w: AdvisorWiring,
  getLedger: () => LedgerSnapshot,
  log: (msg: string) => void,
): {
  askStrategy?: (report: string) => Promise<string | null>;
  escalateWhenStuck: boolean;
  maxEscalations: number;
  enabled: boolean;
} {
  if (!w.consultCloud) return { escalateWhenStuck: false, maxEscalations: 3, enabled: false };
  const level = (Math.min(2, Math.max(0, Number.isFinite(w.redactLevel) ? (w.redactLevel as number) : 2)) |
    0) as RedactLevel;
  const backend = (w.advisorBackend ?? 'claude') as Backend;
  const maxEscalations = Number.isFinite(w.maxConsults) ? (w.maxConsults as number) : 3;
  const askStrategy = createCloudAdvisor({
    backend,
    model: w.advisorModel,
    baseURL: w.advisorBaseURL,
    apiKey: w.advisorApiKey,
    level,
    getLedger,
    // 出境透明：把**脱敏后**的 payload 摘要打给用户（看得见到底出去了什么），不阻断（放行）。
    onEgress: ({ clean, level }) => {
      log(
        `🔒 出境预览(level=${level}, ${clean.length} 字, 已脱敏)：${clean.replace(/\s+/g, ' ').slice(0, 180)}…`,
      );
      return true;
    },
    onEvent: (ev) => {
      if (ev.type === 'redacted')
        log(
          `🔒 脱敏完成：${ev.tokenCount} 个占位符，泄露扫描 ${ev.leaks} 处${ev.leaks ? '（将中止出境）' : ''}`,
        );
      else if (ev.type === 'blocked')
        log(`⛔ 已阻止出境：${ev.reason === 'leaks' ? '脱敏后仍疑似泄露(fail-closed)' : '出境被拒'}`);
      else if (ev.type === 'consulting')
        log(`☁️  正在问云端顾问(${ev.backend}${ev.model ? '/' + ev.model : ''})…`);
      else if (ev.type === 'advice') log(`💡 云端思路已还原(${ev.chars} 字)，注入本地续跑`);
      else if (ev.type === 'error') log(`⚠ 顾问不可用/失败(将回退本地)：${ev.message}`);
    },
  });
  log(
    `☁️  云端顾问已启用：backend=${backend}${w.advisorModel ? ' model=' + w.advisorModel : ''} 脱敏档=${level} 上限=${maxEscalations} 次`,
  );
  return { askStrategy, escalateWhenStuck: true, maxEscalations, enabled: true };
}
