/**
 * Minimal stateless MCP server over Streamable HTTP (JSON responses only).
 * Hand-rolled JSON-RPC so the transport has no dependencies and is easy to swap.
 */
import { ToolError, type Ctx } from './types';
import { TOOLS, callTool } from './tools';

const LATEST = '2025-06-18';
const SUPPORTED = [LATEST, '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  "This server is the user's personal memory: a vault of markdown notes. " +
  'At the start of a session call read_note with path "core/START-HERE.md" to learn who the user is and how they work. ' +
  'Use search before asking the user for facts. ' +
  'Write new notes only with write_note (inbox/agents/). ' +
  'When the user asks you to revise an existing note, use edit_note if the owner allows it, otherwise write a proposal to the inbox. ' +
  'Never include secrets.';

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const err = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

export async function handleMcp(req: Request, ctx: Ctx): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(err(null, -32700, 'Parse error'), 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(ctx, m as RpcMessage)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const res = await handleMessage(ctx, body as RpcMessage);
  return res ? json(res) : new Response(null, { status: 202 });
}

export async function handleMessage(ctx: Ctx, msg: RpcMessage): Promise<unknown | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return err(msg?.id, -32600, 'Invalid request');
  // Notifications and client responses carry no id (or no method): nothing to answer.
  if (msg.id === undefined || !msg.method) return null;
  const id = msg.id;

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : LATEST;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'memory-gateway', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string') return err(id, -32602, 'Missing tool name');
      try {
        const text = await callTool(ctx.env, ctx.agent, name, args);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      } catch (e) {
        if (e instanceof ToolError) {
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } };
        }
        console.error('tool failed', name, e);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'Internal error while running the tool.' }], isError: true },
        };
      }
    }
    default:
      return err(id, -32601, `Method not found: ${msg.method}`);
  }
}
