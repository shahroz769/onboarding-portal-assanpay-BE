# Network contracts

Canonical, dependency-free DTO constants and shapes for the AssanPay onboarding
API. These are **build-time** references only.

## Rules

- No Drizzle, Hono, env, or storage imports in this folder.
- Backend modules may re-export from here.
- Frontend must **mirror** values in its own `src/schemas` (copy/update when
  contracts change). Do not import BE source into FE at runtime or via path
  aliases into this repo.
- OpenAPI codegen is not scaffolded; this folder is the pragmatic contract home
  until generation is added.

## Current contracts

| File | Covers |
|---|---|
| `queues.ts` | `workflowType`, `lifecycle` (plans 003–004) |

Frontend mirror: `onboarding-portal-assanpay-FE/src/schemas/queue-workflow.schema.ts`
