# Phase 5 — Plan: Auth UX

```text
src/app/(auth)/login.tsx
src/app/(auth)/create-household.tsx
src/app/(auth)/accept-invite.tsx
src/app/_layout.tsx          # providers + biometric gate
src/store/sessionUI.ts       # ephemeral only
```

## DB Impact
Uses existing household_members; no schema redesign.

## Exit Criteria
Manual/E2E checklist for pairing + revoke recorded; unit tests for invite validation where applicable.

