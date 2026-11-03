/**
 * The whole memory interface: four operations. Transport-agnostic.
 * MCP, REST or any future protocol only has to call these functions.
 */
import { ToolError, type Env } from './types';
import { agentStamp, canEdit, docType, isLocked, normalizePath, requireMarkdown, stampEdit, stampNote, writtenBy } from './notes';
import { today, toKey, writePrefix } from './keys';
import { readVersion, saveVersion } from './snapshot';
import {
  audit,
  backlinks,
  indexNote,
  listFolder,
  listFolders,
  searchIndex,
  type ListRow,
  type SearchHit,
} from './indexer';

export async function readNote(env: Env, rawPath: unknown): Promise<{ path: string; text: string }> {
  const raw = normalizePath(rawPath);
  // Documents (PDF, Word, Excel) are read as the text the index converted them to.
  if (docType(raw)) {
    const row = await env.DB.prepare('SELECT body FROM notes_fts WHERE path = ?').bind(raw).first<{ body: string }>();
    if (!row) throw new ToolError(`Document not found or not indexed yet: ${raw}.`, 404);
    return { path: raw, text: row.body };
  }
  const path = requireMarkdown(raw);
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
  const inInbox = path.startsWith(allowed);
  // Outside the inbox, an agent may create notes only where EDIT_POLICY lets it edit.
  if (!inInbox && !canEdit(env.EDIT_POLICY, agent, path)) {
    throw new ToolError(
      `You may not create notes in ${path.split('/').slice(0, -1).join('/') || 'the vault root'}. Put the note at ${allowed}${path.split('/').pop()} and the owner will promote it.`,
      403,
    );
  }
  if (typeof content !== 'string' || !content.trim()) throw new ToolError('content is required');
  const max = Number(env.MAX_NOTE_BYTES ?? 200000);
  if (new TextEncoder().encode(content).length > max) throw new ToolError(`Note is larger than ${max} bytes`, 413);

  const key = toKey(env, path);
  const existing = await env.VAULT.get(key);
  // Outside the inbox, existing notes change only through edit_note, which saves the previous version.
  if (existing && !inInbox) throw new ToolError(`${path} already exists. Use edit_note to change it.`, 409);
  if (existing && !overwrite) {
    throw new ToolError(`${path} already exists. Choose a new name, or pass overwrite: true to replace your own note.`, 409);
  }
  if (existing && writtenBy(await existing.text()) !== agentStamp(agent)) {
    throw new ToolError(`${path} was not written by you, so it cannot be overwritten. Choose a new name.`, 403);
  }
  const final = stampNote(content, agent, today(), inInbox);
  const put = await env.VAULT.put(key, final, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
  // Index straight away; the R2 event arrives later and is a harmless no-op repeat.
  await indexNote(env, path, final, put.etag, put.size);
  await audit(env, agent, existing ? 'overwrite' : 'create', path);
  return { path, created: !existing };
}

/**
 * Replaces one exact passage in an existing note, if EDIT_POLICY allows this agent to edit that folder.
 * old_text must occur exactly once, which also catches edits made since the agent read the note.
 * The previous version is saved to the BACKUP bucket first, so every edit can be undone.
 */
export async function editNote(
  env: Env,
  agent: string,
  rawPath: unknown,
  oldText: unknown,
  newText: unknown,
): Promise<{ path: string; version: string }> {
  const path = requireMarkdown(normalizePath(rawPath));
  if (!canEdit(env.EDIT_POLICY, agent, path)) {
    throw new ToolError(
      `You are not allowed to edit ${path}. Write a proposal with write_note under ${writePrefix(env)} instead; the owner will apply it.`,
      403,
    );
  }
  if (!env.BACKUP) throw new ToolError('Editing is disabled: no BACKUP bucket is configured to keep previous versions.', 403);
  if (typeof oldText !== 'string' || !oldText) throw new ToolError('old_text is required: the exact passage to replace');
  if (typeof newText !== 'string') throw new ToolError('new_text is required (use "" to remove the passage)');

  const key = toKey(env, path);
  const obj = await env.VAULT.get(key);
  if (!obj) throw new ToolError(`Note not found: ${path}. edit_note only changes existing notes; use write_note for new ones.`, 404);
  const text = await obj.text();
  if (isLocked(text)) throw new ToolError(`${path} is locked by the owner (locked: true) and cannot be edited.`, 403);

  const at = text.indexOf(oldText);
  if (at < 0) throw new ToolError(`old_text was not found in ${path}. The note may have changed; read it again.`, 409);
  if (text.indexOf(oldText, at + 1) >= 0) {
    throw new ToolError('old_text matches more than once. Include more surrounding text so it is unique.', 409);
  }
  const final = stampEdit(text.slice(0, at) + newText + text.slice(at + oldText.length), agent, today());
  const max = Number(env.MAX_NOTE_BYTES ?? 200000);
  if (new TextEncoder().encode(final).length > max) throw new ToolError(`Note would be larger than ${max} bytes`, 413);

  const version = await saveVersion(env.BACKUP, path, text);
  // Conditional put: refuse if the note changed between our read and this write.
  const put = await env.VAULT.put(key, final, {
    onlyIf: { etagMatches: obj.etag },
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  });
  if (!put) throw new ToolError(`${path} changed while editing. Read it again and retry.`, 409);
  await indexNote(env, path, final, put.etag, put.size);
  await audit(env, agent, 'edit', path);
  return { path, version };
}

/** Owner-only (admin route): puts a saved version back. The current text is saved as a version first. */
export async function restoreNote(env: Env, rawPath: unknown, version: string): Promise<{ path: string; restored: string }> {
  const path = requireMarkdown(normalizePath(rawPath));
  if (!env.BACKUP) throw new ToolError('No BACKUP bucket configured', 400);
  const old = await readVersion(env.BACKUP, path, version);
  if (old === null) throw new ToolError(`No version ${version} for ${path}`, 404);
  const key = toKey(env, path);
  const cur = await env.VAULT.get(key);
  if (cur) await saveVersion(env.BACKUP, path, await cur.text());
  const put = await env.VAULT.put(key, old, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
  await indexNote(env, path, old, put.etag, put.size);
  await audit(env, 'admin', 'restore', `${path}@${version}`);
  return { path, restored: version };
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
      "Read one note from the user's markdown memory vault. Start every session by reading `core/START-HERE.md`, which explains who the user is, how they like you to work, and how the vault is organised. PDF, Word and Excel files found by search are returned as their converted text.",
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
    name: 'backlinks',
    description:
      'List the notes that link to a note ([[wikilinks]] or markdown links). Use it to find related context: the projects, people or incidents that mention a note.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative path, for example "infra/nas-synology.md"' } },
      required: ['path'],
    },
    annotations: { title: 'Find backlinks', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'write_note',
    description:
      'Create a new note. Notes under inbox/agents/ are saved as drafts for the owner to review. If the owner allows you to edit a folder (for example journal/ or projects/), you may also create notes directly there when the user asks; they keep their status (default current). core/ is never writable. Existing notes outside the inbox change only through edit_note. If a folder is not allowed, the error says so: then save the note in inbox/agents/. Never include passwords, keys or tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'For example "inbox/agents/2026-11-03-dns-plan.md", or "journal/2026-11-03.md" where the owner allows it' },
        content: { type: 'string', description: 'Markdown. Start with a heading; add a one-line `description:` in frontmatter if you can.' },
        overwrite: { type: 'boolean', description: 'Replace your own earlier note at this path. Default false.' },
      },
      required: ['path', 'content'],
    },
    annotations: { title: 'Write note to inbox', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'edit_note',
    description:
      "Revise an existing note in place when the user asks you to. Replaces one exact passage: read the note first, copy the passage to change as old_text (it must occur exactly once, so include enough surrounding text), and give the replacement as new_text. Several changes means several calls. Only folders the owner has allowed can be edited; core/ and notes marked `locked: true` never can. Every edit is versioned and can be undone by the owner. Never include passwords, keys or tokens.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Existing note, for example "projects/jarvis.md"' },
        old_text: { type: 'string', description: 'Exact text currently in the note, copied from read_note' },
        new_text: { type: 'string', description: 'Replacement text; "" removes the passage' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    annotations: { title: 'Edit note', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
    case 'backlinks': {
      const path = requireMarkdown(normalizePath(args.path));
      const rows = await backlinks(env, path);
      if (!rows.length) return `No notes link to ${path}.`;
      return [`Notes linking to ${path} (${rows.length}):`, ...rows.map((n) => `- ${n.path}${n.status && n.status !== 'current' ? ` [${n.status}]` : ''}${n.description ? ' - ' + n.description : ''}`)].join('\n');
    }
    case 'write_note': {
      const r = await writeNote(env, agent, args.path, args.content, args.overwrite === true);
      const kind = r.path.startsWith(writePrefix(env)) ? ' as a draft' : '';
      return `${r.created ? 'Saved' : 'Replaced'} ${r.path}${kind}. It will appear in Obsidian on the owner's devices at their next sync.`;
    }
    case 'edit_note': {
      const r = await editNote(env, agent, args.path, args.old_text, args.new_text);
      return `Edited ${r.path}. The previous version is saved, so the owner can undo it. The change reaches Obsidian at the owner's next sync.`;
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}
