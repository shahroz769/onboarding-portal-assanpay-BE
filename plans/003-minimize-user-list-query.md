# Plan 003: Minimize and paginate the administrative user list

> **Executor instructions**: Change only the administrative list fingerprint
> `18b498a4777a`; do not combine this with auth-user or user-detail changes.
>
> **Drift check**: `git diff --stat d3a7504..HEAD -- src/modules/users/users.service.ts src/modules/users/users.schemas.ts src/modules/users/users.routes.ts ../onboarding-portal-assanpay-FE/src/apis/users.ts ../onboarding-portal-assanpay-FE/src/schemas/users.schema.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 001
- **Category**: perf / security
- **Planned at**: commit `d3a7504`, 2026-08-22

## Why this matters

The list query fetched every user column—including `password_hash`, deleted
metadata, and session state—before sanitizing results. It transferred 805,910
bytes in 159 calls over seven days and has no result limit. Removing sensitive
columns from the database result reduces egress and prevents accidental future
exposure; keyset pagination bounds growth.

## Current state

- `src/modules/users/users.service.ts:67-82` derives `hasSetPassword` from the
  hash but returns no hash.
- `src/modules/users/users.service.ts:314-345` uses `findMany` with no `columns`
  or `limit`, then hydrates every user.
- Frontend `src/apis/users.ts:9-23` expects `{ users: UserListItem[] }`, so
  pagination is a contract change and must be coordinated in both repos.
- The backend has no lint script; the frontend has `bun run lint` and
  `bun run format`. Do not run frontend builds.

## Scope

**In scope**: the backend user list schema/service/route and corresponding
frontend API, query hook/schema, and table consumption.

**Out of scope**: `GET /api/users/:id`, auth middleware, directory endpoint,
password flows, or user mutations.

## Steps

### 1. Benchmark and characterize

On a development branch with representative users/access rows, capture
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plus serialized database-result bytes
for the current list query at first and later pages.

**Verify**: existing response fields used by the frontend are enumerated.

### 2. Project only required columns

Replace implicit `select *` with explicit columns. Select a boolean expression
for `hasSetPassword` or select only the hash-derived boolean; never materialize
`passwordHash` in the service result type. Preserve all currently consumed DTO
fields.

**Verify**: a test asserts the query result/DTO has no `passwordHash`,
`sessionVersion`, or `deletedAt` property.

### 3. Add keyset pagination end to end

Use `(created_at, id)` descending cursor semantics matching the case-list
pattern in `src/modules/cases/case-query.service.ts:477-555`. Return
`users`, `nextCursor`, `hasMore`, and `limit`; update the frontend to consume
pages without a frontend build.

**Verify**: tests cover first page, next page, identical timestamps, filters,
and no duplicates/gaps.

### 4. Re-benchmark

Run the same EXPLAIN and payload measurement with the same parameters.

**Verify**: rows are bounded to `limit + 1`, sensitive columns are absent, and
payload bytes are lower than baseline.

## Done criteria

- Backend: `bun test` and `bun run typecheck` pass.
- Frontend: `bun run test`, `bun run lint`, and `bun run format` pass; no build
  is run.
- Before/after plan, timing, rows, buffers, and bytes are recorded.

## STOP conditions

- A frontend consumer requires the complete list for an atomic bulk action.
- Pagination would silently cap selected users.
- An open PR already changes the user-list contract.

## Maintenance notes

Keep the directory endpoint separate; it is already a narrow projection.
