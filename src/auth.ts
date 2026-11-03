import type { Env } from './types';

const enc = new TextEncoder();

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** Constant-time comparison of two strings (compares their SHA-256 digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  const native = (crypto.subtle as unknown as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean }).timingSafeEqual;
  if (typeof native === 'function') return native.call(crypto.subtle, x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Looks the presented token up in AGENT_TOKENS and returns the agent name, or null. */
export async function resolveAgent(env: Pick<Env, 'AGENT_TOKENS'>, presented: string): Promise<string | null> {
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(env.AGENT_TOKENS ?? '{}');
  } catch {
    return null;
  }
  let found: string | null = null;
  for (const [name, tok] of Object.entries(map)) {
    // Tokens shorter than 16 characters are refused outright; no early exit, to keep timing flat.
    if (typeof tok === 'string' && tok.length >= 16 && (await safeEqual(tok, presented))) found = name;
  }
  return found;
}

export interface Auth {
  agent: string;
  /** Request path with any /t/<token> prefix removed. */
  pathname: string;
}

/**
 * Two ways to present a token:
 *  - header `Authorization: Bearer <token>` (Claude Code, Hermes, scripts)
 *  - URL prefix `/t/<token>/...` for clients that cannot send headers, such as the Claude app's custom connector
 */
export async function authenticate(req: Request, url: URL, env: Env): Promise<Auth | null> {
  let pathname = url.pathname.replace(/\/+$/, '') || '/';
  let presented: string | null = null;
  const m = pathname.match(/^\/t\/([^/]+)(\/.*)$/);
  if (m) {
    try {
      presented = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
    pathname = m[2];
  } else {
    const h = req.headers.get('authorization');
    if (h && /^bearer /i.test(h)) presented = h.slice(7).trim();
  }
  if (!presented) return null;
  const agent = await resolveAgent(env, presented);
  return agent ? { agent, pathname } : null;
}

export async function isAdmin(req: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) return false;
  const h = req.headers.get('authorization');
  if (!h || !/^bearer /i.test(h)) return false;
  return safeEqual(env.ADMIN_TOKEN, h.slice(7).trim());
}
