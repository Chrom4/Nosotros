# Phase 0 — Governance SDD & Base Configuration

## 1. Purpose
Establish the immutable Spec-Driven Development (SDD) workspace and the Expo/React Native repository skeleton so subsequent phases can implement the Offline-First household finance MVP without rework on tooling, TypeScript contracts, or directory topology.

This phase produces **no domain/business logic**, **no database schema**, and **no UI feature screens**.

## 2. Scope

### In scope
- Bootstrap a React Native app with **Expo Managed Workflow** and **Expo Router**.
- Enable the **React Native New Architecture**.
- Enforce **TypeScript `strict: true`** with a single path alias `@/*` → `./src/*`.
- Configure **ESLint** (Expo lint defaults) and **Jest** (`jest-expo`) with a green empty suite under `/tests`.
- Materialize the canonical `/src/*` directory tree (empty placeholders only).
- Ensure `AGENTS.md` is available at the repository root as the SDD constitution.
- Prove the Phase 0 DoD gate commands succeed.

### Out of scope
- SQLite / SQLCipher / Drizzle / migrations.
- Supabase, RLS, RPCs, sync engine, HLC, accounting core.
- Auth, biometrics, Google Drive/Calendar, feature screens.
- Any production `.ts` / `.tsx` implementation beyond Expo Router boilerplate required for a compilable empty app.

## 3. Hard Requirements (Stack)

| Requirement | Exact expectation |
|---|---|
| Runtime / framework | React Native via **Expo** (SDK **52+**), Managed Workflow |
| Navigation | **Expo Router**, routes rooted at `/src/app` |
| Architecture | **New Architecture enabled** (`newArchEnabled: true` in Expo config) |
| Language | **TypeScript** with `"strict": true` in `tsconfig.json` |
| Path alias | Exactly one alias: `"@/*": ["./src/*"]` |
| UI state (future) | Zustand lives under `/src/store` (folder created now; no stores yet) |
| Lists (future) | `@shopify/flash-list` may be declared later; **not required** to install in Phase 0 |
| Unit tests | **Jest** + `jest-expo`; test files under `/tests` |
| Lint | Expo ESLint config; `yarn lint` must exit 0 |
| Package manager | **Yarn** (project standard). Scripts must expose `test` and typecheck so agents can also satisfy the AGENTS.md gate (`npm test` ≡ `yarn test`) |
| Forbidden packages (must not be installed) | `googleapis`, `@powersync/*`, `@shopify/react-native-skia` |

## 4. Functional Requirements

### FR-0.1 — Repository bootstrap
The repository root must contain a valid Expo app (`package.json`, `app.json` / `app.config.*`, `tsconfig.json`) that starts with Expo Router from `/src/app`.

### FR-0.2 — Strict TypeScript
`tsconfig.json` must set `"strict": true` and the `@/*` path mapping. `yarn tsc --noEmit` must exit 0.

### FR-0.3 — Lint
ESLint must be configured for the Expo + TypeScript project. `yarn lint` must exit 0 on the Phase 0 tree.

### FR-0.4 — Jest
Jest must run via `yarn test` using the `jest-expo` preset. At least one smoke test under `/tests` must pass (e.g. `tests/smoke.test.ts` asserting `true`).

### FR-0.5 — Canonical directories
The empty layered folders defined in `plan.md` must exist so later phases drop code into known locations without renaming.

### FR-0.6 — SDD constitution
`AGENTS.md` must exist at the repository root (copy or symlink from `specs/AGENTS.md` if needed). Agents must treat it as the highest-priority contract.

## 5. Non-Functional Requirements / Gates (DoD)

| Gate ID | Criterion |
|---|---|
| GATE-0.1 | `yarn test` completes successfully |
| GATE-0.2 | `yarn tsc --noEmit` completes with exit code 0 |
| GATE-0.3 | Combined typecheck + test run finishes in **< 5 seconds** on a developer machine (warm cache allowed after first install) |
| GATE-0.4 | `yarn lint` exits 0 |
| GATE-0.5 | No forbidden packages appear in `package.json` dependencies/devDependencies |
| GATE-0.6 | New Architecture flag is enabled in Expo config |

## 6. Invariants
1. Phase 0 must not create domain tables, sync metadata, or accounting modules.
2. All future source code lives under `/src/**` (never mixed roots for `app`, `core`, `data`, `sync`, `store`).
3. Specs for every phase live under `/specs/<phase-id>/{spec,plan,tasks}.md`.
4. No task is “done” until its automated checks pass (AGENTS.md §2).

## 7. Acceptance Mapping
- **spec.md** (this file) → requirements above.
- **plan.md** → directory topology and config file placement.
- **tasks.md** → atomic, command-level checklist the implementing agent must execute and tick.
