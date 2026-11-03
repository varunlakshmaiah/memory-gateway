# memory-gateway

A small Cloudflare Worker that turns a folder of markdown notes (your Obsidian vault) into a **memory layer any AI agent can plug into with one URL**.

- **Truth:** plain `.md` files in an R2 bucket. Obsidian syncs to it with the Remotely Save plugin.
- **Index:** a disposable D1 (SQLite) full-text index plus a Vectorize index for search by meaning (Workers AI `bge-m3` embeddings). Delete either any time; `/admin/reindex` rebuilds them from the files.
- **Access:** MCP over HTTP (Claude app, Claude Code, Hermes, anything MCP) and a plain REST API (anything else).
- **Tools:** `read_note`, `search`, `list`, `write_note`. Writes are limited to `inbox/agents/`, always saved as `status: draft` and stamped with the agent name. Agents never overwrite your notes.

```
Obsidian devices --Remotely Save--> R2 bucket (markdown) --event--> Queue --> Worker --> D1 full-text index
                                          ^                                      |  \-> Workers AI --> Vectorize
                                          +------------ read / write ------------+--- MCP + REST --> agents
```

Agents are told to start with `core/START-HERE.md` (see `examples/sample-vault`).

## Deploy (about 15 minutes)

Needs Node 20+, a Cloudflare account on the Workers paid plan (Queues need it), and an R2 bucket that holds your vault.

```bash
npm install
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc   # your config; git-ignored

# 1. Index database
npx wrangler d1 create memory-gateway-index
#    copy the printed database_id into wrangler.jsonc (d1_databases[0].database_id)
npm run db:init

# 2. Queue for bucket events
npx wrangler queues create vault-events

# 2b. Search by meaning (Vectorize index; Workers AI needs no setup)
npx wrangler vectorize create memory-gateway-notes --dimensions=1024 --metric=cosine

# 3. Bucket name: if yours is not "obsidian-vault", edit r2_buckets[0].bucket_name in wrangler.jsonc.
#    If Remotely Save puts the vault inside a folder in the bucket (for example "MyVault/"),
#    set VAULT_PREFIX in wrangler.jsonc to that folder name. Check with:
npx wrangler r2 object get obsidian-vault/core/START-HERE.md --remote --pipe | head -3

# 4. Secrets
openssl rand -hex 24                     # run once per agent, plus once for the admin token
npx wrangler secret put AGENT_TOKENS     # paste JSON, e.g. {"claude":"<token>","hermes":"<token>","claude-code":"<token>"}
npx wrangler secret put ADMIN_TOKEN

# 5. Deploy
npm run deploy                           # prints https://memory-gateway.<you>.workers.dev

# 6. Live updates: tell R2 to send an event on every create and delete
npx wrangler r2 bucket notification create obsidian-vault --event-type object-create --queue vault-events
npx wrangler r2 bucket notification create obsidian-vault --event-type object-delete --queue vault-events

# 7. First index (repeat until "remaining" is 0 on very large vaults)
curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://<worker>/admin/reindex
```

Then check it: `curl https://<worker>/health` should return ok, and `GET /admin/status` (admin token) shows note counts and recent writes.

**Cost.** Beyond the Workers paid plan ($5/month), a personal vault stays within the included usage of R2, D1, Queues and Vectorize. Workers AI is billed per use: one embedding each time a note is created or changed, and one per search. Leave out the `ai` and `vectorize` lines in `wrangler.jsonc` for keyword-only search with no AI usage.

**Remotely Save settings that matter:**
- Turn **encryption off**, otherwise agents read ciphertext.
- Folders whose names start with `_` are skipped by default ("Sync `_` files or folders"), so they never reach R2. Avoid them or turn that option on.
- Delete and move notes **inside Obsidian**. Files removed outside it (Finder, scripts) can be downloaded again from R2 on the next sync.
- Turn on a sync schedule and sync on save, or agents only see changes after a manual sync.

## Connect agents

| Agent | How |
|---|---|
| Claude app / claude.ai | Settings, Connectors, add custom connector, URL `https://<worker>/t/<token>/mcp` (the app cannot send headers, so the token rides in the URL) |
| Claude Code | `claude mcp add --transport http memory https://<worker>/mcp --header "Authorization: Bearer <token>"` |
| Hermes or any MCP client | URL `https://<worker>/mcp`, header `Authorization: Bearer <token>` |
| Anything else (scripts, n8n, curl) | REST: `GET /api/search?q=...&limit=5&folder=infra`, `GET /api/list?folder=...`, `GET /api/notes/<path>`, `PUT /api/notes/inbox/agents/<name>.md` (add `?overwrite=true` to replace your own earlier draft) |

