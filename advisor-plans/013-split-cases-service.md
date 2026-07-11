# Plan 013: Split the case service along workflow boundaries

> **Executor instructions**: This is a behavior-preserving extraction. Move one workflow at a time and keep every commit/typecheck/test green. Stop rather than mixing refactors with fixes.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/modules/cases src/modules/merchants src/modules/email src/lib/storage tests`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 001-011 must be DONE
- **Category**: tech-debt
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

`cases.service.ts` is 7,457 lines and the repository’s highest-churn file. It combines core CRUD, authorization, stage transitions, document review, Drive operations, email preparation/sending, public tokens, and Go-Live orchestration. After the correctness plans and characterization coverage land, extracting cohesive workflows will reduce collision and regression risk.

## Current state

- Core case creation/list/detail begins around `cases.service.ts:1107`.
- Stage and document review behavior occupies the central service, including Drive operations around 2987.
- Email preview/token orchestration begins around 4387 and is duplicated between preview and delivery paths.
- MID Go-Live public activation is at 7270 through the file end.
- Existing neighboring modules show the target convention: `case-flow.service.ts` contains one domain concern; `case-resubmission-tokens.service.ts` contains token operations; route files import named functions.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 after every extraction |
| Tests | `bun run test` | all pass after every extraction |
| Cycles | use available TS dependency-cycle checker or `madge` without committing it | no new cycles |

## Scope

**In scope**: `src/modules/cases/**`, narrow import updates in merchant/email/storage modules, corresponding tests.

**Out of scope**: API behavior/shape changes, database schema/migrations, pagination, new features, authorization policy changes, frontend code.

## Steps

1. Record the exported API and map callers with `rg`. Create a facade test/compile checklist so no export disappears accidentally.
   - **Verify**: baseline tests/typecheck pass and export inventory is committed in plan notes or module comments only where useful.
2. Extract shared primitives first: queue access/ownership, case loading, stage resolution, history writing, and email preparation types. Keep database transaction parameters explicit; do not hide transactions in global helpers.
   - **Verify**: no behavior change and no cycle.
3. Extract one workflow per commit in this order: document review/resubmission; sub-merchant; agreement/physical agreement; MID/testing/Go-Live; WordPress. Each module owns its constants, validators/orchestration, and workflow-specific tests. Retain core create/list/detail/assignment in a small core service/facade.
   - **Verify**: full checks after each workflow commit.
4. Centralize preview/delivery preparation only after extraction: pure functions should return typed recipient, subject, template props, token metadata, and history metadata; commands own irreversible sends/reservations.
   - **Verify**: paired preview/send tests assert identical derived content fields.
5. Remove dead imports/exports and document module boundaries in `AGENTS.md` only if Plan 014 has already established that file.
   - **Verify**: `cases.service.ts` is reduced to a focused facade/core module, no file becomes an equivalent god module, full checks pass.

## Test plan

Rely on characterization suites from Plans 002 and 007-011. Add import-level and workflow tests when moving code; do not rewrite assertions merely to fit the refactor. Compare serialized API responses before/after for representative cases.

## Done criteria

- [ ] Every extraction commit passes typecheck and all tests.
- [ ] Public route imports and response shapes are unchanged.
- [ ] Transaction boundaries and side-effect ordering are preserved.
- [ ] No new dependency cycles or replacement god module.
- [ ] `cases.service.ts` contains only core/facade responsibilities.

## STOP conditions

- Any prerequisite plan is not DONE.
- Characterization tests do not cover the workflow being moved.
- Extraction exposes a behavior ambiguity or requires a schema/API change.
- More than one workflow must move atomically to keep the build green; report the coupling before proceeding.

## Maintenance notes

Review module ownership and transaction propagation carefully. Small files alone are not success; cohesive boundaries and preserved invariants are.

