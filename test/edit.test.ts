import { describe, expect, it } from 'vitest';
import { canEdit, isLocked, normalizePath, stampEdit } from '../src/notes';
import { editNote, writeNote } from '../src/tools';
import type { Env } from '../src/types';

const POLICY = JSON.stringify({ claude: [''], hermes: ['notes/'] });

describe('canEdit', () => {
  it('follows the per-agent folders, with "" meaning the whole vault', () => {
    expect(canEdit(POLICY, 'claude', 'projects/a.md')).toBe(true);
    expect(canEdit(POLICY, 'hermes', 'notes/a.md')).toBe(true);
    expect(canEdit(POLICY, 'hermes', 'projects/a.md')).toBe(false);
    expect(canEdit(POLICY, 'other', 'notes/a.md')).toBe(false);
  });
  it('never allows core/, and fails closed on missing or broken policy', () => {
    expect(canEdit(POLICY, 'claude', 'core/START-HERE.md')).toBe(false);
    expect(canEdit(undefined, 'claude', 'notes/a.md')).toBe(false);
    expect(canEdit('{nope', 'claude', 'notes/a.md')).toBe(false);
  });
  it('uses "*" for agents without their own entry', () => {
    expect(canEdit(JSON.stringify({ '*': ['inbox/'] }), 'anyone', 'inbox/x.md')).toBe(true);
  });
});

describe('note helpers', () => {
  it('detects locked notes', () => {
    expect(isLocked('---\nlocked: true\n---\n# T')).toBe(true);
    expect(isLocked('---\nstatus: current\n---\n# T')).toBe(false);
    expect(isLocked('# no frontmatter')).toBe(false);
  });
  it('stamps updated and updated_by, keeping other frontmatter', () => {
    const out = stampEdit('---\ntype: project\nupdated: 2025-01-01\n---\n# T\nbody', 'claude', '2026-11-03');
    expect(out).toBe('---\ntype: project\nupdated: 2026-11-03\nupdated_by: claude\n---\n# T\nbody');
    expect(stampEdit('# T', 'claude', '2026-11-03')).toBe('---\nupdated: 2026-11-03\nupdated_by: claude\n---\n# T');
  });
  it('rejects hidden folders such as .obsidian', () => {
    expect(() => normalizePath('.obsidian/plugins/x/data.md')).toThrow();
    expect(() => normalizePath('notes/.hidden.md')).toThrow();
  });
});

/** In-memory VAULT/BACKUP/DB, enough for editNote. */
function fakeEnv(notes: Record<string, string>, opts: { backup?: boolean; raceOnPut?: boolean } = {}) {
  const versions: Record<string, string> = {};
  const vault = {
    get: async (k: string) => (k in notes ? { etag: 'e1', text: async () => notes[k] } : null),
    put: async (k: string, v: string, o?: { onlyIf?: { etagMatches?: string } }) => {
      if (opts.raceOnPut && o?.onlyIf) return null;
      notes[k] = v;
      return { etag: 'e2', size: v.length };
    },
  };
  const backup = { put: async (k: string, v: string) => void (versions[k] = v) };
  const stmt = { bind: () => stmt, run: async () => ({}) };
  const env = {
    EDIT_POLICY: POLICY,
    VAULT: vault,
    BACKUP: opts.backup === false ? undefined : backup,
    DB: { prepare: () => stmt, batch: async () => [] },
  } as unknown as Env;
  return { env, notes, versions };
}

