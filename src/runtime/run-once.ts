/**
 * --once 模式：非交互执行单任务，无 TUI，纯 stdout/stderr。
 * 适用：脚本化、CI/CD、demo.sh 验收测试。
 */
import { Agent } from '../agent.ts';
import { Budget } from '../budget.ts';
import { type Backend, DEFAULT_CONFIG } from '../config.ts';
import { createLLM } from '../llm.ts';
import { preflightSourceTree } from '../preflight.ts';
import { loadSystemPrompt } from '../prompts.ts';
import { buildResumeContext } from '../resume.ts';
import { ToolRegistry } from '../tools/index.ts';

export interface RunOnceOpts {
  task: string;
  /** 从工作笔记续传：用 §3 续传 prompt + 注入笔记为首条消息 */
  resume?: boolean;
  backend: Backend;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  verbose: boolean;
  autoApprove: boolean;
  workdir?: string;
  budget: number;
  notesPath: string;
}

function color(s: string, code: number): string {
  return process.stderr.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const dim = (s: string) => color(s, 90);
const cyan = (s: string) => color(s, 36);
const green = (s: string) => color(s, 32);
const yellow = (s: string) => color(s, 33);
const red = (s: string) => color(s, 31);

export async function runOnce(opts: RunOnceOpts): Promise<number> {
  if (opts.workdir) process.chdir(opts.workdir);

  // P0 前置校验：源码级任务缺完整源码树 → 秒级 fail-fast + 给配方，别让 agent 撞 123s 超时墙。
  // 续传模式跳过（笔记里已隐含源码树前提，且 resume 有自己的校验）。见「三提议深度分析」§2。
  if (!opts.resume) {
    const pf = preflightSourceTree(opts.task, opts.workdir);
    if (!pf.ok) {
      process.stderr.write(yellow(`⚠ 前置校验未通过：\n`) + `${pf.message}\n`);
      return 2; // 区别于运行错误(1)：2 = 前置条件不满足，需用户补输入
    }
  }

  // 续传：先构建续传上下文（读笔记 + 校验），失败直接退出，不静默退化成新任务。
  let resumeMessage: string | undefined;
  if (opts.resume) {
    const ctx = await buildResumeContext(opts.notesPath, opts.task);
    if (!ctx.ok) {
      process.stderr.write(red(`✗ ${ctx.error}\n`));
      return 1;
    }
    resumeMessage = ctx.message;
    process.stderr.write(
      dim(`[rev-agent] 续传模式：笔记 ${opts.notesPath}（${ctx.noteLines} 行）\n`) +
        (ctx.nextSteps
          ? cyan('  下一步（§4）：\n') + dim(ctx.nextSteps.split('\n').map((l) => `    ${l}`).join('\n') + '\n')
          : yellow('  笔记无明确 §4 下一步，agent 将通读后自行判断\n')),
    );
  }

  // 续传用 §3；否则 §1（--verbose 用 §2）。§9 避坑块会自动拼到 §1/§2/§3 末尾。
  const section = opts.resume ? '§3' : opts.verbose ? '§2' : '§1';
  const systemPrompt = await loadSystemPrompt({ section });
  const model = createLLM({
    backend: opts.backend,
    model: opts.model,
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
  });
  const tools = new ToolRegistry();
  const budget = new Budget(opts.budget ?? DEFAULT_CONFIG.tokenBudget);

  process.stderr.write(
    dim(
      `[rev-agent] backend=${opts.backend} model=${opts.model ?? 'default'} ` +
        `prompt=${section} (${Buffer.byteLength(systemPrompt)} bytes) ` +
        `budget=${budget.max}\n`,
    ),
  );

  const agent = new Agent({
    model,
    tools,
    budget,
    systemPrompt,
    approve: async (call) => {
      if (opts.autoApprove) {
        process.stderr.write(yellow(`  [auto-approve] ${call.name}(${JSON.stringify(call.args).slice(0, 100)})\n`));
        return true;
      }
      // --once 默认拒绝 write 类，避免无人值守误改文件
      process.stderr.write(
        red(`  [denied: write 类工具默认拒，加 --auto-approve 允许] ${call.name}\n`),
      );
      return false;
    },
  });

  // 流式：assistant 正文增量直接进 stdout（评分脚本读 stdout，增量拼起来=完整答案）。
  agent.on('assistantDelta', (delta) => {
    process.stdout.write(delta);
  });
  // 流式：思考链增量进 stderr（暗灰，不污染被评分的 stdout），消灭 Qwen 推理期死屏。
  let reasoningActive = false;
  agent.on('reasoningDelta', (delta) => {
    if (!reasoningActive) {
      process.stderr.write(dim('\n💭 '));
      reasoningActive = true;
    }
    process.stderr.write(dim(delta));
  });
  // 一轮结束的完整 assistant 文本：只补一个换行收尾（正文已由 assistantDelta 流式写过）。
  agent.on('assistant', () => {
    if (reasoningActive) {
      process.stderr.write('\n');
      reasoningActive = false;
    }
    process.stdout.write('\n');
  });
  agent.on('toolCall', (call) => {
    process.stderr.write(cyan(`→ ${call.name} `) + dim(JSON.stringify(call.args).slice(0, 120)) + '\n');
  });
  agent.on('toolResult', (_id, name, result) => {
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    process.stderr.write(dim(`  ← ${name}: ${s.slice(0, 200)}${s.length > 200 ? '...' : ''}\n`));
  });
  agent.on('toolDenied', (_id, name, reason) => {
    process.stderr.write(red(`  ✗ ${name} denied: ${reason}\n`));
  });
  agent.on('budget', (used, max, level) => {
    if (level !== 'green') {
      const c = level === 'yellow' ? yellow : red;
      process.stderr.write(c(`  [budget ${used}/${max} ${level}]\n`));
    }
  });
  agent.on('warn', (msg) => process.stderr.write(yellow(`⚠ ${msg}\n`)));
  agent.on('error', (e) => process.stderr.write(red(`✗ ${e.message}\n`)));

  // 续传时首条消息是注入了笔记全文的续传上下文；否则是用户原始任务。
  agent.addUserMessage(resumeMessage ?? opts.task);

  try {
    await agent.run();
    process.stderr.write(green(`\n✓ done (steps=${agent.step} budget=${budget.used}/${budget.max})\n`));
    return 0;
  } catch (e) {
    process.stderr.write(red(`✗ failed: ${(e as Error).message}\n`));
    return 1;
  }
}
