# User APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/users
```

All error responses use the shape `{ "error": "message" }`.

## Protected Access

All user endpoints require a valid bearer token:

```http
Authorization: Bearer <accessToken>
```

Every endpoint can return:

- `401` Missing bearer token. / Invalid access token.
- `403` Insufficient permissions. (role not allowed on the route)

Path param `:id` must be a UUID; anything else returns `400`.

## Roles

Allowed `roleType` values: `super_admin`, `admin`, `agent`.

Role rules:

- `super_admin` can create and manage `admin` and `agent` users
- `admin` can create and manage `agent` users only
- `agent` cannot manage users
- A `super_admin`'s role cannot be changed

## Queue Access

Only agents have per-queue access. For `super_admin` and `admin` the queue fields are ignored and they see every queue.

- `queueViewScope`: `all` (see every queue) or `selected` (only `viewQueueIds`)
- `viewQueueIds`: queues the agent can see; at least one is required when `queueViewScope` is `selected`
- `workQueueIds`: queues the agent can work; with `selected` scope these must be within `viewQueueIds`

An access change that would leave an agent owning open cases in queues they can no longer work is rejected with `409`; reassign those cases first.

## Common User Object

```json
{
  "id": "uuid",
  "name": "Jane Doe",
  "email": "jane@assanpay.com",
  "username": "jane01",
  "gender": "female",
  "roleType": "agent",
  "status": "active",
  "hasSetPassword": false,
  "queueViewScope": "selected",
  "createdByUserId": "uuid",
  "lastLoginAt": null,
  "createdAt": "2026-04-14T09:00:00.000Z",
  "updatedAt": "2026-04-14T09:00:00.000Z",
  "viewQueueIds": ["uuid"],
  "workQueueIds": ["uuid"],
  "viewQueues": [{ "id": "uuid", "name": "Documents Review" }],
  "workQueues": [{ "id": "uuid", "name": "Documents Review" }],
  "ownedCasesCount": 3
}
```

`hasSetPassword` is `false` until the user completes their invitation link.

## GET `/api/users`

Purpose:

- Lists non-deleted users, newest first

Allowed roles: `super_admin`, `admin`

Query params (all optional):

- `search`: matches name, email or username (case-insensitive)
- `roleType`: comma-separated roles, e.g. `admin,agent`
- `status`: comma-separated statuses, e.g. `active`

Success response: `200`

```json
{
  "users": [{ "...": "Common User Object" }]
}
```

## GET `/api/users/directory`

Purpose:

- Minimal identity fields for mentions
- Active, non-deleted users only

Allowed roles: any authenticated user

Success response: `200`

```json
{
  "users": [{ "id": "uuid", "name": "Jane Doe", "username": "jane01" }]
}
```

## GET `/api/users/:id`

Allowed roles: `super_admin`, `admin`

Success response: `200`

```json
{
  "user": { "...": "Common User Object" }
}
```

Possible errors:

- `404` User not found.

## POST `/api/users`

Purpose:

- Creates a user and emails them an invitation link to set their password
- There is no password field: the user chooses one via `POST /api/auth/set-password`

Allowed roles: `super_admin`, `admin`

Request body:

```json
{
  "name": "Jane Doe",
  "email": "jane@assanpay.com",
  "username": "jane01",
  "gender": "female",
  "roleType": "agent",
  "status": "active",
  "queueViewScope": "selected",
  "viewQueueIds": ["uuid"],
  "workQueueIds": ["uuid"]
}
```

Field rules:

- `name`: string, trimmed, min 2, max 120
- `email`: valid email on the `@assanpay.com` domain, normalized to lowercase
- `username`: string, trimmed, min 2, max 64
- `gender`: `male | female` (required)
- `roleType`: `super_admin | admin | agent` (subject to the role rules)
- `status`: `active | inactive`, default `active`
- `queueViewScope`: `all | selected`, default `all`
- `viewQueueIds`, `workQueueIds`: arrays of queue UUIDs, default `[]`

Success response: `201`

```json
{
  "user": { "...": "Common User Object" }
}
```

Possible errors:

- `400` Invalid body / One or more selected queues are invalid.
- `403` You cannot create a user with this role.
- `409` Email is already in use.
- `409` Username is already in use.
- `502` The invitation email could not be sent. The user is **not** created, so the request can be retried as is.

## PATCH `/api/users/:id`

Purpose:

- Updates a user's profile, role, status or queue access

Allowed roles: `super_admin`, `admin`

Request body (all fields optional, at least one required; email and username cannot be changed):

```json
{
  "name": "Jane Updated",
  "gender": "female",
  "roleType": "agent",
  "status": "active",
  "queueViewScope": "selected",
  "viewQueueIds": ["uuid"],
  "workQueueIds": ["uuid"]
}
```

Success response: `200`

```json
{
  "user": { "...": "Common User Object" }
}
```

Possible errors:

- `400` Invalid body / One or more selected queues are invalid.
- `403` Super Admin role cannot be changed.
- `403` You cannot assign this role.
- `403` Admins can only update agents.
- `404` User not found.
- `409` The user still owns open cases in queues they would lose.

Important behavior:

- Changing `status` to `inactive`, the role, or any queue access revokes all of the user's sessions.

## DELETE `/api/users/:id`

Purpose:

- Deactivates a user (`status` becomes `inactive`) and revokes all of their sessions

Allowed roles: `super_admin`

Success response: `200`

```json
{
  "user": { "...": "Common User Object with status inactive" }
}
```

Possible errors:

- `400` You cannot delete your own account.
- `404` User not found.

## POST `/api/users/bulk-status`

Purpose:

- Activates or deactivates several users; revokes their sessions

Allowed roles: `super_admin`, `admin`

Request body:

```json
{
  "ids": ["uuid"],
  "status": "inactive"
}
```

Success response: `200`

```json
{
  "updated": 1
}
```

Possible errors:

- `400` You cannot deactivate your own account.
- `403` Admins can only update agents.
- `404` One or more selected users no longer exist. (nothing is updated)

## POST `/api/users/:id/reset-password`

Purpose:

- Emails the user a password-reset link

Allowed roles: `super_admin`

Success response: `200`

```json
{
  "success": true
}
```

Possible errors:

- `404` User not found.
- `502` The email could not be sent. The user's previous reset link, if any, stays valid.

## POST `/api/users/bulk-reset-password`

Purpose:

- Emails password-reset links to up to 100 users

Allowed roles: `super_admin`

Request body:

```json
{
  "ids": ["uuid"]
}
```

Success response: `200`

```json
{
  "requested": 3,
  "sent": 2,
  "failed": 1,
  "failedIds": ["uuid"]
}
```

Possible errors:

- `400` Select between 1 and 100 users.
- `404` One or more selected users no longer exist.
- `502` Failed to send password reset emails. (every send failed)

## Password Links

- Invite and reset links point to `<PUBLIC_APP_URL>/set-password/<token>` and expire per the link-deadline configuration.
- A new link replaces the user's previous link of the same kind only once its email has been sent successfully.
- Setting a password consumes every open link for that user.
