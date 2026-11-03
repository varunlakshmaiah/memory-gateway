# memory-gateway: MCP memory server for your Obsidian vault

Give Claude, Cursor, Copilot, Gemini CLI and any other MCP-capable AI agent **long-term memory from your own notes**. A small, self-hosted Cloudflare Worker turns a folder of markdown notes (your Obsidian vault) into a **memory layer any AI agent can plug into with one URL**, over MCP or a plain REST API.

- **Truth:** plain `.md` files in an R2 bucket. Obsidian syncs to it with the Remotely Save plugin.
- **Index:** a disposable D1 (SQLite) full-text index plus a Vectorize index for search by meaning (Workers AI `bge-m3` embeddings). Delete either any time; `/admin/reindex` rebuilds them from the files.
- **Access:** MCP over HTTP (Claude app, Claude Code, Hermes, anything MCP) and a plain REST API (anything else).
- **Tools:** `read_note`, `search`, `list`, `write_note`, `edit_note`. By default new notes go only to `inbox/agents/`, saved as `status: draft` and stamped with the agent name. You can allow an agent to revise and add notes in chosen folders; every edit is versioned so you can undo it.

```
Obsidian devices --Remotely Save--> R2 bucket (markdown) --event--> Queue --> Worker --> D1 full-text index
                                          ^                                      |  \-> Workers AI --> Vectorize
                                          +------------ read / write ------------+--- MCP + REST --> agents
```

Agents are told to start with `core/START-HERE.md` (see `examples/sample-vault`).

## Deploy (about 5 minutes)

Needs a Cloudflare account on the Workers paid plan (Queues need it). Pick one way:

**A. One command** (Node 20+):

```bash
git clone https://github.com/varunlakshmaiah/memory-gateway && cd memory-gateway
npm install
npm run setup
```

It logs you in, asks for your vault bucket name, creates the backup bucket, D1 database, queue and Vectorize index, deploys, generates tokens (saved to the git-ignored `.secrets.local.json`), turns on bucket events and builds the first index. Safe to re-run: existing resources and tokens are kept.

**B. Deploy button** (no local tools):

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/varunlakshmaiah/memory-gateway)

Cloudflare copies the repo to your GitHub, creates the buckets, database, queue and Vectorize index, and asks for the secrets (make each token with `openssl rand -hex 24`). Point the vault bucket at the one Remotely Save syncs to. The button cannot turn on bucket events, so run these once afterwards (or changes are only picked up by the nightly reindex), then build the first index:

```bash
npx wrangler r2 bucket notification create <vault-bucket> --event-type object-create object-delete --queue vault-events
curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://<worker>/admin/reindex   # repeat until "remaining" is 0
```

If Remotely Save stores the vault inside a folder of the bucket (for example `MyVault/`), set `VAULT_PREFIX` to that folder. The index tables are created by the Worker on first use; there is no migration step.

Then check it: `curl https://<worker>/health` should return ok, and `GET /admin/status` (admin token) shows note counts and recent writes.

**Cost.** Beyond the Workers paid plan ($5/month), a personal vault stays within the included usage of R2, D1, Queues and Vectorize. Workers AI is billed per use: one embedding each time a note is created or changed, and one per search. Leave out the `ai` and `vectorize` lines in `wrangler.jsonc` for keyword-only search with no AI usage.

**Remotely Save settings that matter:**
- Turn **encryption off**, otherwise agents read ciphertext.
- Folders whose names start with `_` are skipped by default ("Sync `_` files or folders"), so they never reach R2. Avoid them or turn that option on.
- Delete and move notes **inside Obsidian**. Files removed outside it (Finder, scripts) can be downloaded again from R2 on the next sync.
- Turn on a sync schedule and sync on save, or agents only see changes after a manual sync.

## Connect agents

The gateway is a remote MCP server over **Streamable HTTP** (stateless). Any client that can add a remote/HTTP MCP server can use it in one of three ways:

