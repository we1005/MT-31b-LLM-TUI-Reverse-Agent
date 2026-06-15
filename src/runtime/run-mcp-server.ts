/**
 * MCP server 模式：把 rev-agent 的 4 个工具暴露成 MCP server，让 Claude Code / Cursor / Continue.dev 通过 stdio 反向调用。
 *
 * 启动：bun src/index.tsx --mcp-server
 *
 * Claude Desktop 配置示例（~/Library/Application Support/Claude/claude_desktop_config.json）：
 * {
 *   "mcpServers": {
 *     "rev-agent": {
 *       "command": "bun",
 *       "args": ["/Users/admin/Desktop/personal/feishu-media-saver/reverse/snaptube/MT-NP管理器/rev-agent/src/index.tsx", "--mcp-server"]
 *     }
 *   }
 * }
 *
 * Cursor 配置：~/.cursor/mcp.json 同结构。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ToolRegistry } from '../tools/index.ts';

export interface RunMcpServerOpts {
  /** 工作目录，影响 read_file / grep 的相对路径 */
  workdir?: string;
  /** 是否允许 ask 类工具自动放行（MCP server 模式没有 UI 审批，必须显式开） */
  allowWrite?: boolean;
}

export async function runMcpServer(opts: RunMcpServerOpts = {}): Promise<number> {
  if (opts.workdir) process.chdir(opts.workdir);

  const server = new McpServer(
    {
      name: 'rev-agent',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
      instructions: [
        'rev-agent 是为安卓 APK 逆向场景设计的工具集。',
        '工具组：',
        '  - shell: 白名单 shell（仅 jadx/apktool/apkid/grep/adb/frida 等逆向工具，拒 rm -rf/sudo/curl）',
        '  - read_file: 强制 ≤ 200 行单次读',
        '  - grep: ripgrep 优先，硬限 ≤ 50 命中',
        '  - append_note: 写入 /tmp/work-notes.md',
        '使用纪律：永远先 grep/aapt2/apkid 拿摘要，再读单文件。看完整指南 Mac 安卓逆向工具与工作流指南.md。',
      ].join('\n'),
    },
  );

  const tools = new ToolRegistry();

  // 把每个 rev-agent Tool 注册成 MCP tool
  for (const name of tools.names()) {
    const t = tools.get(name)!;
    server.registerTool(
      t.name,
      {
        description: t.description,
        // MCP SDK 接受 Zod raw shape（不是 z.object 包装后的），从 Zod schema 派生
        // biome-ignore lint/suspicious/noExplicitAny: zod schema 跨工具异构
        inputSchema: (t.inputSchema as any)._def?.shape ?? {},
      },
      async (args: unknown) => {
        // 检查审批级别
        const approval = tools.classify(t.name, args);
        if (approval === 'deny') {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: `tool '${t.name}' classified as deny for these args` },
            ],
          };
        }
        if (approval === 'ask' && !opts.allowWrite) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `tool '${t.name}' is a write tool; rev-agent MCP server started without --allow-write; refusing.`,
              },
            ],
          };
        }

        const { result, error } = await tools.run(t.name, args);
        if (error) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `error: ${error}` }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 不要写 stderr 太多（MCP server 模式 stderr 会出现在 client 日志里）
  process.stderr.write(
    `[rev-agent mcp-server v0.2.0] ${tools.names().length} tools registered: ${tools.names().join(', ')}\n` +
      `  allow-write: ${opts.allowWrite ?? false}, workdir: ${opts.workdir ?? process.cwd()}\n`,
  );

  // 不主动 exit，靠 transport 关闭触发
  return new Promise<number>((resolve) => {
    process.on('SIGTERM', () => resolve(0));
    process.on('SIGINT', () => resolve(0));
  });
}

