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
import { ToolRegistry } from '../tools/index.ts';
import { App, createApprovalChannel } from '../ui/App.tsx';

export interface RunInteractiveOpts {
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

  const systemPrompt = await loadSystemPrompt({ section: opts.verbose ? '§2' : '§1' });
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
