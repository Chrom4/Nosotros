# Phase 11–12 — Hardening, Consumption Audit & EAS Production Build

## 1. Purpose
Production readiness: strip sensitive logs, memory/perf budgets, optional image pipeline hygiene (≤100KB **if** any image path exists; attachments otherwise V2), EAS Android `.aab`/`.apk`, and validation on both household devices.

## 2. Scope
- Production log audit (`__DEV__ === false`).
- Memory profiling target **< 150MB** RAM typical session.
- Cold start target **< 400ms** on mid-range Android.
- `yarn lint` + `yarn tsc --noEmit` + full `yarn test` = 0 failures.
- EAS Build profiles for Android production/preview.
- Final install verification on both phones.

### Out of scope
- New product features; schema redesign.

## 3. Hard Requirements
- No financial payloads/tokens in production logs.
- No forbidden libraries in the lockfile.
- EAS secrets configured outside the repo.

## 4. Acceptance Gates
| Gate | Criterion |
|---|---|
| GATE-11.1 | Full test suite green |
| GATE-11.2 | Lint + typecheck clean |
| GATE-11.3 | EAS Android artifact built |
| GATE-11.4 | APK/AAB installed & smoke-tested on both devices |
| GATE-11.5 | Cold start / memory notes captured vs targets |

