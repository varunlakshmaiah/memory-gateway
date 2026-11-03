---
type: project
description: Project to make this Obsidian vault the shared memory for all AI agents through a Cloudflare Worker MCP server.
updated: 2026-11-03
status: current
---
# Memory gateway

Goal: one URL that any AI agent can connect to for Alex's personal memory, with this vault as the single source of truth.

## Design (v3)
- Vault of plain markdown files, synced to R2 with the Remotely Save plugin.
- D1 SQLite full-text index, rebuilt from the files.
- One Worker exposing four tools: `read_note`, `search`, `list`, `write_note` (inbox only).
- Backup: OneDrive copy on one machine plus a daily bucket snapshot.

## Status
| Step | Status |
|---|---|
| Fill in `START-HERE.md` | Done |
| R2 bucket and Remotely Save | In progress |
| Worker with read and search | Not started |
| Connect Claude as a custom connector | Not started |
| Connect Hermes | Not started |

Decision record: [[decisions/2026-08-use-r2-for-sync]].
