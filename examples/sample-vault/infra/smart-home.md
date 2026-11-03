---
type: infra
description: Home Assistant setup: integrations, key automations and the IoT devices involved.
updated: 2026-10-08
status: current
---
# Smart home

Home Assistant OS runs as VM 101 (10.10.30.22, port 8123).

## Integrations
Zigbee coordinator (USB), 14 Zigbee sensors, 6 smart plugs, 2 PoE cameras (via NAS), Spotify, weather.

## Key automations
- **Night mode** at 23:30: lights off, plugs for the desk and TV off, front door check.
- **Away mode**: when both phones leave home, heating drops to 17 C.
- **Leak alert**: any water sensor triggers a phone notification and turns off the washing machine plug.
