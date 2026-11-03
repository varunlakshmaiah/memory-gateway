import { describe, expect, it } from 'vitest';
import { chunkText, fuse, pruneAudit } from '../src/indexer';
import type { Env } from '../src/types';

describe('fuse', () => {
  it('ranks a path found by both searches above paths found by one', () => {
    expect(fuse(['a', 'b', 'c'], ['d', 'b'])[0]).toBe('b');
  });
  it('keeps every path once, in rank order when only one list has hits', () => {
    expect(fuse(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(fuse([], ['x', 'y', 'x'])).toEqual(['x', 'y']);
  });
});

describe('pruneAudit', () => {
  it('deletes audit rows older than the cutoff', async () => {
    let sql = '';
    let bound = '';
    const db = {
      prepare: (s: string) => ({
        bind: (v: string) => {
          sql = s;
          bound = v;
          return { run: async () => ({ meta: { changes: 3 } }) };
        },
      }),
    };
    const n = await pruneAudit({ DB: db } as unknown as Env, 90);
    expect(n).toBe(3);
    expect(sql).toBe('DELETE FROM audit WHERE ts < ?');
    const ageDays = (Date.now() - Date.parse(bound)) / 86_400_000;
    expect(Math.round(ageDays)).toBe(90);
  });
});

describe('chunkText', () => {
  it('keeps a short note as one chunk', () => expect(chunkText('a\n\nb', 100)).toEqual(['a\n\nb']));
  it('splits at paragraph breaks without exceeding the size', () => {
    const paras = Array.from({ length: 10 }, (_, i) => `p${i} ` + 'x'.repeat(30));
    const chunks = chunkText(paras.join('\n\n'), 80);
    expect(chunks.every((c) => c.length <= 80)).toBe(true);
    expect(chunks.join('\n\n')).toBe(paras.join('\n\n'));
  });
  it('hard-splits one huge paragraph and caps the count', () => {
    expect(chunkText('y'.repeat(250), 100)).toEqual(['y'.repeat(100), 'y'.repeat(100), 'y'.repeat(50)]);
    expect(chunkText('z'.repeat(1000), 100, 3)).toHaveLength(3);
  });
  it('returns one chunk for an empty body', () => expect(chunkText('')).toEqual(['']));
});
