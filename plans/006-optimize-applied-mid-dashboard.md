# Plan 006: Optimize the applied MID dashboard query

> **Executor instructions**: Optimize only fingerprint `417309aba8cf`. Do not
> combine pending-MID or schema-normalization work in this change.
>
> **Drift check**: `git diff --stat d3a7504..HEAD -- src/modules/dashboard/dashboard.service.ts src/db/schema.ts drizzle/meta/_journal.json drizzle`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 001 and 005
- **Category**: perf
- **Planned at**: commit `d3a7504`, 2026-08-22

## Why this matters

The applied-MID query returned 29,473 rows over 286 calls, transferred 2.37 MB,
and consumed 127 ms with p99 2.62 ms. It reconstructs portal/internal MID
classification from JSON history for every dashboard request and joins that
CTE to every applied limit.

## Current state

- `src/modules/dashboard/dashboard.service.ts:316-383` builds `latest_mid`, a
  materialized `classified_mid`, and a `DISTINCT ON` applied-limit result.
- Matching prefers the stored merchant ID, then newest saved history.
- The response includes every applied limit, so some egress is intended.

## Scope

**In scope**: `listAppliedPortalMidLimitRows` and its focused tests. A narrowly
proven index migration is allowed.

**Out of scope**: pending MID query, response pagination, changing category
rules, or introducing a new denormalized table.

## Steps

### 1. Characterize and baseline

Seed duplicated MIDs, null merchant IDs, internal/portal pairs, Shopify and
custom merchants, and multiple saved events. Capture EXPLAIN ANALYZE/BUFFERS
and exact ordered results.

**Verify**: expected merchant/category choice is asserted for every ambiguity.

### 2. Restrict history work to applied MIDs

Rewrite the query so JSON MID extraction/classification is evaluated only for
MIDs present in `portal_mid_limit_applications`, while preserving fallback and
preference ordering. Reuse the latest-MID approach proven in Plan 005 where it
actually applies.

**Verify**: results are byte-equivalent and EXPLAIN shows fewer rows entering
classification on the representative dataset.

### 3. Re-benchmark and gate schema work

Repeat identical parameters. Add no index unless a measured plan node remains
dominant and a development-only candidate improves buffers/rows by at least
2x without duplicating an index.

**Verify**: record total time, rows, buffers, sort spill, and result bytes.

## Done criteria

- `bun test` and `bun run typecheck` pass.
- Category/merchant matching semantics are unchanged.
- Before/after EXPLAIN demonstrates a material improvement or the plan is
  marked REJECTED rather than merging a neutral rewrite.

## STOP conditions

- Applied rows without merchant IDs cannot be matched deterministically.
- The rewrite increases work for the common small applied-MID set.
- Fix requires a denormalized projection/backfill; create a separate design
  plan instead.

## Maintenance notes

If the applied list becomes large, pagination is a separate API/UX change and
must not be folded into this query optimization.
