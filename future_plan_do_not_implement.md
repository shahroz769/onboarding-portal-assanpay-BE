# Future Backend Architecture Plan

## Objective

If this backend were written again from scratch, it should be implemented as a feature-first modular monolith using Bun, Hono, strict TypeScript, Drizzle, PostgreSQL, and Zod.

The architecture should optimize for:

- Readability and easy navigation.
- Clear ownership of business capabilities.
- Explicit dependency direction.
- Small, focused files instead of large route and service files.
- Testable business operations without real databases or external services.
- Safe transaction boundaries for case mutations and single-use actions.
- The ability to split into separate services later without prematurely introducing microservices.

The project should not use global `controllers/`, `services/`, and `repositories/` folders for the entire application. That structure scatters a single feature across unrelated directories. Each business module should contain its own routes, controllers, use cases, policies, contracts, and persistence code.

## Recommended Project Structure

```text
src/
├── main.ts                         # Process startup and graceful shutdown
├── app.ts                          # Creates and configures the Hono application
│
├── config/
│   ├── env.ts                      # Zod-validated environment contract
│   └── constants.ts
│
├── db/
│   ├── client.ts
│   ├── transaction.ts              # Shared database and transaction types
│   ├── migrate.ts
│   └── schema/
│       ├── identity.tables.ts
│       ├── merchants.tables.ts
│       ├── workflows.tables.ts
│       ├── cases.tables.ts
│       ├── communications.tables.ts
│       ├── storage.tables.ts
│       ├── relations.ts
│       └── index.ts                # Schema composition and re-exports only
│
├── shared/
│   ├── http/
│   │   ├── errors.ts
│   │   ├── error-handler.ts
│   │   ├── validator.ts
│   │   ├── pagination.ts
│   │   └── multipart.ts
│   ├── auth/
│   │   ├── auth.middleware.ts
│   │   ├── authorization.ts
│   │   └── session.ts
│   ├── observability/
│   │   ├── logger.ts
│   │   └── request-context.ts
│   ├── crypto/
│   │   ├── tokens.ts
│   │   └── hashing.ts
│   └── types/
│       └── result.ts
│
├── infrastructure/
│   ├── email/
│   │   ├── email.port.ts
│   │   ├── resend-email.adapter.ts
│   │   └── templates/
│   └── storage/
│       ├── storage.port.ts
│       ├── google-drive.adapter.ts
│       ├── storage-ownership.repository.ts
│       └── file-validation.ts
│
├── modules/
│   ├── identity/
│   │   ├── auth/
│   │   └── users/
│   ├── merchants/
│   ├── workflow-configuration/
│   ├── cases/
│   ├── notifications/
│   └── dashboard/
│
├── jobs/
│   ├── refresh-token-cleanup.job.ts
│   ├── case-flow-close.worker.ts
│   └── jobs.runner.ts
│
└── contracts/
    ├── auth.contract.ts
    ├── users.contract.ts
    ├── merchants.contract.ts
    ├── queues.contract.ts
    └── cases.contract.ts

tests/
├── unit/
├── integration/
├── contract/
└── helpers/
    ├── test-app.ts
    ├── test-db.ts
    └── fixtures.ts
```

## Standard Module Structure

A normal module, such as users, should follow this structure:

```text
modules/identity/users/
├── users.module.ts                 # Constructs and exports the module
├── users.routes.ts                 # Paths and middleware ordering
├── users.controller.ts             # Hono request/response adaptation
├── users.contract.ts               # Zod request, query, and response schemas
│
├── application/
│   ├── create-user.use-case.ts
│   ├── update-user.use-case.ts
│   ├── list-users.use-case.ts
│   └── deactivate-user.use-case.ts
│
├── domain/
│   ├── user.ts
│   ├── user.policy.ts
│   └── user.errors.ts
│
├── persistence/
│   ├── users.repository.ts         # Repository interface
│   └── drizzle-users.repository.ts # Drizzle implementation
│
└── users.mapper.ts                 # Database/domain/API transformations
```

Not every small module needs every folder immediately. Begin with routes, controller, contracts, use cases, and persistence. Add domain policy files when real business rules justify them. Avoid empty abstractions and one-line wrapper classes.

## Request Flow

Every request should follow this direction:

```text
Route
  -> authentication and validation middleware
  -> controller
  -> use case
  -> domain policies
  -> repository and external-service ports
  -> response mapper
```

### Layer Responsibilities

