# Plan 001: Restore a passing backend verification baseline

> **Executor instructions**: Follow every step and verification gate. Modify only the files in scope. Stop on any STOP condition. Update `advisor-plans/README.md` when complete unless a reviewer owns the index.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- package.json bun.lock src/modules/cases/cases.service.ts src/modules/merchants/merchants.service.ts src/modules/users/users.service.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, dx
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Strict TypeScript is enabled but the repository has no typecheck command and currently produces nine compiler errors. Two errors reveal a runtime defect: successful and unsuccessful case closure calculate SLA state from fields that were not selected, causing `slaBreached` to be recorded incorrectly. A passing, committed typecheck command is the prerequisite for every later plan.

## Current state

- `package.json:3-7` exposes only `dev` and database scripts; TypeScript is not a dev dependency.
- `src/modules/cases/cases.service.ts:2557-2567` omits `createdAt`, but line 2907 passes `caseData.createdAt` to `isCaseSlaBreached`.
- `src/modules/cases/cases.service.ts:3346-3353` likewise omits `createdAt`; the queue query at 3368-3371 selects only `slug`, but lines 3410-3412 use both missing values.
- `bun x tsc --noEmit` at `daf574b` reports nine errors at cases service lines 2214, 2907, 2909, 2930, 3410, 3412, 7183; merchants service line 423; users service line 306.
- Match existing formatting: two-space indentation, single quotes, trailing commas, no semicolons.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0, no diagnostics |
| Drift/scope | `git status --short` | only in-scope files |

## Scope

**In scope**: `package.json`, `bun.lock`, `src/modules/cases/cases.service.ts`, `src/modules/merchants/merchants.service.ts`, `src/modules/users/users.service.ts`.

**Out of scope**: behavior refactors, API response changes, pagination, tests beyond any minimal type-only fixture.

## Git workflow

- Branch `advisor/001-verification-baseline`; conventional commit such as `fix: restore backend typecheck baseline`.
- Do not push or merge.

## Steps

1. Add `typescript` to dev dependencies and a `typecheck` script exactly equivalent to `tsc --noEmit`; update `bun.lock` through Bun.
   - **Verify**: `bun run typecheck` runs the compiler rather than reporting a missing script.
2. Fix each of the nine diagnostics without casts to `any`, non-null assertions that bypass real nullability, or disabling compiler rules. Add `createdAt` and `slaHours` to the relevant selects. Preserve the optimistic concurrency predicate in `advanceStage`; handle nullable stage IDs using a correctly typed Drizzle condition rather than a cast.
   - **Verify**: `bun run typecheck` exits 0.
3. Confirm closure behavior still uses the queue-specific SLA and original case creation time. Do not change the default SLA policy in `case-sla.ts`.
   - **Verify**: `rg -n "createdAt: cases.createdAt|slaHours: queues.slaHours" src/modules/cases/cases.service.ts` finds the corrected selections.

## Test plan

Plan 002 establishes the integration harness. In this plan, add a small unit test for `isCaseSlaBreached` only if a test location already exists after drift; otherwise do not invent parallel test infrastructure.

## Done criteria

- [ ] `bun run typecheck` exits 0 with no diagnostics.
- [ ] `package.json` declares the script and local compiler.
- [ ] Successful and unsuccessful closure select and pass real `createdAt` and queue `slaHours` values.
- [ ] No `@ts-ignore`, `any`, or unrelated behavioral change was introduced.
- [ ] Only in-scope files changed.

## STOP conditions

- An error can only be silenced by changing a public response contract or database schema.
- Current diagnostics differ materially from the nine listed above.
- Fixing the nullable stage condition would remove the existing optimistic concurrency guarantee.

## Maintenance notes

Run `bun run typecheck` before every backend handoff. Review the SLA fixes for selected-column correctness, not merely compiler satisfaction.

