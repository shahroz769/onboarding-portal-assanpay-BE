To install dependencies:

```sh
bun install
```

Copy `.env.example` to `.env` and configure both database connections:

- `DATABASE_URL`: PlanetScale PgBouncer connection (port `6432`) for API traffic.
- `DIRECT_DATABASE_URL`: direct PlanetScale connection (port `5432`) for
  `db:migrate`, `db:studio`, and other schema operations.

Both PlanetScale URLs must retain the SSL parameters provided by the dashboard.
Do not expose either value to the frontend.

To run:

```sh
bun run dev
```

open http://localhost:3000
