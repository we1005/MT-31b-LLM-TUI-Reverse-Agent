#!/usr/bin/env bun
/**
 * MCP server 端到端测试：spawn `bun src/index.tsx --mcp-server`，跟它握手 + tools/list + tools/call。
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const child = spawn('bun', [resolve(root, 'src/index.tsx'), '--mcp-server'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map<number, (r: unknown) => void>();
let nextId = 1;

child.stdout.on('data', (chunk: Buffer) => {
  buf += chunk.toString();
  // 按 newline 分帧（MCP stdio 是 newline-delimited JSON）
  for (;;) {
    const i = buf.indexOf('\n');
    if (i < 0) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      } else {
        console.error('[notice]', msg);
      }
    } catch (e) {
      console.error('[parse error]', line, e);
    }
  }
});

child.stderr.on('data', (c: Buffer) => process.stderr.write(`[server] ${c.toString()}`));

function send(method: string, params: unknown, isNotification = false): Promise<unknown> {
  const id = isNotification ? undefined : nextId++;
  const req = { jsonrpc: '2.0' as const, ...(id !== undefined && { id }), method, params };
  child.stdin.write(`${JSON.stringify(req)}\n`);
  if (id === undefined) return Promise.resolve(undefined);
  return new Promise<unknown>((resolve) => pending.set(id, resolve));
}

async function main() {
  console.log('── 1. initialize ──');
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'rev-agent-self-test', version: '0.2.0' },
  });
  console.log(JSON.stringify(init, null, 2));

  console.log('\n── 2. notifications/initialized ──');
  await send('notifications/initialized', {}, true);

  console.log('\n── 3. tools/list ──');
  const list = (await send('tools/list', {})) as {
    result?: { tools: Array<{ name: string; description: string }> };
  };
  const tools = list.result?.tools ?? [];
  console.log(`  ${tools.length} tools:`);
  for (const t of tools) {
    console.log(`    - ${t.name}: ${t.description.slice(0, 60)}...`);
  }

  console.log('\n── 4. tools/call shell（白名单内）──');
  const r1 = await send('tools/call', {
    name: 'shell',
    arguments: { cmd: 'echo hello-from-mcp', timeoutMs: 2000 },
  });
  console.log(JSON.stringify(r1, null, 2).slice(0, 500));

  console.log('\n── 5. tools/call shell（黑名单：应拒）──');
  const r2 = await send('tools/call', {
    name: 'shell',
    arguments: { cmd: 'rm -rf /tmp/xx' },
  });
  console.log(JSON.stringify(r2, null, 2).slice(0, 500));

  console.log('\n── 6. tools/call append_note（write 类，没 --allow-write 应拒）──');
  const r3 = await send('tools/call', {
    name: 'append_note',
    arguments: { section: 'test', content: 'should be refused' },
  });
  console.log(JSON.stringify(r3, null, 2).slice(0, 500));

  console.log('\n✓ all roundtrips passed');
  child.kill('SIGTERM');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL:', e);
  child.kill('SIGTERM');
  process.exit(1);
});
