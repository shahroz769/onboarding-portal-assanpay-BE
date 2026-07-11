# Plan 007: Make password-token consumption single-use under concurrency

> **Executor instructions**: Preserve password hashing, session invalidation, and public error semantics. Do not weaken expiry checks.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/modules/auth/auth.service.ts tests/auth`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: `advisor-plans/002-establish-critical-integration-tests.md`
- **Category**: bug, security
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Password links are checked before the update transaction and consumed afterward without an unconsumed/expiry predicate. Two simultaneous submissions can both succeed and the last transaction chooses the password.

## Current state

- `auth.service.ts:338-367` hashes and loads a valid token outside any caller transaction.
- `setPasswordWithToken` calls that helper at 384, hashes at 385, opens a transaction at 387, updates the user first, then consumes by token ID only at 398-401.
- Refresh sessions are revoked in the same transaction at 403-406.
- The repository’s correct conditional-claim pattern exists in refresh rotation at 217-239.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Tests | `bun test tests/auth/password-token.test.ts` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |

## Scope

**In scope**: `src/modules/auth/auth.service.ts`, `tests/auth/password-token.test.ts`.

**Out of scope**: password complexity, token hashing algorithm, invitation UI, refresh-token semantics.

## Steps

1. Keep the read-only context endpoint behavior, but make password submission open one transaction and atomically claim the token using hash, `consumedAt IS NULL`, `expiresAt > now`, and active/non-deleted user constraints. Claim before updating the user.
   - **Verify**: expired/consumed/unknown tokens change no user row.
2. Only after a successful claim, update password/session version and revoke refresh tokens in the same transaction. Preserve the canonical 410 error for a lost race.
   - **Verify**: a forced failure after claim rolls back both claim and user update.
3. Add a true concurrent test using `Promise.allSettled`: exactly one request succeeds, one returns 410, the successful password logs in, the losing password does not, and session version increments once.
   - **Verify**: run the focused test repeatedly (at least 10 iterations) with no flake.
4. Run full checks.
   - **Verify**: `bun run typecheck && bun run test` exits 0.

## Done criteria

- [ ] Exactly one concurrent consumer can update the password.
- [ ] Claim, password update, session-version increment, and refresh revocation are atomic.
- [ ] Context GET remains read-only and response-compatible.
- [ ] Regression tests pass repeatedly.

## STOP conditions

- PostgreSQL transaction isolation in the test environment cannot reproduce concurrent connections.
- The fix requires storing or logging raw token values.

## Maintenance notes

Use conditional claims for every single-use bearer flow. Reviewer should confirm update ordering, not just that a transaction exists.

