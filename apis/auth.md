# Auth APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/auth
```

All error responses use the shape `{ "error": "message" }`.

## Auth Model

The backend uses two auth tokens:

- `accessToken`
  Short-lived JWT sent in the `Authorization` header.
- `refresh_token`
  Stored as an `HttpOnly` cookie by the backend.

Authenticated request header:

```http
Authorization: Bearer <accessToken>
```

Refresh cookie details:

- Cookie name: `refresh_token`
- Set by login and refresh, cleared by logout
- Path: `/`
- `HttpOnly`: `true`
- `SameSite`: backend `COOKIE_SAME_SITE` (default `lax`; use `none` for separately hosted frontend/backend origins)
- `Secure`: backend `COOKIE_SECURE` (defaults to `false` outside production so localhost over plain HTTP can keep the cookie)
- Refresh tokens rotate on every refresh. Presenting an already-rotated token revokes the session.

Frontend note:

- Send requests with `credentials: "include"` (axios `withCredentials: true`) so the browser stores and sends the refresh cookie.
- Hosted cross-site refresh requires `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=none`, HTTPS on the backend, and the frontend origin in `CORS_ORIGIN`.

### CSRF protection

`/login`, `/refresh` and `/logout` are protected in two layers:

- Hono's [`csrf()`](https://hono.dev/docs/middleware/builtin/csrf) middleware rejects form-style requests (`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`) with `403 Forbidden.` unless their `Origin` is in `CORS_ORIGIN` or `Sec-Fetch-Site` is `same-origin`. These are the only types a browser can send cross-site without a preflight.
- JSON requests are covered by CORS instead: a cross-site `application/json` POST needs a preflight, and the preflight only allows origins in `CORS_ORIGIN`, so the browser never sends the request.

Non-browser clients (e.g. curl) are not subject to CORS and are not blocked by an `Origin` mismatch on JSON requests. They cannot carry a victim's browser cookies, so this is not a CSRF path.

### Rate limits

- `/login`: 15 failed attempts per IP per 15 minutes, and 10 failed attempts per account per 15 minutes. Only failures count. Over the limit: `429`.
- `/register-super-admin`: 15 failed attempts per IP per 15 minutes.

## Common User Object

Returned by login, refresh, register and set-password:

```json
{
  "id": "uuid",
  "name": "John Doe",
  "email": "john@assanpay.com",
  "username": "john01",
  "gender": "male",
  "roleType": "admin",
  "status": "active",
  "queueViewScope": "all",
  "workQueueIds": ["uuid"],
  "createdByUserId": "uuid-or-null",
  "lastLoginAt": "2026-04-14T10:00:00.000Z",
  "createdAt": "2026-04-14T09:00:00.000Z",
  "updatedAt": "2026-04-14T10:00:00.000Z"
}
```

Allowed `roleType` values:

- `super_admin`
- `admin`
- `agent`

Allowed `status` values:

- `active`
- `inactive`

Allowed `gender` values:

- `male`
- `female`

`queueViewScope` is `all` or `selected`. `workQueueIds` lists the queues the user may work in.

## POST `/api/auth/register-super-admin`

Purpose:

- Bootstraps a `super_admin` user
- Works only when `ALLOW_SUPER_ADMIN_REGISTRATION=true`

Auth:

- No auth required

Request body:

```json
{
  "name": "Super Admin",
  "email": "admin@assanpay.com",
  "username": "admin01",
  "password": "secret123"
}
```

Field rules:

- `name`: string, trimmed, min 2, max 120
- `email`: valid email, normalized to lowercase
- `username`: string, trimmed, min 2, max 64
- `password`: string, min 8, max 128

Success response:

- Status: `201`

```json
{
  "user": { "...": "Common User Object with roleType super_admin" }
}
```

Possible errors:

- `400` Invalid body
- `403` Super Admin registration is disabled.
- `409` Email is already in use.
- `409` Username is already in use.
- `429` Too many attempts.

## POST `/api/auth/login`

Purpose:

- Logs in a user with either email or username as the identifier
- Sets the `refresh_token` cookie

Auth:

- No auth required

Request body:

```json
{
  "identifier": "admin@assanpay.com",
  "password": "secret123"
}
```

The legacy form `{ "email": "...", "password": "..." }` is still accepted.

Field rules:

- `identifier`: string, min 2, max 255, matched case-insensitively
- `email`: optional legacy field, min 2, max 255
- `password`: string, min 8, max 128
- At least one of `identifier` or `email` must be sent

Success response:

- Status: `200`
- Also sets the `refresh_token` cookie

```json
{
  "accessToken": "jwt-access-token",
  "user": { "...": "Common User Object" }
}
```

Possible errors:

- `400` Invalid body
- `401` Invalid email or password.
- `403` Forbidden. (cross-site form request)
- `429` Too many attempts.

## POST `/api/auth/refresh`

Purpose:

- Issues a new access token from the `refresh_token` cookie
- Rotates the refresh token and sets a new cookie

Auth:

- No bearer token required
- Requires the refresh cookie

Request body:

- None

Success response:

- Status: `200`
- Also sets a new `refresh_token` cookie

```json
{
  "accessToken": "new-jwt-access-token",
  "user": { "...": "Common User Object" }
}
```

Possible errors:

- `401` Missing refresh token.
- `401` Invalid refresh token.
- `401` Refresh token is expired or revoked.
- `401` User is not available.
- `403` Forbidden. (cross-site form request)

## POST `/api/auth/logout`

Purpose:

- Revokes the current refresh session if the cookie is present
- Clears the `refresh_token` cookie

Auth:

- No bearer token required
- Works even if the refresh cookie is missing or invalid

Success response:

- Status: `200`

```json
{
  "success": true
}
```

Possible errors:

- `403` Forbidden. (cross-site form request)

## GET `/api/auth/password-token/:token`

Purpose:

- Validates an invite or password-reset link before showing the set-password form

Auth:

- No auth required

Path params:

- `token`: string, min 32, max 256 (from the emailed link `/set-password/:token`)

Success response:

- Status: `200`

```json
{
  "name": "John Doe",
  "email": "john@assanpay.com",
  "purpose": "invite",
  "expiresAt": "2026-04-17T09:00:00.000Z"
}
```

`purpose` is `invite` or `reset`.

Possible errors:

- `400` Invalid token format
- `410` This password link is expired or invalid.

## POST `/api/auth/set-password`

Purpose:

- Sets the user's password from an invite or reset link
- Consumes the link and any other open invite/reset links for the user
- Revokes all of the user's existing sessions

Auth:

- No auth required

Request body:

```json
{
  "token": "token-from-link",
  "password": "new-secret123",
  "confirmPassword": "new-secret123"
}
```

Field rules:

- `token`: string, min 32, max 256
- `password`, `confirmPassword`: string, min 8, max 128, must match

Success response:

- Status: `200`

```json
{
  "user": { "...": "Common User Object" }
}
```

Possible errors:

- `400` Invalid body / Passwords do not match.
- `410` This password link is expired or invalid.

The user then signs in with `POST /api/auth/login`.

## Suggested Frontend Flow

Login flow:

1. Call `POST /api/auth/login` with credentials included
2. Keep `accessToken` in memory and `user` in auth state
3. Send `Authorization: Bearer <accessToken>` to protected routes
4. On `401`, call `POST /api/auth/refresh` once, then retry the request

Logout flow:

1. Call `POST /api/auth/logout` with credentials included
2. Clear the local access token and auth state
