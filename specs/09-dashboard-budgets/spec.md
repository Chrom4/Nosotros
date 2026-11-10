# Phase 9 — Contextual Dashboard, Net Worth & Budgets

## 1. Purpose
Build the contextual dashboard with pill selector (**Consolidated / Mine / Partner / Domestic**), light charts via **`react-native-svg` only**, net-worth evolution, budget bars, and contribution proportions (DEC-01, DEC-02).

## 2. Scope
- Dashboard tab + filter theme switching (MD3 palettes by context).
- Aggregations from local SQLite only (no network on filter change).
- Budgets UI consuming cash-basis credit payments (DEC-01).
- Contribution breakdown (DEC-02).

### Out of scope
- `@shopify/react-native-skia` (forbidden). Attachments (DEC-04 → V2).

## 3. Hard Requirements
- Aggregates **< 20ms** on device-class target / harness.
- Filter changes are instant local queries.
- Transfers never inflate income/expense totals.

## 4. Acceptance Gates
- Pill switching updates totals/colors without network.
- Budget consumption matches DEC-01 cash basis.

