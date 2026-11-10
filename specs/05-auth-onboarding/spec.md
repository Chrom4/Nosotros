# Phase 5 — Authentication, Couple Onboarding & Biometric Lock

## 1. Purpose
Deliver login/session persistence, household creation, 8-character invite pairing (max 2 members), revocation with **local crypto-shredding**, and biometric/PIN guard after background inactivity (**DEC-03**).

## 2. Scope
- Routes under `/src/app/(auth)/`.
- Supabase Auth session in SecureStore.
- Invite generate/accept UX calling Phase 3 RPCs.
- `expo-local-authentication` guard in root layout.
- E2E pairing of exactly two users; revoked device wipes local SQLite.

### Out of scope
- Finance entry screens (Phase 6+).

## 3. Hard Requirements
- Never ship `service_role` in the app.
- On revoke: delete local DB key / truncate store (crypto-shred) and stop sync.
- Biometric lock on cold start and after background inactivity threshold (DEC-03; default recommendation: 2 minutes unless product owner overrides).

## 4. Acceptance Gates
- Two-user pairing happy path works online.
- Third join blocked.
- Revocation clears local data on next launch/sync denial.

