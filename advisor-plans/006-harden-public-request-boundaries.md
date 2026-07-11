# Plan 006: Bound and throttle all public request paths

> **Executor instructions**: Apply limits before body parsing, preserve legitimate maximum submissions, and verify trusted-proxy behavior. Update the plan index when complete.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/index.ts src/config/env.ts src/modules/auth/auth.routes.ts src/modules/merchants src/middleware package.json bun.lock .env.example tests/public`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/002-establish-critical-integration-tests.md`
- **Category**: security, perf
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Anonymous onboarding and token routes buffer multipart bodies before per-file validation and have no shared throttling. Attackers can consume memory, PostgreSQL work, email/Drive quota, and storage. Limits must execute before parsing and client identity must not trust arbitrary forwarding headers.

## Current state

- Public route groups mount at `src/index.ts:55-59` without shared guards.
- Only auth has a limiter (`auth.routes.ts:42-52`), keyed directly from `x-forwarded-for`/`cf-connecting-ip`.
- Multipart parsing occurs at `form.routes.ts:17`, `public-resubmission.routes.ts:128`, and `public-agreement.routes.ts:51` before file limits.
- `merchants.schemas.ts:374` caps each onboarding file but cannot bound the already-buffered aggregate body.
- `.env.example` documents no proxy trust or public-request limit settings.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun test tests/public/public-boundaries.test.ts` | all pass |
| Frontend check | `bun run test` in `../onboarding-portal-assanpay-FE` only if frontend files change | exit 0 |

## Scope

**In scope**: backend files named in the drift check; new shared middleware/config and `tests/public/public-boundaries.test.ts`; frontend `src/lib/get-api-error-message.ts` or public forms only if existing handling cannot display backend `413`/`429` messages.

**Out of scope**: changing allowed document types, reducing legitimate per-file limits, adding CAPTCHA, rate limiting authenticated case operations.

## Steps

1. Define validated environment configuration for trusted proxy mode and endpoint-specific aggregate body/request rates. Defaults must be safe for direct local development and explicit for EC2/Cloudflare production. Update `.env.example` with placeholders and explanations.
   - **Verify**: invalid combinations fail startup with a Zod error; typecheck passes.
2. Implement a shared client-IP resolver that honors provider headers only when configured behind that proxy; do not accept a caller-controlled comma chain blindly. Reuse it in auth and public limiters.
   - **Verify**: tests prove spoofed forwarding headers do not create unlimited identities in direct mode.
3. Add request/body limits before `formData()` for merchant form, resubmission, agreement upload, and MID Go-Live activation/context as appropriate. Use endpoint ceilings derived from maximum file count × file size plus bounded form overhead; return JSON `413`/`429` through the normal error shape.
   - **Verify**: oversized requests are rejected before service/storage spies run; at-limit valid fixtures pass.
4. Add rate tests for each public group and ensure single-use link errors remain 404/410/425 rather than being masked under normal traffic.
   - **Verify**: focused test passes.
5. Inspect frontend error extraction. If it already renders backend `error` strings, make no frontend edit. Otherwise add narrow `413`/`429` messaging and test it; do not redesign forms.
   - **Verify**: backend checks pass; if changed, frontend `bun run test` and `bun run lint` pass. Do not run frontend build per its `AGENTS.md`.

## Done criteria

- [ ] Every `/api/public` route is throttled with a non-spoofable configured identity.
- [ ] Multipart aggregate size is rejected before parsing/storage calls.
- [ ] Legitimate documented maximum submissions remain accepted.
- [ ] JSON error contract is consistent and frontend compatibility is verified.
- [ ] Backend typecheck/tests pass; frontend tests/lint pass if touched.

## STOP conditions

- The hosting proxy chain cannot be identified from deployment configuration.
- Hono/Bun cannot enforce streaming body limits before `formData()` without a server-layer change; report the required layer instead of pretending a post-parse check is sufficient.
- Product-required maximum request size is unknown and cannot be derived from schemas.

## Maintenance notes

Review limits whenever file count/size policy changes. In-memory limiters do not coordinate across PM2 cluster nodes; if multiple processes are used, move counters to a shared store in a separate plan.

