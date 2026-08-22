# Plan 001: Add bounded database workload attribution

> **Executor instructions**: Work locally on `main`. Do not change PlanetScale
> settings or production data. Run every verification gate. Stop on any STOP
> condition and update this plan's status in `plans/README.md` when complete.
>
> **Drift check**: `git diff --stat d3a7504..HEAD -- src/db/client.ts src/config/env.ts .env.example README.md src/modules/dashboard/dashboard.service.ts src/modules/cases/case-flow.service.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf / observability
- **Planned at**: commit `d3a7504`, 2026-08-22

## Why this matters

Nearly all queries are tagged only as `application_name=postgres.js`. Insights
cannot distinguish API requests, the case-flow worker, dashboard actions, or a
release. This blocks reliable before/after attribution and makes Traffic
Control unsafe to configure. Tags must be bounded and must not contain IDs or
personal data.

## Current state

- `src/db/client.ts:12-19` creates one shared Postgres.js client without a
  connection `application_name`.
- `src/index.ts:191-233` runs the worker in the API process.
- `src/modules/dashboard/dashboard.service.ts:217-381` contains raw SQL for the
  portal-MID dashboard, where SQLCommenter tags can be added explicitly.
- PlanetScale observed only generic system tags plus 64 diagnostic queries
  tagged `source=planetscale-mcp`.
- Postgres.js supports `connection.application_name`; the installed version's
  documentation is at `node_modules/postgres/README.md:1008-1015`.

## Scope

**In scope**: `src/db/client.ts`, `src/config/env.ts`, `.env.example`,
`README.md`, the two named dashboard SQL statements, the worker claim query,
and focused test files.

**Out of scope**: user/merchant/case/request IDs in tags, raw URLs, production
Traffic Control, raw-query collection changes, a new telemetry vendor, and
unrelated queries.

## Steps

### 1. Establish the tag contract

Add stable environment configuration for `application`, `environment`, and
`release_sha`, with bounded defaults suitable for local development. Set
Postgres `application_name` to `onboarding-portal-be`; do not embed release SHA
in `application_name` because that system tag should remain low-cardinality.

**Verify**: `bun run typecheck` exits 0.

### 2. Add SQLCommenter tags to one query at a time

Start with the case-flow claim query. Add a static comment identifying
`application=onboarding-portal`, `service=backend`,
`job=case-flow-close-worker`, `source=worker`, `environment`, and
`release_sha`. Confirm Drizzle emits a valid single statement. Then separately
tag the applied-MID raw SQL with normalized route/action values. If Drizzle
cannot safely prefix the query without raw string concatenation, retain only
`application_name` and STOP to report the driver limitation.

**Verify**: on a development branch, run the tagged query and confirm
`pscale insights tags ... --fingerprint <fingerprint> --format json` reports
only the intended bounded keys.

### 3. Document cardinality and privacy rules

Document the allowed keys and explicitly forbid IDs, emails, tokens, raw URLs,
and request identifiers.

**Verify**: `rg -n "user_id|merchant_id|case_id|request_id|email|token" src/db src/modules` shows no such values inside SQLCommenter tag builders.

## Test plan and done criteria

- Add unit tests for escaping/normalizing tag values if a helper is introduced.
- `bun test` passes.
- `bun run typecheck` passes.
- A development Insights sample exposes the bounded tags.
- No production settings or Traffic Control rules changed.

## STOP conditions

- Tagging requires interpolating untrusted values into SQL comments.
- The driver cannot add a comment without changing parameter binding.
- Tag values would be unbounded.

## Maintenance notes

Review tag cardinality quarterly. Traffic Control remains deferred until at
least seven days of tagged traffic exists.
