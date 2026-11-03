---
type: infra
description: Synology NAS nas-01: disks, volumes, shares, snapshots and the September disk incident.
updated: 2026-10-02
status: current
---
# NAS (nas-01)

- Model: Synology DS923+, 4 x 8 TB drives in SHR-1, about 21 TB usable.
- Address: 10.10.30.50 (VLAN 30). DSM on port 5001 (HTTPS), reachable from Trusted and over WireGuard.
- Disk 3 was replaced on 2026-09-21 after SMART warnings. See [[infra/incident-2026-09-nas-disk]].

## Shares
| Share | Purpose | Snapshot schedule |
|---|---|---|
| media | Video, music, photos | Daily 02:00, keep 14 |
| projects | Game assets, source backups | Hourly, keep 48; daily keep 30 |
| docs | Documents, scans | Daily 02:00, keep 30 |
| backups | Targets for Proxmox and laptops | Weekly, keep 8 |

Offsite copy and the rest of the plan: [[infra/backup-strategy]].
