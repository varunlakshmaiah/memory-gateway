import { ToolError, type Env, type R2Event } from './types';
import { agentExists, authenticate, isAdmin, tooMany, withinLimit } from './auth';
import { handleMcp } from './mcp';
import { handleApi } from './api';
import { audit, docsOn, indexNote, objectText, pruneAudit, reindex, removeNotes } from './indexer';
import { listVersions, snapshot } from './snapshot';
import { fromKey, toKey } from './keys';
import { isIndexable, normalizePath } from './notes';
import { restoreNote } from './tools';
import { authorize, oauthProvider } from './oauth';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import schema from '../schema.sql';

const STATEMENTS = schema
  .replace(/--.*$/gm, '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);
let schemaReady: Promise<unknown> | undefined;

/** Creates the index tables on first use (all IF NOT EXISTS), so a fresh deploy needs no migration step. */
function ensureSchema(env: Env): Promise<unknown> {
  return (schemaReady ??= env.DB.batch(STATEMENTS.map((s) => env.DB.prepare(s))).catch((e) => {
    schemaReady = undefined;
    throw e;
  }));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function handleAdmin(req: Request, url: URL, env: Env): Promise<Response> {
  if (!(await isAdmin(req, env))) return new Response('Unauthorized', { status: 401 });
  if (url.pathname === '/admin/reindex' && req.method === 'POST') {
    const max = Math.min(300, Number(url.searchParams.get('max') ?? 150) || 150);
    // full=1 marks every note stale, so all are re-embedded (after a chunking or model change). Resumable.
    if (url.searchParams.get('full') === '1') await env.DB.prepare("UPDATE notes SET etag = ''").run();
    const r = await reindex(env, max);
    await audit(env, 'admin', 'reindex', JSON.stringify(r));
    return json(r);
  }
  if (url.pathname === '/admin/snapshot' && req.method === 'POST') {
    const r = await snapshot(env);
    await audit(env, 'admin', 'snapshot', JSON.stringify(r));
    return json(r);
  }
  if (url.pathname === '/admin/status' && req.method === 'GET') {
    const n = await env.DB.prepare('SELECT COUNT(*) AS notes, MAX(indexed_at) AS last_indexed FROM notes').first();
    const a = await env.DB.prepare('SELECT ts, agent, action, path FROM audit ORDER BY id DESC LIMIT 15').all();
    return json({ index: n, recent_activity: a.results });
  }
  // Undo for agent edits: list a note's saved versions, or put one back.
  if (url.pathname === '/admin/versions' || url.pathname === '/admin/restore') {
    try {
      const path = normalizePath(url.searchParams.get('path'));
      if (req.method === 'GET' && url.pathname === '/admin/versions') {
        if (!env.BACKUP) throw new ToolError('No BACKUP bucket configured', 400);
        return json({ path, versions: await listVersions(env.BACKUP, path) });
      }
      if (req.method === 'POST' && url.pathname === '/admin/restore') {
        return json(await restoreNote(env, path, url.searchParams.get('version') ?? ''));
      }
    } catch (e) {
      if (e instanceof ToolError) return json({ error: e.message }, e.status);
      throw e;
    }
  }
  return json({ error: 'Not found' }, 404);
}

/** Applies one R2 event notification to the index. Safe to repeat. */
async function applyEvent(env: Env, ev: R2Event): Promise<void> {
  const key = ev.object?.key;
  if (!key) return;
  const path = fromKey(env, key);
  if (!path || !isIndexable(path, docsOn(env))) return;
  if (/^(DeleteObject|LifecycleDeletion)$/i.test(ev.action)) {
    await removeNotes(env, [path]);
    return;
  }
  const obj = await env.VAULT.get(toKey(env, path));
  if (!obj) {
    await removeNotes(env, [path]);
    return;
  }
  await indexNote(env, path, await objectText(env, path, obj), obj.etag, obj.size);
}

/** Everything except OAuth-protected /mcp: health, admin, consent page, static-token routes. */
const app = {
  async fetch(req: Request, env: Env & { OAUTH_PROVIDER?: OAuthHelpers }): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true });
    await ensureSchema(env);
    if (url.pathname.startsWith('/admin/')) return handleAdmin(req, url, env);
    if (url.pathname === '/authorize' && env.OAUTH_PROVIDER) return authorize(req, env as Env & { OAUTH_PROVIDER: OAuthHelpers });

    const auth = await authenticate(req, url, env);
    if (!auth && !(await withinLimit(env, req))) return tooMany();
    if (!auth) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    const ctx = { env, agent: auth.agent };

    if (auth.pathname === '/mcp') return handleMcp(req, ctx);
    if (auth.pathname.startsWith('/api/')) return handleApi(req, url, auth.pathname, ctx);
    return new Response('Not found', { status: 404 });
  },
};

/** /mcp with a token the OAuth provider checked: an OAuth grant or a static agent token. */
const mcp = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const agent = (ctx as unknown as { props: { agent: string } }).props.agent;
    // Removing an agent from AGENT_TOKENS also cuts off its OAuth grants.
    if (!agentExists(env, agent)) return new Response('Unauthorized', { status: 401 });
    await ensureSchema(env);
    return handleMcp(req, { env, agent });
  },
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname;
    // Every attempt at these counts, so token guessing and client-registration spam are capped per IP.
    const guarded = path.startsWith('/admin/') || path === '/register' || path === '/token' || (path === '/authorize' && req.method === 'POST');
    if (guarded && !(await withinLimit(env, req))) return tooMany();
    // OAuth is on when the OAUTH_KV namespace is bound; without it, static tokens only.
    if (!env.OAUTH_KV) return app.fetch(req, env);
    return oauthProvider(new URL(req.url).origin, app, mcp).fetch(req, env, ctx);
  },

  /** R2 event notifications arrive here through the vault-events queue. */
  async queue(batch: MessageBatch<R2Event>, env: Env): Promise<void> {
    await ensureSchema(env);
    for (const msg of batch.messages) {
      try {
        await applyEvent(env, msg.body);
        msg.ack();
      } catch (e) {
        console.error('event failed', e);
        msg.retry();
      }
    }
  },

  /** Nightly: heal the index (covers any missed event), take the snapshot, trim the audit log. */
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env);
        console.log('reindex', JSON.stringify(await reindex(env)));
        console.log('snapshot', JSON.stringify(await snapshot(env)));
        console.log('audit pruned', await pruneAudit(env));
      })(),
    );
  },
} satisfies ExportedHandler<Env, R2Event>;
