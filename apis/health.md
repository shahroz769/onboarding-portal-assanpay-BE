# Health APIs

Base URL:

```txt
http://localhost:3000
```

## GET `/`

Purpose:

- Basic API status check

Auth:

- No auth required

Request body:

- None

Success response:

- Status: `200`

```json
{
  "name": "Onboarding Portal API",
  "status": "ok"
}
```

## GET `/health/db`

Purpose:

- Checks database connectivity

Auth:

- No auth required

Request body:

- None

Success response:

- Status: `200`

```json
{
  "status": "ok",
  "db": true
}
```
