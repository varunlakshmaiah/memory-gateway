export interface Env {
  /** R2 bucket holding the vault: the source of truth. */
  VAULT: R2Bucket;
  /** Optional second bucket for daily snapshots. Never the synced bucket. */
  BACKUP?: R2Bucket;
  /** D1 database holding the disposable full-text index. */
  DB: D1Database;
  /** Optional Workers AI + Vectorize for search by meaning. Without both, search is keyword-only. */
  AI?: Ai;
  VEC?: VectorizeIndex;
  /** "off" disables search by meaning even when AI and VEC are bound (local dev). */
  SEMANTIC_SEARCH?: string;
  /** Secret: JSON map of agent name to token, for example {"claude":"...","hermes":"..."}. */
  AGENT_TOKENS: string;
  /** Secret: token for /admin routes. Admin routes are disabled when unset. */
  ADMIN_TOKEN?: string;
  /** Key prefix of the vault inside the bucket, for example "MyVault/". Empty for bucket root. */
  VAULT_PREFIX?: string;
  /** JSON: agent name (or "*") to folder prefixes it may edit with edit_note; "" = whole vault. Unset = no edits. */
  EDIT_POLICY?: string;
  /** The only folder agents may write to. Default "inbox/agents/". */
  WRITE_PREFIX?: string;
  /** Optional KV namespace for OAuth grants and tokens. Bound = OAuth sign-in on /mcp is on. */
  OAUTH_KV?: KVNamespace;
  MAX_NOTE_BYTES?: string;
  BACKUP_KEEP_DAYS?: string;
}

/** Per-request context: who is calling. */
export interface Ctx {
  env: Env;
  agent: string;
}

/** Payload of an R2 event notification delivered through a Queue. */
export interface R2Event {
  account?: string;
  action: string;
  bucket?: string;
  object: { key: string; size?: number; eTag?: string };
  eventTime?: string;
}

/** An error whose message is safe to show to an agent. */
export class ToolError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
