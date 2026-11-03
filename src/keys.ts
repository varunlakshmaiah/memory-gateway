import type { Env } from './types';

/** Normalised vault prefix: "" or "Name/". */
export function vaultPrefix(env: Env): string {
  const p = (env.VAULT_PREFIX ?? '').trim().replace(/^\/+/, '');
  return p && !p.endsWith('/') ? p + '/' : p;
}

export function writePrefix(env: Env): string {
  const p = (env.WRITE_PREFIX ?? 'inbox/agents/').trim().replace(/^\/+/, '');
  return p.endsWith('/') ? p : p + '/';
}

/** Vault-relative path to R2 key. */
export function toKey(env: Env, path: string): string {
  return vaultPrefix(env) + path;
}

/** R2 key to vault-relative path, or null when the key is outside the vault prefix or a folder marker. */
export function fromKey(env: Env, key: string): string | null {
  const prefix = vaultPrefix(env);
  if (prefix && !key.startsWith(prefix)) return null;
  const path = key.slice(prefix.length);
  if (!path || path.endsWith('/')) return null;
  return path;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
