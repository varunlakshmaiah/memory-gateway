---
type: infra
description: VLAN IDs, subnets, purposes and firewall rules between VLANs.
updated: 2026-10-12
status: current
---
# VLANs

| VLAN | Name | Subnet | Purpose |
|---|---|---|---|
| 1 | Management | 10.10.0.0/24 | Router, switch, access points |
| 10 | Trusted | 10.10.10.0/24 | Laptops, phones |
| 20 | IoT | 10.10.20.0/24 | Smart plugs, TV, speakers |
| 30 | Servers | 10.10.30.0/24 | Proxmox, NAS, AdGuard |
| 40 | Guests | 10.10.40.0/24 | Visitors, internet only |
| 50 | Cameras | 10.10.50.0/24 | Two PoE cameras, no internet |

## Firewall rules (summary)
1. Trusted can reach Servers and IoT. Nothing initiates into Trusted.
2. IoT can only reach the internet and Home Assistant (10.10.30.22, port 8123).
3. Guests: internet only, client isolation on.
4. Cameras: no internet. Only the NAS (10.10.30.50) may pull streams.
5. All VLANs may query DNS at 10.10.30.5 on port 53 only.

## Wi-Fi SSIDs
`Rivera-Home` (Trusted, WPA3), `Rivera-IoT` (IoT, 2.4 GHz only), `Rivera-Guest` (Guests).
