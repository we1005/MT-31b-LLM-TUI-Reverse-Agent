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
  .option('--allow-write', 'MCP server 模式下放行 write 类工具（默认拒）')
  .option('--ask-when-stuck', '原地打转时不强制猜答案，改为输出困境报告求思路（TUI 粘贴续跑 / --once 输出报告并 exit=3）')
  .option('--strategy <text>', '（配合 --once）注入用户/更强模型给的分析思路，让 agent 按此重新分析（承接上一轮 exit=3 的困境报告）')
  .allowExcessArguments(false);

await program.parseAsync(process.argv);
const opts = program.opts();

// 短路 --version（不 import 任何重模块）
// commander 自动处理 --version 退出

// MCP server 模式优先：进 stdio loop 永不返回，直到 SIGTERM/SIGINT
if (opts['mcpServer']) {
  const { runMcpServer } = await import('./runtime/run-mcp-server.ts');
  const code = await runMcpServer({
    workdir: opts['workdir'] as string | undefined,
    allowWrite: !!opts['allowWrite'],
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
      });

process.exit(exitCode);
