---
type: routine
description: Monthly and quarterly backup verification steps.
updated: 2026-10-05
status: current
---
# Backup checks

## Monthly (first Saturday)
- Plug in the USB drive and run the cold copy.
- Confirm last Sunday's offsite job finished in the R2 dashboard.
- Check DSM storage health and SMART status.

## Quarterly
- Restore one VM from backup and boot it.
- Restore a random folder from R2 and open three files.
- Record results in this note.

| Quarter | Result |
|---|---|
| 2026 Q3 | VM restore OK (docker-host), folder restore OK |
