# Phase 0 — Tasks (Atomic Checklist)

> Implementing agents must execute tasks **in order**, tick each box only after the command succeeds, and stop when all gates pass.  
> Do **not** implement Phase 1+ code. Do **not** install forbidden packages (`googleapis`, `@powersync/*`, `@shopify/react-native-skia`).  
> Package manager: **Yarn**. Working directory: repository root `/` (i.e. `Nosotros/`).

## T0.1 — Preconditions

- [x] Confirm phase specs exist:
  ```bash
  ls specs/00-governance-base/spec.md specs/00-governance-base/plan.md specs/00-governance-base/tasks.md
  ```
- [x] Confirm Yarn is available:
  ```bash
  yarn --version
  ```

## T0.2 — Bootstrap Expo (TypeScript + Expo Router)

> If `package.json` already exists with a valid Expo app, skip create and jump to T0.3 after verifying Expo Router.

- [x] Create the Expo app at the repo root without clobbering `specs/` (non-interactive). Prefer generating into a temp dir then merging:
  ```bash
  yarn create expo-app /tmp/nosotros-expo-bootstrap --template tabs -y
  ```
- [x] Copy Expo project files into the repo root **without deleting** `specs/`:
  ```bash
  rsync -a --exclude 'node_modules' --exclude '.git' /tmp/nosotros-expo-bootstrap/ ./
  ```
- [x] If the template created `app/` at root, move it under `src/`:
  ```bash
  mkdir -p src
  if [ -d app ] && [ ! -d src/app ]; then mv app src/app; fi
  ```
- [x] Ensure Expo Router is present (install if missing):
  ```bash
  yarn add expo-router react-native-safe-area-context react-native-screens expo-linking expo-constants expo-status-bar
  ```

## T0.3 — Enable New Architecture + TypeScript Strict + Path Alias

- [x] Set New Architecture in Expo config (`app.json` or `app.config.js`):
  ```bash
  node -e "const fs=require('fs'); const p='app.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.expo=j.expo||{}; j.expo.newArchEnabled=true; fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');"
  ```
- [x] Enforce TypeScript strict + `@/*` alias in `tsconfig.json` (merge carefully; keep Expo extends):
  ```bash
  node <<'NODE'
  const fs = require('fs');
  const path = 'tsconfig.json';
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  j.compilerOptions = j.compilerOptions || {};
  j.compilerOptions.strict = true;
  j.compilerOptions.baseUrl = '.';
  j.compilerOptions.paths = { '@/*': ['./src/*'] };
  fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
  NODE
  ```
- [x] Install TypeScript toolchain if missing:
  ```bash
  yarn add -D typescript @types/react
  ```

## T0.4 — Create Canonical Empty Layers

- [x] Materialize folders from `plan.md` (placeholders only):
  ```bash
  mkdir -p \
    src/app/\(auth\) \
    src/app/\(tabs\) \
    src/components \
    src/core \
    src/data/migrations \
    src/data/schema \
    src/data/repositories \
    src/sync \
    src/store \
    supabase/migrations \
    tests
  ```
- [x] Keep empty dirs trackable:
  ```bash
  touch \
    src/components/.gitkeep \
    src/core/.gitkeep \
    src/data/migrations/.gitkeep \
    src/data/schema/.gitkeep \
    src/data/repositories/.gitkeep \
    src/sync/.gitkeep \
    src/store/.gitkeep \
    supabase/migrations/.gitkeep
  ```
- [x] Ensure minimal Expo Router entrypoints exist under `src/app/` (`_layout.tsx`, `index.tsx`). If missing after bootstrap, create the smallest valid placeholders (no domain UI).

## T0.5 — Constitution at Repository Root

- [x] Place `AGENTS.md` at repo root if absent:
  ```bash
  test -f AGENTS.md || cp specs/AGENTS.md AGENTS.md
  ```

## T0.6 — ESLint

- [x] Install Expo ESLint stack:
  ```bash
  yarn add -D eslint eslint-config-expo
  ```
- [x] Initialize Expo lint config if no ESLint config file exists:
  ```bash
  npx expo lint -- --init 2>/dev/null || true
  test -f eslint.config.js -o -f .eslintrc.js -o -f .eslintrc.json || \
    printf '%s\n' 'module.exports = { extends: ["expo"] };' > .eslintrc.js
  ```
- [x] Add lint script to `package.json`:
  ```bash
  node <<'NODE'
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.lint = 'expo lint';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  NODE
  ```
- [x] Run lint (fix until green; only adjust config/boilerplate, no feature code):
  ```bash
  yarn lint
  ```

## T0.7 — Jest + Smoke Test

- [x] Install Jest tooling:
  ```bash
  yarn add -D jest jest-expo @types/jest
  ```
- [x] Write `jest.config.js`:
  ```bash
  cat > jest.config.js <<'EOF'
  /** @type {import('jest').Config} */
  module.exports = {
    preset: 'jest-expo',
    testMatch: ['<rootDir>/tests/**/*.test.ts'],
    moduleNameMapper: {
      '^@/(.*)$': '<rootDir>/src/$1',
    },
  };
  EOF
  ```
- [x] Add smoke test (no domain logic):
  ```bash
  cat > tests/smoke.test.ts <<'EOF'
  describe('Phase 0 smoke', () => {
    it('runs the Jest pipeline', () => {
      expect(true).toBe(true);
    });
  });
  EOF
  ```
- [x] Wire npm/yarn scripts required by AGENTS.md gates:
  ```bash
  node <<'NODE'
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.test = 'jest';
  pkg.scripts.typecheck = 'tsc --noEmit';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  NODE
  ```

## T0.8 — Forbidden Dependency Guard

- [x] Fail if forbidden packages were installed:
  ```bash
  node <<'NODE'
  const pkg = require('./package.json');
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const forbidden = ['googleapis', '@shopify/react-native-skia'];
  const powersync = Object.keys(all).filter((n) => n.startsWith('@powersync/'));
  const bad = forbidden.filter((n) => n in all).concat(powersync);
  if (bad.length) {
    console.error('Forbidden packages present:', bad);
    process.exit(1);
  }
  console.log('Forbidden dependency guard: OK');
  NODE
  ```

## T0.9 — Definition of Done Gates

- [x] Typecheck:
  ```bash
  yarn tsc --noEmit
  ```
- [x] Unit tests:
  ```bash
  yarn test
  ```
- [x] Lint:
  ```bash
  yarn lint
  ```
- [x] Confirm New Architecture flag:
  ```bash
  node -e "const j=require('./app.json'); if(!j.expo||j.expo.newArchEnabled!==true){process.exit(1)} console.log('newArchEnabled=true')"
  ```
- [x] Optional timing sanity check (warm run target < 5s combined):
  ```bash
  /usr/bin/time -p bash -lc 'yarn tsc --noEmit && yarn test'
  ```

## T0.10 — Phase Hand-off

- [x] Verify SDD folders for later phases exist (do **not** author their artifacts yet):
  ```bash
  ls -d specs/0{0..9}-* specs/10-* specs/11-12-* 
  ```
- [x] Stop. Phase 0 is complete. Next implementing agents must open `specs/01-accounting-core/` only after its `spec.md`, `plan.md`, and `tasks.md` exist.
