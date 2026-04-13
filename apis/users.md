# User APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/users
```

## Protected Access

All user endpoints require:

- A valid bearer token in `Authorization`

Header:

```http
Authorization: Bearer <accessToken>
```

Common user response object:

```json
{
  "id": "uuid",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "username": "jane01",
  "roleType": "employee",
  "status": "active",
  "accessPolicyId": null,
  "createdByUserId": "uuid",
  "lastLoginAt": null,
  "createdAt": "2026-04-14T09:00:00.000Z",
  "updatedAt": "2026-04-14T09:00:00.000Z"
}
```

Allowed `roleType` values:

- `super_admin`
- `admin`
- `supervisor`
- `employee`

## GET `/api/users`

Purpose:

- Returns all non-deleted users

Allowed roles:

- `super_admin`
- `admin`
- `supervisor`

Request body:

- None

Success response:

- Status: `200`

```json
{
  "users": [
    {
      "id": "uuid",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "username": "jane01",
      "roleType": "employee",
      "status": "active",
      "accessPolicyId": null,
      "createdByUserId": "uuid",
      "lastLoginAt": null,
      "createdAt": "2026-04-14T09:00:00.000Z",
      "updatedAt": "2026-04-14T09:00:00.000Z"
    }
  ]
}
```

Possible errors:

- `401` Missing bearer token.
- `401` Invalid access token.
- `403` Insufficient permissions.

## GET `/api/users/:id`

Purpose:

- Returns a single user by ID

Allowed roles:

- `super_admin`
- `admin`
- `supervisor`

Path params:

- `id`: user UUID

Success response:

- Status: `200`

```json
{
  "user": {
    "id": "uuid",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "username": "jane01",
    "roleType": "employee",
    "status": "active",
    "accessPolicyId": null,
    "createdByUserId": "uuid",
    "lastLoginAt": null,
    "createdAt": "2026-04-14T09:00:00.000Z",
    "updatedAt": "2026-04-14T09:00:00.000Z"
  }
}
```

Possible errors:

- `401` Missing bearer token.
- `401` Invalid access token.
- `403` Insufficient permissions.
- `404` User not found.

## POST `/api/users`

Purpose:

- Creates a managed user

Allowed roles:

- `super_admin`
- `admin`
- `supervisor`

Role creation rules:

- `super_admin` can create `admin`, `supervisor`, `employee`
- `admin` can create `supervisor`, `employee`
- `supervisor` can create `employee`
- `employee` cannot create users

Request body:

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "username": "jane01",
  "password": "secret123",
  "roleType": "employee",
  "accessPolicyId": "uuid"
}
```

Field rules:

- `name`: string, min 2, max 120
- `email`: valid email
- `username`: string, min 2, max 64
- `password`: string, min 8, max 128
- `roleType`: `super_admin | admin | supervisor | employee`
- `accessPolicyId`: optional UUID

Success response:

- Status: `201`

```json
{
  "user": {
    "id": "uuid",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "username": "jane01",
    "roleType": "employee",
    "status": "active",
    "accessPolicyId": "uuid",
    "createdByUserId": "uuid",
    "lastLoginAt": null,
    "createdAt": "2026-04-14T09:00:00.000Z",
    "updatedAt": "2026-04-14T09:00:00.000Z"
  }
}
```

Possible errors:

- `400` Invalid body
- `401` Missing bearer token.
- `401` Invalid access token.
- `403` Insufficient permissions.
- `403` You cannot create a user with this role.
- `409` Email is already in use.
- `409` Username is already in use.

## PATCH `/api/users/:id`

Purpose:

- Updates a user

Allowed roles:

- `super_admin`
- `admin`
- `supervisor`

Path params:

- `id`: user UUID

Request body:

All fields are optional, but at least one field must be sent.

```json
{
  "name": "Jane Updated",
  "username": "jane02",
  "roleType": "supervisor",
  "status": "active",
  "accessPolicyId": "uuid",
  "password": "newsecret123"
}
```

Allowed request fields:

- `name`: string, min 2, max 120
- `username`: string, min 2, max 64
- `roleType`: `super_admin | admin | supervisor | employee`
- `status`: `active | inactive`
- `accessPolicyId`: UUID, `null`, or omitted
- `password`: string, min 8, max 128

Success response:

- Status: `200`

```json
{
  "user": {
    "id": "uuid",
    "name": "Jane Updated",
    "email": "jane@example.com",
    "username": "jane02",
    "roleType": "supervisor",
    "status": "active",
    "accessPolicyId": "uuid",
    "createdByUserId": "uuid",
    "lastLoginAt": null,
    "createdAt": "2026-04-14T09:00:00.000Z",
    "updatedAt": "2026-04-14T10:00:00.000Z"
  }
}
```

Possible errors:

- `400` Invalid body
- `401` Missing bearer token.
- `401` Invalid access token.
- `403` Insufficient permissions.
- `403` Only super admins can manage super admins.
- `403` You cannot assign this role.
- `404` User not found.
- `409` Username is already in use.

Important behavior:

- If `password` is changed, all refresh sessions for that user are revoked.
- If `status` is changed to `inactive`, all refresh sessions for that user are revoked.

## DELETE `/api/users/:id`

Purpose:

- Soft deletes a user by setting `status` to `inactive` and filling `deletedAt`

Allowed roles:

- `super_admin`
- `admin`

Path params:

- `id`: user UUID

Success response:

- Status: `200`

```json
{
  "user": {
    "id": "uuid",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "username": "jane01",
    "roleType": "employee",
    "status": "inactive",
    "accessPolicyId": null,
    "createdByUserId": "uuid",
    "lastLoginAt": null,
    "createdAt": "2026-04-14T09:00:00.000Z",
    "updatedAt": "2026-04-14T10:00:00.000Z"
  }
}
```

Possible errors:

- `401` Missing bearer token.
- `401` Invalid access token.
- `403` Insufficient permissions.
- `403` Only super admins can deactivate super admins.
- `404` User not found.

Important behavior:

- This endpoint revokes all refresh sessions for the deleted user.
- Deleted users are excluded from user listings and lookups.