- **Header (preferred):** URL `https://<worker>/mcp` with header `Authorization: Bearer <token>`.
- **OAuth sign-in** (apps with a connector sign-in, such as the Claude app and ChatGPT): URL `https://<worker>/mcp`, then paste an agent token on the sign-in page. See [Sign in with OAuth](#sign-in-with-oauth-claude-app-chatgpt).
- **Token in the URL** (for clients that can do neither): `https://<worker>/t/<token>/mcp`. The token can then show up in logs, so give that client its own token.

| Client | How to connect |
|---|---|
| **Claude Code** | `claude mcp add --transport http memory https://<worker>/mcp --header "Authorization: Bearer <token>"` |
| **Claude app / claude.ai / Claude Desktop** | Settings → Connectors → Add custom connector, URL `https://<worker>/mcp` (OAuth sign-in), or `https://<worker>/t/<token>/mcp` |
| **Cursor** | Add a remote MCP server in `mcp.json`: the `/mcp` URL plus the `Authorization` header |
| **VS Code (GitHub Copilot agent mode)** | Add an HTTP MCP server in `mcp.json` with the URL and header |
| **Windsurf, Cline, Continue, Zed, Goose** | Add a remote (Streamable HTTP) MCP server with the URL and header |
| **Gemini CLI, OpenAI Codex CLI** | Add an HTTP MCP server in their settings with the URL and header |
| **ChatGPT (developer mode connectors)** | Add a remote MCP connector with `https://<worker>/mcp` and OAuth, or the token-in-URL form |
| **LM Studio** (local models) | Add a remote server to its `mcp.json` with the URL and header |
| **Hermes and other agent frameworks** (OpenAI Agents SDK, Anthropic API MCP connector, LangChain/LlamaIndex MCP adapters) | Point their MCP client at the URL with the header |
| **n8n** | MCP Client Tool node with header auth, or the REST API below |
| **Anything else** (scripts, curl, shortcuts) | REST: `GET /api/search?q=...&limit=5&folder=infra`, `GET /api/list?folder=...`, `GET /api/notes/<path>`, `PUT /api/notes/inbox/agents/<name>.md` (add `?overwrite=true` to replace your own earlier draft) |

Menu names and config keys vary between client versions; see the client's MCP docs.

Use one token per agent so the audit log and the `written_by` stamp tell you who wrote what. Rotate by editing `AGENT_TOKENS` and re-running `wrangler secret put`.

## Sign in with OAuth (Claude app, ChatGPT)

When the `OAUTH_KV` namespace is bound (the default config has it), `/mcp` also accepts OAuth 2.1 sign-in, so apps that support it connect with the plain URL `https://<worker>/mcp`, with no token in it:

1. Add `https://<worker>/mcp` as a connector in the app.
2. The app opens a sign-in page on your worker. Paste the agent token the app should act as (for example your `claude` token) and press Allow.
3. The app gets its own OAuth tokens (access for 1 hour, refreshed for 30 days) and acts as that agent: same `written_by` stamp, same `EDIT_POLICY` folders, same audit log.

There is no password or user database: knowing an agent token is the sign-in. Removing an agent from `AGENT_TOKENS` also cuts off its OAuth sessions. Static tokens keep working everywhere (`Authorization: Bearer` on `/mcp` and `/api/`, and `/t/<token>/mcp`), so existing connections do not change. Remove the `kv_namespaces` lines for static tokens only.

## Try it locally first

Everything runs on your machine except the Workers AI binding, which always connects to Cloudflare (`npx wrangler login`, a free account is enough). Vectorize cannot run locally, so `npm run dev` sets `SEMANTIC_SEARCH=off` and search is keyword-only. For a fully offline run, delete the `ai` and `vectorize` lines from your `wrangler.jsonc`.

```bash
npm install
printf '%s\n' 'AGENT_TOKENS={"claude":"local-dev-token-claude-0123456789","hermes":"local-dev-token-hermes-0123456789"}' \
  'ADMIN_TOKEN=local-dev-admin-token-0123456789' > .dev.vars   # local-only tokens the smoke test expects
npm run seed:local          # loads examples/sample-vault into a simulated R2 bucket
npm run dev                 # in one terminal
npm run smoke               # in another: 40 checks across MCP, REST, auth, search, write and edit guardrails
npm test                    # unit tests
```

The smoke test asserts the answers to the questions in `examples/sample-vault/TEST-QUESTIONS.md`. Run the same questions through a real agent after deploying.

Against your deployed worker and real vault, skip the sample-content checks:

```bash
VAULT=real node scripts/smoke.mjs https://<worker> <agent-token> <admin-token>
```

It writes one note, `inbox/agents/smoke-test.md`, and overwrites it on every run. If your deployment allows that agent to edit and has a `BACKUP` bucket, add `EXPECT_EDIT=1` to also check a real edit; otherwise it checks that edits are refused.

## Letting agents revise and add notes (optional)

By default agents only add drafts to `inbox/agents/`. To let an agent revise existing notes when you ask ("update the deadline in my Jarvis note") and create new notes in those folders ("add today's journal entry"), set `EDIT_POLICY` in `wrangler.jsonc` (or in the Worker's variables in the dashboard):

```jsonc
"EDIT_POLICY": "{\"claude\":[\"projects/\",\"notes/\"],\"claude-code\":[\"\"]}"   // "" = whole vault
```

- The `edit_note` tool replaces one exact passage (`old_text` must occur exactly once), so an agent cannot silently overwrite text you changed after it read the note.
- `core/` can never be edited, and neither can any note with `locked: true` in its frontmatter.
- Edits stamp `updated` and `updated_by: <agent>`; the note keeps its status. Nothing is ever deleted or moved.
- In allowed folders `write_note` can also create new notes. They keep their own status (default `current`, not draft) and are stamped `written_by: <agent>`. It never replaces an existing note there; that is what `edit_note` (versioned) is for.
- Before each edit the previous version is saved to the `BACKUP` bucket under `versions/<path>/`. Without a `BACKUP` bucket, editing is refused.
- Undo with the admin token: `GET /admin/versions?path=<note>` lists versions, `POST /admin/restore?path=<note>&version=<id>` puts one back (the current text is saved first).
- REST equivalent: `PATCH /api/notes/<path>` with `{"old_text": "...", "new_text": "..."}`.
- Sync Obsidian before asking for a revision: if you edit the same note at the same time, Remotely Save keeps the newer copy. The saved versions mean nothing is lost.

## Vault conventions that make agents reliable

- `core/START-HERE.md` is the entry point: who you are, how the vault is laid out, rules for agents.
- Each folder has a `README.md` map with one line per note.
- Frontmatter: `type`, `description` (one line), `updated`, `status` (`current`, `draft`, `outdated`), `supersedes`.
- When something changes, write a new note that `supersedes` the old one and mark the old one `outdated`. Search shows `[outdated]` and ranks those lower.
- Notes in `archive/` and `journal/` rank lower, like outdated notes. `meta/templates/` is readable but not searched.
- Don't start folder names with `_`: Remotely Save skips them by default, so they never reach R2.
- No secrets in the vault. Agents can read everything in it.

Mark any note agents must never change with `locked: true`. You review `inbox/agents/` now and then, move good drafts into the right folder, and change `status` to `current`.

## Security notes

- Tokens are compared in constant time and must be 16+ characters. `/health` is the only open route.
- The `/t/<token>/` form puts the secret in the URL, so it can show up in logs. Prefer OAuth sign-in where the app supports it, use `/t/` only where neither OAuth nor headers work, and give that agent its own token.
- Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
- The daily snapshot goes to a **second** bucket (`BACKUP`). Never point it at the synced bucket: a snapshot inside the same bucket is not a backup, and Remotely Save would sync it to your devices.
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
src/tools.ts     the tools
src/indexer.ts   D1 index, search, reindex
src/notes.ts     frontmatter, path safety, query building, write stamping
src/snapshot.ts  optional backup to a second bucket
src/keys.ts      vault path <-> bucket key
src/auth.ts      tokens
src/oauth.ts     OAuth sign-in and consent page
schema.sql       D1 schema (rebuildable)
wrangler.jsonc   config with deployable defaults (setup and the Deploy button use it)
scripts/         setup, local seeding and the end-to-end smoke test
test/            unit tests (npm test)
examples/        sample vault + test questions
```

## License

MIT, see [LICENSE](LICENSE).
