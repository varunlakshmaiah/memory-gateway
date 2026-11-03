import { describe, expect, it } from 'vitest';
import { buildFtsQuery, deriveDescription, isIndexable, normalizePath, parseNote, stampNote } from '../src/notes';
import { fromKey, toKey, vaultPrefix } from '../src/keys';
import type { Env } from '../src/types';

describe('parseNote', () => {
  it('reads frontmatter, title and body', () => {
    const n = parseNote(
      'infra/x.md',
      '---\ntype: infra\ndescription: Tidewalker: a game\nstatus: outdated\nupdated: 2026-01-02\n---\n# Real Title\nbody text',
    );
    expect(n.title).toBe('Real Title');
    expect(n.description).toBe('Tidewalker: a game');
    expect(n.status).toBe('outdated');
    expect(n.body).toContain('body text');
  });
  it('falls back to file name and status current', () => {
    const n = parseNote('a/b/some-note.md', 'no frontmatter here');
    expect(n.title).toBe('some-note');
    expect(n.status).toBe('current');
  });
});

describe('normalizePath', () => {
  it('accepts normal paths and strips leading slash', () => {
    expect(normalizePath('/infra/a.md')).toBe('infra/a.md');
  });
  it.each(['../x.md', 'a/../b.md', 'a//b.md', 'a\\b.md', '', '   ', './a.md'])('rejects %j', (p) => {
    expect(() => normalizePath(p)).toThrow();
  });
  it('rejects non-strings', () => {
    expect(() => normalizePath(42)).toThrow();
  });
});

describe('isIndexable', () => {
  it('indexes markdown outside hidden folders', () => {
    expect(isIndexable('infra/a.md')).toBe(true);
    expect(isIndexable('.obsidian/workspace.json')).toBe(false);
    expect(isIndexable('.trash/old.md')).toBe(false);
    expect(isIndexable('img/pic.png')).toBe(false);
  });
  it('skips templates but indexes the rest of meta/', () => {
    expect(isIndexable('meta/templates/project.md')).toBe(false);
    expect(isIndexable('meta/README.md')).toBe(true);
  });
});

describe('buildFtsQuery', () => {
  it('drops stop words and quotes tokens', () => {
    expect(buildFtsQuery('What is the IP address of the NAS?')).toBe('"ip" OR "address" OR "nas"');
  });
  it('keeps IPs, hostnames and dates as single phrases', () => {
    expect(buildFtsQuery('10.10.30.50 pve-01 2026-09-21')).toBe('"10.10.30.50" OR "pve-01" OR "2026-09-21"');
  });
  it('is safe against FTS syntax', () => {
    const q = buildFtsQuery('foo" OR NEAR(bar) * baz:');
    expect(q).not.toContain('NEAR(');
    expect(q).toBe('"foo" OR "near" OR "bar" OR "baz"');
  });
  it('returns null for empty input', () => {
    expect(buildFtsQuery('???')).toBeNull();
  });
});

describe('stampNote', () => {
  it('adds frontmatter to a bare note and forces draft', () => {
    const out = stampNote('# DNS plan\ntext', 'claude', '2026-11-03');
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('status: draft');
    expect(out).toContain('written_by: claude');
    expect(out).toContain('description: "DNS plan"');
    expect(out).toContain('updated: 2026-11-03');
  });
  it('does not let an agent claim current or spoof written_by', () => {
    const out = stampNote('---\nstatus: current\nwritten_by: someone\ndescription: x\n---\n# T', 'hermes', '2026-11-03');
    expect(out).not.toContain('status: current');
    expect(out).not.toContain('someone');
    expect(out).toContain('status: draft');
    expect(out).toContain('written_by: hermes');
    expect(out.match(/description:/g)?.length).toBe(1);
  });
  it('keeps supersedes', () => {
    const out = stampNote('---\nsupersedes: infra/old.md\n---\n# T', 'claude', '2026-11-03');
    expect(out).toContain('supersedes: infra/old.md');
  });
});

describe('deriveDescription', () => {
  it('truncates long text', () => {
    expect(deriveDescription('# ' + 'x'.repeat(300)).length).toBeLessThanOrEqual(140);
  });
});

describe('key mapping', () => {
  const env = { VAULT_PREFIX: 'MyVault' } as unknown as Env;
  it('normalises the prefix and maps both ways', () => {
    expect(vaultPrefix(env)).toBe('MyVault/');
    expect(toKey(env, 'a/b.md')).toBe('MyVault/a/b.md');
    expect(fromKey(env, 'MyVault/a/b.md')).toBe('a/b.md');
    expect(fromKey(env, 'Other/a.md')).toBeNull();
    expect(fromKey(env, 'MyVault/folder/')).toBeNull();
  });
});
