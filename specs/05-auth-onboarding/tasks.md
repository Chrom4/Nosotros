# Phase 5 — Tasks

## T5.1 — Auth client
- [x] `yarn add @supabase/supabase-js expo-local-authentication expo-secure-store`
- [x] Implement Supabase client with SecureStore auth storage.
- [x] Build login + session restore.

## T5.2 — Onboarding
- [x] Create household screen.
- [x] Generate/display 8-char invite; accept-invite screen.
- [x] Enforce max-2 UX error mapping for `HOUSEHOLD_FULL`.

## T5.3 — Biometrics & shred
- [x] Biometric gate (cold start + inactivity).
- [x] On revoke/FORBIDDEN: shred SQLCipher key / wipe local DB.

## T5.4 — Gates
- [x] Document E2E pairing + revoke results.
- [x] `yarn tsc --noEmit && yarn lint && yarn test`
- [x] Stop for Phase 6.