| Layer | Responsibility |
|---|---|
| Route | Define the URL, HTTP method, middleware, and controller |
| Controller | Read validated HTTP input and authentication, invoke a use case, and produce an HTTP response |
| Contract | Define Zod request, query, parameter, and response schemas and public DTOs |
| Use case | Implement one business operation, authorization requirements, orchestration, and transaction boundaries |
| Domain policy | Express pure business rules, state transitions, and invariants |
| Repository | Execute database reads and writes without HTTP knowledge |
| Adapter | Integrate with Google Drive, Resend, JWT, hashing, and other external systems |
| Mapper | Convert persistence records into domain objects and public API DTOs |

A controller should remain small:

```ts
export async function advanceCaseController(c: AppContext) {
  const result = await advanceCase({
    caseId: c.req.param('caseId'),
    actor: c.var.auth,
  })

  return c.json(result)
}
```

Controllers should not:

- Query Drizzle directly.
- Decide whether a case transition is allowed.
- Send emails or notifications directly.
- Perform Google Drive operations directly.
- Own transaction boundaries.
- Contain lengthy multipart parsing and file-validation logic.

Reusable multipart parsing and validation should live in `shared/http/multipart.ts`, while feature-specific multipart contracts remain inside their feature module.

## Case Module Decomposition

Cases are the core and most complex domain. They should not be represented by one large route file or one general case service.

```text
modules/cases/
├── cases.module.ts
├── cases.routes.ts                 # Mounts the smaller capability routers
├── core/
│   ├── case.ts
│   ├── case-status.ts
│   ├── case-access.policy.ts
│   ├── case.repository.ts
│   └── drizzle-case.repository.ts
├── queries/
│   ├── query.routes.ts
│   ├── list-cases.use-case.ts
│   ├── get-case-detail.use-case.ts
│   └── case-read.repository.ts
├── assignment/
│   ├── assignment.routes.ts
│   ├── assignment.controller.ts
│   ├── assign-case.use-case.ts
│   ├── bulk-assign-cases.use-case.ts
│   └── assignment.policy.ts
├── transitions/
│   ├── transition.routes.ts
│   ├── transition.controller.ts
│   ├── transition-case.use-case.ts
│   ├── transition.policy.ts
│   └── case-state-machine.ts
├── comments/
├── history/
├── reviews/
├── communications/
└── workflows/
    ├── agreement/
    ├── document-review/
    ├── mid-creation/
    ├── testing/
    ├── wordpress/
    ├── physical-agreement/
    ├── sub-merchant-form/
    └── live/
```

Each case workflow folder should own its own:

- Routes and controllers.
- Request and response contracts.
- Use cases.
- Workflow-specific validation and policies.
- Workflow-specific persistence queries.
- Tests.

Shared case behavior should remain in the case core:

- Queue view and queue work access.
- Ownership and assignment.
- State transitions.
- Row locking and stale-state protection.
- SLA calculations.
- Comments and history.
- Common case identifiers and statuses.

## Database Architecture

The database schema should be split by bounded context instead of being maintained in one large file. Drizzle should still receive one composed schema object through `db/schema/index.ts`.

Use explicit names to distinguish different meanings of "schema":

- `*.tables.ts` for Drizzle and PostgreSQL definitions.
- `*.contract.ts` for Zod API schemas and DTOs.
- `*.policy.ts` for business validation and invariants.
- `*.mapper.ts` for transformations.

Avoid broad names such as `schemas.ts` when the file mixes request validation, domain types, and persistence concepts.

Repositories should import only the tables they use. Controllers and routes must never import database tables.

### Transactions

Transactions belong at the use-case boundary because the use case knows which operations must succeed or fail together. Repository methods should accept either the normal database handle or a transaction handle.

```ts
await db.transaction(async (tx) => {
  await tokenRepository.consumeOnce(tx, tokenHash)
  await caseRepository.recordSubmission(tx, submission)
  await outboxRepository.enqueue(tx, event)
})
```

The following invariants must be retained:

- Lock a case row before mutating transition-sensitive state.
- Re-check queue access and ownership inside the transaction.
- Apply stale-state guards to transitions.
- Record case history in the same transaction as the mutation.
- Hash public bearer credentials at rest.
- Atomically consume single-use tokens before external file operations.
- Never run migrations against the normal production/runtime pooled connection.
- Keep migrations forward-only and add a new journal entry for every migration.

## Application Composition and Dependency Injection

Application creation should be separated from process startup.

- `app.ts` should export a pure `createApp(dependencies)` function.
- `main.ts` should construct production dependencies, start the Bun server, and handle graceful shutdown.
- `jobs.runner.ts` should start background workers.
- Tests should call `createApp()` with test doubles and a test database.

