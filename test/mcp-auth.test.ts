import { describe, expect, it } from 'vitest';
import { authenticate, resolveAgent } from '../src/auth';
import { handleMcp } from '../src/mcp';
import { writeNote } from '../src/tools';
import type { Env } from '../src/types';

const env = {
  AGENT_TOKENS: JSON.stringify({ claude: 'claude-token-0123456789', hermes: 'hermes-token-0123456789', weak: 'short' }),
} as unknown as Env;

const rpc = (method: string, params?: unknown, id: number | undefined = 1) =>
  new Request('https://x.test/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

const ctx = { env, agent: 'claude' };

describe('auth', () => {
  it('resolves tokens to agent names', async () => {
    expect(await resolveAgent(env, 'claude-token-0123456789')).toBe('claude');
    expect(await resolveAgent(env, 'hermes-token-0123456789')).toBe('hermes');
    expect(await resolveAgent(env, 'nope')).toBeNull();
  });
  it('refuses tokens shorter than 16 characters', async () => {
    expect(await resolveAgent(env, 'short')).toBeNull();
  });
  it('accepts bearer header', async () => {
    const req = new Request('https://x.test/mcp', { headers: { authorization: 'Bearer claude-token-0123456789' } });
    expect(await authenticate(req, new URL(req.url), env)).toEqual({ agent: 'claude', pathname: '/mcp' });
  });
  it('accepts URL-prefix token and strips it', async () => {
    const req = new Request('https://x.test/t/hermes-token-0123456789/mcp');
    expect(await authenticate(req, new URL(req.url), env)).toEqual({ agent: 'hermes', pathname: '/mcp' });
  });
  it('rejects missing or wrong tokens', async () => {
    const a = new Request('https://x.test/mcp');
    const b = new Request('https://x.test/t/wrong-token-wrong-token/mcp');
    expect(await authenticate(a, new URL(a.url), env)).toBeNull();
    expect(await authenticate(b, new URL(b.url), env)).toBeNull();
  });
});

describe('mcp', () => {
  it('initializes and echoes a supported protocol version', async () => {
    const res = await handleMcp(rpc('initialize', { protocolVersion: '2025-03-26' }), ctx);
    const body = (await res.json()) as any;
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.serverInfo.name).toBe('memory-gateway');
    expect(body.result.instructions).toContain('core/START-HERE.md');
    expect(body.result.capabilities.tools).toBeDefined();
  });
  it('lists the four tools', async () => {
    const body = (await (await handleMcp(rpc('tools/list'), ctx)).json()) as any;
    expect(body.result.tools.map((t: any) => t.name)).toEqual(['read_note', 'search', 'list', 'write_note']);
  });
  it('answers ping', async () => {
    const body = (await (await handleMcp(rpc('ping'), ctx)).json()) as any;
    expect(body.result).toEqual({});
  });
  it('returns 202 for notifications', async () => {
    const res = await handleMcp(
      new Request('https://x.test/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
      ctx,
    );
    expect(res.status).toBe(202);
  });
  it('reports unknown methods and tools', async () => {
    const a = (await (await handleMcp(rpc('nope'), ctx)).json()) as any;
    expect(a.error.code).toBe(-32601);
    const b = (await (await handleMcp(rpc('tools/call', { name: 'nope', arguments: {} }), ctx)).json()) as any;
    expect(b.result.isError).toBe(true);
  });
  it('rejects non-POST and bad JSON', async () => {
    expect((await handleMcp(new Request('https://x.test/mcp'), ctx)).status).toBe(405);
    const bad = await handleMcp(new Request('https://x.test/mcp', { method: 'POST', body: '{' }), ctx);
    expect(bad.status).toBe(400);
  });
  it('rejects writes outside the inbox before touching storage', async () => {
    const body = (await (
      await handleMcp(rpc('tools/call', { name: 'write_note', arguments: { path: 'core/START-HERE.md', content: 'x' } }), ctx)
    ).json()) as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('inbox/agents/');
  });
  it('rejects path traversal', async () => {
    const body = (await (
      await handleMcp(rpc('tools/call', { name: 'read_note', arguments: { path: '../secret.md' } }), ctx)
    ).json()) as any;
    expect(body.result.isError).toBe(true);
  });
});

describe('writeNote overwrite', () => {
  const withNote = (text: string) =>
    ({ ...env, VAULT: { get: async () => ({ text: async () => text }) } }) as unknown as Env;
  it("refuses to overwrite another agent's draft or an owner note", async () => {
    const theirs = withNote('---\nstatus: draft\nwritten_by: hermes\n---\n# T');
    const owners = withNote('# Owner note, no stamp');
    for (const e of [theirs, owners]) {
      await expect(writeNote(e, 'claude', 'inbox/agents/x.md', '# new', true)).rejects.toMatchObject({ status: 403 });
    }
  });
  it('still refuses without overwrite', async () => {
    const mine = withNote('---\nwritten_by: claude\n---\n# T');
    await expect(writeNote(mine, 'claude', 'inbox/agents/x.md', '# new')).rejects.toMatchObject({ status: 409 });
  });
});
