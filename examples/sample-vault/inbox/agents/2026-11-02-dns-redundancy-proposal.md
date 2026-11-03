---
type: proposal
description: Agent proposal: how to add a second AdGuard Home node for DNS redundancy. Awaiting review.
updated: 2026-11-02
status: draft
---
# Proposal: second AdGuard Home node (draft)

Written by an agent. Not yet reviewed by Alex.

## Suggestion
Run a second AdGuard Home instance in a new LXC (for example ID 104, 10.10.30.6) and hand out both resolvers over DHCP: primary 10.10.30.5, secondary 10.10.30.6.

## Steps
1. Create the LXC on pve-01 with 1 vCPU and 512 MB RAM.
2. Install AdGuard Home and copy the config from 10.10.30.5.
3. Add 10.10.30.6 as a second DNS server in the OPNsense DHCP settings for all VLANs.
4. Test by stopping the primary and resolving a name from a laptop.

## Open questions
- Should config sync run automatically (for example with adguardhome-sync)?

Related: [[projects/home-lab-upgrade]], [[infra/dns-and-domains]].
