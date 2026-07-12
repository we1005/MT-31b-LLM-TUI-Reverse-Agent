/**
 * Web 前端模式（--web [port]）：把 Agent 包成 Bun.serve 的 WebSocket server + 浏览器前端。
 * 复刻 run-interactive 的真实接线（Agent 事件流 + onSubmit + 审批通道），但前端是网页而非 OpenTUI。
 * 零新依赖（Bun 内置 serve + WebSocket）。适合人机交互 / 远程访问 / 演示。
 *
 * 铁律:lemonade 单并发 —— server 同一时刻只跑一个 agent.run（busy 闸门，拒绝并发提交）。
 * 合规:只读逆向分析,不产出破解。
 */
import { Agent } from '../agent.ts';
import { Budget } from '../budget.ts';
import { type Backend, DEFAULT_CONFIG } from '../config.ts';
import { createLLM } from '../llm.ts';
import { loadSystemPrompt } from '../prompts.ts';
import { ToolRegistry } from '../tools/index.ts';
import { WEB_HTML } from './web-ui.ts';

export interface RunWebServerOpts {
  backend: Backend;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  verbose: boolean;
  autoApprove: boolean;
  workdir?: string;
  budget: number;
  notesPath: string;
  port: number;
}

// biome-ignore lint/suspicious/noExplicitAny: Bun.ServerWebSocket 类型
type WS = any;

export async function runWebServer(opts: RunWebServerOpts): Promise<number> {
  if (opts.workdir) process.chdir(opts.workdir);

  const section = opts.verbose ? '§2' : '§1';
  const systemPrompt = await loadSystemPrompt({ section });
  const model = createLLM({ backend: opts.backend, model: opts.model, baseURL: opts.baseURL, apiKey: opts.apiKey });
  const tools = new ToolRegistry();
  const budget = new Budget(opts.budget ?? DEFAULT_CONFIG.tokenBudget);

  const clients = new Set<WS>();
  const send = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const ws of clients) {
      try {
        ws.send(s);
      } catch {
        /* 客户端断开,忽略 */
      }
    }
  };

  let busy = false;
  let pendingApproval: ((ok: boolean) => void) | null = null;

  const agent = new Agent({
    model,
    tools,
    budget,
    systemPrompt,
    approve: async (call) => {
      if (opts.autoApprove) return true;
      // 通过 WS 询问浏览器,等回应(单并发下同一时刻只有一个待审批)。
      return new Promise<boolean>((resolve) => {
        pendingApproval = resolve;
        send({ type: 'approval', name: call.name, args: call.args });
      });
    },
  });

  // Agent 事件 → 广播给所有浏览器
  agent.on('assistantDelta', (d: string) => send({ type: 'assistantDelta', text: d }));
  agent.on('reasoningDelta', (d: string) => send({ type: 'reasoningDelta', text: d }));
  agent.on('assistant', () => send({ type: 'assistantEnd' }));
  agent.on('toolCall', (call: { id: string; name: string; args: unknown }) =>
    send({ type: 'toolCall', name: call.name, args: call.args }),
  );
  agent.on('toolResult', (_id: string, name: string, result: unknown) => {
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    send({ type: 'toolResult', name, text: s.slice(0, 600) });
  });
  agent.on('toolDenied', (_id: string, name: string, reason: string) => send({ type: 'toolDenied', name, reason }));
  agent.on('warn', (m: string) => send({ type: 'warn', text: m }));
  agent.on('error', (e: Error) => send({ type: 'error', text: e?.message ?? String(e) }));
  agent.on('budget', (used: number, max: number, level: string) => send({ type: 'budget', used, max, level }));
  agent.on('done', () => {
    busy = false;
    send({ type: 'done', used: budget.used, max: budget.max });
  });

  async function handleSubmit(text: string): Promise<void> {
    if (!text.trim()) return;
    if (busy) {
      send({ type: 'error', text: '正忙(lemonade 单并发),请等当前任务完成' });
      return;
    }
    busy = true;
    send({ type: 'userMsg', text });
    send({ type: 'busy', v: true });
    agent.resetTurnCounters(); // 铁律:每轮重置,否则跨轮累加卡死
    agent.addUserMessage(text);
    try {
      await agent.run();
    } catch (e) {
      agent.emit('error', e instanceof Error ? e : new Error(String(e)));
      busy = false;
      send({ type: 'done', used: budget.used, max: budget.max });
    }
  }

  const server = Bun.serve({
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (srv.upgrade(req)) return; // 升级成功:不返回 Response
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      // 其余路径都返回单页前端
      return new Response(WEB_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
    websocket: {
      open(ws: WS) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'hello', cwd: process.cwd(), backend: opts.backend, budgetMax: budget.max, busy }));
      },
      close(ws: WS) {
        clients.delete(ws);
      },
      message(_ws: WS, raw: string | Buffer) {
        let msg: { type?: string; text?: string; ok?: boolean };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'submit' && typeof msg.text === 'string') {
          void handleSubmit(msg.text);
        } else if (msg.type === 'approvalResponse') {
          const r = pendingApproval;
          pendingApproval = null;
          r?.(!!msg.ok);
        }
      },
    },
  });

  process.stderr.write(
    `\x1b[36m[rev-agent web]\x1b[0m 前端已启动 → \x1b[1mhttp://localhost:${server.port}\x1b[0m` +
      `  (backend=${opts.backend} workdir=${process.cwd()})\n浏览器打开即可交互。Ctrl-C 退出。\n`,
  );

  return new Promise<number>((resolve) => {
    const shutdown = () => {
      server.stop(true);
      resolve(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}
