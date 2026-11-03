import { ToolError, type Env, type R2Event } from './types';
import { authenticate, isAdmin } from './auth';
import { handleMcp } from './mcp';
import { handleApi } from './api';
import { audit, indexNote, pruneAudit, reindex, removeNotes } from './indexer';
import { listVersions, snapshot } from './snapshot';
import { fromKey, toKey } from './keys';
import { isIndexable, normalizePath } from './notes';
import { restoreNote } from './tools';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function handleAdmin(req: Request, url: URL, env: Env): Promise<Response> {
  if (!(await isAdmin(req, env))) return new Response('Unauthorized', { status: 401 });
  if (url.pathname === '/admin/reindex' && req.method === 'POST') {
    const max = Math.min(300, Number(url.searchParams.get('max') ?? 150) || 150);
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
  if (!path || !isIndexable(path)) return;
  if (/^(DeleteObject|LifecycleDeletion)$/i.test(ev.action)) {
    await removeNotes(env, [path]);
    return;
  }
  const obj = await env.VAULT.get(toKey(env, path));
  if (!obj) {
    await removeNotes(env, [path]);
    return;
  }
  await indexNote(env, path, await obj.text(), obj.etag, obj.size);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname.startsWith('/admin/')) return handleAdmin(req, url, env);

    const auth = await authenticate(req, url, env);
    if (!auth) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    const ctx = { env, agent: auth.agent };

    if (auth.pathname === '/mcp') return handleMcp(req, ctx);
    if (auth.pathname.startsWith('/api/')) return handleApi(req, url, auth.pathname, ctx);
    return new Response('Not found', { status: 404 });
  },

  /** R2 event notifications arrive here through the vault-events queue. */
  async queue(batch: MessageBatch<R2Event>, env: Env): Promise<void> {
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
        console.log('reindex', JSON.stringify(await reindex(env)));
        console.log('snapshot', JSON.stringify(await snapshot(env)));
        console.log('audit pruned', await pruneAudit(env));
      })(),
    );
  },
} satisfies ExportedHandler<Env, R2Event>;
