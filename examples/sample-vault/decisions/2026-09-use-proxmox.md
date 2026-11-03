---
type: decision
description: Decision: run services in Proxmox VMs and containers instead of one bare Docker host.
updated: 2026-09-03
status: current
---
# Decision: Proxmox over bare Docker

Date: 2026-09-03. Status: accepted.

Reasons: snapshots before risky changes, easy VM backups, ability to isolate Home Assistant and DNS from the Docker host.
Trade-off: more RAM overhead and one more thing to update monthly.
See [[infra/proxmox-host]].
