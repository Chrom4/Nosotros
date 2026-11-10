# Phase 0 — Plan: Repository Topology & Tooling Layout

## 1. Architectural Intent
Phase 0 freezes the **horizontal layered topology** under `/src/*` (audit §13.10.1 / AUD-10 fix) and the **SDD specs tree** under `/specs/*` (AGENTS.md §6). Later phases only fill files inside these folders; they must not invent alternate roots.

## 2. Target Tree (Repository Root)

```text
/
├── AGENTS.md                      # SDD constitution (must live at root)
├── app.json                       # Expo config (newArchEnabled: true)
├── package.json                   # Yarn project; scripts: test, lint, typecheck
├── tsconfig.json                  # strict: true; paths: "@/*" -> "./src/*"
├── babel.config.js                # Expo babel preset (+ optional module-resolver if needed)
├── jest.config.js                 # preset: jest-expo; roots: <rootDir>/tests
├── .eslintrc.js / eslint.config.* # Expo ESLint flat or legacy config
├── yarn.lock
├── specs/                         # Spec-Driven Development artifacts (already scaffolded)
│   ├── AGENTS.md                  # Canonical source copy kept with specs docs
│   ├── 00-governance-base/        # THIS phase (spec.md, plan.md, tasks.md)
│   ├── 01-accounting-core/
│   ├── 02-local-persistence/
│   ├── 03-supabase-rls/
│   ├── 04-sync-engine/
│   ├── 05-auth-onboarding/
│   ├── 06-accounts-transactions/
│   ├── 07-cards-invoices/
│   ├── 08-recurring-projections/
│   ├── 09-dashboard-budgets/
│   ├── 10-backup-calendar/
│   └── 11-12-hardening-eas/
├── supabase/                      # Placeholder only in Phase 0
│   └── migrations/                # Empty; filled in Phase 3
├── src/
│   ├── app/                       # Expo Router file-based routes (View layer)
│   │   ├── (auth)/                # Empty group — Phase 5
│   │   ├── (tabs)/                # Empty group — Phases 6–9
│   │   ├── _layout.tsx            # Minimal Expo Router root layout (boilerplate only)
│   │   └── index.tsx              # Minimal placeholder screen (boilerplate only)
│   ├── components/                # Shared MD3-ready UI (empty in Phase 0)
│   ├── core/                      # Pure domain — Phase 1
│   ├── data/                      # Local persistence — Phase 2
│   │   ├── migrations/
│   │   ├── schema/
│   │   └── repositories/
│   ├── sync/                      # Sync + Google integrations — Phases 4 / 10
│   └── store/                     # Ephemeral Zustand UI state — later phases
└── tests/
    └── smoke.test.ts              # Single Phase 0 smoke assertion
```

## 3. Config Decisions

| File | Decision |
|---|---|
| `app.json` | `"newArchEnabled": true`; Android-first product; do **not** add SQLCipher plugin yet (Phase 2) |
| `tsconfig.json` | Extend Expo base; `"strict": true`; `baseUrl: "."`; `paths: { "@/*": ["./src/*"] }` |
| `package.json` scripts | `"test": "jest"`, `"lint": "expo lint"`, `"typecheck": "tsc --noEmit"` |
| Jest | `preset: "jest-expo"`; testMatch under `/tests/**/*.test.ts` |
| ESLint | Start from `eslint-config-expo`; zero custom business rules in Phase 0 |
| Yarn | Use Yarn Classic or Berry already present; prefer `yarn` over `npm` for installs |

## 4. Bootstrap Strategy
1. Generate the Expo + TypeScript + Expo Router app at the repository root (or into a temp folder and move files if the root already contains `specs/`).
2. Relocate routes to `/src/app` if the template created `/app`.
3. Create the empty layer folders listed above.
4. Copy `specs/AGENTS.md` → `/AGENTS.md` when the root copy is missing.
5. Add Jest smoke test + scripts; verify gates.

## 5. Database / Sync Impact
**None.** No schema, no migrations, no RPC, no outbox. Topology placeholders only (`src/data/**`, `src/sync/`, `supabase/migrations/`).

## 6. Risk Notes for Implementing Agents
- Do **not** install `googleapis`, `@powersync/*`, or `@shopify/react-native-skia`.
- Do **not** implement `/src/core/*` or Drizzle in this phase (that is Phase 1–2).
- Keep Expo Router boilerplate minimal: one root layout + one index route so typecheck/lint have a valid entry graph.
- Preserve existing files under `specs/` (DOCX sources, `AGENTS.md`, phase folders).

## 7. Exit Criteria (Plan Complete When…)
Folder tree matches §2, tooling configs match §3, and all DoD gates in `spec.md` §5 pass after executing `tasks.md`.
