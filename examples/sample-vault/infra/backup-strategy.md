---
type: infra
description: 3-2-1 backup plan: what is backed up, where, how often, and how restores are tested.
updated: 2026-10-05
status: current
---
# Backup strategy (3-2-1)

| Layer | What | Where | When |
|---|---|---|---|
| 1. Snapshots | NAS shares | On the NAS | Per share (see [[infra/nas-synology]]) |
| 2. Local copy | Proxmox VMs | 1 TB SSD in pve-01 and NAS `backups` share | Nightly 01:30 |
| 3. Offsite | NAS `projects` and `docs` | Cloudflare R2 bucket `nas-offsite` | Sundays 03:00 |
| 4. Cold copy | Everything important | USB drive kept in a drawer | First Saturday of the month |

## Restore tests
Once per quarter, restore one VM and one folder from offsite and confirm it boots or opens. Log the result in the quarterly check. See [[routines/backup-checks]].

## Known gap
The Obsidian vault lives in R2 and on every device. A nightly snapshot of the vault bucket is still to be added. Tracked in [[projects/memory-gateway]].
