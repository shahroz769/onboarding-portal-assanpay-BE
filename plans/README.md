# PlanetScale Insights Optimization Plans

Generated on 2026-08-22 from production Insights for
`shahrozahmed/onboarding-portal/main`, mapped to commit `d3a7504`.

PlanetScale MCP was configured and OAuth login completed, but the active Codex
MCP transport continued to fail its initialize handshake with `Auth required`.
The evidence below was therefore collected through the authenticated,
read-only `pscale insights` and `pscale api` commands, which expose the same
PlanetScale Insights API. No production mutation was performed.

## Executive assessment

The database is not under meaningful resource pressure. The seven-day window
contained roughly 24 seconds of cumulative query time, no current anomalies,
and no recurring application errors. Relative percentages are dominated by
very cheap polling because the workload is small.

The dominant fingerprint was the empty case-flow worker claim query
`d3c8aa36cf60` (649,124 calls, 20,481 ms, 84.23% of seven-day query time, only
28 rows read). Commit `d3a7504` already increased idle backoff to 60 seconds;
the query plan uses `case_flow_close_jobs_pending_idx` in 100% of executions.
Treat that change as implemented and verify it after deployment before making
the worker architecture more complex.

## Execution order and status

Execute only one plan/query pattern at a time. Re-read current Insights and
open pull requests before starting every row.

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---:|---:|---|---|
| [001](001-add-query-attribution.md) | Add bounded database workload attribution | P1 | M | — | TODO |
| [002](002-remove-postgres-type-discovery.md) | Remove unnecessary Postgres.js type discovery | P1 | S | 001 | TODO |
| [003](003-minimize-user-list-query.md) | Minimize and paginate the administrative user list | P1 | M | 001 | TODO |
| [004](004-paginate-case-history.md) | Add keyset pagination to case history | P2 | M | 001 | TODO |
| [005](005-optimize-latest-mid-lookup.md) | Optimize the latest MID credentials lookup | P2 | M | 001 | TODO |
| [006](006-optimize-applied-mid-dashboard.md) | Optimize the applied MID dashboard query | P2 | M | 001, 005 | TODO |
| [007](007-cache-configuration-setting.md) | Add bounded caching to configuration-setting reads | P3 | M | 001 | TODO |
| [008](008-drop-unused-stage-queue-index.md) | Validate and drop the unused stage/queue index | P3 | S | 001 | TODO |

## Risk-ranked Insights inventory

| Query / fingerprint | Seven-day evidence | Code source | Decision |
|---|---|---|---|
| Case-flow claim `d3c8aa36cf60` | 649,124 calls; 20,481 ms; 84.23%; 28 rows read | `src/index.ts:153-233`, `src/modules/cases/case-flow.service.ts:516-610` | Already mitigated by 60-second idle backoff. Observe after deployment; keep the transactional outbox and `SKIP LOCKED` design. |
| Postgres.js type discovery `b8199c4a035d` | 982 calls; 494 ms; 1,474,964 rows read; 8.61 MB egress; current 1h: 34 calls/15.2 ms | `src/db/client.ts:10-19` | Plan 002. |
| Full auth-user read `d2dee98c6728` | 34,327 calls; 1,191 ms; 13.67 MB egress; last seen 2026-08-21 | Replaced by `src/middleware/auth.ts:27-35` selecting only `id` | Already fixed. Current fingerprint `965aa7ded3c1` is narrow. |
| User list `18b498a4777a` | 159 calls; 1,877 rows; 805,910 bytes; includes `password_hash` | `src/modules/users/users.service.ts:314-345` | Plan 003. |
| Case history list `aa862a3e60d6` | 745 calls; 45.7 ms; 10,349 rows read; 758,071 bytes | `src/modules/cases/case-comments.service.ts:238-279` | Plan 004. |
| Latest MID details `8a47fdbbb030` | 558 calls; 50.5 ms; 17,022 rows read for 134 rows; max 21.8 ms | `src/modules/cases/case-detail-lookups.ts:484-497` | Plan 005. |
| Applied MID dashboard `417309aba8cf` | 286 calls; 127.3 ms; 32,317 rows read; 2.37 MB egress; p99 2.62 ms | `src/modules/dashboard/dashboard.service.ts:316-383` | Plan 006. |
| Configuration read `dece38e2ea18` | 1,583 calls; 48.6 ms; 596,136 bytes | `src/modules/configuration/configuration.service.ts:119-167` | Plan 007, behind a measurement gate. |
| `cases_current_stage_queue_idx` | PlanetScale recommendation #11 is open | `src/db/schema.ts:662-665`, migration `0049` | Plan 008. |

