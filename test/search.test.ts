import { describe, expect, it } from 'vitest';
import { fuse, pruneAudit } from '../src/indexer';
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
