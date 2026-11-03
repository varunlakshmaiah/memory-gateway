import type { Env } from './types';
import { today, vaultPrefix } from './keys';

export interface SnapshotResult {
  skipped?: string;
  date?: string;
  copied?: number;
  alreadyThere?: number;
  remaining?: number;
  pruned?: string[];
}

/**
 * Copies the vault into dated folders of a SECOND bucket (BACKUP binding).
 * It must never be the synced bucket, or Remotely Save would pull the snapshots onto your devices.
 * Resumable: run again (or wait for the next cron) while `remaining` > 0.
 */
export async function snapshot(env: Env, maxCopy = 200): Promise<SnapshotResult> {
  const backup = env.BACKUP;
  if (!backup) return { skipped: 'No BACKUP bucket binding configured' };
  const date = today();
  const prefix = vaultPrefix(env);

  const have = new Set<string>();
  let bc: string | undefined;
  do {
    const l = await backup.list({ prefix: `${date}/`, cursor: bc, limit: 1000 });
    for (const o of l.objects) have.add(o.key);
    bc = l.truncated ? l.cursor : undefined;
  } while (bc);

  let copied = 0;
  let remaining = 0;
  let cursor: string | undefined;
  do {
    const l = await env.VAULT.list({ prefix: prefix || undefined, cursor, limit: 1000 });
    for (const o of l.objects) {
      if (o.key.endsWith('/') || o.size > 20_000_000) continue;
      const dest = `${date}/${o.key}`;
      if (have.has(dest)) continue;
      if (copied >= maxCopy) {
        remaining++;
        continue;
      }
      const src = await env.VAULT.get(o.key);
      if (!src) continue;
      await backup.put(dest, src.body, { httpMetadata: src.httpMetadata, customMetadata: src.customMetadata });
      copied++;
    }
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);

  const pruned = await prune(backup, Number(env.BACKUP_KEEP_DAYS ?? 14));
  return { date, copied, alreadyThere: have.size, remaining, pruned };
}

async function prune(backup: R2Bucket, keepDays: number): Promise<string[]> {
  const l = await backup.list({ delimiter: '/' });
  const days = l.delimitedPrefixes.filter((p) => /^\d{4}-\d{2}-\d{2}\/$/.test(p)).sort();
  const old = days.slice(0, Math.max(0, days.length - keepDays));
  const done: string[] = [];
  for (const p of old.slice(0, 1)) {
    let cursor: string | undefined;
    do {
      const page = await backup.list({ prefix: p, cursor, limit: 500 });
      if (page.objects.length) await backup.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    done.push(p);
  }
  return done;
}
