/**
 * The whole memory interface: four operations. Transport-agnostic.
 * MCP, REST or any future protocol only has to call these functions.
 */
import { ToolError, type Env } from './types';
import { agentStamp, normalizePath, requireMarkdown, stampNote, writtenBy } from './notes';
import { today, toKey, writePrefix } from './keys';
import {
  audit,
  indexNote,
  listFolder,
  listFolders,
  searchIndex,
  type ListRow,
  type SearchHit,
} from './indexer';

export async function readNote(env: Env, rawPath: unknown): Promise<{ path: string; text: string }> {
  const path = requireMarkdown(normalizePath(rawPath));
  const obj = await env.VAULT.get(toKey(env, path));
  if (!obj) throw new ToolError(`Note not found: ${path}. Use search or list to find the right path.`, 404);
  return { path, text: await obj.text() };
}

export async function searchNotes(
  env: Env,
  args: { query?: unknown; limit?: unknown; folder?: unknown },
): Promise<SearchHit[]> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new ToolError('query is required');
  const limit = Math.min(20, Math.max(1, Number.isFinite(Number(args.limit)) ? Number(args.limit) : 8));
  const folder = typeof args.folder === 'string' ? args.folder : undefined;
  return searchIndex(env, query, { limit, folder });
}

export type ListResult =
  | { folders: { folder: string; count: number }[]; rootNotes: ListRow[] }
  | { folder: string; notes: ListRow[] };

export async function listNotes(env: Env, folder?: unknown): Promise<ListResult> {
  const f = typeof folder === 'string' ? folder.trim().replace(/^\/+|\/+$/g, '') : '';
  if (!f) return listFolders(env);
  normalizePath(f);
  return { folder: f, notes: await listFolder(env, f) };
}

export async function writeNote(
  env: Env,
  agent: string,
  rawPath: unknown,
  content: unknown,
  overwrite = false,
): Promise<{ path: string; created: boolean }> {
  const path = requireMarkdown(normalizePath(rawPath));
  const allowed = writePrefix(env);
  if (!path.startsWith(allowed)) {
    throw new ToolError(
      `Agents may only write under ${allowed}. Put the note at ${allowed}${path.split('/').pop()} and the owner will promote it.`,
      403,
    );
  }
  if (typeof content !== 'string' || !content.trim()) throw new ToolError('content is required');
  const max = Number(env.MAX_NOTE_BYTES ?? 200000);
  if (new TextEncoder().encode(content).length > max) throw new ToolError(`Note is larger than ${max} bytes`, 413);

  const key = toKey(env, path);
  const existing = await env.VAULT.get(key);
  if (existing && !overwrite) {
    throw new ToolError(`${path} already exists. Choose a new name, or pass overwrite: true to replace your own note.`, 409);
  }
  if (existing && writtenBy(await existing.text()) !== agentStamp(agent)) {
    throw new ToolError(`${path} was not written by you, so it cannot be overwritten. Choose a new name.`, 403);
  }
  const final = stampNote(content, agent, today());
  const put = await env.VAULT.put(key, final, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
  // Index straight away; the R2 event arrives later and is a harmless no-op repeat.
  await indexNote(env, path, final, put.etag, put.size);
  await audit(env, agent, existing ? 'overwrite' : 'create', path);
  return { path, created: !existing };
}

// ---------- text formatting for MCP ----------

export function formatSearch(query: string, hits: SearchHit[]): string {
  if (!hits.length) {
    return `No notes matched "${query}". Try different keywords, or use the list tool to browse folders.`;
  }
  const lines = [`Found ${hits.length} note(s) for "${query}":`];
  hits.forEach((h, i) => {
    const flag = h.status && h.status !== 'current' ? ` [${h.status}]` : '';
    lines.push(`${i + 1}. ${h.path} - ${h.title}${flag}`);
    if (h.description) lines.push(`   ${h.description}`);
    if (h.snippet) lines.push(`   ...${h.snippet.replace(/\s+/g, ' ')}`);
  });
  lines.push('', 'Open a note with read_note. Notes marked outdated or draft are not authoritative.');
  return lines.join('\n');
}

export function formatList(r: ListResult): string {
  if ('folders' in r) {
    const lines = ['Vault folders:'];
    for (const f of r.folders) lines.push(`- ${f.folder}/ (${f.count} notes)`);
    if (r.rootNotes.length) {
      lines.push('', 'Notes at the root:');
      for (const n of r.rootNotes) lines.push(`- ${n.path}${n.description ? ' - ' + n.description : ''}`);
    }
    lines.push('', 'Call list with a folder name to see its notes.');
    return lines.join('\n');
  }
  if (!r.notes.length) return `No notes under ${r.folder}/.`;
  const lines = [`Notes under ${r.folder}/ (${r.notes.length}):`];
  for (const n of r.notes) {
    const flag = n.status && n.status !== 'current' ? ` [${n.status}]` : '';
    lines.push(`- ${n.path}${flag}${n.description ? ' - ' + n.description : ''}`);
  }
  return lines.join('\n');
}

// ---------- tool registry used by the MCP transport ----------

export const TOOLS = [
  {
    name: 'read_note',
    description:
      "Read one note from the user's markdown memory vault. Start every session by reading `core/START-HERE.md`, which explains who the user is, how they like you to work, and how the vault is organised.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative path, for example "core/START-HERE.md"' } },
      required: ['path'],
    },
    annotations: { title: 'Read note', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search',
    description:
      "Search the user's vault by keywords and by meaning. Search here before asking the user a question. Returns paths, one-line descriptions and snippets. Notes marked outdated or draft are not authoritative.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or a short question, for example "NAS IP address"' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results, default 8' },
        folder: { type: 'string', description: 'Optional folder to restrict the search, for example "infra"' },
      },
      required: ['query'],
    },
    annotations: { title: 'Search vault', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list',
    description:
      'Browse the vault. With no folder it returns the top-level folders with note counts; with a folder it returns that folder\'s notes with one-line descriptions.',
    inputSchema: {
      type: 'object',
      properties: { folder: { type: 'string', description: 'Folder to list, for example "projects". Omit for the top level.' } },
    },
    annotations: { title: 'List notes', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'write_note',
    description:
      'Save a new note. Agents can only write inside the inbox folder (inbox/agents/); the owner reviews and promotes notes later. Notes are saved as drafts. To revise a fact, write a new note and set `supersedes:` in its frontmatter to the old path instead of overwriting. Never include passwords, keys or tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path under inbox/agents/, for example "inbox/agents/2026-11-03-dns-plan.md"' },
        content: { type: 'string', description: 'Markdown. Start with a heading; add a one-line `description:` in frontmatter if you can.' },
        overwrite: { type: 'boolean', description: 'Replace your own earlier note at this path. Default false.' },
      },
      required: ['path', 'content'],
    },
    annotations: { title: 'Write note to inbox', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
] as const;

export async function callTool(env: Env, agent: string, name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'read_note':
      return (await readNote(env, args.path)).text;
    case 'search': {
      const hits = await searchNotes(env, args);
      return formatSearch(String(args.query ?? ''), hits);
    }
    case 'list':
      return formatList(await listNotes(env, args.folder));
    case 'write_note': {
      const r = await writeNote(env, agent, args.path, args.content, args.overwrite === true);
      return `${r.created ? 'Saved' : 'Replaced'} ${r.path} as a draft. It will appear in Obsidian on the owner's devices at their next sync.`;
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}
