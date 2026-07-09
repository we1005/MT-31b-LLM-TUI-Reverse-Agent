/**
 * 交互模式：OpenTUI 富 UI。
 * 启动：bun src/index.tsx（默认）或 bun src/index.tsx --interactive
 */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { createElement } from 'react';
import { Agent } from '../agent.ts';
import { Budget } from '../budget.ts';
import { type Backend, DEFAULT_CONFIG } from '../config.ts';
import { createLLM } from '../llm.ts';
import { loadSystemPrompt } from '../prompts.ts';
import { buildResumeContext } from '../resume.ts';
import { ToolRegistry } from '../tools/index.ts';
import { App, createApprovalChannel } from '../ui/App.tsx';

export interface RunInteractiveOpts {
  /** 从工作笔记续传：用 §3 续传 prompt + 预注入笔记并自动起跑首轮 */
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

export async function runInteractive(opts: RunInteractiveOpts): Promise<number> {
  if (opts.workdir) process.chdir(opts.workdir);

  // 续传：构建续传上下文；失败直接退出（不进 TUI 空转）。
  let resumeMessage: string | undefined;
  if (opts.resume) {
    const ctx = await buildResumeContext(opts.notesPath, '继续');
    if (!ctx.ok) {
      process.stderr.write(`✗ ${ctx.error}\n`);
      return 1;
    }
    resumeMessage = ctx.message;
  }

  // 续传用 §3；否则 §1（--verbose 用 §2）。§9 避坑块自动拼到末尾。
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
  const approvalChannel = createApprovalChannel();

  const agent = new Agent({
    model,
    tools,
    budget,
    systemPrompt,
    approve: async (call) => {
      if (opts.autoApprove) return true;
      return approvalChannel.ask(call.name, call.args);
    },
  });

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    enableMouseMovement: false,
  });

  const root = createRoot(renderer);

  const onSubmit = async (text: string) => {
    agent.addUserMessage(text);
    await agent.run();
  };

  root.render(
    createElement(App, {
      agent,
      notesPath: opts.notesPath,
      onSubmit,
      approvalChannel,
    }),
  );

  // 续传：预注入笔记上下文并自动起跑首轮，无需用户再输入
  if (resumeMessage) {
    void onSubmit(resumeMessage);
  }

  // 等待退出（renderer 自己处理 Ctrl-C → exitOnCtrlC: true）
  return new Promise<number>((resolve) => {
    process.on('SIGTERM', () => {
      renderer.destroy();
      resolve(0);
    });
    process.on('SIGINT', () => {
      renderer.destroy();
      resolve(0);
    });
  });
}
