# Repository operating rules

If a contract change requires frontend work, use Desktop path `\Onboarding Portal\onboarding-portal-assanpay-FE` and read its `AGENTS.md` first.

## Database rules

- Both branches are on PlanetScale and reachable via PlanetScale MCP; always use the relevant PlanetScale skills.
- Production (`main` branch): read-only. Use PlanetScale MCP read queries and Insights. Never run `EXPLAIN ANALYZE` there (it executes the query), and never write or migrate from an agent. Production changes go through deploy only.
- Dev (`dev` branch, the local `.env` DB): free for real read/write tests and verifications; test data may stay.
- Benchmarks and bulk fake data on `dev`: run inside a transaction that ends in `ROLLBACK`, and avoid real sequences and external side effects (email, Google Drive).
- Tag agent-run SQL with `/* source=agent */` so it is identifiable in Insights.

## Hono Docs
Always reference https://hono.dev/llms.txt for Hono specific things
- [Full Docs](https://hono.dev/llms-full.txt) Full documentation of Hono. (without examples)

- Stack: Bun, Hono, strict TypeScript, Drizzle, PostgreSQL.
- Style: two spaces, single quotes, trailing commas, no semicolons.
- Before handoff run `bun run typecheck`.
- Never read, print, or commit `.env` values.
- Migrations are forward-only; add a new migration and journal entry.
- Never migrate against the normal production/runtime database.
- Case reads require queue view access; mutations require queue work access and documented ownership.
- Public bearer credentials are hashed at rest and single-use actions must be atomic.
- Track Google Drive ownership explicitly; clean up only failed-attempt objects.
- Do not run frontend builds unless the user explicitly requests one.
