---
type: infra
description: DNS setup: AdGuard Home as resolver, local domain names, public records and tunnel hostnames.
updated: 2026-10-25
status: current
---
# DNS and domains

## Internal
- Resolver: AdGuard Home on 10.10.30.5 (LXC 102). Upstream: Cloudflare DNS over HTTPS.
- Local domain: `home.alexrivera.example`. Examples: `nas.home...` -> 10.10.30.50, `pve.home...` -> 10.10.30.10.
- A second AdGuard instance is planned for redundancy. See [[projects/home-lab-upgrade]].

## Public (Cloudflare)
| Hostname | Target | Access |
|---|---|---|
| git.alexrivera.example | Tunnel -> Gitea (docker-host:3000) | Zero Trust Access (email login) |
| media.alexrivera.example | Tunnel -> Jellyfin (docker-host:8096) | Zero Trust Access |
| alexrivera.example | Website (Cloudflare Pages) | Public |
