#!/usr/bin/env bun
/**
 * rev-agent CLI 入口。
 * 模式：
 *   --once <task>     非交互，跑一个任务到完成（无 TUI，纯 stdout）
 *   --interactive     默认，进 OpenTUI（task #21 尚未实现，先 fallback 到 --once）
 *   --version         打印版本立即退出（< 200ms）
 *
 * commander 解析 + 短路 → 仅在需要时 import LLM / Agent 模块（保持冷启动快）。
 */
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };

const program = new Command()
  .name('rev-agent')
  .description('本地 LLM agent CLI（专为安卓逆向，强制 4 阶段渐进探索协议）')
  .version(pkg.version, '-V, --version', '打印版本退出')
  .option('-b, --backend <name>', 'LLM 后端: lemonade | lm-studio | ollama | local | claude | openai', 'lemonade')
  .option('-m, --model <id>', 'model id（按 backend 默认）')
  .option('-u, --base-url <url>', '覆盖 backend 默认 baseURL')
  .option('-k, --api-key <key>', '覆盖 API key（云端 backend 用）')
  .option('--verbose', '用 §2 长版 system prompt（默认 §1 短版）')
  .option('--resume', '从 --notes 指定的工作笔记续传（用 §3 续传 prompt，注入笔记接着干）')
  .option('--once <task>', '非交互模式：单任务跑到完成，结果走 stdout')
  .option('--auto-approve', '所有工具自动放行（仅 --once 推荐）')
  .option('--workdir <path>', 'agent 默认 cwd（影响 grep / read_file 的相对路径）')
  .option('--corpus <dir>', '案卷续分析模式：指向强 agent 前置分析产物目录（MD 结论 / Frida trace / pcap / dump / 源码树），接手它续分析而非从裸 APK 逆向')
  .option('--budget <tokens>', 'token 预算上限', String(80_000))
  .option('--notes <path>', '工作笔记路径', '/tmp/work-notes.md')
  .option('--mcp-server', '进入 MCP server 模式（stdio transport，给 Claude Code/Cursor 反向调用）')
  .option('--web [port]', '进入 Web 前端模式（浏览器交互，Bun.serve WebSocket，默认端口 5178）')
  .option('--allow-write', 'MCP server 模式下放行 write 类工具（默认拒）')
  .option('--ask-when-stuck', '原地打转时不强制猜答案，改为输出困境报告求思路（TUI 粘贴续跑 / --once 输出报告并 exit=3）')
  .option('--strategy <text>', '（配合 --once）注入用户/更强模型给的分析思路，让 agent 按此重新分析（承接上一轮 exit=3 的困境报告）')
  // —— 混合后端：卡住→脱敏→问云端顾问拿思路（默认关，纯本地不出网）——
  .option('--consult-cloud', '卡住时把困境报告脱敏后问云端顾问拿思路，思路回本地续跑（默认关；开启才会出网）')
  .option('--advisor-backend <name>', '顾问后端: claude | openai | volcengine | local | lemonade（local/lemonade 串行不外泄，用于自测）', 'claude')
  .option('--advisor-model <id>', '顾问 model id（按后端默认）')
  .option('--advisor-base-url <url>', '顾问 baseURL（--advisor-backend local 时必填）')
  .option('--advisor-api-key <key>', '顾问 API key（云端后端用；缺省从 env ANTHROPIC/OPENAI/ARK_API_KEY）')
  .option('--redact-level <0|1|2>', '脱敏档：0=仅URL/IP/key/路径 1=+包名类名方法名 2=最严(默认)', '2')
  .option('--max-consults <n>', '顾问调用次数上限（防无限求助循环）', '3')
  .allowExcessArguments(false);

await program.parseAsync(process.argv);
const opts = program.opts();

// 短路 --version（不 import 任何重模块）
// commander 自动处理 --version 退出

// 混合后端顾问参数（三种运行模式共用）：默认关，仅 --consult-cloud 时生效。
const advisorOpts = {
  consultCloud: !!opts['consultCloud'],
  advisorBackend: opts['advisorBackend'] as never,
  advisorModel: opts['advisorModel'] as string | undefined,
  advisorBaseURL: opts['advisorBaseUrl'] as string | undefined,
  advisorApiKey: opts['advisorApiKey'] as string | undefined,
  redactLevel: Number(opts['redactLevel']),
  maxConsults: Number(opts['maxConsults']),
};

// MCP server 模式优先：进 stdio loop 永不返回，直到 SIGTERM/SIGINT
if (opts['mcpServer']) {
  const { runMcpServer } = await import('./runtime/run-mcp-server.ts');
  const code = await runMcpServer({
    workdir: opts['workdir'] as string | undefined,
    allowWrite: !!opts['allowWrite'],
  });
  process.exit(code);
}

// Web 前端模式：起 HTTP+WS server 永不返回，直到 SIGTERM/SIGINT
if (opts['web']) {
  const { runWebServer } = await import('./runtime/run-web-server.ts');
  const port = typeof opts['web'] === 'string' ? Number(opts['web']) : 5178;
  const code = await runWebServer({
    backend: opts['backend'] as never,
    model: opts['model'] as string | undefined,
    baseURL: opts['baseUrl'] as string | undefined,
    apiKey: opts['apiKey'] as string | undefined,
    verbose: !!opts['verbose'],
    autoApprove: !!opts['autoApprove'],
    workdir: opts['workdir'] as string | undefined,
    budget: Number(opts['budget']),
    notesPath: opts['notes'] as string,
    port: Number.isFinite(port) ? port : 5178,
    ...advisorOpts,
  });
  process.exit(code);
}

// 懒加载重模块
const { runOnce } = await import('./runtime/run-once.ts');
const { runInteractive } = await import('./runtime/run-interactive.ts');

const resume = !!opts['resume'];
const taskText = (opts['once'] as string | undefined) ?? '';
// --once 或 --resume 都走非交互 runOnce（--resume 时 task 默认"继续"）；否则进 TUI。
const exitCode =
  taskText || resume
    ? await runOnce({
        task: taskText || (resume ? '继续' : ''),
        resume,
        backend: opts['backend'] as never,
        model: opts['model'] as string | undefined,
        baseURL: opts['baseUrl'] as string | undefined,
        apiKey: opts['apiKey'] as string | undefined,
        verbose: !!opts['verbose'],
        autoApprove: !!opts['autoApprove'],
        workdir: opts['workdir'] as string | undefined,
        corpus: opts['corpus'] as string | undefined,
        budget: Number(opts['budget']),
        notesPath: opts['notes'] as string,
        askWhenStuck: !!opts['askWhenStuck'],
        strategy: opts['strategy'] as string | undefined,
        ...advisorOpts,
      })
    : await runInteractive({
        resume,
        backend: opts['backend'] as never,
        model: opts['model'] as string | undefined,
        baseURL: opts['baseUrl'] as string | undefined,
        apiKey: opts['apiKey'] as string | undefined,
        verbose: !!opts['verbose'],
        autoApprove: !!opts['autoApprove'],
        workdir: opts['workdir'] as string | undefined,
        budget: Number(opts['budget']),
        notesPath: opts['notes'] as string,
        askWhenStuck: !!opts['askWhenStuck'],
        ...advisorOpts,
      });

process.exit(exitCode);
