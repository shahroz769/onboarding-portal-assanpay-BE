# Case APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/cases
```

All case routes require authentication. Manual case creation is restricted to
`super_admin` and `admin`; agents are constrained by queue access.

## POST `/api/cases/bulk-create`

Purpose:

- Manually create one case per merchant in the same queue (used by the merchants list multi-select).
- Each merchant is created in its own transaction; a merchant rejected with a 4xx (for example an existing live case or unmet creation requirements) is reported in `failed` and does not roll back the others.

Authorization:

- `super_admin`
- `admin`

Request body:

```json
{
  "merchantIds": ["uuid"],
  "queueId": "uuid",
  "subMerchantId": "uuid"
}
```

`merchantIds` accepts 1–200 ids; duplicates are ignored. `subMerchantId` is required only for EP Sub-Merchant Form queues.

Success response:

- Status: `200`

```json
{
  "created": [{ "id": "uuid", "caseNumber": "DR-000000001", "merchantId": "uuid", "merchantName": "Merchant Name" }],
  "failed": [{ "merchantId": "uuid", "error": "Live case LV-000000001 already exists for this merchant." }]
}
```

`created` items have the same shape as the `POST /api/cases` response.

## POST `/api/cases`

Purpose:

- Manually create a case for an existing merchant in an existing queue.
- Merchant submission and successful case closure can create follow-up cases when admin case-flow rules are configured.

Authorization:

- `super_admin`
- `admin`

Request body:

```json
{
  "merchantId": "uuid",
  "queueId": "uuid"
}
```

Success response:

- Status: `201`

```json
{
  "id": "uuid",
  "caseNumber": "DR-000000001",
  "queueId": "uuid",
  "queueName": "Documents Review",
  "merchantId": "uuid",
  "merchantName": "Merchant Name",
  "ownerId": null,
  "ownerName": null,
  "status": "new",
  "priority": "normal",
  "closedAt": null,
  "createdAt": "2026-05-02T00:00:00.000Z",
  "updatedAt": "2026-05-02T00:00:00.000Z"
}
```

Error responses:

- `400` invalid payload
- `401` missing or invalid authentication
- `403` authenticated user is not a super admin or admin
- `404` merchant or queue not found
- `409` queue is not active (`lifecycle !== active`)
- `500` queue stage or case number generation failure

## Case detail queue shape

`GET /api/cases/:id` includes:

```json
{
  "queue": {
    "id": "uuid",
    "name": "Documents Review",
    "slug": "documents-review",
    "workflowType": "document_review",
    "lifecycle": "active",
    "qcEnabled": false,
    "slaHours": 24
  }
}
```

Specialized case actions dispatch on `workflowType`, not slug.

## Email delivery (Resend webhooks)

Case emails sent through Resend are recorded in `email_log`. `sent` only means
Resend accepted the email; delivery events from `POST /api/webhooks/resend`
move it to `delivered`, `delivery_delayed`, `bounced`, `complained`,
`suppressed` or `failed`.

- `GET /api/cases/:id` includes `emailDelivery`: the case's latest merchant
  email sent while delivery was tracked (`null` if none), with `template`,
  `templateLabel`, `recipient`, `cc`, `status`, `detail` (e.g. the bounce
  reason), `sentAt`, `statusUpdatedAt`, `supersededByManual` and
  `closeBlockedReason`.
- `GET /api/cases/:id/history` adds `emailDelivery` to every entry that
  records an email (`details.emailLogId`): `status`, `detail`, `updatedAt`,
  `tracked`, `cc`, `bcc`. When an email becomes undeliverable an
  `email_undelivered` entry is added and the case owner is notified.
- Closing a case successfully returns `409` with `closeBlockedReason` until
  that email is `delivered`, unless a later manual (Gmail) or WhatsApp send
  replaced it. Closing as unsuccessful is not affected. Emails sent before
  `RESEND_WEBHOOK_SECRET` was configured (`delivery_tracked = false`) never
  block.
- If the latest email has waited over 2 minutes for a webhook (`queued`,
  `sent` or `delivery_delayed`), opening the case or closing it asks Resend
  for the email's status directly (at most once a minute per email), so a
  lost webhook doesn't block the case.
- Every status change pushes a `case-email-status` event on the case owner's
  notifications stream (see notifications.md).

## POST `/api/webhooks/resend`

Resend webhook endpoint (public). Every request must carry a valid Svix
signature for `RESEND_WEBHOOK_SECRET`; otherwise `400`. Without the secret
configured it returns `503`. Subscribe the webhook in Resend to:
`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.complained`, `email.failed`, `email.suppressed`. Out-of-order and
repeated events are ignored safely.

Emails are sent with an `email_log_id` tag, so an event that arrives before
the Resend id is stored still finds its row. An event for an unknown email
returns `503` (so Resend retries) while it is under 10 minutes old, and `200`
after that.
