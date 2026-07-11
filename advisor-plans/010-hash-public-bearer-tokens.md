# Plan 010: Hash public workflow bearer tokens at rest

> **Executor instructions**: Plan compatibility for outstanding emailed links before changing lookups. Never record raw token values in migrations, tests, logs, or plans.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/db/schema.ts src/modules/cases src/modules/merchants drizzle tests/public`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `advisor-plans/002-establish-critical-integration-tests.md`, `advisor-plans/008-make-resubmission-storage-concurrency-safe.md`, `advisor-plans/009-serialize-go-live-activation.md`
- **Category**: security, migration
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Resubmission/agreement and MID Go-Live tokens are bearer credentials stored in directly usable form. A read-only database leak grants every outstanding public action. Password tokens already demonstrate the safer SHA-256 lookup pattern.

## Current state

- `schema.ts:870-892` stores `case_resubmission_tokens.token`; `case-resubmission-tokens.service.ts:38-46` inserts it and lines 55-66 query it directly.
- `schema.ts:925-952` stores `mid_go_live_tokens.token`; `cases.service.ts:7238` and 7293 query raw values.
- `auth.service.ts:338-356` hashes a presented password token via `hashToken` before lookup.
- Existing services reuse unexpired stored token values when composing emails, so a hash-only design must change issuance/reuse policy.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Tests | `bun test tests/public/token-storage.test.ts` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |
| Migration | disposable DB upgrade plus fresh migration | both pass |

## Scope

**In scope**: token schema/services/callers, one forward migration, affected tests. Email templates only if types change; no visual/content redesign.

**Out of scope**: JWT signing secrets, refresh/password tokens already hashed, token TTL policy, frontend routes.

## Steps

1. Inventory every raw token read/write/reuse site with `rg`. Choose a compatibility strategy: preferably deploy dual-read/dual-write in staged releases or explicitly invalidate and reissue outstanding links during a coordinated migration. Document the operator action; do not assume plaintext can be transformed into hashes while preserving services that need to resend the raw value.
   - **Verify**: every caller is listed in the implementation notes/tests.
2. Add `tokenHash` unique indexed columns and query `hashToken(presentedToken)`. New issuance returns the raw token once but persists only its hash. Stop reusing stored raw credentials; issue a new link and invalidate the old one when resending.
   - **Verify**: database rows for newly issued links do not equal or contain the presented credential.
3. Implement the staged forward migration. Do not put real credentials in migration output/logs. Include cleanup/removal of plaintext only after compatibility conditions are met.
   - **Verify**: upgrade fixture with synthetic tokens remains intentionally valid or intentionally invalidated per documented policy.
4. Test issue, validate, consume, expiry, resend invalidation, agreement reuse, Go-Live context/activation, and lookup failure. Confirm raw values never appear in application logs or history.
   - **Verify**: focused and full tests pass.

## Done criteria

- [ ] New workflow tokens persist only deterministic hashes.
- [ ] Outstanding-link migration behavior is documented and tested.
- [ ] Resend creates a new credential rather than reading plaintext from storage.
- [ ] No raw token is logged or stored in history.
- [ ] Typecheck/migration/tests pass.

## STOP conditions

- Deployment cannot coordinate compatibility for outstanding links.
- A caller still requires retrieving the raw credential after issuance.
- Migration output would expose stored token values.

## Maintenance notes

Bearer credentials should be display-once and hash-at-rest. Review future public-link features against this invariant.

