import type { Env } from './types';
import { buildFtsQuery, isIndexable, parseNote } from './notes';
import { fromKey, toKey, vaultPrefix } from './keys';

export interface SearchHit {
  path: string;
  title: string;
  description: string;
  status: string;
  type: string;
  updated: string;
  snippet: string;
}

const EMBED_MODEL = '@cf/baai/bge-m3';
// shortcut: one vector per note from its first 8000 characters; chunk notes if long ones stop being found by meaning.
const EMBED_CHARS = 8000;
// Cosine similarity below this is noise (unrelated queries still return nearest neighbours).
// shortcut: tuned on a 111-note vault (nonsense tops out ~0.43, right notes 0.49-0.68); re-probe as the vault grows.
const MIN_SIMILARITY = 0.45;

// Local `wrangler dev` has a VEC binding that throws, so .dev.vars turns semantic search off there.
const semanticOn = (env: Env) => !!(env.AI && env.VEC) && env.SEMANTIC_SEARCH !== 'off';

async function embed(env: Env, text: string): Promise<number[]> {
  const r = (await env.AI!.run(EMBED_MODEL, { text: [text] })) as { data: number[][] };
  return r.data[0];
}

/** Vectorize ids are capped at 64 bytes, paths are not, so the id is the path's SHA-256. */
async function vecId(path: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reciprocal rank fusion: merges ranked path lists; a path ranked well in either list rises. */
export function fuse(...lists: string[][]): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((p, i) => score.set(p, (score.get(p) ?? 0) + 1 / (60 + i)));
  return [...score].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

export async function indexNote(
  env: Env,
  path: string,
  text: string,
  etag: string,
  size: number,
): Promise<void> {
  const n = parseNote(path, text);
  // Vector first: if it fails, the D1 etag stays stale, so the event retry or nightly reindex tries again.
  if (semanticOn(env)) {
    const values = await embed(env, `${n.title}\n${n.description}\n${n.body}`.slice(0, EMBED_CHARS));
    await env.VEC!.upsert([{ id: await vecId(path), values, metadata: { path } }]);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM notes_fts WHERE path = ?').bind(path),
    env.DB.prepare('DELETE FROM notes WHERE path = ?').bind(path),
    env.DB.prepare(
      'INSERT INTO notes (path, title, description, type, status, updated, supersedes, etag, size, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).bind(path, n.title, n.description, n.type, n.status, n.updated, n.supersedes, etag, size, new Date().toISOString()),
    env.DB.prepare('INSERT INTO notes_fts (path, title, description, body) VALUES (?,?,?,?)').bind(
      path,
      n.title,
      n.description,
      n.body,
    ),
  ]);
}

export async function removeNotes(env: Env, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 40) {
    const chunk = paths.slice(i, i + 40);
    if (semanticOn(env)) await env.VEC!.deleteByIds(await Promise.all(chunk.map(vecId)));
    await env.DB.batch(
      chunk.flatMap((p) => [
        env.DB.prepare('DELETE FROM notes_fts WHERE path = ?').bind(p),
        env.DB.prepare('DELETE FROM notes WHERE path = ?').bind(p),
      ]),
    );
  }
}

function likePrefix(folder: string): string {
  const f = folder.replace(/^\/+|\/+$/g, '');
  return f.replace(/[\\%_]/g, (c) => '\\' + c) + '/%';
}

