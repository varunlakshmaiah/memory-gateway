---
type: infra
description: Current home network: OPNsense router, 5 VLANs, switch, access points and ISP details.
updated: 2026-10-12
status: current
supersedes: infra/old-network.md
---
# Network overview

Replaces [[infra/old-network]] (flat network, retired 2026-08-30).

## Topology
ISP fibre (1 Gbps symmetric) -> ONT in bridge mode -> OPNsense router (`fw-01`, 10.10.0.1) -> core switch (`sw-core-01`, 10.10.0.2) -> VLANs and access points.

## Key devices
| Name | Role | Address |
|---|---|---|
| fw-01 | OPNsense router and firewall, Protectli mini PC | 10.10.0.1 |
| sw-core-01 | 24-port managed PoE switch | 10.10.0.2 |
| ap-living | Wi-Fi 6 access point, living room | 10.10.0.11 |
| ap-office | Wi-Fi 6 access point, office | 10.10.0.12 |
| pve-01 | Proxmox host | 10.10.30.10 |
| nas-01 | Synology NAS | 10.10.30.50 |

## Rules of thumb
- Management network is 10.10.0.0/24. Only reachable from the trusted VLAN and over WireGuard.
- DNS for all VLANs is AdGuard Home at 10.10.30.5 (see [[infra/dns-and-domains]]).
- VLAN details in [[infra/vlans]]. Remote access in [[infra/vpn-wireguard]].
