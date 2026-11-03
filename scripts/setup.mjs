#!/usr/bin/env node
// One-command deploy: creates the Cloudflare resources, deploys, sets secrets, wires bucket events
// and builds the first index. Safe to re-run: existing resources and secrets are kept.
// Usage: npm run setup   (reads and updates wrangler.jsonc)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const CONFIG = 'wrangler.jsonc';
const SECRETS_FILE = '.secrets.local.json';
const rl = createInterface({ input: process.stdin });
// Line iterator rather than rl.question: it buffers, so piped answers are not lost.
const lines = rl[Symbol.asyncIterator]();

const wrangler = (args, opts = {}) =>
  spawnSync('npx', ['--no-install', 'wrangler', ...args], { encoding: 'utf8', ...opts });
const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};
const ask = async (q, def) => {
  process.stdout.write(`${q}${def ? ` [${def}]` : ''}: `);
  return ((await lines.next()).value ?? '').trim() || def;
};

/** Runs a create command; "already exists" counts as success. */
function ensure(label, args) {
  const r = wrangler(args);
  if (r.status === 0) return console.log(`✓ ${label}: created`);
  if (/already (exists|taken|in use)|duplicate/i.test(out(r))) return console.log(`✓ ${label}: exists`);
  fail(`${label}: ${out(r).split('\n').filter((l) => /ERROR|\[code/.test(l)).join('\n') || out(r).trim()}`);
}

let text = readFileSync(CONFIG, 'utf8');
const cfg = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
const save = () => writeFileSync(CONFIG, text);
const worker = cfg.name;
const db = cfg.d1_databases[0];
const queue = cfg.queues.consumers[0].queue;
const vec = cfg.vectorize?.[0]?.index_name;
const backup = cfg.r2_buckets.find((b) => b.binding === 'BACKUP')?.bucket_name;
let bucket = cfg.r2_buckets.find((b) => b.binding === 'VAULT').bucket_name;

// 1. Cloudflare login
const who = wrangler(['whoami']);
if (who.status !== 0 || /not authenticated/i.test(out(who))) {
  console.log('Opening the Cloudflare login…');
  if (wrangler(['login'], { stdio: 'inherit' }).status !== 0) fail('wrangler login failed');
}

// 2. Vault bucket (the one Remotely Save syncs to)
console.log('\nThe vault bucket is the R2 bucket Obsidian (Remotely Save) syncs your notes to.');
const newBucket = await ask('Vault bucket name', bucket);
if (newBucket !== bucket) {
  text = text.replace(`"binding": "VAULT", "bucket_name": "${bucket}"`, `"binding": "VAULT", "bucket_name": "${newBucket}"`);
  bucket = newBucket;
}
const prefix = await ask('Folder inside the bucket that holds the vault (blank if notes sit at the root)', cfg.vars.VAULT_PREFIX);
const cleanPrefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : (prefix ?? '');
text = text.replace(/"VAULT_PREFIX": "[^"]*"/, `"VAULT_PREFIX": "${cleanPrefix}"`);
save();