export async function searchIndex(
  env: Env,
  query: string,
  opts: { limit: number; folder?: string },
): Promise<SearchHit[]> {
  const folder = opts.folder?.trim();
  const fetchN = Math.min(60, opts.limit * 3);
  const sql =
    `SELECT n.path, n.title, n.description, n.status, n.type, n.updated,
            snippet(notes_fts, 3, '[', ']', '...', 20) AS snippet,
            bm25(notes_fts, 0.0, 5.0, 3.0, 1.0) AS score
       FROM notes_fts JOIN notes n ON n.path = notes_fts.path
      WHERE notes_fts MATCH ?` +
    (folder ? " AND n.path LIKE ? ESCAPE '\\'" : '') +
    ' ORDER BY score LIMIT ?';
  const run = async (fts: string): Promise<SearchHit[]> => {
    const binds: (string | number)[] = [fts];
    if (folder) binds.push(likePrefix(folder));
    binds.push(fetchN);
    return (await env.DB.prepare(sql).bind(...binds).all<SearchHit>()).results ?? [];
  };
  // Notes containing every term rank first; if that is too few, widen to any term.
  const andQ = buildFtsQuery(query, 'AND');
  if (!andQ) return [];
  const [kw, sem] = await Promise.all([
    (async () => {
      const rows = await run(andQ);
      if (rows.length < opts.limit) {
        const seen = new Set(rows.map((r) => r.path));
        const orQ = buildFtsQuery(query, 'OR');
        if (orQ && orQ !== andQ) for (const r of await run(orQ)) if (!seen.has(r.path)) rows.push(r);
      }
      return rows;
    })(),
    semanticPaths(env, query, folder),
  ]);
  const byPath = new Map(kw.map((r) => [r.path, r]));
  const missing = sem.filter((p) => !byPath.has(p));
  if (missing.length) {
    const extra = await env.DB.prepare(
      `SELECT path, title, description, status, type, updated, '' AS snippet FROM notes WHERE path IN (${missing.map(() => '?').join(',')})`,
    )
      .bind(...missing)
      .all<SearchHit>();
    for (const r of extra.results ?? []) byPath.set(r.path, r);
  }
  const rows = fuse(
    kw.map((r) => r.path),
    sem,
  ).flatMap((p) => byPath.get(p) ?? []);
  // Relevance order with small penalties: outdated and draft notes, archive/ and journal/ (history and
  // low-signal) and folder maps (README.md) stay findable but rank below an equally relevant current note.
  const penalty = (r: SearchHit) =>
    (r.status === 'outdated' || r.path.startsWith('archive/') ? 3 : r.status === 'draft' ? 1 : 0) +
    (r.path.startsWith('journal/') ? 2 : 0) +
    (r.path.endsWith('README.md') ? 2 : 0);
  return rows
    .map((r, i) => ({ r, k: i + penalty(r) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, opts.limit)
    .map(({ r }) => r);
}

/** Paths of the notes closest in meaning to the query. Fails soft to [] so search degrades to keyword-only. */
async function semanticPaths(env: Env, query: string, folder?: string): Promise<string[]> {
  if (!semanticOn(env)) return [];
  try {
    // topK 20 is Vectorize's cap when returning metadata.
    // shortcut: folder is filtered after the top 20, so a folder search can miss in-folder matches; add a folder metadata index if it does.
    const r = await env.VEC!.query(await embed(env, query), { topK: 20, returnMetadata: 'all' });
    const prefix = folder ? folder.replace(/^\/+|\/+$/g, '') + '/' : '';
    return r.matches
      .filter((m) => m.score >= MIN_SIMILARITY)
      .map((m) => String(m.metadata?.path ?? ''))
      .filter((p) => p && p.startsWith(prefix));
  } catch (e) {
    console.error('semantic search failed', e);
    return [];
  }
}

export interface ListRow {
  path: string;
  description: string;
  status: string;
}

export async function listFolders(
  env: Env,
): Promise<{ folders: { folder: string; count: number }[]; rootNotes: ListRow[] }> {
  const f = await env.DB.prepare(
    `SELECT substr(path, 1, instr(path, '/') - 1) AS folder, COUNT(*) AS count
       FROM notes WHERE instr(path, '/') > 0 GROUP BY folder ORDER BY folder`,
  ).all<{ folder: string; count: number }>();
  const r = await env.DB.prepare(
    "SELECT path, description, status FROM notes WHERE instr(path, '/') = 0 ORDER BY path",
  ).all<ListRow>();
  return { folders: f.results ?? [], rootNotes: r.results ?? [] };
}

export async function listFolder(env: Env, folder: string): Promise<ListRow[]> {
  const res = await env.DB.prepare(
    "SELECT path, description, status FROM notes WHERE path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 300",
  )
    .bind(likePrefix(folder))
    .all<ListRow>();
  return res.results ?? [];
}

export async function audit(env: Env, agent: string, action: string, path = ''): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO audit (ts, agent, action, path) VALUES (?,?,?,?)')
      .bind(new Date().toISOString(), agent, action, path)
      .run();
  } catch (e) {
    console.error('audit failed', e);
  }
}

/** Keeps the audit log to the last `days` days. ISO timestamps sort as text. */
export async function pruneAudit(env: Env, days = 90): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const r = await env.DB.prepare('DELETE FROM audit WHERE ts < ?').bind(cutoff).run();
  return r.meta.changes ?? 0;
}

export interface ReindexResult {
  total: number;
  indexed: number;
  removed: number;
  remaining: number;
}

/**
 * Rebuilds the index from R2: indexes new or changed notes (compared by etag),
 * removes index rows whose file is gone. Bounded per call, so re-run while `remaining` > 0.
 */
export async function reindex(env: Env, maxFetch = 150): Promise<ReindexResult> {
  const prefix = vaultPrefix(env);
  const keys = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const l = await env.VAULT.list({ prefix: prefix || undefined, cursor, limit: 1000 });
    for (const o of l.objects) {
      const p = fromKey(env, o.key);
      if (p && isIndexable(p)) keys.set(p, o.etag);
    }
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);

  const rows = await env.DB.prepare('SELECT path, etag FROM notes').all<{ path: string; etag: string }>();
  const indexed = new Map((rows.results ?? []).map((r) => [r.path, r.etag]));
  const stale = [...keys].filter(([p, etag]) => indexed.get(p) !== etag).map(([p]) => p);
  const gone = [...indexed.keys()].filter((p) => !keys.has(p));

  if (gone.length) await removeNotes(env, gone);

  let done = 0;
  for (const p of stale.slice(0, maxFetch)) {
    const o = await env.VAULT.get(toKey(env, p));
    if (!o) {
      await removeNotes(env, [p]);
      continue;
    }
    await indexNote(env, p, await o.text(), o.etag, o.size);
    done++;
  }
  return { total: keys.size, indexed: done, removed: gone.length, remaining: Math.max(0, stale.length - done) };
}
