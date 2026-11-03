/** Plain HTTP binding for agents without MCP. Same operations, same auth. */
import { ToolError, type Ctx } from './types';
import { editNote, listNotes, readNote, searchNotes, writeNote } from './tools';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handleApi(req: Request, url: URL, pathname: string, ctx: Ctx): Promise<Response> {
  try {
    if (pathname === '/api/search' && req.method === 'GET') {
      const hits = await searchNotes(ctx.env, {
        query: url.searchParams.get('q'),
        limit: url.searchParams.get('limit'),
        folder: url.searchParams.get('folder'),
      });
      return json({ results: hits });
    }
    if (pathname === '/api/list' && req.method === 'GET') {
      return json(await listNotes(ctx.env, url.searchParams.get('folder') ?? ''));
    }
    if (pathname.startsWith('/api/notes/')) {
      let path: string;
      try {
        path = decodeURIComponent(pathname.slice('/api/notes/'.length));
      } catch {
        throw new ToolError('Invalid path encoding');
      }
      if (req.method === 'GET') {
        const r = await readNote(ctx.env, path);
        return new Response(r.text, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
      }
      if (req.method === 'PUT') {
        const overwrite = url.searchParams.get('overwrite') === 'true';
        const r = await writeNote(ctx.env, ctx.agent, path, await req.text(), overwrite);
        return json(r, r.created ? 201 : 200);
      }
      if (req.method === 'PATCH') {
        let body: { old_text?: unknown; new_text?: unknown };
        try {
          body = await req.json();
        } catch {
          throw new ToolError('Body must be JSON: {"old_text": "...", "new_text": "..."}');
        }
        return json(await editNote(ctx.env, ctx.agent, path, body.old_text, body.new_text));
      }
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    if (e instanceof ToolError) return json({ error: e.message }, e.status);
    console.error('api failed', e);
    return json({ error: 'Internal error' }, 500);
  }
}
