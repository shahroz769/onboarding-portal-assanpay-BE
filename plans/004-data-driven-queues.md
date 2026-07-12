# Plan 004: Make queues and stages data-driven

> **Executor instructions**: Work on BE and FE. Read both `AGENTS.md` files.
> Do not add tests or run builds.
>
> **Drift check**: `git diff --stat 9d2ee9d..HEAD -- src/modules/queues src/modules/cases src/db drizzle ../onboarding-portal-assanpay-FE/src/features/configuration ../onboarding-portal-assanpay-FE/src/features/cases ../onboarding-portal-assanpay-FE/src/apis ../onboarding-portal-assanpay-FE/src/schemas`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 002 and 003
- **Category**: architecture, migration, direction
- **Planned at**: commit `9d2ee9d`, 2026-07-12

## Why this matters

The queue API claims to create queues, but unknown slugs get no stages. Backend
and frontend behavior is inferred from duplicated slug lists, so adding a useful
queue still requires coordinated code changes.

## Target model

- Queue lifecycle: `draft`, `active`, `inactive` (replace the ambiguous boolean
  at the API boundary; retain a compatible migration/backfill).
- Stable workflow type: `generic` plus explicit specialized types for existing
  document review, agreement, MID, testing, WordPress, card, physical agreement,
  and live workflows. Slug remains a URL/business identifier, not behavior.
- Ordered persisted stages with stable IDs, category, display name, slug,
  active flag, and optional capabilities/actions.
- Existing cases retain referenced stage IDs. Referenced stages can be renamed
  or deactivated but never hard-deleted.

## Steps

1. Add queue workflow type/lifecycle and stage active/capability fields in one
   forward migration. Backfill every existing slug explicitly; abort on unknown
   active queues. Do not infer behavior at runtime after migration.
2. Add transactional queue create/update APIs accepting workflow type and a
   complete valid stage definition or a named server template. Require exactly
   one active initial stage, at least one active terminal stage, unique order and
   slug, positive SLA, and immutable prefix once cases exist.
3. Add stage CRUD/reorder/deactivate endpoints with optimistic queue revision.
   Reject deletion of referenced stages. Activation must run readiness checks
   covering stages, flow graph, required capabilities, and prefix/sequence.
4. Remove slug-coded default/visibility logic. Specialized business services
   must branch on workflow type/capabilities. Generic queues must support normal
   take-ownership, ordered advancement, close blockers, history, comments, and SLA.
5. Extend case-detail/list queue DTOs with workflow type/capabilities. Update FE
   renderer registry to use workflow type and keep a complete generic renderer.
6. Add FE queue creation, lifecycle, and stage editor UI using existing dialog,
   field, DataTable, query invalidation, and toast conventions. Show why a queue
   is not activation-ready and handle revision conflicts.
7. Update queue/case/configuration API docs. Keep backward compatibility only
   where it does not permit invalid activation.

## Verification

- Backend: `bun run typecheck`, `bunx drizzle-kit check`, `git diff --check`.
- Frontend: `bun run lint`; do not run build.
- `rg -n "queue\.slug ===|queueSlug ===|QUEUE_SLUG" src/modules/queues src/modules/cases` may retain constants only in migration/backward-compat adapters, not runtime capability dispatch.
- Creating a generic draft queue through the API returns persisted stages;
  activation rejects incomplete definitions with 409/422 and no partial writes.

## STOP conditions

- Stop if any existing queue cannot be mapped unambiguously to a workflow type.
- Stop if stage mutation would orphan or remap an existing case.
- Stop if FE changes require a build; only lint is authorized.
- Do not add tests.

