# Plan 004: Enforce queue authorization on comments and history

> **Executor instructions**: Follow the plan exactly; preserve administrator behavior and distinguish view from work permissions.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/modules/cases/cases.routes.ts src/modules/cases/cases.service.ts tests/cases`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: `advisor-plans/002-establish-critical-integration-tests.md`
- **Category**: security
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Authenticated, queue-scoped agents can currently read comments/history and create comments on any known case ID. Reads must require queue view permission; writes must require queue work permission. Administrators must retain unrestricted access.

## Current state

- `cases.routes.ts:696-719` calls comment/history services without the session; comment creation passes only `userId`.
- `cases.service.ts:226-244` contains `assertCanViewCase(caseId, actor)` and `246-261` contains work-queue validation.
- `getCaseDetail` demonstrates the read convention at `cases.service.ts:2004-2007`.
- `listCaseComments` at 3977, `createCaseComment` at 4011, and `listCaseHistory` at 4064 only verify existence or write directly.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun test tests/cases/case-collaboration-access.test.ts` | all pass |

## Scope

**In scope**: `src/modules/cases/cases.routes.ts`, `src/modules/cases/cases.service.ts`, new `tests/cases/case-collaboration-access.test.ts`.

**Out of scope**: response pagination (explicitly excluded finding 13), editing/deleting comments, merchant-wide authorization policy, frontend rendering.

## Steps

1. Change read service signatures to accept `SessionUser`; call `assertCanViewCase` before reading comments/history. Pass `c.var.auth` from both routes.
   - **Verify**: selected-scope cross-queue reads return 403; allowed/all-scope/admin reads retain 200.
2. Change comment creation to accept the session or enough typed authorization context and call work-access validation before parent lookup/insertion. Do not require case ownership unless documented policy is changed separately.
   - **Verify**: view-only and cross-queue agents receive 403; work-enabled agents and admins can comment.
3. Test that denial creates no comment and returns no history/proof-file metadata.
   - **Verify**: focused test and `bun run typecheck` pass.

## Done criteria

- [ ] Comment/history reads enforce view access.
- [ ] Comment writes enforce work access.
- [ ] Admin and super-admin behavior is unchanged.
- [ ] Response shapes are unchanged; no pagination added.
- [ ] Full backend tests pass.

## STOP conditions

- Existing product documentation explicitly grants comment writes to view-only agents.
- Fixing authorization would require changing the frontend contract rather than returning standard 403 errors.

## Maintenance notes

Any future case subresource should reuse the same view/work distinction. The frontend already handles authenticated API errors; no planned frontend edit is required.

