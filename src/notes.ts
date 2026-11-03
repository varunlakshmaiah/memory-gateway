import { ToolError } from './types';

export interface ParsedNote {
  title: string;
  description: string;
  type: string;
  status: string;
  updated: string;
  supersedes: string;
  body: string;
}

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Flat `key: value` frontmatter only. Lists and nesting are ignored on purpose. */
export function parseFrontmatter(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export function parseNote(path: string, text: string): ParsedNote {
  let fm: Record<string, string> = {};
  let body = text;
  const m = text.match(FM_RE);
  if (m) {
    fm = parseFrontmatter(m[1]);
    body = text.slice(m[0].length);
  }
  const h1 = body.match(/^#\s+(.+)$/m);
  const base = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
  return {
    title: (h1?.[1] ?? base).trim(),
    description: fm.description ?? '',
    type: fm.type ?? '',
    status: fm.status || 'current',
    updated: fm.updated ?? '',
    supersedes: fm.supersedes ?? '',
    body,
  };
}

/** Validates a vault-relative path. Throws ToolError on anything suspicious. */
export function normalizePath(input: unknown): string {
  if (typeof input !== 'string') throw new ToolError('path must be a string');
  const p = input.trim().replace(/^\/+/, '');
  if (!p || p.length > 300) throw new ToolError('Invalid path');
  if (/[\\\u0000-\u001f]/.test(p)) throw new ToolError('Invalid characters in path');
  // Also blocks hidden folders such as .obsidian (plugin settings can hold credentials).
  if (p.split('/').some((s) => s === '' || s.startsWith('.'))) {
    throw new ToolError('Invalid path segments');
  }
  return p;
}

/** Folders no agent may edit, whatever EDIT_POLICY says. */
const NEVER_EDIT = ['core/'];

/**
 * Whether `agent` may edit an existing note at `path`. EDIT_POLICY is JSON mapping agent names
 * (or "*") to folder prefixes; "" means the whole vault. Missing or invalid policy means no edits.
 */
export function canEdit(policy: string | undefined, agent: string, path: string): boolean {
  if (NEVER_EDIT.some((p) => path.startsWith(p))) return false;
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(policy ?? '{}');
  } catch {
    return false;
  }
  const prefixes = map[agent] ?? map['*'];
  return Array.isArray(prefixes) && prefixes.some((p) => typeof p === 'string' && path.startsWith(p));
}

/** True when the note's frontmatter has `locked: true`. */
export function isLocked(text: string): boolean {
  const m = text.match(FM_RE);
  return !!m && /^(true|yes)$/i.test(parseFrontmatter(m[1]).locked ?? '');
}

/** Sets `updated` and `updated_by` on an edited note, keeping all other frontmatter as it was. */
export function stampEdit(text: string, agent: string, today: string): string {
  const m = text.match(FM_RE);
  const stamp = [`updated: ${today}`, `updated_by: ${agentStamp(agent)}`];
  if (!m) return `---\n${stamp.join('\n')}\n---\n${text}`;
  const kept = m[1].split(/\r?\n/).filter((l) => !/^(updated|updated_by):/.test(l));
  return `---\n${[...kept, ...stamp].join('\n')}\n---\n${text.slice(m[0].length)}`;
}

/** Lowercase link target without ".md": the form stored in the links table and matched by backlinks. */
export const linkKey = (p: string) => p.replace(/\.md$/i, '').toLowerCase();

/**
 * Notes a note links to: [[wikilinks]] (alias, heading and block parts dropped) and markdown links to
 * .md files. "./" and "../" links resolve against the note's folder; other targets stay as written.
 */
export function linkTargets(path: string, body: string): string[] {
  const out = new Set<string>();
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const add = (raw: string) => {
    let t = raw.trim();
    if (/^\.\.?\//.test(t)) {
      const parts = dir ? dir.split('/') : [];
      for (const seg of t.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
      }
      t = parts.join('/');
    }
    t = t.replace(/^\/+/, '');
    if (t) out.add(linkKey(t));
  };
  for (const m of body.matchAll(/\[\[([^\]|#^]+)[^\]]*\]\]/g)) add(m[1]);
  for (const m of body.matchAll(/\]\(<?([^)>\s]+\.md)(?:#[^)]*)?>?\)/gi)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue; // external URL
    try {
      add(decodeURIComponent(m[1]));
    } catch {
      add(m[1]);
    }
  }
  out.delete(linkKey(path));
  return [...out];
}

export function requireMarkdown(path: string): string {
  if (!path.toLowerCase().endsWith('.md')) throw new ToolError('Only .md notes are supported');
  return path;
}

/**
 * Attachments that Workers AI toMarkdown turns into searchable text. Images are left out on purpose:
 * converting them runs a paid vision model on every photo in the vault.
 */
const DOC_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** MIME type of a convertible document, or undefined for anything else. */
export const docType = (path: string): string | undefined => DOC_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];

/**
 * Files the index covers: markdown notes (and, with `docs`, convertible documents) outside hidden
 * folders (.obsidian, .trash, ...).
 */
export function isIndexable(path: string, docs = false): boolean {
  // Templates are empty skeletons: still readable, but kept out of search.
  return (
    (path.toLowerCase().endsWith('.md') || (docs && !!docType(path))) &&
    !path.split('/').some((s) => s.startsWith('.')) &&
    !path.startsWith('meta/templates/')
  );
}

const STOP = new Set(
  (
    'a an the is are was were am be been of to in on for and or but what which who whom when where why how ' +
    'do does did my me i we you it its this that these those with at by from can could should would about ' +
    'any there their has have had not no so if as than then also please tell show find give'
  ).split(' '),
);

/**
 * Turns a natural-language question into a safe FTS5 query: quoted tokens joined by OR.
 * Quoting keeps things like 10.10.30.50 or pve-01 as phrases and blocks FTS syntax injection.
 */
export function buildFtsQuery(q: string, join: 'OR' | 'AND' = 'OR'): string | null {
  const all = (q.match(/[\p{L}\p{N}](?:[\p{L}\p{N}._:-]*[\p{L}\p{N}])?/gu) ?? []).map((t) =>
    t.toLowerCase(),
  );
  let tokens = all.filter((t) => !STOP.has(t));
  if (!tokens.length) tokens = all;
  const uniq = [...new Set(tokens)].slice(0, 12);
  if (!uniq.length) return null;
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(` ${join} `);
}

export function deriveDescription(body: string): string {
  const h = body.match(/^#\s+(.+)$/m)?.[1];
  const first = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
  const raw = (h ?? first ?? 'Agent note').trim().replace(/\s+/g, ' ');
  return raw.length > 140 ? raw.slice(0, 137) + '...' : raw;
}

/**
 * Normalises frontmatter on agent-written notes: always `status: draft` and
 * `written_by: <agent>` (an agent cannot claim "current" or spoof another agent),
 * and fills in type, description and updated when missing.
 */
export function stampNote(content: string, agent: string, today: string, draft = true): string {
  const text = content.replace(/^﻿/, '');
  const m = text.match(FM_RE);
  const body = m ? text.slice(m[0].length) : text;
  const existing = m ? m[1].split(/\r?\n/) : [];
  const fm = parseFrontmatter(m ? m[1] : '');
  // Outside the inbox (an agent allowed by EDIT_POLICY) the note keeps its own status, default current.
  const status = draft ? 'draft' : fm.status && /^(current|draft|outdated)$/.test(fm.status) ? fm.status : 'current';
  const kept = existing.filter((l) => !/^(status|written_by):/.test(l));
  const add: string[] = [];
  if (!fm.type) add.push('type: note');
  if (!fm.description) add.push(`description: "${deriveDescription(body).replace(/"/g, "'")}"`);
  if (!fm.updated) add.push(`updated: ${today}`);
  add.push(`status: ${status}`, `written_by: ${agentStamp(agent)}`);
  return `---\n${[...kept, ...add].join('\n')}\n---\n${body}`;
}

/** The agent name as stamped into `written_by`. */
export const agentStamp = (agent: string) => agent.replace(/[^\w.-]/g, '_');

/** The `written_by` stamp of a note, or '' when it has none (for example, a note the owner wrote). */
export function writtenBy(text: string): string {
  const m = text.match(FM_RE);
  return m ? (parseFrontmatter(m[1]).written_by ?? '') : '';
}
