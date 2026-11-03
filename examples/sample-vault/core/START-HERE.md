---
type: preference
description: Entry point for every AI agent: who Alex is, how to work with them, setup summary and vault map. Read first.
updated: 2026-11-03
status: current
---
# START HERE

Read this file first. It tells you who I am, how I like to work, and where to find things in this vault.
(This is a fictional sample vault for testing the memory gateway. Everything in it is made up.)

## How to use this vault
- Read before you ask. Search the vault for an answer before asking me a question.
- Write new notes only in `inbox/agents/`. Never edit `core/`.
- When something changes, write a new note and set `supersedes` to the old one. Do not overwrite.
- Every note has a one-line `description` in its frontmatter. Use it to decide what to open.
- Notes with `status: outdated` are history. Trust notes with `status: current`.

## About me
- Name: Alex Rivera. Details in [[core/profile]].
- Indie game developer and home-lab hobbyist, based in Porto, Portugal (Europe/Lisbon time zone).
- Working on: the game *Tidewalker* ([[projects/tidewalker-game]]) and a home-lab upgrade ([[projects/home-lab-upgrade]]).

## How I like you to work
- Full details in [[core/preferences]]. Short version: concise answers, metric units, 24-hour time, commands in code blocks, ask before anything destructive.

## My setup (summary)
- Network: OPNsense router, 5 VLANs, WireGuard VPN. See [[infra/network-overview]].
- Servers: Proxmox host and a Synology NAS. See [[infra/proxmox-host]] and [[infra/nas-synology]].
- Cloud: Cloudflare for DNS, tunnels, R2 and Workers. See [[infra/cloudflare-account]].
- Backups: 3-2-1 strategy. See [[infra/backup-strategy]].

## Vault map
| Folder | What is in it |
|---|---|
| `core/` | This file, profile, preferences. Read-only for agents. |
| `infra/` | Network, servers, cloud, backups, incidents |
| `routines/` | Daily, weekly and monthly habits |
| `projects/` | One note per project |
| `people/` | People I work or live with |
| `decisions/` | Dated decision records |
| `inbox/agents/` | Where agents write new notes. I review and promote them. |

## Secrets
Never store passwords, keys or tokens in this vault. Notes say where a secret is kept (my password manager), not the secret.
