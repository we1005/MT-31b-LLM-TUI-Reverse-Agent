/**
 * ToolRegistry：把 Tool 抽象成 ai SDK v6 的 tool() 形态。
 * 同时携带 classify(args) → 'auto' | 'ask' | 'deny' 给 UI 做审批决策。
 */
import { tool } from 'ai';
import type { ZodType } from 'zod';
import { grepTool } from './grep.ts';
import { makeNoteTool, noteTool } from './note.ts';
import { readFileToolDef } from './read-file.ts';
import { shellTool } from './shell.ts';

export type Approval = 'auto' | 'ask' | 'deny';

export interface Tool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<Input>;
  classify: (args: Input) => Approval;
  execute: (args: Input) => Promise<Output>;
}

/** 内置工具清单。传 notesPath 则 append_note 的默认写入路径统一到该路径(否则用工具内置默认 /tmp/work-notes.md)。
 *  noteAutoApprove=true（顺路发现缓存 --findings-cache 开启时）→ append_note 免审批。 */
export function builtinTools(notesPath?: string, noteAutoApprove = false): Tool[] {
  return [
    shellTool as unknown as Tool,
    readFileToolDef as unknown as Tool,
    grepTool as unknown as Tool,
    (notesPath || noteAutoApprove ? makeNoteTool(notesPath, noteAutoApprove) : noteTool) as unknown as Tool,
  ];
}

export const BUILTIN_TOOLS: Tool[] = builtinTools();

export class ToolRegistry {
  private map = new Map<string, Tool>();

  constructor(tools: Tool[] = BUILTIN_TOOLS) {
    for (const t of tools) this.register(t);
  }

  register(t: Tool): void {
    if (this.map.has(t.name)) throw new Error(`tool already registered: ${t.name}`);
    this.map.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.map.get(name);
  }

  names(): string[] {
    return Array.from(this.map.keys());
  }

  /** 一次性导出 ai SDK v6 的 tools 对象（model 调用时用）*/
  // biome-ignore lint/suspicious/noExplicitAny: ai SDK v6 工具签名严格泛型，混合工具需 any 容器
  asAiSdkTools(): Record<string, any> {
    // biome-ignore lint/suspicious/noExplicitAny: same
    const out: Record<string, any> = {};
    for (const [name, t] of this.map) {
      out[name] = tool({
        description: t.description,
        // biome-ignore lint/suspicious/noExplicitAny: zod schema 跨工具异构
        inputSchema: t.inputSchema as any,
        // 不放 execute → agent 主循环手动 dispatch 以走审批
      });
    }
    return out;
  }

  /** Agent 主循环手动调用：先 classify 再 execute */
  async run(name: string, args: unknown): Promise<{
    approval: Approval;
    result?: unknown;
    error?: string;
  }> {
    const t = this.map.get(name);
    if (!t) return { approval: 'deny', error: `unknown_tool: ${name}` };
    // 校验 args
    const parsed = t.inputSchema.safeParse(args);
    if (!parsed.success) {
      return { approval: 'deny', error: `schema_validation_failed: ${parsed.error.message}` };
    }
    const approval = t.classify(parsed.data);
    if (approval === 'deny') {
      return { approval, error: 'classified_as_deny' };
    }
    const result = await t.execute(parsed.data);
    return { approval, result };
  }

  classify(name: string, args: unknown): Approval {
    const t = this.map.get(name);
    if (!t) return 'deny';
    const parsed = t.inputSchema.safeParse(args);
    if (!parsed.success) return 'deny';
    return t.classify(parsed.data);
  }
}