describe('editNote', () => {
  const NOTE = '---\ntype: project\nstatus: current\n---\n# Plan\nDeadline: March.\n';
  it('replaces the passage, stamps it and saves the previous version first', async () => {
    const f = fakeEnv({ 'projects/p.md': NOTE });
    await editNote(f.env, 'claude', 'projects/p.md', 'Deadline: March.', 'Deadline: April.');
    expect(f.notes['projects/p.md']).toContain('Deadline: April.');
    expect(f.notes['projects/p.md']).toContain('updated_by: claude');
    expect(f.notes['projects/p.md']).toContain('status: current');
    expect(Object.values(f.versions)).toEqual([NOTE]);
  });
  it('treats "$" in new_text literally', async () => {
    const f = fakeEnv({ 'projects/p.md': NOTE });
    await editNote(f.env, 'claude', 'projects/p.md', 'March', 'costs $& $1');
    expect(f.notes['projects/p.md']).toContain('Deadline: costs $& $1.');
  });
  it('refuses missing, repeated or stale old_text', async () => {
    const f = fakeEnv({ 'projects/p.md': NOTE + 'March again\n' });
    await expect(editNote(f.env, 'claude', 'projects/p.md', 'nope', 'x')).rejects.toMatchObject({ status: 409 });
    await expect(editNote(f.env, 'claude', 'projects/p.md', 'March', 'x')).rejects.toMatchObject({ status: 409 });
  });
  it('refuses core/, locked notes, other folders and missing notes', async () => {
    const f = fakeEnv({ 'core/START-HERE.md': NOTE, 'notes/l.md': '---\nlocked: true\n---\nx', 'projects/p.md': NOTE });
    await expect(editNote(f.env, 'claude', 'core/START-HERE.md', 'March', 'x')).rejects.toMatchObject({ status: 403 });
    await expect(editNote(f.env, 'claude', 'notes/l.md', 'x', 'y')).rejects.toMatchObject({ status: 403 });
    await expect(editNote(f.env, 'hermes', 'projects/p.md', 'March', 'x')).rejects.toMatchObject({ status: 403 });
    await expect(editNote(f.env, 'claude', 'projects/none.md', 'a', 'b')).rejects.toMatchObject({ status: 404 });
  });
  it('refuses without a BACKUP bucket, and when the note changes mid-edit', async () => {
    const noBackup = fakeEnv({ 'projects/p.md': NOTE }, { backup: false });
    await expect(editNote(noBackup.env, 'claude', 'projects/p.md', 'March', 'x')).rejects.toMatchObject({ status: 403 });
    const race = fakeEnv({ 'projects/p.md': NOTE }, { raceOnPut: true });
    await expect(editNote(race.env, 'claude', 'projects/p.md', 'March', 'x')).rejects.toMatchObject({ status: 409 });
    expect(race.notes['projects/p.md']).toBe(NOTE);
  });
});

describe('writeNote outside the inbox', () => {
  it('creates a note in an allowed folder, keeping its status and stamping the agent', async () => {
    const f = fakeEnv({});
    const r = await writeNote(f.env, 'claude', 'journal/2026-11-03.md', '# 2026-11-03\nRode to Nandi Hills.');
    expect(r.created).toBe(true);
    const out = f.notes['journal/2026-11-03.md'];
    expect(out).toContain('status: current');
    expect(out).toContain('written_by: claude');
    expect(out).toContain('Rode to Nandi Hills.');
  });
  it('refuses folders the agent may not edit, and core/', async () => {
    const f = fakeEnv({});
    await expect(writeNote(f.env, 'hermes', 'journal/x.md', '# x')).rejects.toMatchObject({ status: 403 });
    await expect(writeNote(f.env, 'claude', 'core/new.md', '# x')).rejects.toMatchObject({ status: 403 });
  });
  it('never overwrites an existing note outside the inbox, even with overwrite', async () => {
    const f = fakeEnv({ 'journal/2026-11-03.md': '---\nwritten_by: claude\n---\n# old' });
    await expect(writeNote(f.env, 'claude', 'journal/2026-11-03.md', '# new', true)).rejects.toMatchObject({ status: 409 });
    expect(f.notes['journal/2026-11-03.md']).toContain('# old');
  });
  it('still saves inbox notes as drafts', async () => {
    const f = fakeEnv({});
    await writeNote(f.env, 'claude', 'inbox/agents/x.md', '---\nstatus: current\n---\n# x');
    expect(f.notes['inbox/agents/x.md']).toContain('status: draft');
  });
});
