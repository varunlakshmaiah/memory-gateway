---
type: log
description: Incident log: NAS disk 3 SMART warnings in September 2026 and the replacement.
updated: 2026-09-22
status: current
---
# Incident: NAS disk 3 (September 2026)

| Date | Event |
|---|---|
| 2026-09-14 | DSM raised SMART warnings on disk 3 (reallocated sectors rising) |
| 2026-09-15 | Confirmed fresh backups. Ordered a replacement 8 TB drive |
| 2026-09-20 | Replacement arrived |
| 2026-09-21 | Swapped the drive. SHR rebuild took about 19 hours |
| 2026-09-22 | Rebuild finished, volume healthy. No data lost |

## Lessons
- Keep one spare drive on the shelf.
- SMART alerts now go to push notifications, not just email.
