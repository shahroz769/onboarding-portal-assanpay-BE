# Plan 003: Protect manual case creation with authentication and roles

> **Executor instructions**: Execute exactly, run all checks, and update the plan index. Do not retain any development bypass.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/modules/cases/cases.routes.ts src/modules/cases/cases.service.ts tests`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `advisor-plans/001-restore-verification-baseline.md`, `advisor-plans/002-establish-critical-integration-tests.md`
- **Category**: security
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

`POST /api/cases` is registered once before authentication and again afterward. The first handler lets anonymous callers create operational cases and omits actor-attributed history. There must be one route guarded by authentication and `super_admin`/`admin` roles.

## Current state

`src/modules/cases/cases.routes.ts:112-118` says “TEMP DEVELOPMENT” and registers the public handler. `requireAuth` begins at line 121. The intended protected handler is at lines 136-147 and passes `auth.userId` into `createCase`; `cases.service.ts:1181-1190` then writes `case_created_manually` history.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun test tests/cases/case-creation.test.ts` | all pass |

## Scope

**In scope**: `src/modules/cases/cases.routes.ts`, `tests/cases/case-creation.test.ts` (create). `cases.service.ts` only if a test exposes a narrowly related audit defect.

**Out of scope**: automatic case-flow creation, role renaming, frontend route visibility, other case authorization.

## Steps

1. Delete the pre-auth development route and its comment. Keep exactly one `POST '/'` after `caseRoutes.use('*', requireAuth)`, guarded by `requireRoles('super_admin', 'admin')`.
   - **Verify**: `rg -n "caseRoutes.post\(" src/modules/cases/cases.routes.ts` plus manual route count shows one root POST.
2. Add API tests: anonymous → 401; agent → 403; admin and super admin → 201; successful rows contain an actor-attributed `case_created_manually` history entry; invalid merchant/queue retains existing 404 behavior.
   - **Verify**: focused test passes.
3. Run the full checks.
   - **Verify**: `bun run typecheck && bun run test` exits 0.

## Done criteria

- [ ] No unauthenticated root case-creation handler remains.
- [ ] Role matrix and audit-history tests pass.
- [ ] API success shape is unchanged.
- [ ] Only scoped files changed.

## STOP conditions

- Hono route ordering differs from the cited state.
- Product policy now allows agents to create cases; stop for explicit role-policy confirmation.

## Maintenance notes

Keep authorization at the route boundary and actor attribution in the service. Frontend changes are not required because its case creation call already uses the authenticated API client.