## Tag coverage

| Observed tag | Coverage | Assessment |
|---|---:|---|
| `application_name=postgres.js` | nearly all app traffic | Too generic to identify this service or process role. |
| `source=planetscale-mcp` | 64 diagnostic queries | Correct bounded tag for operator diagnostics. |
| `catalog`, `username`, `remote_address` | system metadata | Useful operationally but cannot attribute routes, jobs, or releases. |

No application SQLCommenter route, action, job, environment, or release tags
were observed. Plan 001 introduces bounded values only. Never tag user IDs,
merchant IDs, case IDs, request IDs, emails, tokens, or raw URLs.

## Candidate Traffic Control slices

Do not create budgets yet: current absolute database time is too low and route
attribution is missing. After Plan 001 has collected at least seven days, only
consider warning-mode budgets for the `case-flow-close-worker` job and the
portal-MID dashboard action. Do not enable throttling without a separate
operator-approved plan.

## Considered and rejected or deferred

- Global and queue-filtered case lists (`30737eee2c8b`, `0ee4e023b7dc`) are
  already keyset paginated and have current p99 below 0.31 ms. Do not add
  another index now; re-evaluate when p99 exceeds 20 ms or rows-read/page grows
  above 10x.
- Agent queue access (`6a4dce06a97d`) used 0.432 ms in the latest 24 hours.
  Cross-request caching could delay permission revocation; it is not justified.
- Unread notification count `45a851a92391` was replaced by fingerprint
  `3939311e31b8`, which uses the partial unread index. No further work.
- Queue and queue-stage reads are small reference datasets. Their combined
  seven-day cost is below 60 ms; avoid cache-invalidation complexity for now.
- Agreement/sub-merchant template reads over-fetch some storage metadata, but
  the total database time is below 15 ms over seven days. Revisit only if
  egress grows by an order of magnitude.
- Merchant-document and merchant-detail payloads are workflow data needed by
  the case detail UI. Optimize only after response-field usage is measured.
- Catalog bloat/sequence queries and the five one-off errors on 2026-08-22 were
  operator benchmark/audit activity, not application incidents.
- A dedicated queue platform or leader-election mechanism is not justified by
  20 seconds of database work over seven days. The existing transactional
  outbox, savepoint retry, idempotent insert, and `FOR UPDATE SKIP LOCKED`
  architecture is correctness-safe across multiple workers. First verify the
  60-second backoff and add process-role attribution.

## Global execution contract

For every plan:

1. Check open GitHub pull requests for the exact fingerprint and code path.
2. Use a PlanetScale development branch, never the production/runtime
   database, for representative data and `EXPLAIN (ANALYZE, BUFFERS, FORMAT
   JSON)` baselines.
3. Preserve query semantics with characterization tests before changing it.
4. Benchmark the same parameters after the change and record plan nodes,
   actual time, rows, buffers, and returned payload bytes.
5. Run `bun run typecheck`. The backend currently has no lint script; do not
   claim lint passed. If a lint script is introduced later, it becomes a gate.
6. Do not open a branch or pull request unless the operator changes the current
   local-only instruction.

No Insights, tag, repository source, schema, or Traffic Control changes have
been applied by this planning pass.
