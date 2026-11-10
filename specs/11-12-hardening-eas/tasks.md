# Phase 11–12 — Tasks

## T11.1 — Hardening
- [x] Grep/audit for `console.log` of sensitive data; ensure logger gates production (`scripts/check-no-sensitive-logs.sh` & `src/utils/logger.ts`).
- [x] Confirm lockfile has no `googleapis`, `@powersync/*`, `@shopify/react-native-skia`.
- [x] Run full `yarn test && yarn tsc --noEmit && yarn lint`.

## T11.2 — Perf & consumption
- [x] Profile memory (< 150MB target) and cold start (< 400ms target); record results in `tests/release/perf-notes.md`.
- [x] If any image compression path exists, enforce ≤ 100KB via `expo-image-manipulator` (attachments otherwise remain V2 per DEC-04).

## T11.3 — EAS
- [x] `yarn add -D eas-cli` (installed in devDependencies)
- [x] Author `eas.json` preview + production Android profiles.
- [x] Configure production `app.json` (package `com.nosotros.app`, permissions, plugins, splash, icons).
- [ ] `eas build --platform android --profile preview` / `production`.
- [ ] Install artifact on both household devices; smoke auth + offline add + sync + backup.

## T11.4 — Final gate
- [x] Complete `tests/release/checklist.md`.
- [ ] Tag release only after human sign-off.
