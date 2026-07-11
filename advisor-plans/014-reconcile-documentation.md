# Plan 014: Reconcile backend and frontend operating documentation

> **Executor instructions**: Document verified current behavior, not aspirations. Do not include credential values. Work in both repositories only where listed.
>
> **Drift check (backend)**: `git diff --stat daf574b..HEAD -- README.md AGENTS.md Plan apis .env.example`
>
> **Drift check (frontend)**: `git -C ../onboarding-portal-assanpay-FE diff --stat b1bb7a0..HEAD -- README.md AGENTS.md ONBOARDING_FORM_API.md`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plans 001-012; execute after contracts and deployment settle
- **Category**: docs, dx
- **Planned at**: backend `daf574b`, frontend `b1bb7a0`, 2026-07-11

## Why this matters

The initial backend plan contradicts implemented roles, email provider, and deployment; API docs claim all case routes require authentication while a development bypass exists; backend `AGENTS.md` is empty. The frontend README remains a generic TanStack starter. Contributors and clients cannot reliably reconstruct current operation.

## Current state

- Backend `README.md:1-22` covers install, two database URLs, and dev startup only.
- Backend `Plan/PLAN.md:17` recommends Nodemailer though `package.json:20` uses Resend; line 55 specifies Hetzner/Coolify while `.github/workflows/deploy.yml` targets EC2/PM2; role tables use superseded supervisor/employee vocabulary.
- `apis/cases.md:15-27` says all routes require authentication and names old roles.
- Backend `AGENTS.md` is empty.
- Frontend `README.md` is generic starter documentation, while frontend `AGENTS.md` correctly identifies separate backend hosting and forbids builds unless specified.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Link/path check | `rg -n "supervisor|employee|Nodemailer|Coolify|all case routes require" README.md AGENTS.md Plan apis` | only explicitly historical/superseded references |
| Backend checks | `bun run typecheck && bun run test` | exit 0 (docs did not break tooling) |
| Frontend format | `bun run format` in frontend | exit 0; do not run build |

## Scope

**Backend in scope**: `README.md`, `AGENTS.md`, `Plan/PLAN.md` (status/superseded framing rather than deletion), `apis/*.md`, `.env.example` comments if missing after Plan 006/012.

**Frontend in scope**: `../onboarding-portal-assanpay-FE/README.md`, `AGENTS.md` only to clarify verified commands/contracts, `ONBOARDING_FORM_API.md` if contradicted by current public routes.

**Out of scope**: source code, generated route tree, product feature promises, secret values, claiming deployment steps were tested when they were not.

## Git workflow

- Backend branch `advisor/014-docs`; frontend branch with the same name if frontend files change.
- Conventional documentation commits; do not push or merge.

## Steps

1. Rewrite backend README as an operator/developer guide: architecture, prerequisites, Bun commands, required/optional env categories, direct-vs-pooled DB use, migrations, tests/typecheck, EC2/PM2 deployment and health checks, frontend URL/CORS/cookie topology. Refer to `.env.example`; never duplicate live values.
   - **Verify**: a clean reader can identify every required command and variable category.
2. Populate backend `AGENTS.md` with module map, formatting conventions, required checks, disposable-test-DB rule, forward-only migration rule, authorization conventions, external storage/email boundaries, and instruction to read frontend `AGENTS.md` when changing contracts.
   - **Verify**: all commands exist in `package.json` at execution time.
3. Mark `Plan/PLAN.md` as historical and create status sections for implemented, superseded, and pending direction. Correct role vocabulary to `super_admin`, `admin`, `agent`; record Resend, Google Drive, PlanetScale/PostgreSQL, EC2/PM2 as current only after verifying code/workflow.
   - **Verify**: stale-term search contains only labeled historical context.
4. Reconcile each `apis/*.md` endpoint, method, auth/role requirement, request/response, and error status against route/schema code. Explicitly document removed dev endpoints and public request limits.
   - **Verify**: route inventory from `rg -n "Routes\.(get|post|patch|delete)" src/modules` is accounted for or intentionally internal.
5. Replace frontend starter README with project-specific setup, API URL, separate-host cookie/CORS requirements, test/lint/format commands, Cloudflare deployment, and links to public onboarding flows. Preserve the frontend `AGENTS.md` no-build rule.
   - **Verify**: frontend format check passes; no build is run.

## Done criteria

- [ ] Current roles, providers, commands, routes, and deployment match code.
- [ ] Historical choices are labeled, not presented as current recommendations.
- [ ] Both repos explain their cross-origin contract and ownership boundary.
- [ ] No secret values or unverifiable success claims are present.
- [ ] Documentation checks and existing tests pass.

## STOP conditions

- Code and deployment workflow disagree and product/operations intent cannot be established.
- An API’s authorization policy remains ambiguous after the prerequisite security plans.
- Documentation would require publishing sensitive infrastructure detail beyond secret names/types.

## Maintenance notes

Update API docs in the same change as contract changes. Keep the historical plan as decision context, but make the current README/AGENTS authoritative.

