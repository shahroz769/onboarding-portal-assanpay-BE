# Plan 005: Remove the unauthenticated notification injection route

> **Executor instructions**: Remove production exposure rather than hiding it with an undocumented secret.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/modules/notifications/notifications.routes.ts src/modules/notifications/notifications.schemas.ts tests/notifications`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `advisor-plans/002-establish-critical-integration-tests.md`
- **Category**: security
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

`POST /api/notifications/test` is intentionally registered before authentication and lets anonymous callers create arbitrary-looking notifications for any user UUID. Production must not expose this development helper.

## Current state

`notifications.routes.ts:33-51` defines the public endpoint, while `requireAuth` begins at line 53. `notifications.schemas.ts:24-29` exists solely to validate this request. No frontend source calls `/api/notifications/test`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Search | `rg -n "notifications/test|testNotificationBodySchema|TestNotificationBody" src tests` | no production matches |
| Tests | `bun test tests/notifications/notification-routes.test.ts` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |

## Scope

**In scope**: `src/modules/notifications/notifications.routes.ts`, `src/modules/notifications/notifications.schemas.ts`, new/updated `tests/notifications/notification-routes.test.ts`.

**Out of scope**: SSE behavior, normal notification creation, frontend notification UI, adding a replacement production endpoint.

## Steps

1. Delete the public test route and now-unused schema/types/imports. Prefer test fixtures calling the notification service directly over a hidden HTTP backdoor.
   - **Verify**: the search command has no production matches.
2. Add a regression test asserting `POST /api/notifications/test` is not a usable route (404; accept the framework’s canonical not-found status) and normal authenticated list/read routes still work.
   - **Verify**: focused test passes.
3. Run full checks.
   - **Verify**: `bun run typecheck && bun run test` exits 0.

## Done criteria

- [ ] Anonymous notification injection is impossible.
- [ ] No unused test-notification schema remains.
- [ ] Normal notification routes and SSE contract are unchanged.

## STOP conditions

- A documented external client depends on this endpoint; stop and obtain an authenticated replacement policy.

## Maintenance notes

Future manual notification tooling belongs behind administrator authorization and audit logging, not a public development route.

