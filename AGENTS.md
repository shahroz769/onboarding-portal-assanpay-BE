# Repository operating rules

If a contract change requires frontend work, use `C:\Users\OFFICE\Downloads\Onboarding Portal\onboarding-portal-assanpay-FE` and read its `AGENTS.md` first.

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