```ts
const dependencies = {
  db,
  clock,
  idGenerator,
  email: new ResendEmailAdapter(env),
  storage: new GoogleDriveAdapter(env),
}

const app = createApp(dependencies)
```

Use cases should receive dependencies explicitly rather than calling global database, email, or storage instances. This makes business operations independently testable and makes side effects visible in their constructors or factory functions.

Prefer simple factory functions and typed dependency objects over a dependency-injection framework.

## Module Dependency Rules

Dependencies should flow inward:

```text
HTTP -> application -> domain
                   -> persistence ports

Infrastructure -> application/domain ports
Persistence implementation -> domain and database schema
Domain -> no framework-specific code
```

Enforce these rules:

- Domain code must not import Hono, Drizzle, environment configuration, Resend, or Google Drive.
- Controllers may import contracts and use cases, but not Drizzle tables.
- Persistence implementations may import Drizzle but not Hono.
- A module may expose public operations only through its `*.module.ts` entry point.
- One module should not import another module's HTTP request schemas.
- Cases should not import merchant request schemas.
- Queues should not import case request schemas.
- Cross-module reads should use narrow query interfaces.
- Cross-module mutations should use explicit application interfaces or domain events.
- Avoid circular dependencies among cases, merchants, queues, configuration, email, and notifications.

## Contracts

Keep dependency-free network contracts in `src/contracts`. These contracts should contain:

- Stable request and response DTO shapes.
- Shared enum constants used over the network.
- Pagination shapes.
- API error response shapes.

They must not import Hono, Drizzle, storage adapters, or environment configuration.

Until OpenAPI generation is introduced, the frontend should mirror these contracts deliberately. In the longer term, generate OpenAPI from the Hono/Zod route definitions and generate frontend clients and types from that specification.

Persistence types such as `typeof users.$inferSelect` must not become public API response types. Responses should use explicit DTOs so database changes do not silently change the API contract.

## Authorization

Authentication middleware should establish the authenticated actor. Authorization should be applied in two places:

1. Route middleware for broad endpoint eligibility, such as requiring authentication or an administrative role.
2. Use-case/domain policies for resource-specific rules, such as queue view access, queue work access, case ownership, and permitted state transitions.

Critical authorization rules must be evaluated inside the same transaction as the mutation when concurrent changes could invalidate an earlier check.

The case access model must preserve these rules:

- Case reads require queue view access.
- Case mutations require queue work access.
- Ownership requirements must be explicit per operation.
- Role checks alone must not replace queue access checks.

## External Services

External systems should be represented by ports owned by the application/domain and adapters owned by infrastructure.

Examples:

```text
EmailPort
  -> ResendEmailAdapter

StoragePort
  -> GoogleDriveAdapter

TokenHasher
  -> production crypto implementation
```

Google Drive ownership must remain explicit:

- Allocate an attempt ID for every provisioning or upload flow.
- Record every created object in the storage ownership ledger.
- Promote successful attempt objects to the current lifecycle.
- Clean up only objects created by the failed attempt.
- Never delete shared or previously successful objects based only on folder names or provider IDs.
- Retain and supersede previous successful versions for auditability.

## Events, Email, Notifications, and Jobs

Email, notifications, and asynchronous follow-up work should not be tightly embedded in case repositories or controllers.

Use a transactional outbox:

1. The business use case mutates domain data.
2. The same transaction inserts an outbox event.
3. A worker safely claims committed events.
4. Handlers send email, create notifications, or perform other follow-up work.
5. Retries are idempotent and recorded.

Example events:

- `CaseAssigned`
- `CaseAdvanced`
- `DocumentsResubmitted`
- `AgreementRequested`
- `MerchantTerminated`
- `UserPasswordResetRequested`

Workers should use database-backed claiming, such as row locking with skip-locked behavior and leases where appropriate. An in-memory boolean is insufficient when more than one application process is running.

In production, run HTTP serving and background workers as separate process roles when practical. They may share the same codebase and deployment artifact.

## Error Handling and Observability

Use one application error model with stable error codes:

```ts
type ApiErrorBody = {
  error: {
    code: string
    message: string
    details?: unknown
    requestId: string
  }
}
```

Business code should throw or return typed application/domain errors. Only the HTTP error handler should translate them into status codes and response bodies.

Add structured logging with:

- Request ID.
- Actor/user ID when authenticated.
- Case, merchant, and queue IDs when relevant.
- Operation name.
- Duration and outcome.
- Worker job/event ID.

Never log credentials, raw bearer tokens, password links, secret environment values, or unnecessarily sensitive merchant data.

## Testing Strategy

The backend should have a real test command and layered tests.

