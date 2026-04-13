# Auth APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/auth
```

## Auth Model

The backend uses two auth tokens:

- `accessToken`
  Used in the `Authorization` header.
- `refresh_token`
  Stored as an `HttpOnly` cookie by the backend.

Authenticated request header:

```http
Authorization: Bearer <accessToken>
```

Refresh cookie details:

- Cookie name: `refresh_token`
- Set by login and refresh
- Cleared by logout
- Path: `/`
- `HttpOnly`: `true`
- `SameSite`: `lax`
- `Secure`: depends on backend env config

Frontend note:

- If your frontend and backend are on different origins, send requests with `credentials: "include"` when refresh cookie support is needed.

## Common User Object

```json
{
  "id": "uuid",
  "name": "John Doe",
  "email": "john@example.com",
  "username": "john01",
  "roleType": "admin",
  "status": "active",
  "accessPolicyId": "uuid-or-null",
  "createdByUserId": "uuid-or-null",
  "lastLoginAt": "2026-04-14T10:00:00.000Z",
  "createdAt": "2026-04-14T09:00:00.000Z",
  "updatedAt": "2026-04-14T10:00:00.000Z"
}
```

Allowed `roleType` values:

- `super_admin`
- `admin`
- `supervisor`
- `employee`

Allowed `status` values:

- `active`
- `inactive`

## POST `/api/auth/register`

Purpose:

- Registers the very first super admin
- Works only once when there is no user in the system

Auth:

- No auth required

Request body:

```json
{
  "name": "Super Admin",
  "email": "admin@example.com",
  "username": "superadmin",
  "password": "secret123"
}
```

Field rules:

- `name`: string, min 2, max 120
- `email`: valid email, normalized to lowercase
- `username`: string, min 2, max 64
- `password`: string, min 8, max 128

Success response:

- Status: `201`

```json
{
  "user": {
    "id": "uuid",
    "name": "Super Admin",
    "email": "admin@example.com",
    "username": "superadmin",
    "roleType": "super_admin",
    "status": "active",
    "accessPolicyId": null,
    "createdByUserId": null,
    "lastLoginAt": null,
    "createdAt": "2026-04-14T09:00:00.000Z",
    "updatedAt": "2026-04-14T09:00:00.000Z"
  }
}
```

Possible errors:

- `400` Invalid body
- `409` Initial registration is already completed.

## POST `/api/auth/login`

Purpose:

- Logs in a user
- Accepts either email or username as the identifier
- Sets the `refresh_token` cookie

Auth:

- No auth required

Request body:

Preferred format:

```json
{
  "identifier": "admin@example.com",
  "password": "secret123"
}
```

Legacy-supported format:

```json
{
  "email": "admin@example.com",
  "password": "secret123"
}
```

Field rules:

- `identifier`: string, min 2, max 255
- `email`: optional legacy field, min 2, max 255
- `password`: string, min 8, max 128
- At least one of `identifier` or `email` must be sent

Success response:

- Status: `200`
- Also sets `refresh_token` cookie

```json
{
  "accessToken": "jwt-access-token",
  "user": {
    "id": "uuid",
    "name": "Admin User",
    "email": "admin@example.com",
    "username": "admin01",
    "roleType": "admin",
    "status": "active",
    "accessPolicyId": null,
    "createdByUserId": "uuid",
    "lastLoginAt": "2026-04-14T10:00:00.000Z",
    "createdAt": "2026-04-14T09:00:00.000Z",
    "updatedAt": "2026-04-14T10:00:00.000Z"
  }
}
```

Possible errors:

- `400` Invalid body
- `401` Invalid email or password.

Frontend notes:

- Save `accessToken` in frontend auth state.
- Use `credentials: "include"` if you want the browser to store and send the refresh cookie.

## POST `/api/auth/refresh`

Purpose:

- Issues a new access token using the `refresh_token` cookie
- Rotates the refresh token and sets a new `refresh_token` cookie

Auth:

- No bearer token required
- Requires refresh cookie

Request body:

- None

Success response:

- Status: `200`
- Also sets a new `refresh_token` cookie

```json
{
  "accessToken": "new-jwt-access-token",
  "user": {
    "id": "uuid",
    "name": "Admin User",
    "email": "admin@example.com",
    "username": "admin01",
    "roleType": "admin",
    "status": "active",
    "accessPolicyId": null,
    "createdByUserId": "uuid",
    "lastLoginAt": "2026-04-14T10:00:00.000Z",
    "createdAt": "2026-04-14T09:00:00.000Z",
    "updatedAt": "2026-04-14T10:00:00.000Z"
  }
}
```

Possible errors:

- `401` Missing refresh token.
- `401` Invalid refresh token.
- `401` Refresh token is expired or revoked.
- `401` User is not available.

Frontend notes:

- Call this when the access token expires.
- Request must include cookies.

## POST `/api/auth/logout`

Purpose:

- Logs out the current session
- Revokes the refresh token if present
- Clears the `refresh_token` cookie

Auth:

- No bearer token required
- Works even if the refresh cookie is missing or invalid

Request body:

- None

Success response:

- Status: `200`

```json
{
  "success": true
}
```

## Suggested Frontend Flow

Login flow:

1. Call `POST /api/auth/login`
2. Save `accessToken`
3. Store returned `user` in auth state
4. Send `Authorization: Bearer <accessToken>` for protected routes
5. Call `POST /api/auth/refresh` when the access token expires

Logout flow:

1. Call `POST /api/auth/logout` with credentials included
2. Clear local access token
3. Clear local auth state
