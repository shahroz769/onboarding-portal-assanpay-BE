# Plan 003: Make flow configuration revisioned and graph-valid

> **Executor instructions**: This changes a backend contract and therefore must
> update the frontend after reading its `AGENTS.md`. Do not add tests or build FE.
>
> **Drift check**: `git diff --stat 9d2ee9d..HEAD -- src/modules/configuration src/db drizzle ../onboarding-portal-assanpay-FE/src/features/configuration ../onboarding-portal-assanpay-FE/src/apis ../onboarding-portal-assanpay-FE/src/schemas`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 002
- **Category**: bug, migration
- **Planned at**: commit `9d2ee9d`, 2026-07-12

## Why this matters

Flow saves currently delete all rules, lose rule identity, silently overwrite
concurrent edits, and the frontend forces every retained rule active. Cyclic
dependencies can make workflows impossible to complete.

## Scope

**In scope**: four flow-rule tables/services/schemas/routes, a revision record,
cycle/readiness validation, frontend flow editor/API/schema/conflict UI.

**Out of scope**: stage CRUD, queue capability redesign, tests, frontend build.

## Steps

1. Add stable rule IDs to DTOs and a singleton flow-configuration revision.
   Return `{ revision, queues, ...rules }`; require `revision` on mutation.
2. Replace delete/reinsert with ID-aware create/update/deactivate operations in
   one transaction. Compare and increment revision atomically; return `409` with
   the current revision when stale. Validate referenced queues inside the transaction.
3. Validate active graphs before commit: reject cycles in creation requirements
   and close blockers, duplicate active edges, impossible trigger/requirement
   combinations, inactive targets, and targets without usable initial/terminal stages.
   Error details must name queue IDs/names and the cycle path without SQL details.
4. Update FE network schemas and editor state to preserve IDs and `isActive`.
   Remove `getActiveCaseFlowConfiguration`; add activation toggles and a stale
   revision dialog that reloads rather than overwriting.
5. Update API documentation for revision and `409` behavior.

## Verification

- Backend: `bun run typecheck` and `bunx drizzle-kit check` exit 0.
- Frontend: `bun run lint` from the FE root exits 0. Do not run `build`.
- `rg -n "delete\(caseFlow" src/modules/configuration` returns no wholesale deletes.
- `rg -n "isActive: true" ../onboarding-portal-assanpay-FE/src/features/configuration/panels/case-flow-rules-panel.tsx` returns no forced activation mapping.

## STOP conditions

- Stop if rule IDs cannot be preserved through the existing response contract.
- Stop if existing active configuration contains a cycle; report the cycle and
  require an operator decision rather than silently disabling rules.
- Do not add tests.

