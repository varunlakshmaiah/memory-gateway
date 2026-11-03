---
type: infra
description: WireGuard remote access: subnet, port, peers and how to add a new device.
updated: 2026-09-18
status: current
---
# WireGuard VPN

- Server: OPNsense (`fw-01`), UDP port 51820, tunnel subnet 10.10.99.0/24.
- Peers: laptop (10.10.99.2), phone (10.10.99.3), tablet (10.10.99.4).
- Split tunnel: only 10.10.0.0/16 is routed through the VPN.
- Peers can reach Servers and Management. They cannot reach IoT or Cameras.

## Adding a device
1. Create a peer in OPNsense under VPN > WireGuard.
2. Assign the next free address in 10.10.99.0/24.
3. Scan the QR code on the device. Delete the QR afterwards.
4. Test by opening `https://pve.home.alexrivera.example:8006`.
