# Plan 005: Decompose the case service and centralize network contracts

> **Executor instructions**: This is behavior-preserving cleanup after plans
> 001–004. Do not introduce new product behavior or add tests.
>
> **Drift check**: `git diff --stat 9d2ee9d..HEAD -- src/modules/cases ../onboarding-portal-assanpay-FE/src/schemas ../onboarding-portal-assanpay-FE/src/apis`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 001–004
- **Category**: tech-debt, architecture
- **Planned at**: commit `9d2ee9d`, 2026-07-12
- **Completed**: DONE (behavior-preserving split of `cases.service.ts`; contracts in `src/contracts/`)

## Why this matters

`cases.service.ts` is roughly 6,700 lines and is the main churn hotspot. It owns
state transitions, queue-specific workflows, storage, public tokens, email,
comments, history, and read models. This makes every queue change risky and
encourages duplicated slug and validation logic.

## Scope

**In scope**: split case services by responsibility, dependency injection for
storage/email, shared dependency-free DTO contracts or generated OpenAPI types,
frontend network schema consumption.

**Out of scope**: behavior changes, migrations, UI redesign, tests, builds.

## Steps

1. Freeze and inventory all exported case-service functions and their route
   callers. Define modules for query/read models, transitions, assignments,
   comments/history, document review, communications, public tokens, and each
   specialized workflow. Keep routes unchanged while moving one cohesive group
   at a time.
2. Extract shared transaction types, queue capability checks, cursor helpers,
   upload validators, and communication helpers into narrowly named modules.
   Do not create a generic `utils.ts` dumping ground.
3. Inject `FileStorageProvider` and email clients at module boundaries so network
   effects are visible. Preserve failed-attempt ownership semantics from plan 001.
4. Establish one network contract source: preferably generated OpenAPI from Hono;
   otherwise a dependency-free shared package consumed by both repos. Runtime
   request/response validation remains mandatory. UI-only form schemas stay local.
5. Switch FE APIs/schemas incrementally, one endpoint group at a time. Remove
   duplicated queue/flow/case DTO schemas only after all consumers compile/lint.
6. Keep `cases.service.ts` as a temporary re-export facade, then remove it once
   route imports are migrated and repository search shows no direct callers.

## Verification

- Backend `bun run typecheck` exits 0 after each moved group.
- Frontend `bun run lint` exits 0; do not run build.
- Final `cases.service.ts` is removed or under 300 lines as an explicit facade.
- `rg -n "export async function" src/modules/cases` shows functions grouped in
  responsibility-specific modules.
- `git diff --check` exits 0 and no migration files are added.

## STOP conditions

- Stop if an extraction requires changing behavior or response shapes not
  introduced by plans 001–004.
- Stop if the chosen contract mechanism requires coupling FE deployment to BE
  source files at runtime; contracts must be build-time only.
- Stop rather than adding tests or running a build.

## Maintenance notes

Reviewers should reject circular imports, broad service singletons, and a new
god-module under a different name. Contract generation must be deterministic and
versioned with the backend API.

