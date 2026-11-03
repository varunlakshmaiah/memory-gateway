---
type: decision
description: Decision: sync the vault to Cloudflare R2 with Remotely Save instead of OneDrive plus Graph.
updated: 2026-08-28
status: current
---
# Decision: use R2 for vault sync

Date: 2026-08-28. Status: accepted.

## Context
The vault was synced through OneDrive. Giving agents access would need Microsoft Graph webhooks, token refresh and subscription renewal.

## Decision
Sync the vault directly to a Cloudflare R2 bucket with the Remotely Save plugin. Keep OneDrive as a backup copy on one machine only.

## Consequences
- Fewer moving parts. R2 holds real markdown files.
- Obsidian must be open to sync, especially on phones.
- Only one tool should move changes between devices.
