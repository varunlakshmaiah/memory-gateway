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
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new ToolError('Invalid path segments');
  }
  return p;
}

export function requireMarkdown(path: string): string {
  if (!path.toLowerCase().endsWith('.md')) throw new ToolError('Only .md notes are supported');
  return path;
}

/** Notes the index covers: markdown files outside hidden folders (.obsidian, .trash, ...). */
export function isIndexable(path: string): boolean {
  // Templates are empty skeletons: still readable, but kept out of search.
  return (
    path.toLowerCase().endsWith('.md') &&
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
export function stampNote(content: string, agent: string, today: string): string {
  const text = content.replace(/^﻿/, '');
  const m = text.match(FM_RE);
  const body = m ? text.slice(m[0].length) : text;
  const existing = m ? m[1].split(/\r?\n/) : [];
  const fm = parseFrontmatter(m ? m[1] : '');
  const kept = existing.filter((l) => !/^(status|written_by):/.test(l));
  const add: string[] = [];
  if (!fm.type) add.push('type: note');
  if (!fm.description) add.push(`description: "${deriveDescription(body).replace(/"/g, "'")}"`);
  if (!fm.updated) add.push(`updated: ${today}`);
  add.push('status: draft', `written_by: ${agentStamp(agent)}`);
  return `---\n${[...kept, ...add].join('\n')}\n---\n${body}`;
}

/** The agent name as stamped into `written_by`. */
export const agentStamp = (agent: string) => agent.replace(/[^\w.-]/g, '_');

/** The `written_by` stamp of a note, or '' when it has none (for example, a note the owner wrote). */
export function writtenBy(text: string): string {
  const m = text.match(FM_RE);
  return m ? (parseFrontmatter(m[1]).written_by ?? '') : '';
}
