---
type: infra
description: Cloudflare services in use: DNS, tunnels, Zero Trust Access, R2 buckets and Workers.
updated: 2026-11-02
status: current
---
# Cloudflare account

Plan: Workers Paid. Domain: `alexrivera.example` (fictional).

## Services in use
| Service | Used for |
|---|---|
| DNS | All public records for the domain |
| Tunnel (`cloudflared` on docker-host) | Exposes Gitea and Jellyfin without open ports |
| Zero Trust Access | Login gate for Gitea and admin panels |
| R2 | Buckets `obsidian-vault` (memory gateway) and `nas-offsite` (weekly NAS backup) |
| Workers | `memory-gateway` (MCP server for the Obsidian vault), small redirects |

## Notes
- API tokens are stored in the password manager under "Cloudflare". Never in the vault.
- The memory gateway project is described in [[projects/memory-gateway]].
- R2 sync decision: [[decisions/2026-08-use-r2-for-sync]].
