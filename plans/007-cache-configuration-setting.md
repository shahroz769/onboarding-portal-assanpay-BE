# Plan 007: Add bounded caching to configuration-setting reads

> **Executor instructions**: Optimize only fingerprint `dece38e2ea18`. Treat
> cache consistency as a correctness requirement.
>
> **Drift check**: `git diff --stat d3a7504..HEAD -- src/modules/configuration/configuration.service.ts src/config/env.ts .env.example README.md`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 001
- **Category**: perf
- **Planned at**: commit `d3a7504`, 2026-08-22

## Why this matters

Single-key configuration reads ran 1,583 times and transferred 596 KB in seven
days, but cost only 48.6 ms. A small cache can remove repeat reads from hot case
detail paths, but stale payment, deadline, or email-mode configuration is more
harmful than the current database cost. Execute only if tagged data still shows
the query above the threshold below.

## Current state

- `src/modules/configuration/configuration.service.ts:119-167` reads one row per
  helper invocation and supports a legacy payment-method fallback.
- `writeSetting` is the centralized write path for these settings.
- Multiple API processes may exist; an in-memory cache cannot provide
  immediate cross-process invalidation.

## Scope

**In scope**: this single settings query and centralized write invalidation.

**Out of scope**: agreement/template caches, queue caches, external Redis,
database triggers, or changing configuration semantics.

## Steps

### 1. Apply the measurement gate

After Plan 001 has seven days of tags, continue only if this fingerprint is at
least 5% of app query time or 10,000 calls/week. Otherwise mark this plan
REJECTED as not worth its consistency risk.

**Verify**: paste the tagged Insights evidence into the implementation notes.

### 2. Baseline

Capture EXPLAIN for the indexed key lookup and benchmark 1,000 repeated service
reads in a development process. Record query count and wall time.

**Verify**: the baseline confirms the primary-key/index lookup is healthy.

### 3. Add a short, bounded cache

Implement per-key single-flight caching with a maximum TTL of 10 seconds and a
bounded key set. Cache parsed values, including fallbacks. `writeSetting` must
update/invalidate the local entry after a successful commit. Document that
other processes may observe old values for at most the TTL.

**Verify**: fake-timer tests cover hit, miss, expiry, concurrent miss,
successful write invalidation, failed write, and legacy fallback.

### 4. Re-benchmark

Repeat the service benchmark. EXPLAIN will remain unchanged because the SQL is
unchanged; the decisive after metric is database executions.

**Verify**: warm reads issue zero SQL until expiry and serialized results match
baseline.

## Done criteria

- Measurement gate passed.
- `bun test` and `bun run typecheck` pass.
- Query-count reduction and unchanged EXPLAIN plan are recorded.
- TTL/staleness behavior is documented.

## STOP conditions

- Any setting requires immediate cross-process consistency.
- Writes bypass `writeSetting`.
- Required cache keys can grow without bound.

## Maintenance notes

If immediate invalidation becomes necessary, remove this cache or adopt a
shared invalidation mechanism in a separately approved architecture change.
