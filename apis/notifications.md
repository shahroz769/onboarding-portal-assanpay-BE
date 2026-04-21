# Notifications API

Base URL: `http://localhost:3000`
All endpoints require `Authorization: Bearer <accessToken>`.

---

## GET /api/notifications

Cursor-paginated list of notifications for the current user, latest first.

**Query parameters**

| Name   | Type           | Default | Description                                |
| ------ | -------------- | ------- | ------------------------------------------ |
| cursor | ISO datetime   | —       | Returns items strictly older than cursor.  |
| limit  | int (1..50)    | 20      | Page size.                                 |
| filter | `all`\|`unread` | all    | Restrict to unread.                         |

**200 Response**

```json
{
  "items": [
    {
      "id": "uuid",
      "type": "case_assigned",
      "title": "Case CASE-000000123 assigned to you",
      "body": "Alice assigned this Onboarding case to you.",
      "caseId": "uuid",
      "caseNumber": "CASE-000000123",
      "commentId": null,
      "actorId": "uuid",
      "actorName": "Alice",
      "metadata": { "caseNumber": "CASE-000000123", "queueName": "Onboarding", "actorName": "Alice" },
      "isRead": false,
      "readAt": null,
      "createdAt": "2026-04-22T10:00:00.000Z"
    }
  ],
  "nextCursor": "2026-04-22T09:30:00.000Z",
  "unreadCount": 7
}
```

`nextCursor` is `null` when no more pages.

---

## GET /api/notifications/unread-count

```json
{ "count": 7 }
```

---

## PATCH /api/notifications/:id/read

Marks one notification as read. Idempotent. Scoped to current user (404 otherwise).

```json
{ "id": "uuid", "isRead": true, "readAt": "2026-04-22T10:01:00.000Z" }
```

---

## PATCH /api/notifications/read-all

Marks all unread notifications for the current user as read.

```json
{ "updated": 7 }
```

---

## GET /api/notifications/stream

Server-Sent Events stream of live notifications for the current user.

**Events**

- `event: ready` — emitted on connect (`data: ok`).
- `event: notification` — `data:` is a JSON-encoded notification object (same shape as list items).
- `event: ping` — every 25s (heartbeat to defeat proxy timeouts).

The connection unsubscribes automatically on client disconnect.

---

## Trigger Sources

Notifications are created automatically by other endpoints:

| Source                                 | Type(s) created                                    | Recipients                                                                  |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| `PATCH /api/cases/:id/assign`          | `case_assigned`, `case_unassigned`                 | New owner (assigned), previous owner (unassigned). Excludes the actor.      |
| `POST  /api/cases/bulk-assign`         | `case_assigned`, `case_unassigned`                 | Same rules per case.                                                        |
| `POST  /api/cases/:id/comments`        | `comment_mention` > `comment_reply` > `comment_thread` (precedence per recipient) | @-mentioned users; parent comment author on reply; prior commenters in the thread. Excludes the comment author. |

Notification creation is best-effort — failures are logged and do **not** roll back the originating action.
