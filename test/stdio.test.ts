/**
 * The real stdio entry point (src/mcp-main.ts) as an MCP client would spawn it,
 * with the API pointed at a closed port so nothing leaves the machine: malformed
 * lines are answered with JSON-RPC errors instead of being dropped (2026-10-15.13),
 * initialize is not required before a request, and
 * the resources are served without any network.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/mcp-main.ts', import.meta.url));

type Reply = { jsonrpc: '2.0'; id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

/** Writes the lines, waits for `expected` replies (or 4 s), kills the child and returns the parsed replies. */
async function exchange(lines: string[], expected: number): Promise<{ replies: Reply[]; stderr: string }> {
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', entry], {
    env: { PATH: process.env.PATH, BOUNTYMARKET_API_URL: 'http://127.0.0.1:9' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const replies = await new Promise<Reply[]>((resolve) => {
    const done = () => {
      const parsed = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Reply);
      resolve(parsed);
    };
    const timer = setTimeout(done, 4000);
    child.stdout.on('data', () => {
      if (out.split('\n').filter((l) => l.trim()).length >= expected) { clearTimeout(timer); done(); }
    });
    child.stdin.write(`${lines.join('\n')}\n`);
  });
  child.kill();
  return { replies, stderr: err };
}

describe('stdio server: malformed lines, no-initialize calls, resources (no network)', () => {
  it('answers -32700 for a line that is not JSON and -32600 for JSON that is not one JSON-RPC object, then keeps serving', async () => {
    const { replies, stderr } = await exchange([
      '{bad json',
      '[]',
      '"ping"',
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    ], 4);
    assert.deepEqual(replies[0], { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the line is not JSON.' } });
    assert.deepEqual(replies[1], { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: expected one JSON-RPC 2.0 object per line (no batch arrays).' } });
    assert.deepEqual(replies[2], replies[1]);
    assert.deepEqual(replies[3], { jsonrpc: '2.0', id: 1, result: {} });
    assert.match(stderr, /bountymarket-mcp .*read-only, no key/);
    assert.doesNotMatch(stderr, /bhk_/);
  });

  it('serves tools/list and the guides before any initialize (soft enforcement, as the hosted endpoint) and without a request', async () => {
    const { replies } = await exchange([
      '{"jsonrpc":"2.0","id":"t","method":"tools/list"}',
      '{"jsonrpc":"2.0","id":"r","method":"resources/read","params":{"uri":"bountymarket://guide/errors"}}',
      '{"jsonrpc":"2.0","id":"g","method":"tools/call","params":{"name":"get_rules","arguments":{"guide":"waiting"}}}',
    ], 3);
    const byId = Object.fromEntries(replies.map((r) => [String(r.id), r]));
    const tools = byId.t!.result!.tools as Array<{ name: string }>;
    assert.deepEqual(tools.map((t) => t.name), ['get_marketplace_capabilities', 'search_tasks', 'get_task', 'get_rules']);
    assert.ok(Buffer.byteLength(JSON.stringify(byId.t!.result)) < 2500, 'four read-only tools under 2.5 KB');
    const contents = byId.r!.result!.contents as Array<{ uri: string; text: string }>;
    assert.equal(contents[0]!.uri, 'bountymarket://guide/errors');
    assert.match(contents[0]!.text, /^# Errors and limits/);
    const call = byId.g!.result as { content: Array<{ type: string; text: string }>; structuredContent?: unknown };
    assert.equal(call.structuredContent, undefined, 'one representation');
    assert.match(JSON.parse(call.content[0]!.text).guide.text, /^# Waiting and events/);
  });
});