Use one token per agent so the audit log and the `written_by` stamp tell you who wrote what. Rotate by editing `AGENT_TOKENS` and re-running `wrangler secret put`.

## Try it locally first

Everything runs on your machine except the Workers AI binding, which always connects to Cloudflare (`npx wrangler login`, a free account is enough). Vectorize cannot run locally, so `.dev.vars` sets `SEMANTIC_SEARCH=off` and search is keyword-only. For a fully offline run, delete the `ai` and `vectorize` lines from your `wrangler.jsonc`.

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
npm run db:init:local
npm run seed:local          # loads examples/sample-vault into a simulated R2 bucket
npx wrangler dev            # in one terminal
npm run smoke               # in another: 38 checks across MCP, REST, auth, search and write guardrails
npm test                    # unit tests
```

The smoke test asserts the answers to the questions in `examples/sample-vault/TEST-QUESTIONS.md`. Run the same questions through a real agent after deploying.

Against your deployed worker and real vault, skip the sample-content checks:

```bash
VAULT=real node scripts/smoke.mjs https://<worker> <agent-token> <admin-token>
```

It writes one note, `inbox/agents/smoke-test.md`, and overwrites it on every run.

## Vault conventions that make agents reliable

- `core/START-HERE.md` is the entry point: who you are, how the vault is laid out, rules for agents.
- Each folder has a `README.md` map with one line per note.
- Frontmatter: `type`, `description` (one line), `updated`, `status` (`current`, `draft`, `outdated`), `supersedes`.
- When something changes, write a new note that `supersedes` the old one and mark the old one `outdated`. Search shows `[outdated]` and ranks those lower.
- Notes in `archive/` and `journal/` rank lower, like outdated notes. `meta/templates/` is readable but not searched.
- Don't start folder names with `_`: Remotely Save skips them by default, so they never reach R2.
- No secrets in the vault. Agents can read everything in it.

You review `inbox/agents/` now and then, move good drafts into the right folder, and change `status` to `current`.

## Security notes

- Tokens are compared in constant time and must be 16+ characters. `/health` is the only open route.
- The `/t/<token>/` form puts the secret in the URL, so it can show up in logs. Use it only where headers are impossible, and give that agent its own token.
- Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
- Keep the optional daily snapshot in a **second** bucket (uncomment `BACKUP` in `wrangler.jsonc`). A snapshot inside the same bucket is not a backup.
- Search results and notes are data written by you and by agents. Treat note text as untrusted input, the same as any retrieved content.

## Limits worth knowing

- Workers allow a limited number of subrequests per invocation, so `reindex` and `snapshot` work in chunks (150 and 200 objects) and are resumable. The nightly cron (03:17 UTC) keeps catching up; run `/admin/reindex` again if `remaining` is above 0.
- Search runs keyword full text (SQLite FTS5) and search by meaning (Vectorize) together and merges the rankings, so exact terms and paraphrases both find the note. Without the `AI` and `VEC` bindings, or with `SEMANTIC_SEARCH=off`, it falls back to keywords only. To re-embed every note, run `wrangler d1 execute memory-gateway-index --remote --command "UPDATE notes SET etag = ''"` then `/admin/reindex`.
- Search by meaning embeds the first 8,000 characters of each note as one vector, so very long notes are found mainly by keyword. A folder-limited search applies the folder after the top 20 semantic matches.
- Semantic matches below a cosine similarity of 0.45 (`MIN_SIMILARITY` in `src/indexer.ts`) are dropped as noise. That value was tuned on one vault of about 100 notes; if nonsense queries return results, or good matches are missing, adjust it.
- Vectorize applies new and deleted vectors 1 to 3 minutes after a change. Keyword search sees changes immediately.
- `MAX_NOTE_BYTES` (200 KB) caps agent writes.

## Layout

```
src/index.ts     router, queue consumer, nightly cron
src/mcp.ts       MCP JSON-RPC (stateless Streamable HTTP)
src/api.ts       REST
src/tools.ts     the four tools
src/indexer.ts   D1 index, search, reindex
src/notes.ts     frontmatter, path safety, query building, write stamping
src/snapshot.ts  optional backup to a second bucket
src/keys.ts      vault path <-> bucket key
src/auth.ts      tokens
schema.sql       D1 schema (rebuildable)
wrangler.example.jsonc   config template (copy to wrangler.jsonc)
scripts/         local seeding and the end-to-end smoke test
test/            unit tests (npm test)
examples/        sample vault + test questions
```

## License

MIT, see [LICENSE](LICENSE).