### Unit Tests

Test pure logic without PostgreSQL:

- Case state-machine transitions.
- Queue access and ownership policies.
- SLA calculations.
- Workflow readiness rules.
- Zod contracts.
- File signature and metadata validation.
- Token expiry decisions.

### Use-Case Tests

Use repository and adapter fakes to verify:

- Authorization decisions.
- Transaction orchestration.
- Expected writes and domain events.
- No email/storage side effects after rejected operations.
- Correct handling of retries and stale state.

### Integration Tests

Use a dedicated migrated test PostgreSQL database for:

- Drizzle repository queries.
- Transaction behavior and row locking.
- Atomic single-use token consumption.
- Queue access enforcement.
- Route validation and error responses.
- Outbox claiming and retries.

Never run integration tests or migrations against the normal runtime or production database.

### Contract Tests

Verify that:

- Route responses match declared Zod/OpenAPI response contracts.
- Enum values remain synchronized with clients.
- Breaking contract changes are detected deliberately.

Recommended commands:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test tests/integration"
  }
}
```

## Documentation

Keep documentation close to the code and decisions:

```text
docs/
├── architecture.md
├── authorization.md
├── case-state-machine.md
├── storage-ownership.md
├── transactional-outbox.md
├── local-development.md
└── adr/
    ├── 0001-modular-monolith.md
    ├── 0002-transactional-outbox.md
    └── 0003-explicit-storage-ownership.md
```

API documentation should be generated from code where possible. Architectural decision records should explain decisions that future maintainers might otherwise reverse without understanding their safety implications.

## File and Naming Conventions

Use predictable suffixes:

| Suffix | Meaning |
|---|---|
| `*.routes.ts` | Route definitions and middleware order |
| `*.controller.ts` | HTTP adaptation |
| `*.contract.ts` | Zod API contracts and DTOs |
| `*.use-case.ts` | One business operation |
| `*.policy.ts` | Pure business rules and authorization |
| `*.repository.ts` | Persistence interface or implementation |
| `*.tables.ts` | Drizzle table declarations |
| `*.mapper.ts` | Data transformations |
| `*.adapter.ts` | External service implementation |
| `*.port.ts` | External capability interface |
| `*.worker.ts` | Background processing loop |
| `*.job.ts` | Scheduled job definition |

Prefer explicit names such as `advance-case.use-case.ts` over generic names such as `case.service.ts`.

Target file sizes should be treated as guidance, not rigid rules:

- Routes: usually under 150 lines.
- Controllers: usually under 150 lines.
- Use cases: usually under 200 lines.
- Domain policies: focused on one rule family.
- Repository implementations: split read and write repositories when they become large.

When a file requires a long table of configuration or templates, keep that static data separate from behavior.

## Decisions to Preserve from the Current Backend

The rewrite should preserve these strong existing decisions:

- Feature-oriented top-level modules.
- Strict TypeScript.
- Central error handling.
- Zod validation at API boundaries.
- Separate queue view and queue work authorization.
- Documented case ownership requirements.
- Atomic case transitions with row locking.
- Hashed public bearer credentials.
- Atomic single-use token actions.
- Explicit Google Drive ownership tracking.
- Failed-attempt-only storage cleanup.
- Forward-only database migrations.
- A separate direct database URL for migration tooling.
- Dependency-free network contract definitions.

The goal is not to add abstraction everywhere. The goal is to make dependencies visible, business rules testable, transaction ownership explicit, and each business capability easy to find and change.

## Recommended Implementation Order

If the architecture is introduced incrementally, use this order:

1. Establish `app.ts` and `main.ts` separation without changing API behavior.
2. Add the testing foundation and a dedicated test database workflow.
3. Introduce typed dependency construction and external-service ports.
4. Split the database schema by bounded context without changing generated SQL.
5. Extract shared HTTP validation, multipart parsing, error handling, and request context.
6. Refactor one smaller module, such as users, into the target structure as the reference implementation.
7. Refactor queues and workflow configuration while removing their dependency on case HTTP schemas.
8. Split case routes into capability routers.
9. Move case mutations into explicit use cases and domain policies.
10. Introduce repository interfaces only at useful testing or module boundaries.
11. Introduce the transactional outbox for email, notifications, and background follow-up work.
12. Refactor merchant public flows while preserving atomic token consumption and storage ownership guarantees.
13. Generate OpenAPI and frontend client contracts after backend boundaries stabilize.

Each phase should preserve existing API contracts unless a coordinated frontend change is explicitly planned. Every phase must pass `bun run typecheck` and the relevant test suites before proceeding.
