# Phase 11–12 — Plan: Release

```text
eas.json
app.json                 # production identifiers, icons, permissions review
scripts/check-no-sensitive-logs.sh  # optional CI guard
tests/release/checklist.md
```

## DB Impact
None expected. Migrations must already be stable.

## Exit Criteria
Signed Android build distributed to the couple; release checklist archived under `tests/release/`.