// 3. Resources
console.log('');
ensure(`bucket ${bucket}`, ['r2', 'bucket', 'create', bucket]);
if (backup) ensure(`bucket ${backup}`, ['r2', 'bucket', 'create', backup]);
ensure(`queue ${queue}`, ['queues', 'create', queue]);
if (vec) ensure(`vectorize ${vec}`, ['vectorize', 'create', vec, '--dimensions=1024', '--metric=cosine']);
if (vec) ensure(`vectorize ${vec} folder index`, ['vectorize', 'create-metadata-index', vec, '--propertyName=folder', '--type=string']);
if (!db.database_id) {
  const list = wrangler(['d1', 'list', '--json']);
  let id = list.status === 0 ? JSON.parse(list.stdout).find((d) => d.name === db.database_name)?.uuid : undefined;
  if (!id) {
    const r = wrangler(['d1', 'create', db.database_name]);
    id = out(r).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    if (r.status !== 0 || !id) fail(`d1 create: ${out(r).trim()}`);
  }
  text = text.replace(`"database_name": "${db.database_name}"`, `"database_name": "${db.database_name}",\n      "database_id": "${id}"`);
  save();
}
console.log(`✓ database ${db.database_name}`);
const kv = cfg.kv_namespaces?.find((k) => k.binding === 'OAUTH_KV');
if (kv && !kv.id) {
  const title = `${worker}-oauth`;
  const list = wrangler(['kv', 'namespace', 'list']);
  let id = list.status === 0 ? JSON.parse(list.stdout).find((n) => n.title === title)?.id : undefined;
  if (!id) {
    const r = wrangler(['kv', 'namespace', 'create', title]);
    id = out(r).match(/"id": "([0-9a-f]{32})"/)?.[1];
    if (r.status !== 0 || !id) fail(`kv namespace create: ${out(r).trim()}`);
  }
  text = text.replace('{ "binding": "OAUTH_KV" }', `{ "binding": "OAUTH_KV", "id": "${id}" }`);
  save();
}
if (kv) console.log('✓ OAuth sign-in storage');

// 4. Deploy
console.log('\nDeploying…');
const dep = wrangler(['deploy'], { stdio: ['inherit', 'pipe', 'inherit'] });
process.stdout.write(dep.stdout ?? '');
if (dep.status !== 0) fail('deploy failed');
const url = dep.stdout.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];

// 5. Secrets: generated once; never rotated by a re-run (that would disconnect your agents)
const listed = wrangler(['secret', 'list', '--format', 'json']);
const have = new Set(listed.status === 0 ? JSON.parse(listed.stdout).map((s) => s.name) : []);
const saved = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) : {};
const add = {};
const token = () => randomBytes(24).toString('hex');
if (!have.has('AGENT_TOKENS')) {
  const names = (await ask('\nAgent names, comma separated (one token each)', 'claude,claude-code'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  add.AGENT_TOKENS = JSON.stringify(Object.fromEntries(names.map((n) => [n, token()])));
}
if (!have.has('ADMIN_TOKEN')) add.ADMIN_TOKEN = token();
if (Object.keys(add).length) {
  const r = wrangler(['secret', 'bulk'], { input: JSON.stringify(add) });
  if (r.status !== 0) fail(`secret bulk: ${out(r).trim()}`);
  Object.assign(saved, { url, ...add });
  writeFileSync(SECRETS_FILE, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  console.log(`✓ secrets set; tokens saved to ${SECRETS_FILE} (git-ignored). Move them to your password manager.`);
} else console.log('✓ secrets already set (kept)');

// 6. Live updates: the bucket sends create/delete events to the queue
const rules = wrangler(['r2', 'bucket', 'notification', 'list', bucket]);
if (out(rules).includes(queue)) console.log(`✓ bucket events → ${queue}: exists`);
else {
  const r = wrangler(['r2', 'bucket', 'notification', 'create', bucket, '--event-types', 'object-create', 'object-delete', '--queue', queue]);
  if (r.status !== 0) fail(`bucket notification: ${out(r).trim()}`);
  console.log(`✓ bucket events → ${queue}: created`);
}

// 7. First index
const admin = saved.ADMIN_TOKEN;
if (url && admin) {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${url}/admin/reindex?max=300`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) fail(`reindex: HTTP ${res.status}`);
    console.log(`✓ index: ${r.total} notes, ${r.remaining} remaining`);
    if (!r.remaining) break;
  }
} else console.log(`Build the index: curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" ${url ?? 'https://<worker>'}/admin/reindex`);

console.log(`\nDone. MCP endpoint: ${url ?? 'https://<worker>'}/mcp  (or ${url ?? 'https://<worker>'}/t/<agent-token>/mcp for the Claude app)`);
console.log(`Worker: ${worker}. Next: connect your agents (README "Connect agents").`);
rl.close();
