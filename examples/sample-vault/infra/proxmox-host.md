---
type: infra
description: Proxmox host pve-01: hardware, VMs and containers, resources and maintenance.
updated: 2026-10-30
status: current
---
# Proxmox host (pve-01)

- Hardware: mini workstation, 8 cores, 64 GB RAM, 2 TB NVMe (VM storage), 1 TB SATA SSD (backups).
- Address: 10.10.30.10 (VLAN 30). Web UI on port 8006, reachable from Trusted and over WireGuard only.
- Updates: monthly, first Saturday. Snapshot VMs before updating.

## Guests
| ID | Name | Type | Address | Notes |
|---|---|---|---|---|
| 100 | docker-host | VM, 4 vCPU, 12 GB | 10.10.30.21 | Runs Docker stack incl. cloudflared, Jellyfin, Gitea |
| 101 | home-assistant | VM, 2 vCPU, 4 GB | 10.10.30.22 | Home Assistant OS |
| 102 | adguard | LXC, 1 vCPU, 512 MB | 10.10.30.5 | AdGuard Home, primary DNS |
| 103 | build-runner | VM, 4 vCPU, 8 GB | 10.10.30.23 | Godot export builds, started on demand |

## Decision
Chose Proxmox over bare Docker in September. See [[decisions/2026-09-use-proxmox]].
